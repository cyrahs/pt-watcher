FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY src/server ./src/server
COPY drizzle ./drizzle
# 版本标记：CI 传入提交 SHA，运行时在 /api/status、启动事件与系统快照中可见。
# 放在最后，避免每次提交都让前面的依赖安装层缓存失效
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
EXPOSE 3000
CMD ["bun", "src/server/index.ts"]
