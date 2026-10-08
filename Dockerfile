# syntax=docker/dockerfile:1
# ===== getmes-tg: образ для раскатки (cron каждые 3 минуты) =====
# Две стадии на минималистичных Alpine-образах:
#   build   — npm ci; кэш npm и промежуточные файлы остаются в этом слое
#             и в итоговый образ не переносятся;
#   runtime — только нужные файлы приложения и node_modules; busybox crond
#             уже есть в Alpine, из пакетов добавляются лишь tzdata (корректный
#             TZ в логах и cron) и su-exec (запуск задач от пользователя node).
#
# Секреты (config.yaml, config.docker.yaml, session.txt), данные (output/,
# state/, logs/) и тесты в образ НЕ попадают: и точечные COPY ниже,
# и .dockerignore.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Только рабочие файлы: тесты, README, PLAN и конфиги не нужны
COPY export.js ./
COPY lib ./lib

FROM node:22-alpine AS runtime
RUN apk add --no-cache tzdata su-exec
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/home/node
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/export.js ./export.js
COPY --from=build /app/lib ./lib
COPY docker/cron.sh ./cron.sh
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh ./cron.sh
# Без USER: entrypoint (root) готовит каталоги/crontab, а задачи cron
# выполняет пользователь node (uid 1000 — как владелец файлов на хосте)
ENTRYPOINT ["/entrypoint.sh"]
