import fs from "fs";
import { loadConfig, messageUrl, resolveFetchConfig } from "./lib/config.js";
import { authorize } from "./lib/session.js";
import { fetchChannelMessages } from "./lib/fetch.js";
import { formatMessageToMarkdown } from "./lib/markdown.js";
import { parseCli, buildHelp, CliError, SELF } from "./lib/cli.js";
import { validateSend, readMessageText, sendToChat } from "./lib/send.js";
import { validateDbConfig, buildRow, openDb } from "./lib/db.js";
import { initLogger, logError, getLogger } from "./lib/logger.js";
import {
  saveStateEntry,
  loadChannelState,
  migrateLegacyState,
  normalizeModeState,
  maxMessageIdInText,
  messageIdsInText,
  effectiveExportCheckpoint,
  effectiveDbCheckpoint,
  partitionByCheckpoints,
} from "./lib/state.js";
import { createRateLimiter, runPool, sleep } from "./lib/concurrency.js";
import {
  readMarkdown,
  validateUniqueOutputPaths,
  writeMarkdownAtomic,
} from "./lib/artifacts.js";
import { createProgress } from "./lib/progress.js";

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

function uniqueChannels(channels) {
  const unique = [];
  const seen = new Map();
  for (const channel of channels || []) {
    const id = String(channel.id);
    const previous = seen.get(id);
    if (!previous) {
      seen.set(id, channel);
      unique.push(channel);
      continue;
    }
    if (previous.title !== channel.title || previous.startDate !== channel.startDate) {
      throw new CliError(`канал ${id} повторяется в конфиге с разными title/startDate`);
    }
  }
  return unique;
}

function stateEntry(channel, maxId) {
  return {
    title: channel.title,
    lastMessageId: maxId,
  };
}

function rowsFor(channel, messages) {
  return messages.map((message) =>
    buildRow(channel.id, channel.title, message, messageUrl(channel.id, message.id))
  );
}

async function openPreparedDb(config, channels) {
  const problem = validateDbConfig(config);
  if (problem) throw new CliError(problem);
  try {
    const db = await openDb(config);
    await db.init();
    if (typeof db.fillChannelTitle === "function") {
      for (const channel of channels) await db.fillChannelTitle(channel.id, channel.title);
    }
    return db;
  } catch (err) {
    throw new CliError(err.message);
  }
}

async function getMaxIds(db, channels) {
  if (typeof db.getMaxMessageIds === "function") {
    return db.getMaxMessageIds(channels.map((channel) => channel.id));
  }
  const entries = await Promise.all(
    channels.map(async (channel) => [String(channel.id), await db.getMaxMessageId(channel.id)])
  );
  return new Map(entries);
}

function fileCommit(channel, filePath, content, messages, repair) {
  let next = content;
  for (const message of messages) {
    next += formatMessageToMarkdown(message, channel.title, channel.id);
  }
  if (messages.length > 0) writeMarkdownAtomic(filePath, next);
  const top = maxMessageIdInText(next);
  if (repair && top > 0) saveStateEntry("export", channel.id, stateEntry(channel, top));
  if (!repair && messages.length > 0) {
    const maxId = Math.max(...messages.map((message) => message.id));
    saveStateEntry("export", channel.id, stateEntry(channel, maxId));
  }
  return { count: messages.length, top };
}

async function dbCommit(db, channel, messages, logger) {
  if (messages.length === 0) return { count: 0, top: 0 };
  const rows = rowsFor(channel, messages);
  await db.upsertMessages(rows, logger);
  const top = Math.max(...messages.map((message) => message.id));
  saveStateEntry("db", channel.id, stateEntry(channel, top));
  return { count: rows.length, top };
}

function printPoolResults(channels, settled, progress) {
  return settled.map((item, index) => {
    if (item?.status === "fulfilled") {
      const result = item.value;
      for (const error of result.errorLines || []) progress.error(error);
      if (result.line) progress.out(result.line);
      return result;
    }
    const err = item?.reason || new Error("задача не была запущена");
    const channel = channels[index];
    progress.channelError(channel.id);
    logError(`[${channel.title}]`, err);
    progress.error(`! ${channel.title}: ${err.message}`);
    return { errors: 1, addedFile: 0, addedDb: 0 };
  });
}

async function runExportLike(values, mode) {
  const config = loadConfig(values.config);
  const repair = Boolean(values.repair);
  const fetchConfig = resolveFetchConfig(config, { repair });
  initLogger(config);
  const allChannels = uniqueChannels(config.channels || []);
  const channels = filterChannels(allChannels, values.channel);
  const needsFile = mode !== "db";
  const needsDb = mode !== "export";
  if (needsDb) {
    const problem = validateDbConfig(config);
    if (problem) throw new CliError(problem);
  }
  const outputPaths = needsFile ? validateUniqueOutputPaths(channels, OUTPUT_DIR) : new Map();
  if (needsFile) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const stateMode of [needsFile && "export", needsDb && "db"].filter(Boolean)) {
    migrateLegacyState(stateMode, allChannels);
    const statePreparation = normalizeModeState(stateMode, allChannels);
    for (const orphan of statePreparation.orphans) {
      getLogger().warn(
        `state/${stateMode}: файл ${orphan.file} не соответствует каналу из конфигурации (ID: ${orphan.channelId}) и игнорируется`
      );
    }
    for (const failure of statePreparation.errors) {
      getLogger().warn(
        `state/${stateMode}: не удалось нормализовать ${failure.file}: ${failure.error.message}`
      );
    }
  }

  let db;
  let progress;
  let maxIds = new Map();
  if (needsDb) {
    db = await openPreparedDb(config, channels);
    maxIds = await getMaxIds(db, channels);
  }

  const started = Date.now();
  let client;
  try {
    progress = createProgress({
      mode: values.progress || "auto",
      runMode: mode,
      channels,
      concurrency: fetchConfig.concurrency,
      intervalMs: fetchConfig.progressIntervalMs,
    });
    client = await authorize(config);
    const limiter = createRateLimiter(fetchConfig.requestIntervalMs);
    let stopNewTasks = false;
    const settled = await runPool(channels, fetchConfig.concurrency, async (channel) => {
      const logger = getLogger().child({ mode, channelId: channel.id, channelTitle: channel.title });
      progress.channelStart(channel.id);
      try {
        progress.channelPhase(channel.id, "prepare");
        let content;
        let filePath;
        let cpExport = 0;
        let cpDb = 0;
        let exportState;
        let dbState;
        if (needsFile) {
          filePath = outputPaths.get(String(channel.id));
          content = readMarkdown(filePath, channel);
          exportState = loadChannelState("export", channel.id);
          if (exportState && exportState.title !== channel.title) {
            saveStateEntry("export", channel.id, { ...exportState, title: channel.title });
            exportState = { ...exportState, title: channel.title };
          }
          cpExport = repair ? 0 : effectiveExportCheckpoint(
            exportState,
            maxMessageIdInText(content)
          );
        }
        if (needsDb) {
          dbState = loadChannelState("db", channel.id);
          if (dbState && dbState.title !== channel.title) {
            saveStateEntry("db", channel.id, { ...dbState, title: channel.title });
            dbState = { ...dbState, title: channel.title };
          }
          cpDb = repair ? 0 : Number(effectiveDbCheckpoint(
            maxIds.get(String(channel.id)) || 0,
            dbState
          )) || 0;
        }
        const fetchFrom = repair
          ? 0
          : mode === "full"
            ? (cpExport > 0 && cpDb > 0 ? Math.min(cpExport, cpDb) : 0)
            : (needsFile ? cpExport : cpDb);
        logger.info("prepare", `чекпоинт файла #${cpExport}, БД #${cpDb}, fetch от #${fetchFrom}`);
        const messages = await fetchChannelMessages(
          client,
          { ...channel, lastMessageId: fetchFrom },
          {
            pageDelayMs: fetchConfig.pageDelayMs,
            limiter,
            request: (id, params) => {
              if (stopNewTasks) throw new Error("общая ошибка Telegram остановила новые запросы");
              return limiter.run(() => client.getMessages(id, params));
            },
            sleep,
            log: logger,
            progress: (event, details) => progress.fetchEvent(channel.id, event, details),
          }
        );

        let forFile = [];
        let forDb = [];
        if (mode === "full") {
          if (repair) {
            const ids = messageIdsInText(content);
            forFile = messages.filter((message) => !ids.has(message.id));
            forDb = messages;
          } else {
            ({ forFile, forDb } = partitionByCheckpoints(messages, cpExport, cpDb));
          }
        } else if (mode === "export") {
          forFile = repair
            ? messages.filter((message) => !messageIdsInText(content).has(message.id))
            : messages;
        } else {
          forDb = messages;
        }

        if (mode === "export") {
          progress.channelPhase(channel.id, "markdown", `${forFile.length} сообщ.`);
          const file = fileCommit(channel, filePath, content, forFile, repair);
          logger.info("file", `записано ${file.count}, вершина #${file.top}`);
          const result = {
            errors: 0,
            addedFile: file.count,
            addedDb: 0,
            line: repair
              ? `${channel.title}: ${file.count ? `+${file.count} пропусков → ${filePath}` : "пропусков нет"} (#${file.top})`
              : `${channel.title}: ${file.count ? `+${file.count} → ${filePath} (#${file.top})` : "нет новых"}`,
          };
          progress.channelComplete(channel.id);
          return result;
        }

        if (mode === "db") {
          progress.channelPhase(channel.id, "mysql", `${forDb.length} строк`);
          const saved = await dbCommit(db, channel, forDb, logger);
          if (saved.count === 0) logger.info("mysql", "новых строк нет");
          const result = {
            errors: 0,
            addedFile: 0,
            addedDb: saved.count,
            line: repair
              ? `${channel.title}: ${saved.count ? `сверка → ${saved.count} строк в MySQL (#${saved.top})` : "сообщений с startDate нет"}`
              : `${channel.title}: ${saved.count ? `+${saved.count} → MySQL (#${saved.top})` : "нет новых"}`,
          };
          progress.channelComplete(channel.id);
          return result;
        }

        progress.channelPhase(channel.id, "commit", `файл ${forFile.length}, MySQL ${forDb.length}`);
        const commits = await Promise.allSettled([
          Promise.resolve().then(() => fileCommit(channel, filePath, content, forFile, repair)),
          dbCommit(db, channel, forDb, logger),
        ]);
        const errorLines = [];
        let errors = 0;
        let filePart = "файл: ошибка";
        let dbPart = "БД: ошибка";
        let addedFile = 0;
        let addedDb = 0;
        if (commits[0].status === "fulfilled") {
          const value = commits[0].value;
          addedFile = value.count;
          filePart = repair
            ? (value.count ? `файл +${value.count} пропусков → ${filePath} (#${value.top})` : `файл: пропусков нет (#${value.top})`)
            : (value.count ? `файл +${value.count} → ${filePath} (#${value.top})` : "файл: нет новых");
          logger.info("file", `записано ${value.count}, вершина #${value.top}`);
        } else {
          errors++;
          logger.error("file", commits[0].reason);
          errorLines.push(`! ${channel.title} (файл): ${commits[0].reason.message}`);
        }
        if (commits[1].status === "fulfilled") {
          const value = commits[1].value;
          addedDb = value.count;
          dbPart = repair
            ? (value.count ? `MySQL: сверка → ${value.count} строк (#${value.top})` : "MySQL: сообщений с startDate нет")
            : (value.count ? `MySQL +${value.count} (#${value.top})` : "MySQL: нет новых");
          if (value.count === 0) logger.info("mysql", "новых строк нет");
        } else {
          errors++;
          logger.error("mysql", commits[1].reason);
          errorLines.push(`! ${channel.title} (БД): ${commits[1].reason.message}`);
        }
        const result = {
          errors,
          addedFile,
          addedDb,
          errorLines,
          line: !repair && addedFile === 0 && addedDb === 0 && errors === 0
            ? `${channel.title}: нет новых`
            : `${channel.title}: ${filePart} | ${dbPart}`,
        };
        progress.channelComplete(channel.id, { failed: errors > 0 });
        return result;
      } catch (err) {
        const message = String(err?.errorMessage || err?.message || err);
        if (/AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED|PEER_FLOOD/i.test(message)) {
          stopNewTasks = true;
        }
        logger.error("result", err);
        progress.channelError(channel.id);
        throw err;
      }
    }, { shouldStop: () => stopNewTasks });
    const results = printPoolResults(channels, settled, progress);
    const totals = results.reduce((sum, result) => ({
      errors: sum.errors + (result.errors || 0),
      addedFile: sum.addedFile + (result.addedFile || 0),
      addedDb: sum.addedDb + (result.addedDb || 0),
    }), { errors: 0, addedFile: 0, addedDb: 0 });
    const sec = ((Date.now() - started) / 1000).toFixed(1);
    progress.stop();
    if (mode === "export") {
      out(`Готово: ${channels.length} каналов, +${totals.addedFile} сообщений${totals.errors ? `, ошибок: ${totals.errors}` : ""}${repair ? " (полная сверка)" : ""} за ${sec} с`);
    } else if (mode === "db") {
      out(`Готово: ${channels.length} каналов, +${totals.addedDb} сообщений в MySQL${totals.errors ? `, ошибок: ${totals.errors}` : ""}${repair ? " (полная сверка)" : ""} за ${sec} с`);
    } else {
      out(`Готово: ${channels.length} каналов, +${totals.addedFile} в файлы, +${totals.addedDb} в MySQL${totals.errors ? `, ошибок: ${totals.errors}` : ""}${repair ? " (полная сверка)" : ""} за ${sec} с`);
      if (totals.errors > 0) {
        // main() после возврата принудительно ставит exit 0, поэтому ошибочный
        // full завершает процесс здесь. Ресурсы закрываем явно до process.exit;
        // finally ниже увидит null и не выполнит закрытие повторно.
        await safeDisconnect(client);
        client = null;
        await db.close().catch(() => {});
        db = null;
        await flushStdio();
        process.exit(1);
      }
    }
  } finally {
    if (progress) progress.stop();
    if (client) await safeDisconnect(client);
    if (db) await db.close().catch(() => {});
  }
}

const runExport = (values) => runExportLike(values, "export");
const runDb = (values) => runExportLike(values, "db");
const runFull = (values) => runExportLike(values, "full");

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
