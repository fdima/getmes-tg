import fs from "fs";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import { resolveProxyConfig } from "./config.js";
import { logInfo, muteConsoleStderr } from "./logger.js";

// Загрузка сохранённой сессии
export function loadSession(sessionFile) {
  try {
    if (fs.existsSync(sessionFile)) {
      const saved = fs.readFileSync(sessionFile, "utf-8").trim();
      if (saved) {
        // В gramjs сессия восстанавливается через конструктор StringSession.
        // Сам клиент вызовет session.load() при подключении.
        return new StringSession(saved);
      }
    }
  } catch (err) {
    console.warn("⚠️  Не удалось восстановить сессию, потребуется повторный вход:", err.message);
  }

  return new StringSession("");
}

// Создание клиента и авторизация (интерактивно, если сессии нет)
export async function authorize(config) {
  // Секция proxy разбирается ДО создания клиента: кривая конфигурация
  // (CliError) завершает работу с понятным сообщением, не логиня аккаунт.
  const proxy = resolveProxyConfig(config);

  const session = loadSession(config.api.sessionFile);

  const client = new TelegramClient(session, config.api.apiId, config.api.apiHash, {
    connectionRetries: 5,
    ...(proxy ? { proxy } : {}),
  });

  if (proxy) {
    // Только адрес и тип — пароль в лог не пишем
    logInfo(`прокси: включён, SOCKS${proxy.socksType} ${proxy.ip}:${proxy.port}`);
  } else {
    logInfo("прокси: выключен (прямое подключение)");
  }

  // Явно подключаемся и проверяем результат: client.connect() при неудаче
  // (после всех ретраев) возвращает false, а НЕ бросает — без этой проверки
  // client.start() зависает на мёртвом соединении, промис утекает и процесс
  // молча завершается с кодом 0, не выдав ошибки.
  // Ошибки ретраев (5× сырые трейсы socks, в т.ч. с опциями прокси) при этом
  // уходят только в лог-файл, не засоряя консоль.
  let connected;
  const restoreStderr = muteConsoleStderr();
  try {
    connected = await client.connect();
  } finally {
    restoreStderr();
  }
  if (!connected) {
    throw new Error(
      proxy
        ? `не удалось подключиться к Telegram через прокси SOCKS${proxy.socksType} ${proxy.ip}:${proxy.port} за 5 попыток — проверьте доступность прокси и то, что он разрешает соединения к серверам Telegram (149.154.167.50:80 и др.), либо отключите прокси (proxy: false)`
        : "не удалось подключиться к Telegram за 5 попыток — проверьте доступность сети/интернета"
    );
  }

  await client.start({
    phoneNumber: async () => await input.text("Введите номер телефона: "),
    password: async () => await input.text("Введите пароль (если есть): "),
    phoneCode: async () => await input.text("Введите код из Telegram: "),
    onError: (err) => console.error("Ошибка авторизации:", err),
  });

  // Сохраняем сессию для следующих запусков
  const sessionString = client.session.save();
  fs.writeFileSync(config.api.sessionFile, sessionString, "utf-8");

  console.log("✅ Авторизация выполнена");

  return client;
}
