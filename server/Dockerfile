FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN echo "=== package.json ===" && cat package.json \
    && echo "=== installing ===" \
    && npm install --omit=dev \
    && echo "=== node_modules/@node-rs ===" \
    && ls -la node_modules/@node-rs/ 2>/dev/null || true \
    && echo "=== grep argon ===" \
    && ls node_modules/ | grep -i argon || true \
    && test -d node_modules/@node-rs/argon2 \
    || (echo "ERROR: @node-rs/argon2 not installed" && exit 1)

COPY src/ ./src/

RUN mkdir -p /app/data && chown node:node /app/data

EXPOSE 3000

CMD ["node", "src/index.js"]
