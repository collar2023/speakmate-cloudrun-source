# 使用官方 Node.js 精简镜像
FROM node:20-slim

# 设置生产环境变量
ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
ENV LANG=C.UTF-8

# ✅ 安装 git（用于支持 npm 安装 GitHub 源依赖）
RUN apt-get update && apt-get install -y git && apt-get clean

# 设置工作目录
WORKDIR /app

# 复制 package.json 和 package-lock.json（若有）
COPY package*.json ./

# 安装依赖，排除 devDependencies，并跳过 npm 安全审计
RUN npm install --omit=dev --no-audit

# 复制项目全部文件
COPY . .

# 启动入口
CMD ["node", "index.js"]
