// Юнит-проверки слоя БД (lib/db.js) — чистые функции, без сервера.
// Запуск: npm test
import { validateDbConfig, serializeEntities, buildRow } from "./lib/db.js";
import { renderMessageText } from "./lib/markdown.js";

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) console.log(`     ожидалось: ${JSON.stringify(expected)}\n     получено:  ${JSON.stringify(actual)}`);
}

const goodDb = { driver: "mysql", host: "127.0.0.1", user: "root", database: "tgexport" };

// 1. Валидация: нет секции db
check("нет секции db", validateDbConfig({}), "секция db не задана в конфиге (нужны driver/host/port/user/password/database)");
check("db: false → выгрузка отключена", validateDbConfig({ db: false }), "выгрузка в БД отключена в конфиге (db: false)");
check("db.enabled: false → выгрузка отключена", validateDbConfig({ db: { enabled: false } }), "выгрузка в БД отключена в конфиге (db.enabled: false)");

// 2. Валидация: неподдерживаемый драйвер
check("драйвер postgres", validateDbConfig({ db: { ...goodDb, driver: "postgres" } }).startsWith("драйвер postgres не поддерживается"), true);

// 3. Валидация: не заполнен host
check("нет host", validateDbConfig({ db: { driver: "mysql", user: "root", database: "x" } }), "в секции db не заполнено поле host");

// 4. Валидация: валидная конфигурация
check("валидная db", validateDbConfig({ db: goodDb }), null);

// 5. Валидация: driver можно не указывать (по умолчанию mysql)
check("driver по умолчанию", validateDbConfig({ db: { host: "h", user: "u", database: "d" } }), null);

// 6. serializeEntities: gramjs-объекты не тащат лишнее
check(
  "serializeEntities",
  serializeEntities([{ className: "MessageEntityBold", offset: 0, length: 4, extra: "x" }, { className: "MessageEntityTextUrl", offset: 1, length: 2, url: "https://x" }]),
  JSON.stringify([
    { className: "MessageEntityBold", offset: 0, length: 4 },
    { className: "MessageEntityTextUrl", offset: 1, length: 2, url: "https://x" },
  ])
);

// 7. serializeEntities: пусто → null (колонка entities nullable)
check("serializeEntities пусто", serializeEntities([]), null);
check("serializeEntities без entity", serializeEntities(undefined), null);

// 8. renderMessageText: rawText + entity → Markdown (та же логика, что в .md)
check(
  "renderMessageText",
  renderMessageText({
    rawText: "привет мир",
    entities: [{ className: "MessageEntityBold", offset: 0, length: 6 }],
  }),
  "**привет** мир"
);
check("renderMessageText без entity", renderMessageText({ rawText: "текст" }), "текст");

// 9. buildRow: порядок колонок совпадает с UPSERT_SQL в lib/mysql.js
{
  const msg = {
    id: 42,
    date: 1759363200,
    rawText: "привет",
    entities: [{ className: "MessageEntityBold", offset: 0, length: 3 }],
    media: { className: "MessageMediaPhoto" },
  };
  const row = buildRow(
    "-1001149896996",
    "Интерфакс",
    msg,
    "https://t.me/c/1149896996/42"
  );
  check("row[0] channel_id", row[0], "-1001149896996");
  check("row[1] channel_title", row[1], "Интерфакс");
  check("row[2] message_id", row[2], 42);
  check("row[3] date — Date", row[3] instanceof Date, true);
  check("row[4] text_raw", row[4], "привет");
  check("row[5] text_md", row[5], "**при**вет");
  check("row[6] media_class", row[6], "MessageMediaPhoto");
  check("row[7] entities JSON", row[7], JSON.stringify([{ className: "MessageEntityBold", offset: 0, length: 3 }]));
  check("row[8] url", row[8], "https://t.me/c/1149896996/42");
  check("row.length = 9 колонок", row.length, 9);

  const noTitle = buildRow("-1001149896996", null, msg, "u");
  check("channel_title без названия → null", noTitle[1], null);
}

console.log(failed ? `\nПровалено: ${failed}` : "\nВсе проверки пройдены");
process.exit(failed ? 1 : 0);
