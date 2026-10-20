// Ошибка из-за недоступного канала приходит как CHANNEL_INVALID от GetChannels,
// а «сырое» сообщение gramjs отсылает к документации telethon — заменяем на
// внятное объяснение с указанием канала.
function describeFetchError(err) {
  const msg = (err && (err.errorMessage || err.message)) || String(err);
  if (/CHANNEL_INVALID|CHANNEL_PRIVACY|CHANNEL_PRIVATE|PEER_ID_INVALID/.test(msg)) {
    return `канал недоступен этому аккаунту (${msg}) — проверьте id в конфиге или подпишитесь на канал`;
  }
  return msg;
}

function floodWaitMs(err) {
  const msg = (err && (err.errorMessage || err.message)) || "";
  const match = msg.match(/FLOOD_WAIT_?(\d+)/i);
  return match ? Number(match[1]) * 1000 : 0;
}

// Получение сообщений из канала. Пагинация одного канала последовательна,
// но request может пропускать каждый запрос через общий limiter.
export async function fetchChannelMessages(client, channelConfig, runtime = {}) {
  const { id: channelId, title, startDate, lastMessageId } = channelConfig;
  const pageDelayMs = runtime.pageDelayMs ?? 500;
  const request = runtime.request || ((id, params) => client.getMessages(id, params));
  const log = runtime.log || {
    info: (...args) => console.log(...args),
    error: (...args) => console.error(...args),
  };
  const progress = typeof runtime.progress === "function" ? runtime.progress : () => {};

  log.info("fetch", `обработка канала ${title} (${channelId})`);

  const startTimestamp = Math.floor(new Date(startDate).getTime() / 1000);

  // Формируем параметры запроса
  const params = {
    limit: 100,
  };

  // Если есть lastMessageId — запрашиваем только сообщения НОВЕЕ него.
  // В gramjs minId отсекает сообщения с id <= minId (клиентская фильтрация).
  if (lastMessageId) {
    params.minId = lastMessageId;
    log.info("fetch", `новые сообщения после #${lastMessageId}`);
  } else {
    // Первоначальная выгрузка: начинаем с самых новых и идём вглубь
    log.info("fetch", `первоначальная выгрузка с ${startDate}`);
  }

  let allMessages = [];
  let page = 0;

  // Итеративная загрузка (пагинация)
  while (true) {
    let batch;

    let attempts = 0;
    while (true) {
      try {
        // После FloodWait сохраняем видимую фазу паузы до успешного ответа:
        // повторный request ждёт глобальный limiter и не должен преждевременно
        // выглядеть как возобновившийся сетевой запрос.
        if (attempts === 0) progress("request", { page: page + 1 });
        batch = await request(channelId, { ...params });
        break;
      } catch (err) {
        const waitMs = floodWaitMs(err);
        if (waitMs > 0 && runtime.limiter && attempts < 1) {
          attempts++;
          runtime.limiter.pause(waitMs);
          progress("floodWait", { ms: waitMs, page: page + 1 });
          log.info("fetch", `FloodWait ${Math.ceil(waitMs / 1000)} с, повтор запроса`);
          continue;
        }
        const described = describeFetchError(err);
        log.error("fetch", `ошибка при получении сообщений: ${described}`);
        progress("error", { page: page + 1, error: described });
        throw new Error(described, { cause: err });
      }
    }

    if (!batch || batch.length === 0) {
      break;
    }

    // Фильтруем: новые сообщения по ID, первоначальную выгрузку — по дате
    let filtered;
    if (lastMessageId) {
      filtered = batch.filter((msg) => msg.id > lastMessageId);
    } else {
      filtered = batch.filter((msg) => msg.date >= startTimestamp);
    }

    allMessages.push(...filtered);
    page++;
    progress("page", {
      page,
      pageMessages: filtered.length,
      totalMessages: allMessages.length,
      lastMessageId: batch[batch.length - 1]?.id || 0,
    });

    // Если в батче попались уже выгруженные (или старше startDate) сообщения —
    // дальше листать не нужно
    if (filtered.length < batch.length) {
      break;
    }

    // Если сообщений в батче меньше лимита — значит, история закончилась
    if (batch.length < params.limit) {
      break;
    }

    // Сдвигаем offsetId для следующей итерации
    params.offsetId = batch[batch.length - 1].id;

    // Небольшая пауза, чтобы не получить FloodWait
    if (pageDelayMs > 0) {
      progress("delay", { ms: pageDelayMs, page });
      await (runtime.sleep
        ? runtime.sleep(pageDelayMs)
        : new Promise((resolve) => setTimeout(resolve, pageDelayMs)));
    }
  }

  // Сортируем по ID (от старых к новым для удобства чтения)
  allMessages.sort((a, b) => a.id - b.id);

  log.info("fetch", `найдено сообщений: ${allMessages.length}`);
  progress("complete", { pages: page, totalMessages: allMessages.length });

  return allMessages;
}
