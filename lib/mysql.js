// Реализация MySQL (драйвер mysql2/promise). SQL-диалект изолирован здесь:
// для Postgres/ClickHouse появятся свои модули с тем же интерфейсом
// { init, getMaxMessageId, upsertMessages, close } (см. PLAN/plan 2.md).
import { logWarn, logError, logInfo } from "./logger.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  channel_id    VARCHAR(32)  NOT NULL,
  channel_title VARCHAR(255) NULL,
  message_id    BIGINT       NOT NULL,
  date          DATETIME     NOT NULL,
  text_raw      MEDIUMTEXT,
  text_md       MEDIUMTEXT,
  media_class   VARCHAR(64),
  entities      JSON,
  url           VARCHAR(255),
  PRIMARY KEY (channel_id, message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

// Миграция таблиц, созданных до появления channel_title (1060 = дубль колонки)
const ALTER_ADD_TITLE_SQL = `
ALTER TABLE messages
  ADD COLUMN channel_title VARCHAR(255) NULL AFTER channel_id
`;

const UPSERT_SQL = `
INSERT INTO messages
  (channel_id, channel_title, message_id, date, text_raw, text_md, media_class, entities, url)
VALUES ?
ON DUPLICATE KEY UPDATE
  channel_title = VALUES(channel_title),
  date = VALUES(date),
  text_raw = VALUES(text_raw),
  text_md = VALUES(text_md),
  media_class = VALUES(media_class),
  entities = VALUES(entities),
  url = VALUES(url)
`;

const BATCH_SIZE = 100;

// Временные ошибки (deadlock, lock wait, обрыв соединения) — имеет смысл
// повторить; всё остальное — постоянная ошибка строки/схемы.
const TEMPORARY_CODES = new Set([
  1213, // ER_LOCK_DEADLOCK
  1205, // ER_LOCK_WAIT_TIMEOUT
  "ETIMEDOUT",
  "ECONNRESET",
  "PROTOCOL_CONNECTION_LOST",
]);

function isTemporary(err) {
  if (!err) return false;
  return TEMPORARY_CODES.has(err.errno) || TEMPORARY_CODES.has(err.code);
}

async function withRetry(fn, attempts = 2, delayMs = 1500) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTemporary(err) || i >= attempts - 1) throw err;
      logWarn(`временная ошибка БД (${err.code || err.message}), повтор через ${delayMs} мс`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export async function openMysql(dbConfig) {
  let mysql;
  try {
    mysql = await import("mysql2/promise");
  } catch {
    throw new Error('драйвер mysql2 не установлен: cmd /c "npm i mysql2"');
  }

  const pool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port || 3306,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    connectionLimit: 5,
    waitForConnections: true,
    charset: "utf8mb4",
    connectTimeout: 10000,
  });

  // Проверяем подключение сразу — с понятной ошибкой, до авторизации Telegram
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    await pool.end().catch(() => {});
    throw new Error(
      `нет подключения к MySQL на ${dbConfig.host}:${dbConfig.port || 3306} (${err.code || err.message})`
    );
  }
  logInfo(
    `MySQL: соединение с ${dbConfig.host}:${dbConfig.port || 3306}/${dbConfig.database} установлено`
  );

  return {
    async init() {
      await pool.query(SCHEMA_SQL);
      try {
        await pool.query(ALTER_ADD_TITLE_SQL);
      } catch (err) {
        if (err.errno !== 1060) throw err; // 1060: колонка уже добавлена
      }
    },

    // Бэкфилл названия канала для строк, залитых до появления channel_title
    async fillChannelTitle(channelId, title) {
      await pool.execute(
        "UPDATE messages SET channel_title = ? WHERE channel_id = ? AND channel_title IS NULL",
        [title, String(channelId)]
      );
    },

    async getMaxMessageId(channelId) {
      const [rows] = await pool.execute(
        "SELECT COALESCE(MAX(message_id), 0) AS maxId FROM messages WHERE channel_id = ?",
        [String(channelId)]
      );
      return Number(rows[0].maxId);
    },

    // valuesRows — массив строк buildRow().
    // Идемпотентность даёт INSERT ... ON DUPLICATE KEY UPDATE (проверка
    // присутствия = PRIMARY KEY (channel_id, message_id), без отдельного SELECT):
    // повторный запуск или гонка никогда не создают дублей.
    // Живучесть: если батч не встал — построчная вставка (одна плохая строка
    // не мешает остальным); неудачи логируются, а при их наличии кидаем
    // ошибку, чтобы чекпоинт не сдвинулся — следующий запуск дозальёт.
    async upsertMessages(valuesRows) {
      try {
        await withRetry(async () => {
          const conn = await pool.getConnection();
          try {
            await conn.beginTransaction();
            for (let i = 0; i < valuesRows.length; i += BATCH_SIZE) {
              await conn.query(UPSERT_SQL, [valuesRows.slice(i, i + BATCH_SIZE)]);
            }
            await conn.commit();
          } catch (err) {
            await conn.rollback().catch(() => {});
            throw err;
          } finally {
            conn.release();
          }
        });
        logInfo(`MySQL: вставлено строк: ${valuesRows.length}`);
        return;
      } catch (err) {
        logWarn(
          `батч вставки (${valuesRows.length} строк) не удался: ${err.message} — построчная вставка`
        );
      }

      const failed = [];
      for (const row of valuesRows) {
        try {
          await withRetry(() => pool.query(UPSERT_SQL, [[row]]));
        } catch (err) {
          failed.push(err);
          logError(`не вставлена строка message_id=${row[2]}:`, err.message);
        }
      }
      if (failed.length) {
        throw new Error(
          `вставлено ${valuesRows.length - failed.length} из ${valuesRows.length} строк ` +
            `(первая ошибка: ${failed[0].message}) — чекпоинт не сдвинут, повторный запуск дозальёт без дублей`
        );
      }
      logInfo(`MySQL: вставлено строк: ${valuesRows.length} (построчно)`);
    },

    async close() {
      await pool.end();
    },
  };
}
