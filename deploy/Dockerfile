FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY vendor ./vendor
ENV NODE_ENV=production
EXPOSE 4874
CMD ["node", "src/server.mjs"]
