FROM node:20-slim

ENV NODE_ENV=production
ENV DATA_DIR=/data

WORKDIR /app

# better-sqlite3 compiles from source when prebuilt binaries can't be
# downloaded (e.g. no GitHub access from the build host).
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

RUN mkdir -p /data && chmod 777 /data

EXPOSE 3000

CMD ["node", "src/server.js"]