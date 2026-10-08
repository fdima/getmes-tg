import fs from "fs";
import path from "path";
import { loadConfig, messageUrl } from "./lib/config.js";
import { authorize } from "./lib/session.js";
import { fetchChannelMessages } from "./lib/fetch.js";
import { formatMessageToMarkdown } from "./lib/markdown.js";
import { parseCli, buildHelp, CliError, SELF } from "./lib/cli.js";
import { validateSend, readMessageText, sendToChat } from "./lib/send.js";
import { validateDbConfig, buildRow, openDb } from "./lib/db.js";
import { initLogger, logError, logInfo } from "./lib/logger.js";
import {
  loadState,
  saveStateEntry,
  backfillStateTitles,
  maxMessageIdInText,
  messageIdsInText,
  effectiveExportCheckpoint,
  effectiveDbCheckpoint,
  partitionByCheckpoints,
} from "./lib/state.js";

const OUTPUT_DIR = "./output";

// Компактный прогресс в консоль: напрямую в stdout/stderr, в обход шима
// console.* (он уводит подробности в лог-файл — см. lib/logger.js).
function out(msg) {
  process.stdout.write(msg + "\n");
}

function errOut(msg) {
  process.stderr.write(msg + "\n");
}

function fail(err) {
  errOut(`Ошибка: ${err.message}`);
  errOut(`Справка:  ${SELF} help`);
  process.exit(1);
}

// Перед принудительным выходом дожидаемся, чтобы весь вывод дошёл до
// родительского процесса (иначе stdout может оборваться в пайпе).
function flushStdio() {
  return Promise.all([
    new Promise((resolve) => process.stdout.write("", resolve)),
    new Promise((resolve) => process.stderr.write("", resolve)),
  ]);
}

// Завершение не должно ронять процесс после успешной работы и не должно
// подвешивать его: обычный disconnect() не останавливает update-loop gramjs —
// тот продолжает пинговать закрытый sender (≈30 с задержки и Error: TIMEOUT
// в stderr). destroy() выставляет _destroyed и завершает цикл.
async function safeDisconnect(client) {
  try {
    await client.destroy();
  } catch (err) {
    console.warn(`⚠️  Ошибка при отключении: ${err.message}`);
  }
}

function filterChannels(channels, channelArg) {
  if (!channelArg) return channels;
  const query = channelArg.toLowerCase();
  const found = channels.filter(
    (c) => String(c.id) === channelArg || c.title.toLowerCase().includes(query)
  );
  if (found.length === 0) {
    throw new CliError(`канал не найден в конфиге: ${channelArg}`);
  }
  return found;
}

// Подкоманда export — выгрузка в Markdown-файлы (1.1)
async function runExport(values) {
  const config = loadConfig(values.config);
  initLogger(config);
  const channels = filterChannels(config.channels || [], values.channel);

  // Проверяем наличие папки output
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Доводка записей: во всех записях есть название канала (читаемость
  // state-файла, PLAN/plan 6.md) — до чтения, чтобы state уже с title
  backfillStateTitles("export", channels);
  // Чекпоинты режима export — только в state/export.yaml (config не пишется)
  const state = loadState("export");
  // --repair: полная сверка с startDate, чекпоинты игнорируются (plan 6, п. 5)
  const repair = Boolean(values.repair);

  const started = Date.now();
  let added = 0;
  let errors = 0;

  const client = await authorize(config);

  // Обрабатываем каждый канал
  for (const channelConfig of channels) {
    try {
      // Формируем имя файла
      const safeTitle = channelConfig.title.replace(/[^a-zA-Zа-яА-Я0-9_\- ]/g, "").trim();
      const fileName = `${safeTitle}.md`;
      const filePath = path.join(OUTPUT_DIR, fileName);

      // Файл читается ДО fetch: чекпоинт = max(state-запись, вершина файла),
      // поэтому содержимое нужно и для расчёта, и для последующей дозаписи
      // (см. PLAN/plan 6.md, п. 3.2). При --repair чекпоинт игнорируется:
      // выборка полная с startDate, а из файла строится множество id сверки.
      let content = "";
      if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, "utf-8");
      } else {
        content = `# ${channelConfig.title}\n\n`;
        content += `> Канал: @${channelConfig.id}\n\n---\n\n`;
      }

      const messages = await fetchChannelMessages(client, {
        ...channelConfig,
        lastMessageId: repair
          ? 0
          : effectiveExportCheckpoint(
              state[channelConfig.id],
              maxMessageIdInText(content)
            ),
      });

      if (repair) {
        // Сверка по id: в файл дописываются только отсутствующие сообщения,
        // в порядке возрастания id (fetch возвращает отсортированный список) —
        // дубли невозможны. Известное ограничение: доливка попадает в конец
        // файла, даты могут «перескочить» (PLAN/plan 6.md, п. 5).
        const existing = messageIdsInText(content);
        const missing = messages.filter((m) => !existing.has(m.id));
        for (const msg of missing) {
          content += formatMessageToMarkdown(
            msg,
            channelConfig.title,
            channelConfig.id
          );
        }
        if (missing.length > 0) {
          // Порядок записи как в обычном режиме: сначала файл, потом state
          fs.writeFileSync(filePath, content, "utf-8");
        }
        // state-запись = вершина файла (и при доливке, и без неё — repair
        // выравнивает отставшую запись с артефактом)
        const fileTop = maxMessageIdInText(content);
        if (fileTop > 0) {
          saveStateEntry("export", channelConfig.id, {
            title: channelConfig.title,
            lastMessageId: fileTop,
            lastMessageUrl: messageUrl(channelConfig.id, fileTop),
          });
        }
        if (missing.length > 0) {
          added += missing.length;
          out(`${channelConfig.title}: +${missing.length} пропусков → ${filePath} (#${fileTop})`);
        } else {
          out(`${channelConfig.title}: пропусков нет (#${fileTop})`);
        }
        continue;
      }

      if (messages.length === 0) {
        out(`${channelConfig.title}: нет новых`);
        continue;
      }

      // Добавляем новые сообщения
      for (const msg of messages) {
        content += formatMessageToMarkdown(msg, channelConfig.title, channelConfig.id);
      }

      // Порядок записи: сначала файл канала, потом чекпоинт. Аварийный обрыв
      // между ними даёт «файл впереди записи» — правило max() при следующем
      // запуске продолжит с вершины файла и не создаст дублей.
      fs.writeFileSync(filePath, content, "utf-8");

      const maxId = Math.max(...messages.map((m) => m.id));
      saveStateEntry("export", channelConfig.id, {
        title: channelConfig.title,
        lastMessageId: maxId,
        lastMessageUrl: messageUrl(channelConfig.id, maxId),
      });

      added += messages.length;
      out(`${channelConfig.title}: +${messages.length} → ${filePath} (#${maxId})`);
    } catch (err) {
      errors++;
      logError(`[${channelConfig.title}]`, err);
      errOut(`! ${channelConfig.title}: ${err.message}`);
    }
  }

  await safeDisconnect(client);
  const sec = ((Date.now() - started) / 1000).toFixed(1);
  out(
    `Готово: ${channels.length} каналов, +${added} сообщений` +
      (errors ? `, ошибок: ${errors}` : "") +
      (repair ? " (полная сверка)" : "") +
      ` за ${sec} с`
  );
}

// Подкоманда db — выгрузка ТОЛЬКО в базу данных, без output/*.md (1.2, 1.3)
async function runDb(values) {
  const config = loadConfig(values.config);
  initLogger(config);
  const channels = filterChannels(config.channels || [], values.channel);

  // Валидация секции db и подключение ДО авторизации Telegram —
  // ошибка конфигурации не должна логинить клиента
  const problem = validateDbConfig(config);
  if (problem) throw new CliError(problem);

  let db;
  try {
    db = await openDb(config);
    await db.init();
    // Бэкфилл названия канала для строк, залитых до появления channel_title
    if (typeof db.fillChannelTitle === "function") {
      for (const ch of channels) {
        await db.fillChannelTitle(ch.id, ch.title);
      }
    }
  } catch (err) {
    throw new CliError(err.message);
  }

  // Доводка записей: во всех записях есть название канала (читаемость
  // state-файла, PLAN/plan 6.md) — до чтения, чтобы state уже с title
  backfillStateTitles("db", channels);
  // Чекпоинты режима db — только в state/db.yaml (config не пишется)
  const state = loadState("db");
  // --repair: полная сверка с startDate, чекпоинты игнорируются (plan 6, п. 5)
  const repair = Boolean(values.repair);

  const started = Date.now();
  let added = 0;
  let errors = 0;

  try {
    const client = await authorize(config);
    try {
      for (const channelConfig of channels) {
        try {
          // Чекпоинт инкрементальности (PLAN/plan 6.md, п. 3.2):
          // БД — источник истины. Пустая БД → первичная заливка с startDate
          // (иначе история никогда не попадёт в базу, будут только новые).
          // Наполненная → max(MAX(БД), state-запись): запись отсутствует
          // (миграция) → чекпоинтом становится MAX(БД), режимы не разъезжаются.
          // --repair: чекпоинты игнорируются (effective = undefined), полная
          // выборка с startDate; upsert идемпотентен (ON DUPLICATE KEY
          // UPDATE) — существующие строки обновляются, дублей не создаётся.
          const entry = state[channelConfig.id];
          let effectiveLastId;
          if (repair) {
            effectiveLastId = undefined;
            console.log(
              `полная сверка ${channelConfig.title} с ${channelConfig.startDate}`
            );
          } else {
            const maxInDb = await db.getMaxMessageId(channelConfig.id);
            const fromState =
              entry && entry.lastMessageId ? entry.lastMessageId : 0;
            effectiveLastId = effectiveDbCheckpoint(maxInDb, entry);

            if (maxInDb > 0) {
              if (maxInDb !== fromState) {
                console.log(
                  `чекпоинт ${channelConfig.title}: БД #${maxInDb} / state #${fromState} → #${effectiveLastId}`
                );
              }
            } else {
              console.log(
                `первичная заливка ${channelConfig.title} с ${channelConfig.startDate}`
              );
            }
          }

          const messages = await fetchChannelMessages(client, {
            ...channelConfig,
            lastMessageId: effectiveLastId,
          });

          if (messages.length === 0) {
            out(
              repair
                ? `${channelConfig.title}: сообщений с startDate нет`
                : `${channelConfig.title}: нет новых`
            );
            continue;
          }

          const rows = messages.map((m) =>
            buildRow(
              channelConfig.id,
              channelConfig.title,
              m,
              messageUrl(channelConfig.id, m.id)
            )
          );
          await db.upsertMessages(rows);

          // В лог: сколько сообщений найдено в канале и сколько вставлено в БД
          logInfo(
            repair
              ? `канал «${channelConfig.title}»: полная сверка, строк ${rows.length}, вставлено в MySQL ${rows.length}`
              : `канал «${channelConfig.title}»: новых сообщений ${messages.length}, вставлено в MySQL ${rows.length}`
          );

          // Чекпоинт режима db — в state/db.yaml (как в export, но в своём файле)
          const maxId = Math.max(...messages.map((m) => m.id));
          saveStateEntry("db", channelConfig.id, {
            title: channelConfig.title,
            lastMessageId: maxId,
            lastMessageUrl: messageUrl(channelConfig.id, maxId),
          });

          added += rows.length;
          out(
            repair
              ? `${channelConfig.title}: сверка → ${rows.length} строк в MySQL (#${maxId})`
              : `${channelConfig.title}: +${rows.length} → MySQL (#${maxId})`
          );
        } catch (err) {
          errors++;
          logError(`[${channelConfig.title}]`, err);
          errOut(`! ${channelConfig.title}: ${err.message}`);
        }
      }
    } finally {
      await safeDisconnect(client);
    }
  } finally {
    await db.close().catch(() => {});
  }

  const sec = ((Date.now() - started) / 1000).toFixed(1);
  out(
    `Готово: ${channels.length} каналов, +${added} сообщений в MySQL` +
      (errors ? `, ошибок: ${errors}` : "") +
      (repair ? " (полная сверка)" : "") +
      ` за ${sec} с`
  );
}

// Подкоманда full — комплексная выгрузка: output/*.md И MySQL за один проход
// (plan 7): один вход в Telegram и одна пагинация на канал вместо двух.
// Каждый режим двигает только свой чекпоинт по своим правилам
// (max(state, артефакт)), поэтому расхождение чекпоинтов закрывается fetch'ем
// от минимума двух, а фильтр каждой части по своему чекпоинту исключает дубли
// и сохраняет семантику ручного «подъёма» записи.
async function runFull(values) {
  const config = loadConfig(values.config);
  initLogger(config);
  const channels = filterChannels(config.channels || [], values.channel);

  // Валидация секции db ДО открытия соединения и авторизации Telegram —
  // ошибка конфигурации не должна логинить клиента (порядок как в runDb)
  const problem = validateDbConfig(config);
  if (problem) throw new CliError(problem);

  // Папка output — как в runExport
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Доводка записей обоих state-файлов (читаемость, plan 6) — до чтения,
  // чтобы чекпоинты читались уже с title. У каждого режима свой файл.
  backfillStateTitles("export", channels);
  backfillStateTitles("db", channels);
  const stateExport = loadState("export");
  const stateDb = loadState("db");
  // --repair: чекпоинты обоих режимов игнорируются (plan 7, п. 5)
  const repair = Boolean(values.repair);

  const started = Date.now();
  let addedFile = 0;
  let addedDb = 0;
  let errors = 0;

  // Соединение с БД до авторизации Telegram (как в runDb)
  let db;
  try {
    db = await openDb(config);
    await db.init();
    // Бэкфилл названия канала для строк, залитых до появления channel_title
    if (typeof db.fillChannelTitle === "function") {
      for (const ch of channels) {
        await db.fillChannelTitle(ch.id, ch.title);
      }
    }
  } catch (err) {
    throw new CliError(err.message);
  }

  try {
    const client = await authorize(config);
    try {
      for (const channelConfig of channels) {
        // --- Общая подготовка: чтение файла, оба чекпоинта, ОДИН fetch ---
        // Её ошибка общая для обеих частей → одна строка ошибки, канал без
        // строки прогресса (как в одиночных режимах), чекпоинты не двигаются.
        let content;
        let filePath;
        let fileIds; // при --repair: множество id файла для сверки
        let cpExport;
        let cpDb;
        let forFile;
        let forDb;
        try {
          const safeTitle = channelConfig.title
            .replace(/[^a-zA-Zа-яА-Я0-9_\- ]/g, "")
            .trim();
          filePath = path.join(OUTPUT_DIR, `${safeTitle}.md`);

          // Файл читается ДО fetch: чекпоинт = max(state-запись, вершина файла)
          if (fs.existsSync(filePath)) {
            content = fs.readFileSync(filePath, "utf-8");
          } else {
            content = `# ${channelConfig.title}\n\n`;
            content += `> Канал: @${channelConfig.id}\n\n---\n\n`;
          }

          if (repair) {
            cpExport = 0;
            cpDb = 0;
            fileIds = messageIdsInText(content);
            console.log(
              `полная сверка ${channelConfig.title} с ${channelConfig.startDate}`
            );
          } else {
            cpExport = effectiveExportCheckpoint(
              stateExport[channelConfig.id],
              maxMessageIdInText(content)
            );
            // Пустая БД → 0 → первичная заливка с startDate (как в runDb)
            const maxInDb = await db.getMaxMessageId(channelConfig.id);
            cpDb =
              Number(
                effectiveDbCheckpoint(maxInDb, stateDb[channelConfig.id])
              ) || 0;
          }

          // Один fetch на канал: от минимума чекпоинтов. Нулевой чекпоинт
          // (нет файла или пустая БД) → полная выборка с startDate.
          const fetchFrom =
            cpExport > 0 && cpDb > 0 ? Math.min(cpExport, cpDb) : 0;
          if (!repair && cpExport !== cpDb) {
            // Диагностика расхождения чекпоинтов — в лог (console.* → лог-файл)
            console.log(
              `чекпоинт ${channelConfig.title}: файл #${cpExport} / БД #${cpDb} → fetch от #${fetchFrom}`
            );
          }

          const messages = await fetchChannelMessages(client, {
            ...channelConfig,
            lastMessageId: fetchFrom,
          });

          if (repair) {
            // Файл — сверка по множеству id (дубли невозможны), БД — вся
            // выборка: upsert идемпотентен (как в export --repair / db --repair)
            forFile = messages.filter((m) => !fileIds.has(m.id));
            forDb = messages;
          } else {
            ({ forFile, forDb } = partitionByCheckpoints(
              messages,
              cpExport,
              cpDb
            ));
          }
        } catch (err) {
          errors++;
          logError(`[${channelConfig.title}]`, err);
          errOut(`! ${channelConfig.title}: ${err.message}`);
          continue;
        }

        // --- Файловая часть: свой try/catch, свой чекпоинт ---
        let filePart;
        let fileN = -1; // -1 = часть не выполнена (ошибка)
        try {
          if (repair) {
            for (const msg of forFile) {
              content += formatMessageToMarkdown(
                msg,
                channelConfig.title,
                channelConfig.id
              );
            }
            if (forFile.length > 0) {
              // Порядок записи как в одиночных режимах: сначала артефакт,
              // потом state-запись режима export
              fs.writeFileSync(filePath, content, "utf-8");
            }
            // state-запись = вершина файла (и при доливке, и без неё —
            // repair выравнивает отставшую запись с артефактом)
            const fileTop = maxMessageIdInText(content);
            if (fileTop > 0) {
              saveStateEntry("export", channelConfig.id, {
                title: channelConfig.title,
                lastMessageId: fileTop,
                lastMessageUrl: messageUrl(channelConfig.id, fileTop),
              });
            }
            fileN = forFile.length;
            if (fileN > 0) {
              addedFile += fileN;
              logInfo(
                `канал «${channelConfig.title}» (full): в файл дописано ${fileN} пропусков, вершина #${fileTop}`
              );
            }
            filePart =
              fileN > 0
                ? `файл +${fileN} пропусков → ${filePath} (#${fileTop})`
                : `файл: пропусков нет (#${fileTop})`;
          } else if (forFile.length > 0) {
            for (const msg of forFile) {
              content += formatMessageToMarkdown(
                msg,
                channelConfig.title,
                channelConfig.id
              );
            }
            // Сначала файл, потом его чекпоинт (правило max лечит обрыв)
            fs.writeFileSync(filePath, content, "utf-8");
            const maxFileId = Math.max(...forFile.map((m) => m.id));
            saveStateEntry("export", channelConfig.id, {
              title: channelConfig.title,
              lastMessageId: maxFileId,
              lastMessageUrl: messageUrl(channelConfig.id, maxFileId),
            });
            fileN = forFile.length;
            addedFile += fileN;
            filePart = `файл +${fileN} → ${filePath} (#${maxFileId})`;
            logInfo(
              `канал «${channelConfig.title}» (full): в файл дописано ${fileN}, вершина #${maxFileId}`
            );
          } else {
            fileN = 0;
            filePart = `файл: нет новых`;
          }
        } catch (err) {
          errors++;
          logError(`[${channelConfig.title} / файл]`, err);
          errOut(`! ${channelConfig.title} (файл): ${err.message}`);
          filePart = `файл: ошибка`;
        }

        // --- db-часть: свой try/catch, свой чекпоинт ---
        let dbPart;
        let dbN = -1; // -1 = часть не выполнена (ошибка)
        try {
          if (forDb.length > 0) {
            const rows = forDb.map((m) =>
              buildRow(
                channelConfig.id,
                channelConfig.title,
                m,
                messageUrl(channelConfig.id, m.id)
              )
            );
            await db.upsertMessages(rows);

            // Чекпоинт режима db — только после успешного upsert
            const maxDbId = Math.max(...forDb.map((m) => m.id));
            saveStateEntry("db", channelConfig.id, {
              title: channelConfig.title,
              lastMessageId: maxDbId,
              lastMessageUrl: messageUrl(channelConfig.id, maxDbId),
            });
            dbN = rows.length;
            addedDb += dbN;
            logInfo(
              repair
                ? `канал «${channelConfig.title}» (full): полная сверка, строк ${dbN}, вставлено в MySQL ${dbN}`
                : `канал «${channelConfig.title}» (full): новых сообщений ${dbN}, вставлено в MySQL ${dbN}`
            );
            dbPart = repair
              ? `MySQL: сверка → ${dbN} строк (#${maxDbId})`
              : `MySQL +${dbN} (#${maxDbId})`;
          } else {
            dbN = 0;
            dbPart = repair
              ? `MySQL: сообщений с startDate нет`
              : `MySQL: нет новых`;
          }
        } catch (err) {
          errors++;
          logError(`[${channelConfig.title} / БД]`, err);
          errOut(`! ${channelConfig.title} (БД): ${err.message}`);
          dbPart = `БД: ошибка`;
        }

        // --- Итоговая строка канала: одна, с двумя частями ---
        if (fileN < 0 && dbN < 0) {
          // Обе части упали — строки ошибок уже напечатаны, без строки прогресса
        } else if (!repair && fileN === 0 && dbN === 0) {
          out(`${channelConfig.title}: нет новых`);
        } else {
          out(`${channelConfig.title}: ${filePart} | ${dbPart}`);
        }
      }
    } finally {
      await safeDisconnect(client);
    }
  } finally {
    await db.close().catch(() => {});
  }

  const sec = ((Date.now() - started) / 1000).toFixed(1);
  out(
    `Готово: ${channels.length} каналов, +${addedFile} в файлы, +${addedDb} в MySQL` +
      (errors ? `, ошибок: ${errors}` : "") +
      (repair ? " (полная сверка)" : "") +
      ` за ${sec} с`
  );

  // Ошибки любой части (подготовки, файловой или db) → ненулевой код выхода
  // (plan 7, § 6): незавершённый канал виден скрипту/cron по exit-коду.
  // Вывод дожидаемся доставки — как в main().
  if (errors > 0) {
    await flushStdio();
    process.exit(1);
  }
}

// Подкоманда send — отправка сообщения и/или файла в чат (1.4, 1.5)
async function runSend(values) {
  const config = loadConfig(values.config);
  initLogger(config);

  // Валидация параметров ДО авторизации — не логинимся при ошибке
  const problem = validateSend(values, config);
  if (problem) throw new CliError(problem);

  const chat = values.chat || config.send.defaultChat;
  const text = readMessageText(values);

  const client = await authorize(config);
  try {
    const sent = await sendToChat(client, {
      chat,
      text,
      file: values.file,
      plain: values.plain,
    });
    out(`Отправлено: id ${sent.id}${sent.url ? ` (${sent.url})` : ""}`);
  } finally {
    await safeDisconnect(client);
  }
}

async function main() {
  const argv = process.argv.slice(2);

  // 1.6: запуск без параметров — приветствие со списком параметров
  if (argv.length === 0) {
    console.log(buildHelp());
    return;
  }

  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (err) {
    fail(err);
  }

  if (parsed.values.help) {
    console.log(buildHelp());
    return;
  }

  switch (parsed.command) {
    case "help":
      console.log(buildHelp());
      break;
    case "export":
      await runExport(parsed.values);
      break;
    case "db":
      await runDb(parsed.values);
      break;
    case "full":
      await runFull(parsed.values);
      break;
    case "send":
      await runSend(parsed.values);
      break;
    default:
      throw new CliError(`неизвестная подкоманда: ${parsed.command}`);
  }

  // Успешное завершение. Выходим принудительно: после sendFile у gramjs
  // остаётся неснятый таймер отпускания exported sender'а
  // (EXPORTED_SENDER_RELEASE_TIMEOUT, 30 с), который держит процесс живым.
  // Весь вывод к этому моменту уже сделан — дожидаемся его доставки.
  await flushStdio();
  process.exit(0);
}

main().catch((err) => {
  if (err instanceof CliError) {
    fail(err);
  }
  // Стек (с путями и упоминаниями node) — только в лог-файл;
  // в консоль — сам текст ошибки без стектрейса.
  logError(err);
  errOut(`Критическая ошибка: ${err.message}`);
  process.exit(1);
});
