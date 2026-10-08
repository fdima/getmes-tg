// Smoke-проверки командной строки export.js: справка, ошибки, валидация send.
// Ничего не отправляет и не выгружает — только быстрые вызовы без сети.
// Запуск: npm test
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(ROOT, "export.js");

let failed = 0;
function check(name, args, expectedStatus, pattern) {
  const res = spawnSync(process.execPath, [ENTRY, ...args], {
    encoding: "utf-8",
    timeout: 20000,
  });
  const out = `${res.stdout || ""}${res.stderr || ""}`;
  const statusOk = res.status === expectedStatus;
  const textOk = pattern.test(out);
  const ok = statusOk && textOk && res.error === undefined;
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    if (res.error) console.log(`     запуск: ${res.error.message}`);
    if (!statusOk) console.log(`     ожидался exit ${expectedStatus}, получен ${res.status}`);
    if (!textOk) console.log(`     в выводе нет ${pattern}\n     вывод: ${out.slice(0, 500)}`);
  }
}

// 1. Без параметров — приветствие со списком параметров, exit 0 (1.6)
check("нет параметров → справка", [], 0, /Подкоманды/);
check("нет параметров → перечислены export и send", [], 0, /export[\s\S]*send/);

// 2. help / --help — exit 0
check("help", ["help"], 0, /Использование/);
check("--help", ["--help"], 0, /Использование/);
check("-h", ["-h"], 0, /Использование/);

// 3. Неизвестная подкоманда — exit 1 с ошибкой
check("неизвестная подкоманда", ["bogus"], 1, /неизвестная подкоманда/i);

// 4. Неизвестный флаг — exit 1
check("неизвестный флаг", ["export", "--bogus"], 1, /неподдерж|неизвестн|unknown/i);

// 5. Флаг чужой подкоманды — exit 1
check("--text недоступен для export", ["export", "--text", "x"], 1, /не поддерживается/);

// 6. Лишние позиционные аргументы — exit 1
check("лишние аргументы", ["help", "extra"], 1, /лишние аргументы/);

// 7. Валидация send БЕЗ сети (до авторизации)
check("send без получателя", ["send"], 1, /получатель/);
check(
  "send: --text и --text-file вместе",
  ["send", "--chat", "123", "--text", "a", "--text-file", "b.md"],
  1,
  /одновременно/
);
check(
  "send: файл не найден",
  ["send", "--chat", "123", "--file", "нет-такого-файла.pdf"],
  1,
  /файл не найден/
);
check(
  "send: нечего отправлять",
  ["send", "--chat", "123", "--plain"],
  1,
  /нет данных/
);

// 9. Фильтр по несуществующему каналу — exit 1
check(
  "export: канал не найден",
  ["export", "--channel", "нет-такого-канала"],
  1,
  /не найден/
);

// 8. Подкоманда db: валидация конфигурации БД ДО авторизации Telegram
{
  const os = await import("os");
  const fsMod = await import("fs");
  const noDbConfig = path.join(os.tmpdir(), "tg-test-nodb.json");
  const deadDbConfig = path.join(os.tmpdir(), "tg-test-deaddb.json");
  fsMod.writeFileSync(noDbConfig, JSON.stringify({ api: { apiId: 1, apiHash: "x", sessionFile: "session.txt" }, channels: [] }));
  fsMod.writeFileSync(deadDbConfig, JSON.stringify({
    api: { apiId: 1, apiHash: "x", sessionFile: "session.txt" },
    db: { driver: "mysql", host: "127.0.0.1", port: 1, user: "nobody", password: "x", database: "none" },
    channels: [],
  }));

  check("db: нет секции db → понятная ошибка", ["db", "--config", noDbConfig], 1, /секция db не задана/);
  check("db: мёртвый порт → ошибка подключения до авторизации", ["db", "--config", deadDbConfig], 1, /нет подключения к MySQL/);
  // full — та же валидация до авторизации (plan 7)
  check("full: нет секции db → понятная ошибка до авторизации", ["full", "--config", noDbConfig], 1, /секция db не задана/);
  check("full: мёртвый порт → ошибка подключения до авторизации", ["full", "--config", deadDbConfig], 1, /нет подключения к MySQL/);

  fsMod.rmSync(noDbConfig, { force: true });
  fsMod.rmSync(deadDbConfig, { force: true });
}

// 10. Файл конфигурации: понятные ошибки без стектрейса (plan 4)
{
  const os = await import("os");
  const fsMod = await import("fs");
  const missing = path.join(os.tmpdir(), "tg-test-no-such-config.json");
  fsMod.rmSync(missing, { force: true });
  const emptyConfig = path.join(os.tmpdir(), "tg-test-empty-config.json");
  fsMod.writeFileSync(emptyConfig, "");

  check("export: конфиг не найден → понятное сообщение", ["export", "--config", missing], 1, /Ошибка: файл конфигурации не найден/);
  check("db: конфиг не найден → понятное сообщение", ["db", "--config", missing], 1, /файл конфигурации не найден/);
  check("send: конфиг не найден → понятное сообщение", ["send", "--config", missing], 1, /файл конфигурации не найден/);
  check("нет «Критическая ошибка», сразу справка", ["export", "--config", missing], 1, /Ошибка: файл конфигурации не найден[^\r\n]*\r?\nСправка/);
  check("пустой файл → некорректный JSON, без стектрейса", ["export", "--config", emptyConfig], 1, /Ошибка: некорректный JSON[^\r\n]*\r?\nСправка/);

  // Вывод без упоминаний node (бинарь работает без Node) — plan 5
  check("справка: имя программы вместо «node export.js»", ["help"], 0, /export\.js <подкоманда> \[параметры\]/);
  check("справка: ни одного упоминания node", ["help"], 0, /^(?![\s\S]*\bnode\b)[\s\S]*/);
  check("ошибка: справка называет программу без node", ["export", "--config", missing], 1, /\nСправка: {0,2}export\.js help/);

  fsMod.rmSync(emptyConfig, { force: true });
}

// 11. YAML-конфиг и отключения (plan 5, п. 2.7–2.8)
{
  const os = await import("os");
  const fsMod = await import("fs");

  const yamlNoDb = path.join(os.tmpdir(), "tg-test-nodb.yaml");
  fsMod.writeFileSync(
    yamlNoDb,
    "api:\n  apiId: 1\n  apiHash: x\n  sessionFile: session.txt\nchannels: []\n",
    "utf-8"
  );
  check("yaml: файл разбирается (db не задана)", ["db", "--config", yamlNoDb], 1, /секция db не задана/);

  const yamlDbOff = path.join(os.tmpdir(), "tg-test-dboff.yaml");
  fsMod.writeFileSync(yamlDbOff, "db: false\nchannels: []\n", "utf-8");
  check("yaml: db: false → выгрузка отключена", ["db", "--config", yamlDbOff], 1, /выгрузка в БД отключена в конфиге \(db: false\)/);

  const yamlDbEnabledOff = path.join(os.tmpdir(), "tg-test-dboffenoff.yaml");
  fsMod.writeFileSync(yamlDbEnabledOff, "db:\n  enabled: false\nchannels: []\n", "utf-8");
  check("yaml: db.enabled: false → выгрузка отключена", ["db", "--config", yamlDbEnabledOff], 1, /выгрузка в БД отключена в конфиге \(db\.enabled: false\)/);

  fsMod.rmSync(yamlNoDb, { force: true });
  fsMod.rmSync(yamlDbOff, { force: true });
  fsMod.rmSync(yamlDbEnabledOff, { force: true });
}

// 12. Секция proxy: понятные ошибки ДО авторизации (клиент не логинится)
{
  const os = await import("os");
  const fsMod = await import("fs");

  const badProxy = path.join(os.tmpdir(), "tg-test-badproxy.yaml");
  fsMod.writeFileSync(badProxy, 'proxy:\n  host: "1.2.3.4"\nchannels: []\n', "utf-8");
  check(
    "proxy без порта: send → ошибка, без запроса телефона",
    ["send", "--chat", "me", "--text", "x", "--config", badProxy],
    1,
    /^(?![\s\S]*Введите номер телефона)[\s\S]*proxy\.host не указан порт[\s\S]*$/m
  );
  check("proxy без порта: export → понятная ошибка", ["export", "--config", badProxy], 1, /Ошибка: в proxy\.host не указан порт[^\r\n]*\r?\nСправка/);

  const proxyString = path.join(os.tmpdir(), "tg-test-proxystring.yaml");
  fsMod.writeFileSync(proxyString, 'proxy: "1.2.3.4:1080"\nchannels: []\n', "utf-8");
  check("proxy строкой → понятная ошибка", ["export", "--config", proxyString], 1, /секция proxy должна быть объектом/);

  fsMod.rmSync(badProxy, { force: true });
  fsMod.rmSync(proxyString, { force: true });
}

// 13. Флаг --repair (plan 6, этап 2): виден в справке у export, db и full
// (plan 7), принимается выгрузками (разбор CLI не логинит клиент),
// запрещён в send
{
  check("без параметров: --repair в справке", [], 0, /--repair/);
  check("без параметров: подкоманда full в списке", [], 0, /Подкоманды[\s\S]*full/);
  check(
    "справка: подкоманда full с флагами",
    ["help"],
    0,
    /full\s+комплексная выгрузка/
  );
  check(
    "export --repair принимается (доходит до фильтра каналов)",
    ["export", "--repair", "--channel", "нет-такого-канала"],
    1,
    /не найден/
  );
  check(
    "db --repair принимается (доходит до фильтра каналов)",
    ["db", "--repair", "--channel", "нет-такого-канала"],
    1,
    /не найден/
  );
  check(
    "full --repair принимается (доходит до фильтра каналов)",
    ["full", "--repair", "--channel", "нет-такого-канала"],
    1,
    /не найден/
  );
  check(
    "send --repair → параметр не поддерживается",
    ["send", "--repair"],
    1,
    /параметр --repair не поддерживается для подкоманды send/
  );

  // --repair должен быть в справке ровно трижды: у export, db и full, но не у send
  const res = spawnSync(process.execPath, [ENTRY, "help"], { encoding: "utf-8", timeout: 20000 });
  const count = ((res.stdout || "").match(/--repair/g) || []).length;
  const ok = res.status === 0 && count === 3 && res.error === undefined;
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} справка: --repair ровно трижды (export, db, full)`);
  if (!ok) console.log(`     найдено упоминаний: ${count}, ожидалось: 3, exit ${res.status}`);
}

console.log(failed ? `\nПровалено: ${failed}` : "\nВсе проверки пройдены");
process.exit(failed ? 1 : 0);
