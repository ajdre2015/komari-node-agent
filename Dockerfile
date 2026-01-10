FROM node:20-bullseye-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm i --omit=dev

COPY . .

ENV NODE_ENV=production
CMD ["node", "index.js"]
