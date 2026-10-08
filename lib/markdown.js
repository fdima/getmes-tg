import { messageUrl } from "./config.js";

// Текст сообщения с наложенными сущностями (сырой текст + entity → Markdown).
// Базовый текст — rawText: msg.text в gramjs уже отрендеренный Markdown.
export function renderMessageText(msg) {
  const raw = msg.rawText || "";
  if (msg.entities && msg.entities.length > 0) {
    return applyEntities(raw, msg.entities);
  }
  return raw;
}

// Форматирование сообщения в Markdown
export function formatMessageToMarkdown(msg, channelTitle, channelId) {
  const date = new Date(msg.date * 1000);
  const dateStr = date.toLocaleString("ru-RU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const lines = [];

  lines.push(`## Сообщение #${msg.id}`);
  lines.push(``);
  lines.push(`**Дата:** ${dateStr}`);
  lines.push(``);

  // Ссылка на само сообщение — отдельной строкой
  if (channelId !== undefined && channelId !== null) {
    lines.push(`**Ссылка:** ${messageUrl(channelId, msg.id)}`);
    lines.push(``);
  }

  const text = renderMessageText(msg);

  if (text) {
    lines.push(text);
    lines.push(``);
  }

  // Медиа
  if (msg.media) {
    lines.push(`*Медиа:* ${msg.media.className}`);
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(``);

  return lines.join("\n");
}

// Применение форматирования Telegram → Markdown
export function entityTags(entity) {
  const { className, url, userId } = entity;

  switch (className) {
    case "MessageEntityBold":
      return { open: "**", close: "**" };
    case "MessageEntityItalic":
      return { open: "*", close: "*" };
    case "MessageEntityCode":
      return { open: "`", close: "`" };
    case "MessageEntityPre":
      return { open: "```\n", close: "\n```" };
    case "MessageEntityStrike":
      return { open: "~~", close: "~~" };
    case "MessageEntityUnderline":
      return { open: "<u>", close: "</u>" };
    case "MessageEntityTextUrl":
      return url ? { open: "[", close: `](${url})` } : null;
    case "MessageEntityUrl":
    case "MessageEntityMention":
      return { open: "<", close: ">" };
    case "MessageEntityMentionName":
      return { open: "[", close: `](tg://user?id=${userId})` };
    default:
      return null;
  }
}

export function applyEntities(text, entities) {
  // Собираем маркеры в координатах ОРИГИНАЛЬНОГО текста и вставляем одним
  // проходом — так вложенные entity и entity с одинаковым offset не сбивают
  // позиции друг друга.
  const events = [];
  let order = 0;

  for (const entity of entities) {
    if (!entity || !entity.length) continue;

    const start = entity.offset;
    const end = entity.offset + entity.length;
    const idx = order++;

    // Цитата: "> " перед каждой строкой, попавшей в диапазон entity
    if (entity.className === "MessageEntityBlockquote") {
      events.push({ pos: start, kind: "open", span: entity.length, tag: "> ", idx });
      for (let i = text.indexOf("\n", start); i !== -1 && i + 1 < end; i = text.indexOf("\n", i + 1)) {
        events.push({ pos: i + 1, kind: "open", span: entity.length, tag: "> ", idx });
      }
      continue;
    }

    const tags = entityTags(entity);
    if (!tags) continue;

    events.push({ pos: start, kind: "open", span: entity.length, tag: tags.open, idx });
    events.push({ pos: end, kind: "close", span: entity.length, tag: tags.close, idx });
  }

  // Сортировка по позиции; на одной позиции закрывающие раньше открывающих.
  // Открывающие: сначала внешние (больший диапазон), закрывающие: сначала
  // внутренние. При равных диапазонах порядок объявления разворачивается —
  // это даёт корректную вложенность тегов.
  events.sort((a, b) => {
    if (a.pos !== b.pos) return a.pos - b.pos;
    if (a.kind !== b.kind) return a.kind === "close" ? -1 : 1;
    if (a.span !== b.span) {
      return a.kind === "open" ? b.span - a.span : a.span - b.span;
    }
    return a.kind === "open" ? b.idx - a.idx : a.idx - b.idx;
  });

  const out = [];
  let cursor = 0;

  for (const event of events) {
    const pos = Math.min(Math.max(event.pos, cursor), text.length);

    if (pos > cursor) {
      out.push(text.slice(cursor, pos));
      cursor = pos;
    }

    if (!event.tag) continue;

    // Соприкасающиеся закрытие и открытие одного стиля ("**текст****дальше")
    // сливаются в один непрерывный стиль — иначе Markdown ломается.
    if (event.kind === "open") {
      const last = out[out.length - 1];
      if (last && last.type === "tag" && last.kind === "close" && last.tag === event.tag && last.pos === pos) {
        out.pop();
        continue;
      }
    }

    out.push({ type: "tag", kind: event.kind, tag: event.tag, pos });
  }

  out.push(text.slice(cursor));

  return out.map((piece) => (typeof piece === "string" ? piece : piece.tag)).join("");
}
