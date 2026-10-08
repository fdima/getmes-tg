import { renderMessageText } from "./markdown.js";

// Валидация секции db — вызывается ДО подключения и ДО авторизации Telegram,
// чтобы ошибка конфигурации не логинила клиента. Возвращает текст или null.
export function validateDbConfig(config) {
  const db = config.db;
  // Отключение выгрузки в БД: db: false или db: { enabled: false }
  if (db === false) {
    return "выгрузка в БД отключена в конфиге (db: false)";
  }
  if (db && db.enabled === false) {
    return "выгрузка в БД отключена в конфиге (db.enabled: false)";
  }
  if (!db) {
    return "секция db не задана в конфиге (нужны driver/host/port/user/password/database)";
  }
  const driver = db.driver || "mysql";
  if (driver !== "mysql") {
    return `драйвер ${driver} не поддерживается — пока реализован только mysql (см. PLAN/plan 2.md)`;
  }
  for (const field of ["host", "user", "database"]) {
    if (!db[field]) return `в секции db не заполнено поле ${field}`;
  }
  return null;
}

// Упрощённое представление сущностей для колонки entities (JSON):
// gramjs-объекты классов не сериализуются сами и тащат за собой лишнее.
export function serializeEntities(entities) {
  if (!entities || entities.length === 0) return null;
  const light = entities
    .filter((e) => e && e.className)
    .map((e) => {
      const item = { className: e.className, offset: e.offset, length: e.length };
      if (e.url !== undefined) item.url = e.url;
      if (e.userId !== undefined) item.userId = e.userId;
      return item;
    });
  return light.length ? JSON.stringify(light) : null;
}

// Строка INSERT: те же колонки и порядок, что в UPSERT_SQL (lib/mysql.js).
export function buildRow(channelId, channelTitle, msg, url) {
  return [
    String(channelId),
    channelTitle || null,
    msg.id,
    new Date(msg.date * 1000),
    msg.rawText || "",
    renderMessageText(msg),
    msg.media ? msg.media.className : null,
    serializeEntities(msg.entities),
    url,
  ];
}

// Единая точка входа БД. Ленивая загрузка: mysql2 подгружается только здесь,
// поэтому export/send работают и без установленного драйвера.
export async function openDb(config) {
  const { driver = "mysql" } = config.db;
  if (driver === "mysql") {
    const { openMysql } = await import("./mysql.js");
    return openMysql(config.db);
  }
  throw new Error(`драйвер ${driver} не реализован`);
}
