// Независимые чекпоинты подкоманд (PLAN/plan 6.md, вариант Б).
// Каждый режим хранит свой прогресс в своём файле:
//   state/export.yaml — файловая выгрузка (output/*.md)
//   state/db.yaml     — выгрузка в MySQL
// Благодаря этому режимы не влияют друг на друга, одновременный запуск
// export и db безопасен (каждый пишет только свой файл), а config.yaml
// остаётся строго читаемым (в нём живут только секреты и список каналов).
import fs from "fs";
import path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CliError } from "./cli.js";

const STATE_DIR = "./state";

const MODE_FILES = {
  export: "export.yaml",
  db: "db.yaml",
};

// Подсказка для сообщения о повреждённом файле: откуда чекпоинт
// восстановится после удаления файла.
const MODE_HINTS = {
  export: "output/*.md",
  db: "MAX(message_id) в БД",
};

function resolveStatePath(mode, dir = STATE_DIR) {
  const file = MODE_FILES[mode];
  if (!file) throw new Error(`неизвестный режим state: ${mode}`);
  return path.join(dir, file);
}

// Чтение состояния режима. Нет файла → {} (миграция: чекпоинт будет
// выведен из артефакта). Битый файл → CliError с инструкцией: молчаливое
// превращение в {} дало бы незаметную повторную выгрузку/залитую.
export function loadState(mode, dir = STATE_DIR) {
  const file = resolveStatePath(mode, dir);

  if (!fs.existsSync(file)) return {};

  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new CliError(
      `не удалось прочитать файл чекпоинтов ${file}: ${err.message} — удалите его, чекпоинт будет восстановлен из ${MODE_HINTS[mode]}`
    );
  }

  if (!raw.trim()) return {};

  let data;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new CliError(
      `файл чекпоинтов повреждён: ${file} (${err.message}) — удалите его, чекпоинт будет восстановлен из ${MODE_HINTS[mode]}`
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new CliError(
      `файл чекпоинтов повреждён: ${file} (пустой или необъектный документ) — удалите его, чекпоинт будет восстановлен из ${MODE_HINTS[mode]}`
    );
  }
  return data;
}

// Запись чекпоинта канала: read-modify-write + атомарная публикация
// (tmp + rename), чтобы обрыв посреди записи не оставил битый файл.
// В запись входит title (название канала, первым полем) — только для
// читаемости файла, на логику чекпоинтов не влияет.
export function saveStateEntry(mode, channelId, entry, dir = STATE_DIR) {
  const state = loadState(mode, dir);
  const key = String(channelId);
  const next = { ...entry };
  // title сохраняется, даже если в новой записи его забыли передать
  const prev = state[key];
  if (!next.title && prev && typeof prev === "object" && prev.title) {
    next.title = prev.title;
  }
  state[key] = normalizeEntry(next);
  writeState(mode, state, dir);
}

// Порядок полей записи: title → остальное (lastMessageId, lastMessageUrl…)
function normalizeEntry(entry) {
  const out = {};
  if (entry && entry.title) out.title = entry.title;
  for (const [key, value] of Object.entries(entry || {})) {
    if (key !== "title") out[key] = value;
  }
  return out;
}

function writeState(mode, state, dir) {
  const file = resolveStatePath(mode, dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(
    tmp,
    stringifyYaml(state, { indent: 2, lineWidth: 0 }),
    "utf-8"
  );
  fs.renameSync(tmp, file);
}

// Доводка записей при старте режима: во всех записях каналов из конфига
// стоит актуальное title (для читаемости state-файла). Проставляет
// отсутствующие и обновляет изменившиеся (переименование канала);
// если менять нечего — файл не трогается. Возвращает true при изменении.
export function backfillStateTitles(mode, channels, dir = STATE_DIR) {
  const state = loadState(mode, dir);
  let changed = false;
  for (const channel of channels || []) {
    const entry = state[String(channel.id)];
    if (!entry || typeof entry !== "object" || !channel.title) continue;
    if (entry.title !== channel.title) {
      state[String(channel.id)] = normalizeEntry({ ...entry, title: channel.title });
      changed = true;
    }
  }
  if (changed) writeState(mode, state, dir);
  return changed;
}

// Максимальный id среди заголовков «## Сообщение #N» — ровно тот формат,
// который пишет formatMessageToMarkdown (lib/markdown.js).
export function maxMessageIdInText(text) {
  let max = 0;
  if (!text) return max;
  for (const m of text.matchAll(/^## Сообщение #(\d+)$/gm)) {
    const id = Number(m[1]);
    if (Number.isInteger(id) && id > max) max = id;
  }
  return max;
}

// Вершина файла выгрузки (0 — файла нет или в нём только шапка).
export function readFileMaxMessageId(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return maxMessageIdInText(fs.readFileSync(filePath, "utf-8"));
}

// Все id сообщений файла (множество) — сверка при --repair: в файл
// дописываются только id, которых там нет, дубли невозможны.
export function messageIdsInText(text) {
  const ids = new Set();
  if (!text) return ids;
  for (const m of text.matchAll(/^## Сообщение #(\d+)$/gm)) {
    const id = Number(m[1]);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

// Разбивка общей выборки на части двух режимов (plan 7): каждая часть —
// только сообщения строго новее чекпоинта СВОЕГО режима. Правило
// max(state, артефакт) гарантирует, что в файле лежат id <= cpExport, а фильтр
// по cpDb сохраняет семантику ручного «подъёма» чекпоинта (пропуск истории).
// 0 / undefined чекпоинта → пустая часть получает всю выборку (первичная
// заливка или выгрузка файла с startDate).
export function partitionByCheckpoints(messages, cpExport, cpDb) {
  const fileCp = Number(cpExport) || 0;
  const dbCp = Number(cpDb) || 0;
  return {
    forFile: messages.filter((m) => m.id > fileCp),
    forDb: messages.filter((m) => m.id > dbCp),
  };
}

// Правило чекпоинта export: max(state-запись, вершина файла).
// - запись впереди файла (ручной «подъём», пропуск истории) — уважается;
// - файл впереди записи (авария между записью файла и state) — берём файл:
//   следующий запуск продолжит с его вершины и не создаст дублей;
// - оба нуля → 0 → выгрузка с startDate.
export function effectiveExportCheckpoint(entry, fileMax = 0) {
  const fromState = entry && entry.lastMessageId ? Number(entry.lastMessageId) : 0;
  const fromFile = fileMax ? Number(fileMax) : 0;
  return Math.max(fromState, fromFile);
}

// Правило чекпоинта db: пустая БД → первичная заливка с startDate
// (undefined, state-запись не участвует); иначе max(MAX(БД), state-запись) —
// если записи нет (миграция), чекпоинтом становится MAX(БД).
export function effectiveDbCheckpoint(maxInDb, entry) {
  const db = Number(maxInDb) || 0;
  if (db <= 0) return undefined;
  const fromState = entry && entry.lastMessageId ? Number(entry.lastMessageId) : 0;
  return Math.max(db, fromState);
}
