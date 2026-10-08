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

// Получение сообщений из канала
export async function fetchChannelMessages(client, channelConfig) {
  const { id: channelId, title, startDate, lastMessageId } = channelConfig;

  console.log(`\n📥 Обработка канала: ${title} (${channelId})`);

  const startTimestamp = Math.floor(new Date(startDate).getTime() / 1000);

  // Формируем параметры запроса
  const params = {
    limit: 100,
  };

  // Если есть lastMessageId — запрашиваем только сообщения НОВЕЕ него.
  // В gramjs minId отсекает сообщения с id <= minId (клиентская фильтрация).
  if (lastMessageId) {
    params.minId = lastMessageId;
    console.log(`   ⏩ Новые сообщения после #${lastMessageId}`);
  } else {
    // Первоначальная выгрузка: начинаем с самых новых и идём вглубь
    console.log(`   🕐 Первоначальная выгрузка с ${startDate}`);
  }

  let allMessages = [];

  // Итеративная загрузка (пагинация)
  while (true) {
    let batch;

    try {
      batch = await client.getMessages(channelId, params);
    } catch (err) {
      console.error(`   ❌ Ошибка при получении сообщений: ${describeFetchError(err)}`);
      break;
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
    await new Promise((r) => setTimeout(r, 500));
  }

  // Сортируем по ID (от старых к новым для удобства чтения)
  allMessages.sort((a, b) => a.id - b.id);

  console.log(`   ✅ Найдено сообщений: ${allMessages.length}`);

  return allMessages;
}
