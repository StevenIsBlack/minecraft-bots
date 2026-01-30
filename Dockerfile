FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install mineflayer prismarine-auth express
COPY . .
CMD ["node", "bot.js"]
