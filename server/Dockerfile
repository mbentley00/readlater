# node:22-slim (Debian/glibc) so better-sqlite3's prebuilt binary is used —
# alpine/musl would compile it from source.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js web.js db.js ./
ENV READLATER_DATA_DIR=/data \
    PORT=8090
EXPOSE 8090
CMD ["node", "server.js"]
