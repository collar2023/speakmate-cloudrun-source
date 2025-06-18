# 使用官方的Node.js 20镜像
FROM node:20-slim

# 设置工作目录
WORKDIR /usr/src/app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm install

# 复制应用代码
COPY . .

# 暴露应用监听的端口
EXPOSE 8080

# 启动应用的命令
CMD [ "npm", "start" ]