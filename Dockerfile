FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
COPY server.js ./
COPY public ./public
COPY data ./data

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "start"]
