# 使用官方 Node.js 20 的瘦身版本
FROM node:20-slim

# 避免无效区域设置警告
ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
ENV LANG=C.UTF-8

# 设置工作目录
WORKDIR /app

# 优先复制依赖文件用于缓存利用
COPY package*.json ./

# 安装依赖（使用 ci 更稳定，如无 lock 文件可改为 install）
RUN npm ci --omit=dev --no-audit

# 复制其余应用代码
COPY . .

# 默认监听端口（仅供本地调试参考，Cloud Run 不强制需要）
EXPOSE 8080

# 启动应用
CMD [ "npm", "start" ]
