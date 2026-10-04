# 安装指南

三份文档，按需要读：

- Docker 一键部署（推荐）→ 本文第 1 节
- 接已有皮肤站 → 第 2 节
- 不用 Docker → 第 3 节

---

## 1. Docker 一键部署（独立模式）

**要求**：一台装了 Docker 的 Linux 服务器（2 核 2G 起步）。
皮肤站在别的机器上也可以 —— 见第 2 节。

### 1.1 拉代码

```bash
git clone https://github.com/KokuuStudio/kokuu-credit-admin.git
cd kokuu-credit-admin
```

### 1.2 生成口令

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

> 也可以用 `openssl rand -base64 32`。

### 1.3 写配置

```bash
cp .env.example .env
vi .env          # 至少改 ADMIN_TOKEN
```

关键项：

```dotenv
ADMIN_TOKEN=<第 1.2 步生成的口令>

# 默认只绑本机，前面放 nginx / Caddy 做 TLS。
# 改成 0.0.0.0 的话，口令与账本数据都是明文传输。
BIND_ADDR=127.0.0.1
BIND_PORT=8787
```

### 1.4 起

```bash
docker compose up -d
docker compose logs -f app      # 看启动日志
```

看到这几行就是正常：

```
  后端模式  独立模式（不依赖皮肤站 / 不依赖 MySQL）
  账本      皮肤站积分（MySQL）
  监听      http://0.0.0.0:8787
```

打开 <http://127.0.0.1:8787>，用 `ADMIN_TOKEN` 登录。

### 1.5 反向代理 + TLS

```bash
mkdir -p ~/.acme.sh
curl https://get.acme.sh | sh -s email=你的邮箱
~/.acme.sh/acme.sh --issue --nginx -d credit.example.com
~/.acme.sh/acme.sh --install-cert -d credit.example.com \
  --key-file /etc/ssl/private/credit.key \
  --fullchain-file /etc/ssl/certs/credit.crt
```

nginx 配置：

```nginx
server {
    listen 443 ssl http2;
    server_name credit.example.com;

    ssl_certificate     /etc/ssl/certs/credit.crt;
    ssl_certificate_key /etc/ssl/private/credit.key;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 1.6 验证

```bash
curl -s http://127.0.0.1:8787/api/ping
# {"ok":true,"backend":"standalone","storage":"mysql",...}

docker compose exec mysql mysql -ukokuu -p -e "SHOW TABLES;" kokuu
# 应能看到 bridge_config / bridge_exchange / bridge_identity
```

---

## 2. 接已有皮肤站

### 2.1 前置条件

| 条件 | 说明 |
|---|---|
| 网络可达 | 皮肤站与中间件同机，或内网可达 |
| MySQL 权限 | 能建表（三个 `bridge_*` 表由本服务自动创建，幂等） |
| Redis 可达 | 用皮肤站那台 |

> **不要把皮肤站的 Redis 暴露到公网。** 不同机就走 SSH 隧道或内网。

### 2.2 配置

```bash
cp .env.example .env
vi .env
```

```dotenv
BACKEND=skin

# 皮肤站的库
DB_HOST=host.docker.internal     # 皮肤站在宿主机上
DB_PORT=3306
DB_DATABASE=kokuu
DB_USERNAME=kokuu
DB_PASSWORD=<皮肤站那个用户的密码>

# 皮肤站的 Redis
REDIS_HOST=host.docker.internal
REDIS_PORT=6379
REDIS_PASSWORD=<皮肤站的 Redis 密码>

ADMIN_TOKEN=<你的口令>
```

> 皮肤站跑在别的机器上时，`DB_HOST` / `REDIS_HOST` 改成那台机器的内网地址。

### 2.3 ★ 队列键名前缀（最容易踩的坑）

**皮肤站用 Laravel 的 Redis 门面，内核 `config/database.php` 会给 redis 设一个
`prefix`（默认为 `blessing_skin_database_`）。phpredis 在扩展层加上它，
而本服务与 MC 插件用的是裸客户端，键名就是字面量。**

所以「同一个 key 名」在两边**实际是不同的键**。如果皮肤站还跑着
`kokuu-exchange` 之类的旧插件参与兑换队列，那里用的是什么键名，
本服务的 `REDIS_ASSET_KEY` / `REDIS_EVENT_KEY` 就要填什么。

验证（能列出键名就对了）：

```bash
docker compose -f docker-compose.skin.yml exec app \
  node -e "const{Queue}=await import('./src/queue.js');console.log((await import('./src/env.js')).loadEnv().REDIS_ASSET_KEY)"
```

### 2.4 起

```bash
docker compose -f docker-compose.skin.yml up -d
docker compose -f docker-compose.skin.yml logs -f app
```

看到 `后端模式 皮肤站模式（账本 = MySQL users.score）` 就是对的。

### 2.5 验证皮肤站账户能被识别

用皮肤站里一个**真实存在的账号**：

```bash
TOKEN=$(grep ADMIN_TOKEN .env | cut -d= -f2)
curl -s -H "X-Admin-Token: $TOKEN" \
  "http://127.0.0.1:8787/api/players/suggest?kw=你的昵称开头"
```

能返回该账户就说明 uid 解析链路通了。

> ⚠️ **皮肤站模式下，玩家必须先有皮肤站账号**，中间件不会凭空开户。
> 这是刻意的：账本就是 `users.score`，没有用户行就无处可写。

---

## 3. 不用 Docker

### 3.1 依赖

| 组件 | 版本 | 必需性 |
|---|---|---|
| Node.js | 22+ | 必需 |
| MySQL | 8.0 | `skin` 模式必需；`standalone` 也建议用 |
| Redis | 6+ | 只有资产下发与金币回流需要 |

不用 MySQL 也可以：`standalone` 模式下账本能退化成 JSONL 文件（`DATA_DIR`），
适合先跑起来看看功能。**但它不适合生产** —— 单机、无事务、跨进程并发不安全。

### 3.2 装

```bash
git clone https://github.com/KokuuStudio/kokuu-credit-admin.git
cd kokuu-credit-admin

cd server && npm ci
cd ../web && npm ci && npm run build      # 产物在 web/dist
```

### 3.3 systemd

```bash
sudo useradd -r -s /usr/sbin/nologin kokuu
sudo mkdir -p /opt/kokuu-credit-admin
sudo cp -r server/src server/package.json server/scripts /opt/kokuu-credit-admin/
sudo cp -r web/dist /opt/kokuu-credit-admin/web-dist
```

`/etc/systemd/system/kokuu-credit.service`：

```ini
[Unit]
Description=Kokuu Credit Admin
After=network.target mysql.service redis.service

[Service]
Type=simple
User=kokuu
WorkingDirectory=/opt/kokuu-credit-admin
Environment=BACKEND=standalone
Environment=ADMIN_TOKEN=你的口令
Environment=HOST=127.0.0.1
Environment=PORT=8787
Environment=SERVE_WEB=1
Environment=DATA_DIR=/var/lib/kokuu-credit
EnvironmentFile=-/etc/kokuu-credit.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5

# 账本目录要先建好并给权限，否则服务起不来
StateDirectory=kokuu-credit
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/kokuu-credit

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now kokuu-credit
sudo systemctl status kokuu-credit
```

> **务必用 `ExecStart` 直接跑 node，不要用 `npm start`。**
> npm 会多套一层进程，systemd 的 `Restart` 只杀得掉 npm，
> 子进程会变成孤儿进程占着端口，导致重启后「端口已占用」。

---

## 4. 装 MC 插件

见 [exchange-bridge 的 README](https://github.com/KokuuStudio/exchange-bridge#安装)。

关键：**两边队列键名必须完全一致**（本服务 `.env` 的 `REDIS_*_KEY`
↔ 插件 `config.yml` 的 `queue.*`）。不一致的后果是消息「凭空消失」——
玩家积分已扣，但订单永远停在发放中。

---

## 5. 升级

```bash
cd kokuu-credit-admin
git pull
docker compose up -d --build
```

**升级前先备份**（`bash scripts/backup.sh`）。
升级会自动建新表、幂等补列，不需要手动跑迁移。

---

## 6. 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 起不来，日志 `ECONNREFUSED 127.0.0.1:3306` | skin 模式下 `DB_HOST` 没改 | 见 2.2 |
| 起不来，`EACCES ... /data` | 卷的属主与容器内 `node` 用户（uid 1000）不匹配 | `docker compose exec app chown -R 1000:1000 /data`，或改 compose 加 `user:` |
| 登录提示「口令无效」 | `.env` 改了但没重建容器 | `docker compose up -d --force-recreate app` |
| 资产下发没反应 | 队列键名两边不一致 | 见 2.3 |
| 回流不生效 | ①本服务 `reflow_enabled=0` ②插件 `reflow.enabled=false` ③比例没对齐 | 后台 `/config` 页有实时状态面板，逐项对照 |
| `/api/ping` 返回 `ok:false` | 数据库连不上 | 看日志里的真实报错 |

### 定位问题的通用手段

```bash
docker compose logs --tail=200 app        # 中间件日志
docker compose exec mysql mysql -ukokuu -p kokuu   # 直接查库

# 队列深度（消费不掉时看这里）
docker compose exec redis redis-cli LLEN bs:asset:event
```

玩家侧排查：

```
/exbridge status
```

它会一次性给出：Redis 连通性、四个队列的深度、经济插件绑定情况、
收发计数、回流统计。**先看这个再翻日志**，能省掉大部分猜测。
