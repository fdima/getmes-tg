// Логирование в файл с дневной ротацией + шим console.*.
// Подробности уходят в logs/, консоль получает только компактный прогресс
// (см. out() в export.js) и ошибки/предупреждения.
import fs from "fs";
import path from "path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const DEFAULTS = {
  dir: "./logs",
  level: "info",
  fileMask: "getmes-tg_{date}.log",
};

// Разбор секции log конфига (чистая функция):
//   log: false | { enabled: false } → { disabled: true } — логирование выключено
//   log: { dir, level, fileMask }   → настройки (незаполненные — дефолты)
//   log: отсутствует                → дефолтные настройки
export function resolveLogConfig(logSection) {
  if (logSection === false) return { disabled: true };
  if (logSection && typeof logSection === "object" && logSection.enabled === false) {
    return { disabled: true };
  }
  const s = logSection && typeof logSection === "object" ? logSection : {};
  return {
    disabled: false,
    dir: s.dir || DEFAULTS.dir,
    level: s.level || DEFAULTS.level,
    fileMask: s.fileMask || DEFAULTS.fileMask,
  };
}

// Имя файла лога: маска с плейсхолдером {date} + дата записи.
// Ротация «один файл — один день»: дата берётся на момент каждой записи,
// поэтому первая запись после 00:00 создаёт файл нового дня (без таймеров).
export function resolveLogFileName(dir, mask, date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return path.join(dir, mask.replaceAll("{date}", `${y}-${m}-${d}`));
}

function formatArg(a) {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function timestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

export function createLogger(logConfig = {}) {
  const dir = logConfig.dir || DEFAULTS.dir;
  const fileMask = logConfig.fileMask || DEFAULTS.fileMask;
  const threshold = LEVELS[logConfig.level] ?? LEVELS[DEFAULTS.level];

  function write(levelName, args) {
    if (LEVELS[levelName] < threshold) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const line = args.map(formatArg).join(" ");
      const file = resolveLogFileName(dir, fileMask);
      fs.appendFileSync(
        file,
        `${timestamp()} [${levelName.toUpperCase().padEnd(5)}] ${line}\n`,
        "utf-8"
      );
    } catch {
      // Логирование не должно ронять приложение
    }
  }

  return {
    debug: (...a) => write("debug", a),
    info: (...a) => write("info", a),
    warn: (...a) => write("warn", a),
    error: (...a) => write("error", a),
    dir,
    fileMask,
    level: logConfig.level || DEFAULTS.level,
  };
}

let current = null;

// Логгер, созданный initLogger(); до инициализации вызовы — no-op
function log() {
  return current || { debug() {}, info() {}, warn() {}, error() {} };
}

export const logDebug = (...a) => log().debug(...a);
export const logInfo = (...a) => log().info(...a);
export const logWarn = (...a) => log().warn(...a);
export const logError = (...a) => log().error(...a);

// Временно подавить консольный дубль console.warn/error (остаётся только лог-файл).
// Нужно на фазе подключения: при недоступном сервере/прокси gramjs делает
// 5 ретраев и сыпет сырыми трейсами SocksClientError (в node-выводе там даже
// видны опции прокси с паролем) — консоль засоряется, а итоговое сообщение
// об ошибке подключения и так выводится отдельно (fail() в export.js).
// Возвращает restore-функцию. При отключённых логах (log: false) — no-op,
// чтобы не прятать ошибки от пользователя, отказавшегося от логов.
export function muteConsoleStderr() {
  const lg = log();
  if (lg.disabled) return () => {};
  const prevError = console.error;
  const prevWarn = console.warn;
  console.error = (...a) => lg.error(...a);
  console.warn = (...a) => lg.warn(...a);
  return () => {
    console.error = prevError;
    console.warn = prevWarn;
  };
}

// Настройка логгера из секции log конфига + перехват console.*:
//   console.log/info/debug → только в лог-файл (gramjs [INFO] исчезает из консоли);
//   console.warn/error     → в лог-файл и в исходный stderr (ошибки видимы).
// log: false (или enabled: false) — полное отключение: без файлов, без шима
// (console.* остаются обычными, gramjs-шум снова виден — это осознанный выбор).
export function initLogger(config = {}) {
  const cfg = resolveLogConfig(config.log);
  if (cfg.disabled) {
    current = { disabled: true, debug() {}, info() {}, warn() {}, error() {} };
    return current;
  }

  const logger = createLogger(cfg);
  current = logger;

  const raw = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };

  console.log = console.info = (...a) => logger.info(...a);
  console.debug = (...a) => logger.debug(...a);
  console.warn = (...a) => {
    logger.warn(...a);
    raw.warn(...a);
  };
  console.error = (...a) => {
    logger.error(...a);
    raw.error(...a);
  };

  logger.info(`--- запуск ---`);
  return logger;
}
