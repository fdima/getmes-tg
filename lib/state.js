// Независимые чекпоинты режимов и каналов (PLAN/plan 8):
//   state/export/<encoded-channel-id>.yaml
//   state/db/<encoded-channel-id>.yaml
import fs from "fs";
import path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CliError } from "./cli.js";

const STATE_DIR = "./state";
const MODES = new Set(["export", "db"]);
const MODE_HINTS = { export: "output/*.md", db: "MAX(message_id) в БД" };

function assertMode(mode) {
  if (!MODES.has(mode)) throw new Error(`неизвестный режим state: ${mode}`);
}

export function encodeChannelId(channelId) {
  return encodeURIComponent(String(channelId));
}

export function resolveChannelStatePath(mode, channelId, dir = STATE_DIR) {
  assertMode(mode);
  return path.join(dir, mode, `${encodeChannelId(channelId)}.yaml`);
}

function readYamlObject(file, mode) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new CliError(
      `не удалось прочитать файл чекпоинта ${file}: ${err.message} — удалите его, чекпоинт будет восстановлен из ${MODE_HINTS[mode]}`
    );
  }
  if (!raw.trim()) return {};
  let data;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new CliError(
      `файл чекпоинта повреждён: ${file} (${err.message}) — удалите его, чекпоинт будет восстановлен из ${MODE_HINTS[mode]}`
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new CliError(
      `файл чекпоинта повреждён: ${file} (пустой или необъектный документ) — удалите его, чекпоинт будет восстановлен из ${MODE_HINTS[mode]}`
    );
  }
  return data;
}

function normalizeEntry(entry, title) {
  const out = {};
  const actualTitle = title ?? entry?.title;
  if (actualTitle !== undefined) {
    if (typeof actualTitle !== "string") {
      throw new CliError("поле title должно быть строкой");
    }
    out.title = actualTitle;
  }
  if (entry?.lastMessageId !== undefined) {
    const lastMessageId = Number(entry.lastMessageId);
    if (!Number.isInteger(lastMessageId) || lastMessageId < 0) {
      throw new CliError("поле lastMessageId должно быть целым неотрицательным числом");
    }
    out.lastMessageId = lastMessageId;
  }
  return out;
}

function serializeEntry(entry, title) {
  return stringifyYaml(normalizeEntry(entry, title), { indent: 2, lineWidth: 0 });
}

function waitSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function atomicWriteFileSync(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, content, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (err) {
        if (!(err.code === "EPERM" || err.code === "EBUSY") || attempt >= 4) throw err;
        waitSync(25 * (attempt + 1));
      }
    }
    try {
      const dirFd = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch {
      // fsync каталога недоступен на части платформ; файл уже опубликован.
    }
  } finally {
    try { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); } catch {}
  }
}

export function loadChannelState(mode, channelId, dir = STATE_DIR) {
  const file = resolveChannelStatePath(mode, channelId, dir);
  if (!fs.existsSync(file)) return undefined;
  const data = readYamlObject(file, mode);
  try {
    return normalizeEntry(data);
  } catch (err) {
    if (err instanceof CliError) {
      throw new CliError(
        `файл чекпоинта повреждён: ${file} (${err.message}) — удалите его, чекпоинт будет восстановлен из ${MODE_HINTS[mode]}`
      );
    }
    throw err;
  }
}

export function saveChannelState(mode, channelId, entry, dir = STATE_DIR) {
  const file = resolveChannelStatePath(mode, channelId, dir);
  const prev = fs.existsSync(file) ? loadChannelState(mode, channelId, dir) : undefined;
  const next = { ...entry };
  if (!next.title && prev?.title) next.title = prev.title;
  atomicWriteFileSync(file, serializeEntry(next));
}

// Совместимые имена API: теперь операция всегда касается только файла канала.
export const saveStateEntry = saveChannelState;

export function loadModeState(mode, channels, dir = STATE_DIR) {
  assertMode(mode);
  const state = {};
  for (const channel of channels || []) {
    const entry = loadChannelState(mode, channel.id, dir);
    if (entry) state[String(channel.id)] = entry;
  }
  return state;
}

export function loadState(mode, dir = STATE_DIR) {
  assertMode(mode);
  const modeDir = path.join(dir, mode);
  if (!fs.existsSync(modeDir)) return {};
  const state = {};
  for (const name of fs.readdirSync(modeDir)) {
    if (!name.endsWith(".yaml")) continue;
    const channelId = decodeURIComponent(name.slice(0, -5));
    state[channelId] = loadChannelState(mode, channelId, dir);
  }
  return state;
}

function mergeEntries(channel, oldEntry, newEntry) {
  const oldId = Number(oldEntry?.lastMessageId) || 0;
  const newId = Number(newEntry?.lastMessageId) || 0;
  return normalizeEntry({
    title: channel.title || newEntry?.title || oldEntry?.title,
    lastMessageId: Math.max(oldId, newId),
  });
}

// Идемпотентный переход со старого агрегатного state/<mode>.yaml.
export function migrateLegacyState(mode, channels, dir = STATE_DIR) {
  assertMode(mode);
  const legacy = path.join(dir, `${mode}.yaml`);
  if (!fs.existsSync(legacy)) return false;
  const old = readYamlObject(legacy, mode);
  const byId = new Map((channels || []).map((channel) => [String(channel.id), channel]));
  for (const [channelId, oldEntry] of Object.entries(old)) {
    const channel = byId.get(String(channelId)) || { id: channelId, title: oldEntry?.title };
    const current = loadChannelState(mode, channelId, dir);
    saveChannelState(mode, channelId, mergeEntries(channel, oldEntry, current), dir);
  }
  for (const channelId of Object.keys(old)) {
    const migrated = loadChannelState(mode, channelId, dir);
    if ((Number(migrated?.lastMessageId) || 0) < (Number(old[channelId]?.lastMessageId) || 0)) {
      throw new CliError(`не удалось проверить миграцию чекпоинта канала ${channelId}`);
    }
  }
  const archive = path.join(dir, "legacy", `${mode}.yaml.migrated`);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  if (fs.existsSync(archive)) {
    // Архив — исторический источник для rollback старого бинаря. Повторно
    // появившийся агрегат уже перенесён в per-channel state, но существующий
    // архив не переписываем.
    fs.rmSync(legacy);
  } else {
    fs.renameSync(legacy, archive);
  }
  return true;
}

export function backfillStateTitles(mode, channels, dir = STATE_DIR) {
  let changed = false;
  for (const channel of channels || []) {
    const entry = loadChannelState(mode, channel.id, dir);
    if (entry && channel.title && entry.title !== channel.title) {
      saveChannelState(mode, channel.id, { ...entry, title: channel.title }, dir);
      changed = true;
    }
  }
  return changed;
}

function decodeStateFileName(name) {
  try {
    return decodeURIComponent(name.slice(0, -5));
  } catch {
    return name.slice(0, -5);
  }
}

// Атомарно приводит state настроенных каналов к каноническому формату
// { title, lastMessageId }. Ошибки отдельных файлов возвращаются вызывающему:
// выбранный канал позднее получит штатную локальную ошибку при чтении.
export function normalizeModeState(mode, channels, dir = STATE_DIR) {
  assertMode(mode);
  const modeDir = path.join(dir, mode);
  const configured = new Map((channels || []).map((channel) => [String(channel.id), channel]));
  const result = { normalized: [], orphans: [], errors: [] };
  if (!fs.existsSync(modeDir)) return result;

  for (const name of fs.readdirSync(modeDir)) {
    if (!name.endsWith(".yaml") || name.includes(".tmp-")) continue;
    const channelId = decodeStateFileName(name);
    const file = path.join(modeDir, name);
    const channel = configured.get(channelId);
    if (!channel) {
      result.orphans.push({ channelId, file });
      continue;
    }
    try {
      const data = readYamlObject(file, mode);
      const canonical = serializeEntry(data, channel.title);
      const current = fs.readFileSync(file, "utf-8");
      if (current !== canonical) {
        atomicWriteFileSync(file, canonical);
        result.normalized.push(file);
      }
    } catch (error) {
      result.errors.push({ channelId, file, error });
    }
  }
  return result;
}

export function maxMessageIdInText(text) {
  let max = 0;
  if (!text) return max;
  for (const match of text.matchAll(/^## Сообщение #(\d+)$/gm)) {
    const id = Number(match[1]);
    if (Number.isInteger(id) && id > max) max = id;
  }
  return max;
}

export function readFileMaxMessageId(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return maxMessageIdInText(fs.readFileSync(filePath, "utf-8"));
}

export function messageIdsInText(text) {
  const ids = new Set();
  if (!text) return ids;
  for (const match of text.matchAll(/^## Сообщение #(\d+)$/gm)) {
    const id = Number(match[1]);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

export function partitionByCheckpoints(messages, cpExport, cpDb) {
  const fileCp = Number(cpExport) || 0;
  const dbCp = Number(cpDb) || 0;
  return {
    forFile: messages.filter((message) => message.id > fileCp),
    forDb: messages.filter((message) => message.id > dbCp),
  };
}

export function effectiveExportCheckpoint(entry, fileMax = 0) {
  const fromState = entry?.lastMessageId ? Number(entry.lastMessageId) : 0;
  return Math.max(fromState, Number(fileMax) || 0);
}

export function effectiveDbCheckpoint(maxInDb, entry) {
  const db = Number(maxInDb) || 0;
  if (db <= 0) return undefined;
  const fromState = entry?.lastMessageId ? Number(entry.lastMessageId) : 0;
  return Math.max(db, fromState);
}
