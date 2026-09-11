FROM node:20-slim

WORKDIR /app

# gosu is needed by the entrypoint to drop from root to the node user after
# fixing volume ownership (prevents SQLITE_READONLY on pre-existing volumes).
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

# NODE_ENV=production also makes Express install its production error handler,
# so unhandled route errors no longer render a stack trace to the client.
ENV NODE_ENV=production

# npm ci against the committed lockfile — every build resolves to the exact
# versions that were reviewed, and two builds of the same commit are identical.
# (npm install would re-resolve every caret range at build time.)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && (test -d node_modules/@node-rs/argon2 \
    || (echo "ERROR: @node-rs/argon2 not installed" && exit 1))

COPY src/ ./src/
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

RUN mkdir -p /app/data && chown node:node /app/data

EXPOSE 3000

# Note: no USER instruction here intentionally. The container starts as root
# so the entrypoint can fix volume ownership (chown /app/data), then uses gosu
# to permanently drop privileges to the non-root "node" user before exec-ing
# the application. The runtime process is always non-root.
ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "src/index.js"]
