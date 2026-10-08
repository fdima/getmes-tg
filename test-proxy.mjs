// Юнит-проверки секции proxy (resolveProxyConfig из lib/config.js) —
// чистая функция, без сети и без подключения к прокси.
// Запуск: npm test
// В проверках 2 и 9 секция proxy берётся из конфигурационного файла
// (config.yaml, при его отсутствии — config.yaml.example): в коде теста
// никаких секретов не хранится и не печатается.
import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { resolveProxyConfig, loadConfig } from "./lib/config.js";
import { CliError } from "./lib/cli.js";

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) console.log(`     ожидалось: ${JSON.stringify(expected)}\n     получено:  ${JSON.stringify(actual)}`);
}

// Возвращает текст CliError либо null, если исключения не было
function errorOf(config) {
  try {
    resolveProxyConfig(config);
    return null;
  } catch (err) {
    if (!(err instanceof CliError)) return `НЕ CliError: ${err.message}`;
    return err.message;
  }
}

// --- Источник секретов для проверок 2 и 9 --------------------------------
// config.yaml → config.yaml.example (шаблон без секретов). Выбирается первый
// файл, где есть непустая секция proxy.host; сама секция используется как есть.
function loadProxySection() {
  const fromExample = (why) => {
    console.log(`INFO источник секции proxy: config.yaml.example (${why})`);
    return parseYaml(fs.readFileSync("config.yaml.example", "utf-8")).proxy;
  };
  if (fs.existsSync("config.yaml")) {
    try {
      const cfg = loadConfig("config.yaml");
      if (cfg.proxy && cfg.proxy.host) return cfg.proxy;
      return fromExample("в config.yaml нет proxy.host");
    } catch (err) {
      return fromExample(`config.yaml не прочитан: ${err.message}`);
    }
  }
  return fromExample("config.yaml отсутствует");
}

const px = loadProxySection();

// Ожидаемые ip/port из конфига — зеркало разбора host в resolveProxyConfig
function expectedHost(section) {
  const hasPortField = section.port !== undefined && section.port !== null && section.port !== "";
  const host = String(section.host);
  if (hasPortField) return { ip: host, port: Number(section.port) };
  if (host.startsWith("[") && host.includes("]")) {
    const close = host.indexOf("]");
    const rest = host.slice(close + 1);
    if (rest.startsWith(":")) return { ip: host.slice(1, close), port: Number(rest.slice(1)) };
    return { ip: host, port: Number(section.port) };
  }
  const idx = host.lastIndexOf(":");
  if (idx > 0 && idx < host.length - 1) return { ip: host.slice(0, idx), port: Number(host.slice(idx + 1)) };
  return { ip: host, port: Number(section.port) };
}

// Ожидаемое значение опциональной строки: пустое/отсутствующее → undefined
const defined = (v) => (v === undefined || v === null || v === "" ? undefined : String(v));

// 1. Выключение прокси → null (работа без прокси)
check("нет секции proxy", resolveProxyConfig({}), null);
check("proxy: false", resolveProxyConfig({ proxy: false }), null);
check("proxy: null", resolveProxyConfig({ proxy: null }), null);
check("proxy: { enabled: false }", resolveProxyConfig({ proxy: { enabled: false, host: "1.2.3.4:1080" } }), null);

// 2. Включение: host: "ip:порт" одной строкой — значения берутся из конфига
{
  const p = resolveProxyConfig({ proxy: { ...px, enabled: true } });
  const exp = expectedHost(px);
  check("host:port → ip", p.ip, exp.ip);
  check("host:port → port", p.port, exp.port);
  check("socksType: дефолт 5 либо значение конфига", p.socksType, px.socksType === undefined ? 5 : Number(px.socksType));
  check("username из конфига пробрасывается", p.username, defined(px.username));
  check("password пробрасывается (значение не печатается)", p.password === defined(px.password), true);
  check("timeout из конфига (если задан)", p.timeout, px.timeout === undefined || px.timeout === null ? undefined : Number(px.timeout));
}

// 3. host и port отдельными полями
{
  const p = resolveProxyConfig({ proxy: { host: "10.0.0.1", port: 9050 } });
  check("отдельный port: ip", p.ip, "10.0.0.1");
  check("отдельный port: port", p.port, 9050);
}

// 4. Порт строкой (yaml может дать и строку)
{
  const p = resolveProxyConfig({ proxy: { host: "1.2.3.4:1080" } });
  check("порт из строки → число", p.port, 1080);
}

// 5. Явно включённый proxy.enabled: true
{
  const p = resolveProxyConfig({ proxy: { enabled: true, host: "1.2.3.4:1080" } });
  check("enabled: true → включён", p.ip, "1.2.3.4");
}

// 6. Опциональные поля: socksType 4, свой timeout, пустые username/password
{
  const p = resolveProxyConfig({ proxy: { host: "1.2.3.4:1080", socksType: 4, timeout: 15, username: "", password: "" } });
  check("socksType: 4", p.socksType, 4);
  check("timeout: 15", p.timeout, 15);
  check("пустой username не попадает в объект", p.username, undefined);
  check("пустой password не попадает в объект", p.password, undefined);
}

// 7. IPv6 в скобках: [::1]:1080
{
  const p = resolveProxyConfig({ proxy: { host: "[::1]:1080" } });
  check("IPv6: ip без скобок", p.ip, "::1");
  check("IPv6: port", p.port, 1080);
}

// 8. Ошибки конфигурации (все — CliError, понятные сообщения)
check("proxy не объект", errorOf({ proxy: "1.2.3.4:1080" }), "секция proxy должна быть объектом ({ host, username, password }) либо false — см. README, раздел «Прокси»");
check("нет host", errorOf({ proxy: {} }), 'в секции proxy не заполнено поле host — укажите "ip:порт" (например, host: "1.2.3.4:1080") либо host и port отдельно');
check("enabled: true без host", errorOf({ proxy: { enabled: true } }).startsWith("в секции proxy не заполнено поле host"), true);
check("host без порта", errorOf({ proxy: { host: "1.2.3.4" } }), 'в proxy.host не указан порт: "1.2.3.4" — укажите host:port или отдельное поле port');
check("порт за пределами 1–65535", errorOf({ proxy: { host: "1.2.3.4:70000" } }), "некорректный порт прокси: 70000 (ожидается целое 1–65535)");
check("порт не число", errorOf({ proxy: { host: "1.2.3.4:abc" } }), "некорректный порт прокси: abc (ожидается целое 1–65535)");
check("некорректный socksType", errorOf({ proxy: { host: "1.2.3.4:1080", socksType: 9 } }), "некорректный socksType прокси: 9 (допустимо 4 или 5)");
check("некорректный timeout", errorOf({ proxy: { host: "1.2.3.4:1080", timeout: 0 } }), "некорректный таймаут прокси: 0 (ожидается число секунд > 0)");
check("все ошибки — CliError", errorOf({ proxy: { host: "1.2.3.4" } }).includes("не указан порт"), true);

// 9. Полный объект из конфигурационного файла (SOCKS5 с авторизацией) —
// пароль в вывод теста не попадает: он сверяется отдельно (проверка 2)
{
  const p = resolveProxyConfig({ proxy: { ...px, enabled: true } });
  const exp = expectedHost(px);
  const expected = { ip: exp.ip, port: exp.port, socksType: px.socksType === undefined ? 5 : Number(px.socksType) };
  if (defined(px.username) !== undefined) expected.username = defined(px.username);
  if (defined(px.password) !== undefined) expected.password = defined(px.password);
  if (px.timeout !== undefined && px.timeout !== null) expected.timeout = Number(px.timeout);
  const noPassword = (o) => {
    const copy = { ...o };
    delete copy.password;
    return copy;
  };
  check("секция proxy из конфига: полный объект (пароль — в проверке 2)", JSON.stringify(noPassword(p)), JSON.stringify(noPassword(expected)));
}

console.log(failed ? `\nПровалено: ${failed}` : "\nВсе проверки пройдены");
process.exit(failed ? 1 : 0);
