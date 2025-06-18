FROM node:20-slim

ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
ENV LANG=C.UTF-8

WORKDIR /app

COPY package*.json ./

# 使用 install 方式并关闭审计，提高部署容忍度
RUN npm install --omit=dev --no-audit

# 拷贝其余源代码
COPY . .

EXPOSE 8080

CMD [ "npm", "start" ]
