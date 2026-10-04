# KokuuPanel 生产镜像
#
# 两阶段：先在 builder 里构建前端，再把产物与后端运行时一起塞进最终镜像。
# 最终镜像里没有 pnpm、没有 node_modules 的开发依赖，也没有前端源码。

# ── 构建阶段 ─────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /build

# pnpm 11 的构建设置只能从 pnpm-workspace.yaml 读，
# 少了 allowBuilds 这一段，esbuild 的平台二进制不会被安装，
# 表现为构建时报 `Cannot find module 'esbuild'`。
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json ./packages/protocol/
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/

RUN corepack enable && pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web

RUN pnpm --filter @kokuu/web build

# ── 运行阶段 ─────────────────────────────────────────────────
FROM node:24-alpine

# node:sqlite 是内置模块，不需要编译工具链，所以这里不需要
# python3/make/g++ —— 这也是选它而不是 better-sqlite3 的实际收益。
RUN addgroup -S kokuu && adduser -S -G kokuu kokuu

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/protocol/package.json ./packages/protocol/
COPY apps/server/package.json ./apps/server/

RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY packages/protocol/src ./packages/protocol/src
COPY apps/server/src ./apps/server/src

# 前端产物。路径要与 KP_WEB_DIST 一致。
COPY --from=builder /build/apps/web/dist ./apps/web/dist

# 数据目录（SQLite 库与会话密钥）。挂载卷覆盖它。
RUN mkdir -p /data && chown -R kokuu:kokuu /data /app
VOLUME ["/data"]

USER kokuu

ENV KP_HOST=0.0.0.0 \
    KP_PORT=8787 \
    KP_DATA_DIR=/data \
    KP_WEB_DIST=/app/apps/web/dist \
    KP_NODE_ENV=production \
    NODE_ENV=production

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/_api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/src/index.ts"]
