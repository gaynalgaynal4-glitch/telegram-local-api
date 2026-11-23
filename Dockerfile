FROM aiogram/telegram-bot-api:latest

# Add Node.js to the Alpine-based image. Node manages the gateway and cleanup API.
RUN apk add --no-cache nodejs

WORKDIR /app
COPY server.js /app/server.js

ENV TELEGRAM_HTTP_PORT=8081 \
    TELEGRAM_WORK_DIR=/tmp/telegram-bot-api-data \
    TELEGRAM_TEMP_DIR=/tmp/telegram-bot-api-temp \
    MAX_REQUEST_MB=210

EXPOSE 10000

# Override the base image entrypoint so Node starts first and manages the engine.
ENTRYPOINT ["node", "/app/server.js"]
