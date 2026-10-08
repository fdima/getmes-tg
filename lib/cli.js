import { parseArgs } from "node:util";
import path from "path";

export class CliError extends Error {}

// Как программа называет саму себя: export.js при запуске из исходников,
// имя бинаря (getmes-tg-windows-x64.exe и т.п.) в собранном виде.
// В сообщениях не упоминаем node — бинарь работает без него.
export const SELF = path.basename(process.argv[1] || "export.js");

// Все опции всех подкоманд в одном наборе (strict-парсинг ловит неизвестные
// флаги), принадлежность конкретной подкоманде проверяем после разбора.
const OPTIONS = {
  config: { type: "string" },
  channel: { type: "string" },
  chat: { type: "string" },
  text: { type: "string" },
  "text-file": { type: "string" },
  file: { type: "string" },
  plain: { type: "boolean" },
  repair: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

const FLAG_DOCS = {
  config: ["--config <путь>", "путь к конфигурации (по умолчанию config.yaml)"],
  channel: ["--channel <id|заголовок>", "выгрузить только этот канал"],
  chat: ["--chat <id|@username>", "чат-получатель (или send.defaultChat в конфиге)"],
  text: ['--text "<текст>"', "текст сообщения"],
  "text-file": ["--text-file <путь>", "текст сообщения из файла (UTF-8)"],
  file: ["--file <путь>", "файл для отправки (имя файла сохраняется)"],
  plain: ["--plain", "отправлять без разметки, как есть"],
  repair: ["--repair", "полная сверка с startDate: долить пропуски (тяжело)"],
};

export const COMMANDS = {
  export: {
    summary: "выгрузка сообщений из Telegram в Markdown-файлы (output/)",
    opts: ["config", "channel", "repair"],
    examples: [`${SELF} export`, `${SELF} export --channel Интерфакс`],
  },
  db: {
    summary: "выгрузка сообщений в базу данных (ТОЛЬКО в БД, без output/*.md)",
    note: "MySQL, секция db в конфиге",
    opts: ["config", "channel", "repair"],
    examples: [`${SELF} db`, `${SELF} db --channel Интерфакс`],
  },
  full: {
    summary: "комплексная выгрузка: output/*.md И MySQL за один проход",
    note: "файлы + MySQL, свой чекпоинт у каждого режима",
    opts: ["config", "channel", "repair"],
    examples: [`${SELF} full`, `${SELF} full --channel Интерфакс`],
  },
  send: {
    summary: "отправка сообщения и/или файла в чат или группу",
    opts: ["config", "chat", "text", "text-file", "file", "plain"],
    examples: [
      `${SELF} send --chat @durov --text "Привет всем!"`,
      `${SELF} send --chat -1001234567890 --file отчёт.pdf --text "Файл"`,
      `${SELF} send --chat -1001234567890 --text-file сообщение.md`,
    ],
  },
  help: {
    summary: "показать эту справку",
    opts: [],
    examples: [`${SELF} help`],
  },
};

export function parseCli(argv) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    }));
  } catch (err) {
    throw new CliError(err.message);
  }

  if (values.help && positionals.length === 0) {
    return { command: "help", values };
  }

  const [name, ...rest] = positionals;
  if (!name) throw new CliError("не указана подкоманда");

  const cmd = COMMANDS[name];
  if (!cmd) throw new CliError(`неизвестная подкоманда: ${name}`);
  if (rest.length) throw new CliError(`лишние аргументы: ${rest.join(" ")}`);

  const allowed = new Set([...cmd.opts, "help"]);
  for (const key of Object.keys(values)) {
    if (values[key] === undefined || values[key] === false) continue;
    if (!allowed.has(key)) {
      throw new CliError(`параметр --${key} не поддерживается для подкоманды ${name}`);
    }
  }

  return { command: name, values };
}

export function buildHelp() {
  const version = process.env.npm_package_version || "1.0.0";
  const lines = [];

  lines.push(`telegram-exporter v${version} — выгрузка истории Telegram-каналов`);
  lines.push("");
  lines.push("Использование:");
  lines.push(`  ${SELF} <подкоманда> [параметры]`);
  lines.push(`  ${SELF}                 без параметров — эта справка`);
  lines.push("");
  lines.push("Подкоманды:");

  for (const [name, cmd] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(8)}${cmd.summary}`);
    const flags = cmd.opts.filter((o) => o !== "config");
    if (flags.length) {
      lines.push("               Флаги:");
      for (const key of flags) {
        const [flag, desc] = FLAG_DOCS[key];
        lines.push(`                 ${flag.padEnd(26)}${desc}`);
      }
    }
    if (cmd.note) lines.push(`               ⚠ ${cmd.note}`);
  }

  lines.push("");
  lines.push("Общие параметры:");
  lines.push(`  ${FLAG_DOCS.config[0].padEnd(28)}${FLAG_DOCS.config[1]}`);
  lines.push(`  -h, --help${" ".repeat(17)}показать справку`);
  lines.push("");
  lines.push("Примеры:");
  for (const cmd of Object.values(COMMANDS)) {
    for (const ex of cmd.examples) lines.push(`  ${ex}`);
  }
  lines.push("");
  lines.push(
    "Разметка в send: **жирный**, __курсив__, ~~зачёркнутый~~, `код`, блок кода;"
  );
  lines.push(
    "ссылки [текст](url) встроенный парсер gramjs пока не оформляет — используйте --plain."
  );

  return lines.join("\n");
}
