import fs from "fs";
import { messageUrl } from "./config.js";

// Проверки до авторизации — чтобы не логиниться зря при ошибке в параметрах.
// Возвращает текст ошибки или null.
export function validateSend(values, config) {
  const chat = values.chat || (config.send && config.send.defaultChat);
  if (!chat) {
    return "не указан получатель: задайте --chat либо поле send.defaultChat в конфиге";
  }
  if (values.text && values["text-file"]) {
    return "--text и --text-file одновременно использовать нельзя";
  }
  if (!values.text && !values["text-file"] && !values.file) {
    return "нет данных для отправки: укажите --text, --text-file или --file";
  }
  if (values["text-file"] && !fs.existsSync(values["text-file"])) {
    return `файл не найден: ${values["text-file"]}`;
  }
  if (values.file && !fs.existsSync(values.file)) {
    return `файл не найден: ${values.file}`;
  }
  return null;
}

export function readMessageText(values) {
  if (values.text) return values.text;
  if (values["text-file"]) return fs.readFileSync(values["text-file"], "utf-8");
  return undefined;
}

function resolveTarget(chat) {
  return /^-?\d+$/.test(String(chat)) ? Number(chat) : String(chat);
}

async function messageLink(client, target, sent) {
  try {
    const entity = await client.getEntity(target);
    if (entity && entity.username) {
      return `https://t.me/${entity.username}/${sent.id}`;
    }
    const chatId = sent.chatId;
    if (chatId !== undefined && chatId !== null && String(chatId).startsWith("-100")) {
      return messageUrl(chatId, sent.id);
    }
  } catch (err) {
    // ссылку построить не удалось — вернём null
  }
  return null;
}

// Отправка текста и/или файла. Возвращает { id, url }.
export async function sendToChat(client, { chat, text, file, plain }) {
  const target = resolveTarget(chat);
  // Без --plain используется встроенный markdown-парсер gramjs
  // (**жирный**, __курсив__, ~~зачёркнутый~~, `код`, блок кода).
  // parseMode: false — отправить текст дословно, без разметки.
  const parseMode = plain ? false : "markdown";

  let sent;
  if (file) {
    sent = await client.sendFile(target, {
      file,
      caption: text !== undefined ? text : "",
      parseMode: text !== undefined ? parseMode : false,
    });
  } else {
    sent = await client.sendMessage(target, { message: text, parseMode });
  }

  return { id: sent.id, url: await messageLink(client, target, sent) };
}
