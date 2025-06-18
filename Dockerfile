FROM node:20-slim

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
ENV LANG=C.UTF-8

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev --no-audit

COPY . .

EXPOSE 8080

CMD [ "npm", "start" ]
