// Юнит-проверки конкурентного fetch/runtime — fake client, без сети.
// Запуск: npm test
import { resolveFetchConfig } from "./lib/config.js";
import { createRateLimiter, runPool } from "./lib/concurrency.js";
import { fetchChannelMessages } from "./lib/fetch.js";

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) console.log(`     ожидалось: ${JSON.stringify(expected)}\n     получено:  ${JSON.stringify(actual)}`);
}

const defaults = resolveFetchConfig({});
check("fetch: default concurrency", defaults.concurrency, 3);
check("fetch: default requestIntervalMs", defaults.requestIntervalMs, 150);
check("fetch: default pageDelayMs", defaults.pageDelayMs, 500);
check("fetch: default progressIntervalMs", defaults.progressIntervalMs, 10000);
check("fetch: repair default concurrency", resolveFetchConfig({}, { repair: true }).concurrency, 2);
check("fetch: repair ограничен общим concurrency", resolveFetchConfig({ fetch: { concurrency: 1, repairConcurrency: 5 } }, { repair: true }).concurrency, 1);
check("fetch: пользовательские значения", JSON.stringify(resolveFetchConfig({ fetch: { concurrency: 4, repairConcurrency: 3, requestIntervalMs: 0, pageDelayMs: 10, progressIntervalMs: 1000 } })), JSON.stringify({ concurrency: 4, requestIntervalMs: 0, pageDelayMs: 10, progressIntervalMs: 1000 }));
check("fetch: нижняя граница progressIntervalMs", resolveFetchConfig({ fetch: { progressIntervalMs: 1000 } }).progressIntervalMs, 1000);
check("fetch: верхняя граница progressIntervalMs", resolveFetchConfig({ fetch: { progressIntervalMs: 60000 } }).progressIntervalMs, 60000);

for (const [name, fetch, text] of [
  ["секция не объект", false, "секция fetch должна быть объектом"],
  ["concurrency ниже границы", { concurrency: 0 }, "fetch.concurrency"],
  ["concurrency не integer", { concurrency: 1.5 }, "fetch.concurrency"],
  ["repairConcurrency выше границы", { repairConcurrency: 6 }, "fetch.repairConcurrency"],
  ["requestIntervalMs ниже границы", { requestIntervalMs: -1 }, "fetch.requestIntervalMs"],
  ["pageDelayMs выше границы", { pageDelayMs: 10001 }, "fetch.pageDelayMs"],
  ["progressIntervalMs ниже границы", { progressIntervalMs: 999 }, "fetch.progressIntervalMs"],
  ["progressIntervalMs выше границы", { progressIntervalMs: 60001 }, "fetch.progressIntervalMs"],
  ["progressIntervalMs не integer", { progressIntervalMs: 1000.5 }, "fetch.progressIntervalMs"],
]) {
  let message = "";
  try { resolveFetchConfig({ fetch }); } catch (err) { message = err.message; }
  check(`fetch: ${name}`, message.includes(text), true);
}

let active = 0;
let maxActive = 0;
const pool = await runPool([30, 5, 5, 5], 2, async (ms) => {
  active++;
  maxActive = Math.max(maxActive, active);
  await new Promise((resolve) => setTimeout(resolve, ms));
  active--;
  return ms;
});
check("pool: лимит активных задач", maxActive, 2);
check("pool: порядок результатов исходный", pool.map((r) => r.value).join(","), "30,5,5,5");
const rejected = await runPool([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error("x"); return n; });
check("pool: ошибка одной задачи локальна", rejected.map((r) => r.status).join(","), "fulfilled,rejected,fulfilled");

let fakeNow = 0;
const waits = [];
const limiter = createRateLimiter(150, {
  now: () => fakeNow,
  wait: async (ms) => { waits.push(ms); fakeNow += ms; },
});
await Promise.all([limiter.run(() => "a"), limiter.run(() => "b"), limiter.run(() => "c")]);
check("limiter: интервалы между стартами", waits.join(","), "150,150");
limiter.pause(500);
await limiter.run(() => "d");
check("limiter: глобальная пауза", waits.at(-1), 500);

let releaseFirst;
const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
let secondStarted = false;
const overlapLimiter = createRateLimiter(0);
const pending = overlapLimiter.run(() => firstPending);
await overlapLimiter.run(() => { secondStarted = true; });
check("limiter: ответ первого запроса не блокирует старт второго", secondStarted, true);
releaseFirst();
await pending;

const first = Array.from({ length: 100 }, (_, i) => ({ id: 200 - i, date: 2000 }));
let page = 0;
let fetchError = "";
try {
  await fetchChannelMessages({ getMessages: async () => { page++; if (page === 2) throw new Error("page failed"); return first; } }, { id: "x", title: "X", startDate: "1970-01-01T00:00:00Z" }, { pageDelayMs: 0 });
} catch (err) { fetchError = err.message; }
check("fetch: ошибка второй страницы бросается наружу", fetchError.includes("page failed"), true);

const fetchEvents = [];
let eventPage = 0;
await fetchChannelMessages(
  { getMessages: async () => eventPage++ === 0 ? [{ id: 5, date: 2000 }, { id: 4, date: 2000 }] : [] },
  { id: "events", title: "Events", startDate: "1970-01-01T00:00:00Z" },
  { pageDelayMs: 0, progress: (event, details) => fetchEvents.push([event, details]) }
);
check("fetch: событие успешной страницы", fetchEvents.some(([event]) => event === "page"), true);
check("fetch: событие завершения", fetchEvents.at(-1)[0], "complete");
check("fetch: накопленное число сообщений в событии", fetchEvents.find(([event]) => event === "page")[1].totalMessages, 2);

const errorEvents = [];
try {
  await fetchChannelMessages(
    { getMessages: async () => { throw new Error("broken"); } },
    { id: "error", title: "Error", startDate: "1970-01-01T00:00:00Z" },
    { pageDelayMs: 0, progress: (event) => errorEvents.push(event) }
  );
} catch {}
check("fetch: ошибка страницы сообщает событие", errorEvents.includes("error"), true);
check("fetch: ошибка не сообщает завершение", errorEvents.includes("complete"), false);

const floodEvents = [];
let floodAttempt = 0;
const floodLimiter = { pause() {} };
await fetchChannelMessages(
  { getMessages: async () => { if (floodAttempt++ === 0) throw new Error("FLOOD_WAIT_2"); return []; } },
  { id: "flood", title: "Flood", startDate: "1970-01-01T00:00:00Z" },
  { pageDelayMs: 0, limiter: floodLimiter, progress: (event, details) => floodEvents.push([event, details]) }
);
check("fetch: FloodWait сообщает паузу", floodEvents.find(([event]) => event === "floodWait")[1].ms, 2000);

console.log(failed ? `\nПровалено: ${failed}` : "\nВсе проверки пройдены");
process.exit(failed ? 1 : 0);
