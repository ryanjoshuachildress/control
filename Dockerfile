FROM node:20-slim

ENV NODE_ENV=production
ENV DATA_DIR=/data

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

RUN mkdir -p /data && chmod 777 /data

EXPOSE 3000

CMD ["node", "src/server.js"]