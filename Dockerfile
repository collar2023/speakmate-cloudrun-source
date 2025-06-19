# 使用官方 Node.js 18 LTS 镜像作为基础镜像
FROM node:18-slim

# 设置工作目录
WORKDIR /app

# 创建非 root 用户以提高安全性
RUN groupadd -r nodeuser && useradd -r -g nodeuser nodeuser

# 复制 package.json 和 package-lock.json（如果存在）
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production && npm cache clean --force

# 复制应用代码
COPY index.js ./

# 更改文件所有权为非 root 用户
RUN chown -R nodeuser:nodeuser /app

# 切换到非 root 用户
USER nodeuser

# 暴露端口（默认 8080，与 Cloud Run 兼容）
EXPOSE 8080

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=8080

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (res) => { \
    if (res.statusCode === 200) { \
      console.log('Health check passed'); \
      process.exit(0); \
    } else { \
      console.log('Health check failed'); \
      process.exit(1); \
    } \
  }).on('error', () => process.exit(1))"

# 启动应用
CMD ["npm", "start"]