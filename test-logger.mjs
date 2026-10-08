// Чистые проверки логгера lib/logger.js (без сети): имя файла по маске,
// дневная ротация, фильтр уровней, устойчивость к недоступному каталогу.
// Запуск: npm test
import fs from "fs";
import os from "os";
import path from "path";
import { resolveLogFileName, resolveLogConfig, createLogger, initLogger, muteConsoleStderr } from "./lib/logger.js";

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) console.log(`     ожидалось: ${JSON.stringify(expected)}\n     получено:  ${JSON.stringify(actual)}`);
}

// 1. Имя файла: {date} подставляется как YYYY-MM-DD
const day = new Date(2026, 9, 3); // 03.10.2026
check(
  "маска с {date}",
  resolveLogFileName("./logs", "app_{date}.log", day),
  path.join("./logs", "app_2026-10-03.log")
);
check(
  "одиннадцатый месяц с ведущим нулём",
  resolveLogFileName("L", "a_{date}", new Date(2026, 11, 5)),
  path.join("L", "a_2026-12-05")
);

// 2. Ротация: другой день — другой файл (один лог-файл на один день)
check(
  "разные дни → разные файлы",
  resolveLogFileName("L", "a_{date}", day) !== resolveLogFileName("L", "a_{date}", new Date(2026, 9, 4)),
  true
);

// 3. Запись: info попадает в файл, debug фильтруется дефолтным level=info
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-log-"));
  const mask = "t_{date}.log";
  const logger = createLogger({ dir: tmp, level: "info", fileMask: mask });
  logger.debug("не должно попасть");
  logger.info("привет");
  const content = fs.readFileSync(resolveLogFileName(tmp, mask), "utf-8");
  check("info записан с уровнем", content.includes("[INFO ] привет"), true);
  check("debug отфильтрован", content.includes("не должно попасть"), false);
  check("строка содержит метку времени", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(content), true);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 4. Уровень warn: info не пишется, warn пишется
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-log-"));
  const mask = "w_{date}.log";
  const logger = createLogger({ dir: tmp, level: "warn", fileMask: mask });
  logger.info("только инфо");
  logger.warn("важно");
  const content = fs.readFileSync(resolveLogFileName(tmp, mask), "utf-8");
  check("info отфильтрован уровнем warn", content.includes("только инфо"), false);
  check("warn пишется", content.includes("[WARN ] важно"), true);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 5. Недоступный каталог — логирование не должно ронять приложение
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-log-"));
  const blocker = path.join(tmp, "blocker");
  fs.writeFileSync(blocker, "x");
  const logger = createLogger({ dir: path.join(blocker, "sub"), level: "info" }); // mkdir упадёт
  let threw = false;
  try {
    logger.error("должно проглотиться");
  } catch {
    threw = true;
  }
  check("ошибка записи в лог не бросается", threw, false);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 6. Разбор секции log (plan 5, п. 2.7): отключение и дефолты
check("log: false → отключено", resolveLogConfig(false).disabled, true);
check("enabled: false → отключено", resolveLogConfig({ enabled: false }).disabled, true);
{
  const d = resolveLogConfig(undefined);
  check("без секции — не отключено", d.disabled, false);
  check("без секции — дефолтный уровень", d.level, "info");
  check("без секции — дефолтная маска", d.fileMask, "getmes-tg_{date}.log");
  check("без секции — дефолтный каталог", d.dir, "./logs");
}
{
  const m = resolveLogConfig({ dir: "L", level: "warn" });
  check("свой dir сохраняется", m.dir, "L");
  check("свой уровень сохраняется", m.level, "warn");
  check("незаполненная маска — дефолт", m.fileMask, "getmes-tg_{date}.log");
}

// 7. Дефолтные значения createLogger (без секции log)
{
  const logger = createLogger({});
  check("дефолтный уровень info", logger.level, "info");
  check("дефолтная маска", logger.fileMask, "getmes-tg_{date}.log");
  check("дефолтный каталог", logger.dir, "./logs");
}

// 8. muteConsoleStderr: подавление консольного дубля console.error/warn
// (ошибки ретраев подключения уходят только в лог, не в stderr)
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tg-log-"));
  const native = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };
  initLogger({ log: { dir: tmp, level: "info", fileMask: "m_{date}.log" } });

  const writes = [];
  const origWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };

  const restore = muteConsoleStderr();
  console.error("шум ретрая");
  console.warn("ещё шум");
  const mutedCount = writes.length;
  restore();
  console.error("после mute");

  process.stderr.write = origWrite;
  const content = fs.readFileSync(resolveLogFileName(tmp, "m_{date}.log"), "utf-8");

  // Восстанавливаем нативные console.* ДО check — иначе вывод тестов уйдёт в лог
  Object.assign(console, native);
  fs.rmSync(tmp, { recursive: true, force: true });

  check("mute: console.error/warn не пишут в stderr", mutedCount, 0);
  check("после restore снова пишет в stderr", writes.length > mutedCount, true);
  check("mute: ошибка записана в лог", content.includes("шум ретрая"), true);
  check("mute: warn записан в лог", content.includes("ещё шум"), true);
}

console.log(failed ? `\nПровалено: ${failed}` : "\nВсе проверки пройдены");
process.exit(failed ? 1 : 0);
