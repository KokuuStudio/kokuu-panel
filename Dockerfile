# ── 构建阶段：装依赖 + 构建前端 ──────────────────────────────
# 用三阶段构建（deps / build / runtime），最终镜像不含 devDependencies。
# 单阶段做不干净的原因：vite 与 element-plus 的开发依赖会让镜像大出一倍，
# 而运行时只需要 dist 里的静态文件 + server 的生产依赖。

# ★ 源要能被覆盖，不能写死国内镜像。
#   package-lock.json 里的 resolved 字段是**写死的下载地址**，
#   而 npm 的 replace-registry-host 默认值是 `npmjs` ——
#   意思是「只把 registry.npmjs.org 换成别的源」，对 npmmirror 的地址无效。
#   于是 `npm ci --registry=...` 这个参数会被**静默忽略**，
#   境外构建镜像时仍然去连国内源（实测：默认参数 35s vs always 0.9s，
#   差的就是有没有真的换源）。
#   → 必须显式加 --replace-registry-host=always 才换得动。
#   默认走官方源；国内构建加：
#     --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=https://registry.npmjs.org

FROM node:22-alpine AS deps
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev \
      --registry=$NPM_REGISTRY --replace-registry-host=always \
    || (npm install --omit=dev \
      --registry=$NPM_REGISTRY --replace-registry-host=always)

FROM node:22-alpine AS build
WORKDIR /app
COPY web/package*.json ./web/
RUN cd web && (npm ci --registry=$NPM_REGISTRY --replace-registry-host=always \
             || npm install --registry=$NPM_REGISTRY --replace-registry-host=always)
COPY web/ ./web/
# 相对路径解析基于 cwd，放到 /app/web 下跑，产物落在 /app/web/dist
RUN cd web && npm run build

# ── 运行阶段 ───────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app/server

# tini 负责转发信号与回收僵尸进程 —— 没有它，Ctrl+C / docker stop
# 收不到 SIGTERM，进程被强杀，正在写的账本流水会丢半条。
RUN apk add --no-cache tini

# 生产依赖单独一层：改业务代码时这一层命中缓存，不用重装依赖
COPY --from=deps /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
# ★ 不要 COPY server/scripts —— 那个目录不存在（开发期的
#   scripts/sync-env.js 在仓库根，而且只给本地用：它读 .env.remote
#   与 ops/token.txt，这些都不该进镜像）。曾写了这行导致
#   `docker build` 直接失败，而本机无 Docker 没能第一时间发现。

# 前端产物。用 /app/web/dist，与 server/src/index.js 里的
# `new URL('../../web/dist/', import.meta.url)` 相对位置对应。
COPY --from=build /app/web/dist ../web/dist

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    SERVE_WEB=1

# 以非 root 运行。账本文件写在挂载的 volume 里，
# 目录属主要与宿主机 uid 一致，否则会写不进去（详见 INSTALL.md）。
USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/ping',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["src/index.js"]
