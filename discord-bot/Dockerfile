# OnYourSite Discord-Bot – schlankes Image ohne Zugangsdaten (die kommen zur Laufzeit aus .env)
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY index.js ./
COPY src ./src
# Nicht als root laufen
USER node
ENV OYS_BOT_RUNTIME=docker
CMD ["node", "index.js"]
