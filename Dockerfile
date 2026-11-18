FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache tzdata curl

ENV NODE_ENV=production \
    PORT=3000 \
    TZ=Europe/Zurich \
    DATA_DIR=/app/data \
    OLLAMA_URL=http://ollama:11434 \
    SMART_MODEL=llama3.1:latest \
    GEMINI_API_KEY="" \
    GEMINI_MODEL=gemini-flash-latest

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server/ ./server/
COPY public/ ./public/

VOLUME ["/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/health || exit 1

CMD ["node", "server/index.js"]
