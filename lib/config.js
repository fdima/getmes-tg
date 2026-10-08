import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import { CliError } from "./cli.js";

// Порядок поиска дефолтного конфига: yaml — основной формат,
// json — legacy (читается и пишется, если yaml-файла нет).
const DEFAULT_PATHS = ["config.yaml", "config.yml", "config.json"];

function isYaml(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === ".yaml" || ext === ".yml";
}

// Явный --config используется как есть; без него — первый существующий
// из DEFAULT_PATHS (если ничего нет — config.yaml: сообщение об ошибке
// должно указывать на основной формат).
function resolvePath(configPath) {
  if (configPath) return configPath;
  for (const p of DEFAULT_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return DEFAULT_PATHS[0];
}

export function loadConfig(configPath) {
  const file = resolvePath(configPath);

  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new CliError(
        `файл конфигурации не найден: ${file} — создайте его или укажите путь через --config <путь>`
      );
    }
    if (err.code === "EACCES") {
      throw new CliError(`нет доступа к файлу конфигурации: ${file}`);
    }
    throw new CliError(
      `не удалось прочитать файл конфигурации ${file}: ${err.message}`
    );
  }

  if (isYaml(file)) {
    let data;
    try {
      data = parseYaml(raw);
    } catch (err) {
      throw new CliError(`некорректный YAML в конфиге ${file}: ${err.message}`);
    }
    if (!data || typeof data !== "object") {
      throw new CliError(`некорректный YAML в конфиге ${file}: пустой или необъектный документ`);
    }
    return data;
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    // Частая причина: висячая запятая после ручной правки конфига
    throw new CliError(`некорректный JSON в конфиге ${file}: ${err.message}`);
  }
}

// Изменяемого состояния в конфиге больше нет: чекпоинты выгрузки живут
// в state/ (lib/state.js), config.yaml только читается — секреты в нём
// не переписываются ни одним запуском (PLAN/plan 6.md).

// Разбор секции proxy конфига (чистая функция, CliError при кривых значениях —
// id вида "-1001557052991" → https://t.me/c/1557052991/27684
export function messageUrl(channelId, messageId) {
  const numericId = String(channelId).replace(/^-100/, "");
  return `https://t.me/c/${numericId}/${messageId}`;
}

// Разбор секции proxy конфига (чистая функция, CliError при кривых значениях —
// проверяем ДО авторизации, чтобы ошибка не логинила клиента).
// Возвращает объект для TelegramClient (gramjs: { ip, port, socksType,
// username, password, timeout }) либо null — работа без прокси:
//   proxy отсутствует | proxy: false | proxy: { enabled: false } → null;
//   proxy: { host: "ip:порт", username?, password?, ... }         → включён.
export function resolveProxyConfig(config) {
  const section = config ? config.proxy : undefined;
  if (section === undefined || section === null || section === false) return null;
  if (typeof section !== "object" || Array.isArray(section)) {
    throw new CliError(
      "секция proxy должна быть объектом ({ host, username, password }) либо false — см. README, раздел «Прокси»"
    );
  }
  if (section.enabled === false) return null;

  if (!section.host) {
    throw new CliError(
      'в секции proxy не заполнено поле host — укажите "ip:порт" (например, host: "1.2.3.4:1080") либо host и port отдельно'
    );
  }

  // Порт: из поля port либо из host вида "адрес:порт"
  let host = String(section.host);
  let port = section.port;
  if (port === undefined || port === null || port === "") {
    if (host.startsWith("[") && host.includes("]")) {
      // IPv6 в скобках: [::1]:1080 → адрес ::1, порт 1080
      const close = host.indexOf("]");
      const rest = host.slice(close + 1);
      if (rest.startsWith(":")) {
        port = rest.slice(1);
        host = host.slice(1, close);
      }
    } else {
      const idx = host.lastIndexOf(":");
      if (idx > 0 && idx < host.length - 1 && host.indexOf(":") === idx) {
        port = host.slice(idx + 1);
        host = host.slice(0, idx);
      }
    }
  }
  if (port === undefined || port === null || port === "") {
    throw new CliError(
      `в proxy.host не указан порт: "${section.host}" — укажите host:port или отдельное поле port`
    );
  }
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new CliError(`некорректный порт прокси: ${port} (ожидается целое 1–65535)`);
  }

  const socksType = section.socksType === undefined ? 5 : Number(section.socksType);
  if (socksType !== 4 && socksType !== 5) {
    throw new CliError(`некорректный socksType прокси: ${section.socksType} (допустимо 4 или 5)`);
  }

  const proxy = { ip: host, port: portNum, socksType };

  if (section.username !== undefined && section.username !== null && section.username !== "") {
    proxy.username = String(section.username);
  }
  if (section.password !== undefined && section.password !== null && section.password !== "") {
    proxy.password = String(section.password);
  }

  if (section.timeout !== undefined && section.timeout !== null) {
    const timeout = Number(section.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new CliError(`некорректный таймаут прокси: ${section.timeout} (ожидается число секунд > 0)`);
    }
    proxy.timeout = timeout;
  }

  return proxy;
}
