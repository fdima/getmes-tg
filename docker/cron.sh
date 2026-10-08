#!/bin/sh
# Одна cron-задача: последовательно режимы export (output/*.md) и db (MySQL).
# Независимые чекпоинты (PLAN/plan 6.md) делают такой запуск безопасным.
#
# У каждого режима свой lock: если предыдущий тик ещё не закончил работу
# (например, первичная заливка ушла в долгой fetch), следующий тик его
# пропускает — два параллельных запуска одного режима не поддерживаются.
# Lock живёт в /tmp контейнера; зависшие (после kill -9) снимаются по
# отсутствию процесса или при старте контейнера (см. entrypoint.sh).
set -u
cd /app

RUN_EXPORT="${RUN_EXPORT:-1}"
RUN_DB="${RUN_DB:-1}"

run_mode() {
  mode="$1"
  lock="/tmp/getmes-tg-$mode.lock"

  if ! mkdir "$lock" 2>/dev/null; then
    if pgrep -f "export.js $mode" >/dev/null 2>&1; then
      echo "[cron] $mode: предыдущий запуск ещё идёт — тик пропущен ($(date '+%F %T'))"
      return 0
    fi
    # Процесса нет — lock завис после аварийной останова, снимаем
    rmdir "$lock" 2>/dev/null || true
    mkdir "$lock" 2>/dev/null || return 0
  fi

  # Лок снимается в любом исходе, включая сигнал остановки контейнера
  trap 'rmdir "$lock" 2>/dev/null || true' EXIT INT TERM HUP
  echo "[cron] $mode: старт $(date '+%F %T')"
  node export.js "$mode"
  rc=$?
  echo "[cron] $mode: финиш $(date '+%F %T') (код $rc)"
  rmdir "$lock" 2>/dev/null || true
  trap - EXIT INT TERM HUP
  return $rc
}

rc=0
if [ "$RUN_EXPORT" = "1" ]; then
  run_mode export || rc=1
fi
if [ "$RUN_DB" = "1" ]; then
  run_mode db || rc=1
fi
exit $rc
