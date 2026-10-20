// Юнит-проверки чекпоинтов (lib/state.js) — чистые функции + fs во
// временном каталоге, без сети и без Telegram/MySQL.
// Запуск: npm test
import fs from "fs";
import os from "os";
import path from "path";
import {
  encodeChannelId,
  resolveChannelStatePath,
  loadChannelState,
  loadModeState,
  loadState,
  saveStateEntry,
  backfillStateTitles,
  migrateLegacyState,
  normalizeModeState,
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
  check("encode: числовой id читаем", encodeChannelId("-100123"), "-100123");
  check("encode: username экранирован", encodeChannelId("@public/name"), "%40public%2Fname");
  check("path: traversal не создаёт подкаталог", path.basename(resolveChannelStatePath("export", "../x", tmp)), "..%2Fx.yaml");
  check("неизвестный режим → ошибка", (() => { try { loadState("nope", tmp); return ""; } catch (err) { return err.message; } })(), "неизвестный режим state: nope");
  check("нет файла канала → undefined", loadChannelState("export", "x", tmp), undefined);
  check("нет каталога режима → {}", JSON.stringify(loadState("export", tmp)), "{}");

  saveStateEntry("export", "-1001", { channelId: "чужой", title: "Первый", lastMessageId: 10, lastMessageUrl: "u10", extra: true }, tmp);
  const firstPath = resolveChannelStatePath("export", "-1001", tmp);
  check("создан отдельный файл канала", fs.existsSync(firstPath), true);
  check("уникальный tmp не остался", fs.readdirSync(path.dirname(firstPath)).some((n) => n.includes(".tmp-")), false);
  check("state содержит только два поля", Object.keys(loadChannelState("export", "-1001", tmp)).join(","), "title,lastMessageId");
  check("title сохранён", loadChannelState("export", "-1001", tmp).title, "Первый");
  check("id сохранён", loadChannelState("export", "-1001", tmp).lastMessageId, 10);
  const raw = fs.readFileSync(firstPath, "utf-8");
  check("канонический YAML: title затем lastMessageId", raw, "title: Первый\nlastMessageId: 10\n");
  check("производные и неизвестные поля не записаны", /channelId|lastMessageUrl|extra/.test(raw), false);

  saveStateEntry("export", "-1002", { title: "Второй", lastMessageId: 20 }, tmp);
  saveStateEntry("db", "-1001", { title: "Первый", lastMessageId: 7 }, tmp);
  check("два канала — два файла", fs.readdirSync(path.join(tmp, "export")).filter((n) => n.endsWith(".yaml")).length, 2);
  check("запись второго не меняет первый", loadChannelState("export", "-1001", tmp).lastMessageId, 10);
  check("режимы изолированы", loadChannelState("db", "-1001", tmp).lastMessageId, 7);
  check("loadModeState читает выбранные каналы", Object.keys(loadModeState("export", [{ id: "-1002" }], tmp)).join(","), "-1002");
  check("loadState собирает карту режима", Object.keys(loadState("export", tmp)).sort().join(","), "-1001,-1002");

  saveStateEntry("export", "-1001", { lastMessageId: 11 }, tmp);
  check("title переживает обновление без title", loadChannelState("export", "-1001", tmp).title, "Первый");
  check("обновляется только свой checkpoint", loadChannelState("export", "-1001", tmp).lastMessageId, 11);
  check("чужой checkpoint не изменён", loadChannelState("export", "-1002", tmp).lastMessageId, 20);
  check("backfill меняет title", backfillStateTitles("export", [{ id: "-1001", title: "Первый новый" }], tmp), true);
  check("backfill записал title", loadChannelState("export", "-1001", tmp).title, "Первый новый");
  check("backfill без изменений", backfillStateTitles("export", [{ id: "-1001", title: "Первый новый" }], tmp), false);

  const badPath = resolveChannelStatePath("export", "bad", tmp);
  fs.writeFileSync(badPath, "x: [\n", "utf-8");
  let bad;
  try { loadChannelState("export", "bad", tmp); } catch (err) { bad = err; }
  check("битый файл одного канала → CliError", bad instanceof CliError, true);
  check("ошибка содержит конкретный путь", bad?.message.includes(badPath), true);
  check("ошибка содержит подсказку артефакта", bad?.message.includes("output/*.md"), true);
  fs.rmSync(badPath);
  fs.writeFileSync(badPath, "channelId: other\ntitle: Старый формат\nlastMessageId: 1\nlastMessageUrl: old\n", "utf-8");
  check("старый расширенный формат читается", loadChannelState("export", "bad", tmp).lastMessageId, 1);

  const oldFormatPath = resolveChannelStatePath("export", "old", tmp);
  fs.writeFileSync(oldFormatPath, "channelId: old\ntitle: Старое название\nlastMessageId: 33\nlastMessageUrl: old-url\nextra: value\n", "utf-8");
  const canonicalPath = resolveChannelStatePath("export", "canonical", tmp);
  fs.writeFileSync(canonicalPath, "title: Канонический\nlastMessageId: 44\n", "utf-8");
  const canonicalMtime = fs.statSync(canonicalPath).mtimeMs;
  const orphanPath = resolveChannelStatePath("export", "orphan", tmp);
  fs.writeFileSync(orphanPath, "title: Сирота\nlastMessageId: 55\n", "utf-8");
  fs.writeFileSync(path.join(tmp, "export", "note.txt"), "не state", "utf-8");
  fs.writeFileSync(path.join(tmp, "export", "ignored.yaml.tmp-1"), "x", "utf-8");
  const normalized = normalizeModeState("export", [
    { id: "-1001", title: "Первый новый" },
    { id: "-1002", title: "Второй" },
    { id: "bad", title: "Актуальное название" },
    { id: "old", title: "Новое название" },
    { id: "canonical", title: "Канонический" },
  ], tmp);
  check("нормализация удаляет старые поля", fs.readFileSync(oldFormatPath, "utf-8"), "title: Новое название\nlastMessageId: 33\n");
  check("нормализация сохраняет checkpoint", loadChannelState("export", "old", tmp).lastMessageId, 33);
  check("нормализация актуализирует title", loadChannelState("export", "bad", tmp).title, "Актуальное название");
  check("канонический файл не переписан", fs.statSync(canonicalPath).mtimeMs, canonicalMtime);
  check("orphan обнаружен", normalized.orphans.some((item) => item.channelId === "orphan"), true);
  check("настроенный невыбранный канал не orphan", normalized.orphans.some((item) => item.channelId === "-1002"), false);
  check("orphan не удалён", fs.existsSync(orphanPath), true);
  check("не-state файлы игнорируются", normalized.orphans.some((item) => item.channelId === "note"), false);
  check("повторная нормализация идемпотентна", normalizeModeState("export", [
    { id: "-1001", title: "Первый новый" },
    { id: "-1002", title: "Второй" },
    { id: "bad", title: "Актуальное название" },
    { id: "old", title: "Новое название" },
    { id: "canonical", title: "Канонический" },
  ], tmp).normalized.length, 0);

  const migration = path.join(tmp, "migration");
  fs.mkdirSync(migration, { recursive: true });
  fs.writeFileSync(path.join(migration, "export.yaml"), '"-1001":\n  title: Старый\n  lastMessageId: 50\n  lastMessageUrl: old50\n"@name":\n  title: Public\n  lastMessageId: 30\n', "utf-8");
  saveStateEntry("export", "-1001", { title: "Новый", lastMessageId: 70, lastMessageUrl: "new70" }, migration);
  check("legacy migration выполнена", migrateLegacyState("export", [{ id: "-1001", title: "Актуальный" }, { id: "@name", title: "Public new" }], migration), true);
  check("migration не понижает новый state", loadChannelState("export", "-1001", migration).lastMessageId, 70);
  check("migration предпочитает актуальный title", loadChannelState("export", "-1001", migration).title, "Актуальный");
  check("migration переносит второй канал", loadChannelState("export", "@name", migration).lastMessageId, 30);
  check("migration создаёт сокращённый формат", fs.readFileSync(resolveChannelStatePath("export", "@name", migration), "utf-8"), "title: Public new\nlastMessageId: 30\n");
  check("legacy перемещён в архив", fs.existsSync(path.join(migration, "legacy", "export.yaml.migrated")), true);
  check("legacy-архив сохранил старое поле", fs.readFileSync(path.join(migration, "legacy", "export.yaml.migrated"), "utf-8").includes("lastMessageUrl: old50"), true);
  check("исходный legacy удалён после проверки", fs.existsSync(path.join(migration, "export.yaml")), false);
  check("повтор без legacy ничего не делает", migrateLegacyState("export", [], migration), false);
  const archiveBefore = fs.readFileSync(path.join(migration, "legacy", "export.yaml.migrated"), "utf-8");
  fs.writeFileSync(path.join(migration, "export.yaml"), '"-1001":\n  title: Повторный legacy\n  lastMessageId: 80\n', "utf-8");
  check("повторный legacy мигрирован", migrateLegacyState("export", [{ id: "-1001", title: "Актуальный" }], migration), true);
  check("повторный legacy поднял checkpoint", loadChannelState("export", "-1001", migration).lastMessageId, 80);
  check("существующий legacy-архив не переписан", fs.readFileSync(path.join(migration, "legacy", "export.yaml.migrated"), "utf-8"), archiveBefore);

  check("max: пусто", maxMessageIdInText(""), 0);
  check("max: максимум заголовков", maxMessageIdInText("## Сообщение #10\n## Сообщение #99\n## Сообщение #2\n"), 99);
  check("max: хвост не совпадает", maxMessageIdInText("## Сообщение #55 хвост\n"), 0);
  const md = path.join(tmp, "Канал.md");
  check("read max: файла нет", readFileMaxMessageId(md), 0);
  fs.writeFileSync(md, "## Сообщение #42\n", "utf-8");
  check("read max: файл", readFileMaxMessageId(md), 42);
  const ids = messageIdsInText("## Сообщение #10\n## Сообщение #20\n## Сообщение #10\n");
  check("messageIds: множество без дублей", ids.size, 2);
  check("messageIds: содержит id", ids.has(20), true);

  check("export checkpoint: оба нуля", effectiveExportCheckpoint(undefined, 0), 0);
  check("export checkpoint: state впереди", effectiveExportCheckpoint({ lastMessageId: 20 }, 10), 20);
  check("export checkpoint: файл впереди", effectiveExportCheckpoint({ lastMessageId: 10 }, 20), 20);
  check("db checkpoint: пустая БД игнорирует state", effectiveDbCheckpoint(0, { lastMessageId: 20 }), undefined);
  check("db checkpoint: БД впереди", effectiveDbCheckpoint(30, { lastMessageId: 20 }), 30);
  check("db checkpoint: state впереди", effectiveDbCheckpoint(30, { lastMessageId: 40 }), 40);
  check("удалённый export state восстанавливается из Markdown", effectiveExportCheckpoint(undefined, 42), 42);
  check("удалённый db state восстанавливается из БД", effectiveDbCheckpoint(42, undefined), 42);

  const sample = [{ id: 10 }, { id: 20 }, { id: 30 }];
  const part = partitionByCheckpoints(sample, 20, 10);
  check("partition: файл", part.forFile.map((m) => m.id).join(","), "30");
  check("partition: БД", part.forDb.map((m) => m.id).join(","), "20,30");
  check("partition: нулевой получает всё", partitionByCheckpoints(sample, 0, 30).forFile.length, 3);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\nПровалено: ${failed}` : "\nВсе проверки пройдены");
process.exit(failed ? 1 : 0);
