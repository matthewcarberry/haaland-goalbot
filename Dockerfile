FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

RUN mkdir -p /app/gifs /app/data

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
