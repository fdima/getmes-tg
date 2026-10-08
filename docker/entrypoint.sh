#!/bin/sh
# Точка входа контейнера getmes-tg.
#   - без аргументов: демон-режим — готовит каталоги, генерирует crontab
#     по переменным RUN_EXPORT / RUN_DB / CRON_SCHEDULE / TZ и запускает
#     busybox crond в foreground (PID 1);
#   - с аргументами: разовый запуск
#     (docker compose run --rm app node export.js export ...).
set -eu
cd /app

RUN_EXPORT="${RUN_EXPORT:-1}"
RUN_DB="${RUN_DB:-1}"
CRON_SCHEDULE="${CRON_SCHEDULE:-*/3 * * * *}"
TZ="${TZ:-Europe/Moscow}"
export TZ
CONSOLE_LOG="/app/logs/cron-console.log"

# Разовые команды — от пользователя node (uid 1000), чтобы файлы на
# bind-монтированиях не переходили владельцу root
if [ "$#" -gt 0 ]; then
  exec su-exec node "$@"
fi

# Быстрая диагностика ошибок монтирования: если файла на хосте нет,
# docker монтирует вместо него КАТАЛОГ
if [ ! -f /app/config.yaml ]; then
  {
    echo "[entrypoint] ОШИБКА: /app/config.yaml — не файл."
    echo "[entrypoint] На хосте нужен config.docker.yaml (db.host: mysql):"
    echo "[entrypoint]   sed 's/host: 127.0.0.1/host: mysql/' config.yaml > config.docker.yaml"
  } >&2
  exit 1
fi
if [ -d /app/session.txt ]; then
  {
    echo "[entrypoint] ОШИБКА: на хосте ./session.txt — каталог, а не файл."
    echo "[entrypoint] Удалите его и создайте пустой файл:"
    echo "[entrypoint]   rm -rf session.txt && touch session.txt"
  } >&2
  exit 1
fi
[ -f /app/session.txt ] || touch /app/session.txt

mkdir -p /app/output /app/state /app/logs
touch "$CONSOLE_LOG"
chown -R node:node /app/output /app/state /app/logs /app/session.txt

# Banner — первой строкой docker logs, до запуска tail
echo "[entrypoint] cron: '$CRON_SCHEDULE' | export=$RUN_EXPORT db=$RUN_DB | TZ=$TZ"

# Вывод cron-задач — в docker logs. Задачи выполняются от node, которому
# запись в /proc/1/fd/1 запрещена, поэтому crond пишет в файл, а фоновый
# tail транслирует его в stdout контейнера. «-n 0» — при рестарте не
# дописывать в лог хвост прошлых тиков.
tail -n 0 -f "$CONSOLE_LOG" &

# crontab генерируется на старте: так переменные контейнера гарантированно
# попадают в задачу (busybox crond не сохраняет среду процесса целиком),
# а при RUN_EXPORT=0 и RUN_DB=0 расписание просто не создаётся.
# ВАЖНО: файл crontab должен принадлежать root (иначе busybox crond его
# игнорирует), а имя файла задаёт пользователя задачи — node.
CRONTAB="/etc/crontabs/node"
{
  echo "# Сгенерировано entrypoint.sh при старте контейнера — не правьте руками."
  if [ "$RUN_EXPORT" = "1" ] || [ "$RUN_DB" = "1" ]; then
    printf '%s TZ=%s RUN_EXPORT=%s RUN_DB=%s /bin/sh /app/cron.sh >> %s 2>&1\n' \
      "$CRON_SCHEDULE" "$TZ" "$RUN_EXPORT" "$RUN_DB" "$CONSOLE_LOG"
  fi
} > "$CRONTAB"
chown root:root "$CRONTAB"
chmod 600 "$CRONTAB"

# Собственный лог crond (старт задач, ошибки запуска): файл заранее создаётся
# от node, чтобы root-запись не меняла владельца на хосте
CROND_LOG="/app/logs/crond.log"
touch "$CROND_LOG"
chown node:node "$CROND_LOG"

# Старые lock-каталоги (после kill -9 или рестарта) — снять, иначе
# режим навсегда залочится
rm -rf /tmp/getmes-tg-*.lock

# crond — PID 1 в foreground: SIGTERM от docker stop останавливает контейнер.
# -c обязателен: в этой сборке busybox дефолтный каталог — /var/spool/cron/crontabs
exec crond -f -l 6 -c /etc/crontabs -L "$CROND_LOG"
