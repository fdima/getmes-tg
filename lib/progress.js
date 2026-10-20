import readline from "node:readline";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function elapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function phaseLabel(phase) {
  return ({
    prepare: "подготовка",
    fetch: "Telegram",
    delay: "пауза",
    floodWait: "FloodWait",
    markdown: "Markdown",
    mysql: "MySQL",
    commit: "запись",
  })[phase] || phase || "работает";
}

function trimLine(text, columns) {
  const width = Number.isInteger(columns) && columns > 10 ? columns : 120;
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(1, width - 1))}…`;
}

export function createProgress(options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const now = options.now || Date.now;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const requestedMode = options.mode || "auto";
  let renderer = requestedMode === "off"
    ? "off"
    : requestedMode === "plain" || !stdout.isTTY
      ? "plain"
      : "tty";
  const startedAt = now();
  const channels = new Map();
  for (const [index, channel] of (options.channels || []).entries()) {
    channels.set(String(channel.id), {
      id: String(channel.id),
      title: channel.title,
      status: "queued",
      order: index,
      phase: "ожидание",
      pages: 0,
      messages: 0,
      lastMessageId: 0,
      startedAt: 0,
      detail: "",
    });
  }

  let pages = 0;
  let messages = 0;
  let stopped = false;
  let renderedLines = 0;
  let frame = 0;
  let heartbeatTimer;
  let renderTimer;
  const exitCleanup = () => clearPanel();

  function snapshot() {
    const list = [...channels.values()];
    const active = list.filter((item) => item.status === "active");
    return {
      total: list.length,
      completed: list.filter((item) => item.status === "complete" || item.status === "error").length,
      failed: list.filter((item) => item.status === "error").length,
      active: active.length,
      queued: list.filter((item) => item.status === "queued").length,
      pages,
      messages,
      elapsedMs: now() - startedAt,
      activeChannels: active.sort((a, b) => a.order - b.order).map((item) => ({ ...item })),
    };
  }

  function clearPanel() {
    if (renderer !== "tty" || renderedLines === 0) return;
    try {
      readline.moveCursor(stdout, 0, -renderedLines);
      readline.clearScreenDown(stdout);
      renderedLines = 0;
    } catch {
      renderedLines = 0;
      renderer = "plain";
      startPlain();
    }
  }

  function ttyLines() {
    const state = snapshot();
    const name = ({ export: "Экспорт", db: "MySQL", full: "Полная выгрузка" })[options.runMode] || "Выгрузка";
    const errors = state.failed ? ` • ошибок ${state.failed}` : "";
    const lines = [
      `${name}: ${state.completed}/${state.total} каналов • активно ${state.active} • ожидает ${state.queued}${errors} • ${elapsed(state.elapsedMs)}`,
    ];
    for (const item of state.activeChannels.slice(0, options.concurrency || state.activeChannels.length)) {
      const stats = [];
      if (item.pages) stats.push(`стр. ${item.pages}`);
      if (item.messages) stats.push(`${item.messages} сообщ.`);
      if (item.lastMessageId) stats.push(`#${item.lastMessageId}`);
      if (item.detail) stats.push(item.detail);
      lines.push(`${FRAMES[frame % FRAMES.length]} ${item.title} • ${phaseLabel(item.phase)}${stats.length ? ` • ${stats.join(" • ")}` : ""}`);
    }
    return lines.map((line) => trimLine(line, stdout.columns));
  }

  function renderTty() {
    if (stopped || renderer !== "tty") return;
    try {
      clearPanel();
      const lines = ttyLines();
      stdout.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
      frame++;
    } catch {
      clearPanel();
      renderer = "plain";
      startPlain();
    }
  }

  function scheduleTty(delay = 0) {
    if (stopped || renderer !== "tty" || renderTimer) return;
    renderTimer = setTimeoutFn(() => {
      renderTimer = undefined;
      renderTty();
      scheduleTty(250);
    }, delay);
    renderTimer?.unref?.();
  }

  function plainLine() {
    const state = snapshot();
    const errors = state.failed ? `, ошибок ${state.failed}` : "";
    const flood = state.activeChannels.find((item) => item.phase === "floodWait");
    return `[прогресс ${elapsed(state.elapsedMs)}] завершено ${state.completed}/${state.total}, активно ${state.active}, ожидает ${state.queued}, страниц ${state.pages}, сообщений ${state.messages}${errors}${flood ? `, FloodWait: ${flood.title}${flood.detail ? ` ${flood.detail}` : ""}` : ""}`;
  }

  function startPlain() {
    if (stopped || renderer !== "plain" || heartbeatTimer) return;
    heartbeatTimer = setIntervalFn(() => {
      if (!stopped) stdout.write(`${plainLine()}\n`);
    }, options.intervalMs || 10000);
    heartbeatTimer?.unref?.();
  }

  function changed() {
    if (renderer === "tty") scheduleTty(renderedLines ? 50 : (options.ttyDelayMs ?? 300));
  }

  function get(channelId) {
    return channels.get(String(channelId));
  }

  function channelStart(channelId) {
    const item = get(channelId);
    if (!item || item.status !== "queued") return;
    item.status = "active";
    item.phase = "prepare";
    item.startedAt = now();
    changed();
  }

  function channelPhase(channelId, phase, detail = "") {
    const item = get(channelId);
    if (!item || item.status !== "active") return;
    item.phase = phase;
    item.detail = detail;
    changed();
  }

  function fetchPage(channelId, details = {}) {
    const item = get(channelId);
    if (!item || item.status !== "active") return;
    const previousPages = item.pages;
    const previousMessages = item.messages;
    item.phase = "fetch";
    item.detail = "";
    item.pages = Number(details.page) || previousPages;
    item.messages = Number(details.totalMessages) || 0;
    item.lastMessageId = Number(details.lastMessageId) || item.lastMessageId;
    pages += Math.max(0, item.pages - previousPages);
    messages += Math.max(0, item.messages - previousMessages);
    changed();
  }

  function fetchEvent(channelId, event, details = {}) {
    if (event === "page") return fetchPage(channelId, details);
    if (event === "request") return channelPhase(channelId, "fetch");
    if (event === "delay") return channelPhase(channelId, "delay", `${Math.ceil((details.ms || 0) / 1000)} с`);
    if (event === "floodWait") return channelPhase(channelId, "floodWait", `${Math.ceil((details.ms || 0) / 1000)} с`);
    if (event === "complete") return channelPhase(channelId, "commit");
  }

  function channelComplete(channelId, { failed = false } = {}) {
    const item = get(channelId);
    if (!item || (item.status !== "active" && item.status !== "queued")) return;
    item.status = failed ? "error" : "complete";
    item.phase = failed ? "ошибка" : "готово";
    item.detail = "";
    changed();
  }

  function permanent(stream, line) {
    clearPanel();
    stream.write(`${line}\n`);
    if (!stopped && renderer === "tty") renderTty();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (heartbeatTimer) clearIntervalFn(heartbeatTimer);
    if (renderTimer) clearTimeoutFn(renderTimer);
    heartbeatTimer = undefined;
    renderTimer = undefined;
    clearPanel();
    process.removeListener("exit", exitCleanup);
  }

  process.once("exit", exitCleanup);
  if (renderer === "plain") startPlain();
  if (renderer === "tty") scheduleTty(options.ttyDelayMs ?? 300);

  return {
    get mode() { return renderer; },
    snapshot,
    channelStart,
    channelPhase,
    fetchEvent,
    channelComplete,
    channelError(channelId) { channelComplete(channelId, { failed: true }); },
    out(line) { permanent(stdout, line); },
    error(line) { permanent(stderr, line); },
    render() { if (renderer === "tty") renderTty(); },
    heartbeat() { if (renderer === "plain" && !stopped) stdout.write(`${plainLine()}\n`); },
    stop,
  };
}
