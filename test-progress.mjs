// Юнит-проверки progress controller и renderers — fake stdout/clock, без сети и ожиданий.
// Запуск: npm test
import { createProgress } from "./lib/progress.js";

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) console.log(`     ожидалось: ${JSON.stringify(expected)}\n     получено:  ${JSON.stringify(actual)}`);
}

function output(isTTY = false, columns = 120) {
  return {
    isTTY,
    columns,
    text: "",
    write(value) { this.text += String(value); return true; },
  };
}

function timers() {
  const intervals = new Set();
  const timeouts = new Set();
  return {
    intervals,
    timeouts,
    setIntervalFn(fn) { const timer = { fn, unref() {} }; intervals.add(timer); return timer; },
    clearIntervalFn(timer) { intervals.delete(timer); },
    setTimeoutFn(fn) { const timer = { fn, unref() {} }; timeouts.add(timer); return timer; },
    clearTimeoutFn(timer) { timeouts.delete(timer); },
    runTimeout() { const timer = [...timeouts][0]; if (timer) { timeouts.delete(timer); timer.fn(); } },
    runInterval() { for (const timer of [...intervals]) timer.fn(); },
  };
}

let now = 0;
const plainOut = output(false);
const plainErr = output(false);
const plainTimers = timers();
const progress = createProgress({
  mode: "auto",
  runMode: "export",
  channels: [{ id: "1", title: "Первый" }, { id: "2", title: "Второй" }],
  stdout: plainOut,
  stderr: plainErr,
  now: () => now,
  ...plainTimers,
});
check("progress: auto вне TTY выбирает plain", progress.mode, "plain");
check("progress: начально все queued", progress.snapshot().queued, 2);
check("plain: до интервала вывода нет", plainOut.text, "");
progress.channelStart("1");
check("progress: start меняет active", progress.snapshot().active, 1);
check("progress: start уменьшает queued", progress.snapshot().queued, 1);
progress.fetchEvent("1", "page", { page: 1, totalMessages: 100, lastMessageId: 900 });
progress.fetchEvent("1", "page", { page: 2, totalMessages: 150, lastMessageId: 800 });
check("progress: страницы суммируются", progress.snapshot().pages, 2);
check("progress: сообщения не двойные", progress.snapshot().messages, 150);
progress.channelStart("2");
progress.fetchEvent("2", "page", { page: 1, totalMessages: 7, lastMessageId: 10 });
check("progress: каналы не смешивают сообщения", progress.snapshot().messages, 157);
now = 10000;
plainTimers.runInterval();
check("plain: heartbeat содержит счётчики", /завершено 0\/2, активно 2, ожидает 0, страниц 3, сообщений 157/.test(plainOut.text), true);
progress.fetchEvent("1", "floodWait", { ms: 28000 });
progress.heartbeat();
check("plain: FloodWait отражён", /FloodWait: Первый 28 с/.test(plainOut.text), true);
progress.out("Первый: готово");
check("plain: постоянный итог немедленный", plainOut.text.includes("Первый: готово\n"), true);
progress.error("! Второй: ошибка");
check("plain: ошибка немедленная", plainErr.text, "! Второй: ошибка\n");
progress.channelComplete("1");
progress.channelError("2");
check("progress: complete учитывает завершённые", progress.snapshot().completed, 2);
check("progress: error учитывает failed", progress.snapshot().failed, 1);
progress.channelComplete("1");
check("progress: повторное завершение безопасно", progress.snapshot().completed, 2);
progress.stop();
progress.stop();
const stoppedText = plainOut.text;
plainTimers.runInterval();
check("plain: после stop heartbeat отсутствует", plainOut.text, stoppedText);
check("progress: stop очищает interval", plainTimers.intervals.size, 0);

const offTimers = timers();
const off = createProgress({ mode: "off", channels: [], stdout: output(), stderr: output(), ...offTimers });
check("off: renderer отключён", off.mode, "off");
check("off: таймеры не создаются", offTimers.intervals.size + offTimers.timeouts.size, 0);
off.stop();

const ttyOut = output(true, 70);
const ttyErr = output(true, 70);
const ttyTimers = timers();
const tty = createProgress({
  mode: "auto",
  runMode: "full",
  concurrency: 2,
  channels: [{ id: "a", title: "Очень длинное название первого канала" }, { id: "b", title: "Второй" }, { id: "c", title: "Третий" }],
  stdout: ttyOut,
  stderr: ttyErr,
  ttyDelayMs: 0,
  ...ttyTimers,
});
check("progress: auto в TTY выбирает tty", tty.mode, "tty");
tty.channelStart("a");
tty.channelStart("b");
tty.channelStart("c");
tty.fetchEvent("a", "page", { page: 4, totalMessages: 387, lastMessageId: 80027 });
tty.render();
const ttyLines = ttyOut.text.trimEnd().split("\n");
check("tty: есть общая строка", ttyLines.some((line) => line.includes("0/3 каналов")), true);
check("tty: число строк ограничено concurrency", ttyLines.slice(-3).length, 3);
check("tty: строки не шире терминала", ttyLines.every((line) => line.length <= 70), true);
const order = tty.snapshot().activeChannels.map((item) => item.id).join(",");
check("tty: порядок активных каналов стабилен", order, "a,b,c");
tty.out("постоянная строка");
check("tty: постоянная строка выводится", ttyOut.text.includes("постоянная строка\n"), true);
tty.stop();
check("tty: stop очищает scheduler", ttyTimers.timeouts.size, 0);

console.log(failed ? `\nПровалено: ${failed}` : "\nВсе проверки пройдены");
process.exit(failed ? 1 : 0);
