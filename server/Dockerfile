FROM node:20-alpine

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY src/ ./src/

# Copy the built Svelte client if it exists (build client first: cd client && npm run build)
COPY --chown=node:node . .

EXPOSE 3000

USER node

CMD ["node", "src/index.js"]
