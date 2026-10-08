// Юнит-проверки чекпоинтов (lib/state.js) — чистые функции + fs во
// временном каталоге, без сети и без Telegram/MySQL.
// Запуск: npm test
import fs from "fs";
import os from "os";
import path from "path";
import {
  loadState,
  saveStateEntry,
  backfillStateTitles,
  maxMessageIdInText,
  messageIdsInText,
  readFileMaxMessageId,
  effectiveExportCheckpoint,
  effectiveDbCheckpoint,
  partitionByCheckpoints,
} from "./lib/state.js";
import { CliError } from "./lib/cli.js";

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) console.log(`     ожидалось: ${JSON.stringify(expected)}\n     получено:  ${JSON.stringify(actual)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "getmes-tg-state-"));

try {
  // 1. maxMessageIdInText: заголовки «## Сообщение #N» → максимум
  check("maxMessageIdInText: пустой текст", maxMessageIdInText(""), 0);
  check("maxMessageIdInText: только шапка файла", maxMessageIdInText("# Канал\n\n> Канал: @x\n\n---\n"), 0);
  check(
    "maxMessageIdInText: максимум из нескольких заголовков",
    maxMessageIdInText("## Сообщение #29381\n\nтекст\n\n---\n\n## Сообщение #29400\n\n## Сообщение #29399\n"),
    29400
  );
  check(
    "maxMessageIdInText: id не по порядку берётся максимум",
    maxMessageIdInText("## Сообщение #10\n## Сообщение #999\n## Сообщение #2\n"),
    999
  );
  check(
    "maxMessageIdInText: нечисловые заголовки игнорируются",
    maxMessageIdInText("## Сообщение #abc\n## Сообщение #\n## Сообщение #12x\n"),
    0
  );
  check(
    "maxMessageIdInText: хвост после id не совпадает",
    maxMessageIdInText("## Сообщение #555 хвост\n"),
    0
  );

  // 2. readFileMaxMessageId: отсутствующий файл → 0, кириллическое имя
  const mdDir = fs.mkdtempSync(path.join(os.tmpdir(), "getmes-tg-md-"));
  const mdPath = path.join(mdDir, "Интерфакс.md");
  check("readFileMaxMessageId: файла нет → 0", readFileMaxMessageId(mdPath), 0);
  fs.writeFileSync(mdPath, "# Интерфакс\n\n---\n\n## Сообщение #79621\n\ntext\n", "utf-8");
  check("readFileMaxMessageId: файл с сообщением → его id", readFileMaxMessageId(mdPath), 79621);

  // 3. effectiveExportCheckpoint: max(state-запись, вершина файла)
  check("export: оба нуля → 0 (выгрузка с startDate)", effectiveExportCheckpoint(undefined, 0), 0);
  check("export: только запись", effectiveExportCheckpoint({ lastMessageId: 500 }, 0), 500);
  check("export: только файл", effectiveExportCheckpoint(undefined, 700), 700);
  check("export: оба → max", effectiveExportCheckpoint({ lastMessageId: 500 }, 700), 700);
  check("export: ручной «подъём» записи уважается", effectiveExportCheckpoint({ lastMessageId: 900 }, 700), 900);
  check("export: файл впереди записи (авария) → файл, без дублей", effectiveExportCheckpoint({ lastMessageId: 450 }, 600), 600);
  check("export: запись с lastMessageId: 0 → файл", effectiveExportCheckpoint({ lastMessageId: 0 }, 42), 42);
  check("export: запись без поля → файл", effectiveExportCheckpoint({}, 42), 42);

  // 4. effectiveDbCheckpoint: пустая БД → первичная заливка (undefined)
  check("db: пустая БД → первичная заливка", effectiveDbCheckpoint(0, undefined), undefined);
  check("db: пустая БД, запись игнорируется", effectiveDbCheckpoint(0, { lastMessageId: 600 }), undefined);
  check("db: только MAX(БД)", effectiveDbCheckpoint(800, undefined), 800);
  check("db: max(MAX(БД), запись)", effectiveDbCheckpoint(800, { lastMessageId: 1000 }), 1000);
  check("db: запись позади БД → БД", effectiveDbCheckpoint(800, { lastMessageId: 500 }), 800);
  check("db: миграция без записи → MAX(БД)", effectiveDbCheckpoint(12345, undefined), 12345);

  // 5. loadState: нет файла → {}; неизвестный режим → ошибка
  check("loadState: файла нет → {}", JSON.stringify(loadState("export", tmp)), "{}");
  check(
    "loadState: неизвестный режим → ошибка",
    (() => {
      try {
        loadState("nope", tmp);
        return "не бросил";
      } catch (e) {
        return e.message;
      }
    })(),
    "неизвестный режим state: nope"
  );

  // 6. saveStateEntry: создание каталога/файла, дописывание, перезапись
  saveStateEntry(
    "export",
    "-1001149896996",
    { title: "Интерфакс", lastMessageId: 79621, lastMessageUrl: "https://t.me/c/1149896996/79621" },
    tmp
  );
  check("state: каталог и файл созданы", fs.existsSync(path.join(tmp, "export.yaml")), true);
  check("state: .tmp не остался", fs.existsSync(path.join(tmp, "export.yaml.tmp")), false);

  const loaded = loadState("export", tmp);
  check("state: запись читается", loaded["-1001149896996"].lastMessageId, 79621);
  check("state: url сохранён", loaded["-1001149896996"].lastMessageUrl, "https://t.me/c/1149896996/79621");
  check("state: название канала сохранено", loaded["-1001149896996"].title, "Интерфакс");
  // title — первым полем записи (читаемость файла, PLAN/plan 6.md)
  const rawState = fs.readFileSync(path.join(tmp, "export.yaml"), "utf-8");
  check(
    "state: title первым полем записи",
    /^"-1001149896996":\n  title: Интерфакс\n  lastMessageId:/m.test(rawState),
    true
  );

  saveStateEntry("export", "-1001557052991", { lastMessageId: 29381 }, tmp);
  const two = loadState("export", tmp);
  check("state: вторая запись дописана", Object.keys(two).length, 2);
  check("state: первая запись не тронута", two["-1001149896996"].lastMessageId, 79621);

  saveStateEntry("export", "-1001149896996", { lastMessageId: 80000 }, tmp);
  const upd = loadState("export", tmp);
  check("state: перезапись своей записи", upd["-1001149896996"].lastMessageId, 80000);
  check("state: чужая запись не тронута", upd["-1001557052991"].lastMessageId, 29381);
  check("state: title пережил перезапись без title", upd["-1001149896996"].title, "Интерфакс");

  // 7. Изоляция режимов: запись export не появляется в db и наоборот
  check("изоляция: в db нет записи export", loadState("db", tmp)["-1001149896996"], undefined);
  saveStateEntry("db", "-1001149896996", { lastMessageId: 555 }, tmp);
  check("изоляция: db получил свою запись", loadState("db", tmp)["-1001149896996"].lastMessageId, 555);
  check("изоляция: export не изменился", loadState("export", tmp)["-1001149896996"].lastMessageId, 80000);

  // 8. Пустой файл → {} (нет записи, но и нет ошибки)
  const emptyDir = path.join(tmp, "empty");
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.writeFileSync(path.join(emptyDir, "export.yaml"), "", "utf-8");
  check("пустой файл → {}", JSON.stringify(loadState("export", emptyDir)), "{}");

  // 9. Битый YAML → CliError с путём и инструкцией по восстановлению
  const badDir = path.join(tmp, "bad");
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, "export.yaml"), "ключ: [битый\n", "utf-8");
  let badErr = null;
  try {
    loadState("export", badDir);
  } catch (err) {
    badErr = err;
  }
  check("битый YAML → экземпляр CliError", badErr instanceof CliError, true);
  check(
    "битый YAML → путь к файлу в сообщении",
    badErr !== null && badErr.message.includes(path.join(badDir, "export.yaml")),
    true
  );
  check(
    "битый YAML → подсказка про output/*.md",
    badErr !== null && badErr.message.includes("удалите его, чекпоинт будет восстановлен из output/*.md"),
    true
  );

  // 10. Необъектный документ → CliError
  fs.writeFileSync(path.join(badDir, "export.yaml"), "- первый\n- второй\n", "utf-8");
  let arrErr = null;
  try {
    loadState("export", badDir);
  } catch (err) {
    arrErr = err;
  }
  check("массив вместо карты → CliError", arrErr instanceof CliError, true);
  check("массив → текст про повреждение", arrErr !== null && arrErr.message.startsWith("файл чекпоинтов повреждён"), true);

  // 11. Подсказка для db отличается от подсказки для export
  fs.writeFileSync(path.join(badDir, "db.yaml"), "бито\n  - [;\n", "utf-8");
  let dbErr = null;
  try {
    loadState("db", badDir);
  } catch (err) {
    dbErr = err;
  }
  check(
    "битый db → подсказка про MAX(message_id)",
    dbErr !== null && dbErr.message.includes("MAX(message_id) в БД"),
    true
  );

  // 12. Миграционный сценарий: записи нет → решает артефакт
  check(
    "миграция export: файла нет, записи нет → 0",
    effectiveExportCheckpoint(undefined, maxMessageIdInText("")),
    0
  );
  check(
    "миграция export: файл есть, записи нет → вершина файла",
    effectiveExportCheckpoint(undefined, maxMessageIdInText("## Сообщение #100\n")),
    100
  );
  // 13. messageIdsInText: множество id из заголовков — сверка при --repair
  check("messageIdsInText: пустой текст → пустое множество", messageIdsInText("").size, 0);
  check("messageIdsInText: только шапка → пустое множество", messageIdsInText("# Канал\n\n> Канал: @x\n\n---\n").size, 0);
  const ids = messageIdsInText(
    "# Интерфакс\n\n---\n\n## Сообщение #79621\n\ntext\n\n---\n\n## Сообщение #79640\n\n## Сообщение #79621\n"
  );
  check("messageIdsInText: все id собраны", ids.size, 2);
  check("messageIdsInText: дубль заголовка → один id", ids.has(79621), true);
  check("messageIdsInText: второй id найден", ids.has(79640), true);
  check(
    "messageIdsInText: нечисловые заголовки игнорируются",
    messageIdsInText("## Сообщение #abc\n## Сообщение #\n## Сообщение #12x\n## Сообщение #555 хвост\n").size,
    0
  );
  check("messageIdsInText: null/undefined → пустое множество", messageIdsInText(null).size, 0);
  // 14. backfillStateTitles: проставление/обновление title для читаемости
  const channelsForTitles = [
    { id: "-1001557052991", title: "bitkogan" }, // запись без title → проставится
    { id: "-1001149896996", title: "Интерфакс (нов.)" }, // title изменился → обновится
    { id: "-1009999999999", title: "Нет такой" }, // записи нет → не создаётся
  ];
  check(
    "backfill: изменения есть → true",
    backfillStateTitles("export", channelsForTitles, tmp),
    true
  );
  const afterBackfill = loadState("export", tmp);
  check("backfill: отсутствующий title проставлен", afterBackfill["-1001557052991"].title, "bitkogan");
  check("backfill: изменившийся title обновлён", afterBackfill["-1001149896996"].title, "Интерфакс (нов.)");
  check("backfill: чекпоинт не тронут", afterBackfill["-1001149896996"].lastMessageId, 80000);
  check("backfill: запись неизвестного канала не создаётся", afterBackfill["-1009999999999"], undefined);
  check(
    "backfill: без изменений → false (файл не трогается)",
    backfillStateTitles("export", channelsForTitles, tmp),
    false
  );
  // 15. partitionByCheckpoints: разбивка общей выборки двух режимов (plan 7)
  const sample = [{ id: 10 }, { id: 20 }, { id: 30 }, { id: 40 }];
  const idsOf = (arr) => arr.map((m) => m.id).join(",");
  const part = (cpExport, cpDb) =>
    partitionByCheckpoints(sample, cpExport, cpDb);
  check(
    "partition: оба чекпоинта позади → вся выборка в обе части",
    `${idsOf(part(5, 5).forFile)}/${idsOf(part(5, 5).forDb)}`,
    "10,20,30,40/10,20,30,40"
  );
  check(
    "partition: оба чекпоинта впереди → обе части пусты",
    `${part(40, 40).forFile.length}/${part(40, 40).forDb.length}`,
    "0/0"
  );
  check(
    "partition: файл впереди, БД позади → файл пуст, БД догоняет",
    `${idsOf(part(40, 5).forFile)}/${idsOf(part(40, 5).forDb)}`,
    "/10,20,30,40"
  );
  check(
    "partition: БД впереди, файл позади → файл догоняет, БД пуста",
    `${idsOf(part(5, 40).forFile)}/${idsOf(part(5, 40).forDb)}`,
    "10,20,30,40/"
  );
  check(
    "partition: граница строгая (равный чекпоинт отсекается)",
    idsOf(partitionByCheckpoints([{ id: 10 }, { id: 11 }], 10, 10).forFile),
    "11"
  );
  check(
    "partition: cpDb = undefined (пустая БД) → первичная заливка всей выборки",
    idsOf(part(5, undefined).forDb),
    "10,20,30,40"
  );
  check(
    "partition: cpExport = 0 → файл получает всё с startDate",
    idsOf(part(0, 40).forFile),
    "10,20,30,40"
  );
  check(
    "partition: нечисловые чекпоинты → 0 (вся выборка)",
    idsOf(part("x", null).forFile),
    "10,20,30,40"
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\nПровалено: ${failed}` : "\nВсе проверки пройдены");
process.exit(failed ? 1 : 0);
