#!/usr/bin/env bash
# 备份与恢复。三个卷就是全部状态 —— 不导出它们就不算完整备份。
#
# 用法：
#   bash scripts/backup.sh              备份到 ./backups/<时间戳>/
#   bash scripts/backup.sh /mnt/nas     备份到指定目录
#
# ★ 为什么必须用 mysqldump 而不是「拷贝 mysql 数据卷」：
#   直接 tar 数据目录等于赌「此刻没有正在写的 InnoDB 页」。
#   mysqldump 走的是一致性快照，拷到任何时候都能安全恢复。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/backups/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$DEST"

echo "备份到 $DEST"

# ── 1. 配置与账本快照 ────────────────────────────────────────
# 独立模式的数据在 kokuu-data 卷里（config.json / JSONL 账本）
if docker volume inspect kokuu-credit-admin_kokuu-data >/dev/null 2>&1; then
  docker run --rm -v kokuu-credit-admin_kokuu-data:/data:ro \
    -v "$(cd "$DEST" && pwd)":/backup alpine \
    tar czf /backup/data.tar.gz -C /data .
  echo "  [1/3] 数据卷 → data.tar.gz"
else
  echo "  [1/3] 跳过（没有 kokuu-data 卷；皮肤站模式下数据在皮肤站的库里）"
fi

# ── 2. 数据库 ────────────────────────────────────────────────
if docker volume inspect kokuu-credit-admin_kokuu-mysql >/dev/null 2>&1; then
  docker compose -f "$ROOT/docker-compose.yml" exec -T mysql \
    mysqldump -uroot -p"${MYSQL_ROOT_PASSWORD:-kokuu_root_pw}" \
      --single-transaction --routines --triggers \
      "${DB_DATABASE:-kokuu}" > "$DEST/db.sql"
  echo "  [2/3] 数据库 → db.sql（$(wc -l < "$DEST/db.sql") 行）"
else
  echo "  [2/3] 跳过（独立 MySQL 不在本机；皮肤站模式请用皮肤站的备份方式）"
fi

# ── 3. Redis AOF ─────────────────────────────────────────────
# ★ 必须拷 AOF 而不是 dump.rdb：
#   回流事件在队列里等着被消费，丢了就等于「玩家金币已扣、积分没入账」。
if docker volume inspect kokuu-credit-admin_kokuu-redis >/dev/null 2>&1; then
  docker compose -f "$ROOT/docker-compose.yml" exec -T redis \
    sh -c 'redis-cli BGSAVE >/dev/null 2>&1; sleep 2; tar czf - -C /data .' \
    > "$DEST/redis.tar.gz"
  echo "  [3/3] Redis → redis.tar.gz"
else
  echo "  [3/3] 跳过（Redis 在外部）"
fi

cat > "$DEST/RESTORE.txt" <<'EOF'
恢复步骤（docker compose 栈已停止的前提下）
──────────────────────────────────────────
1) 起 MySQL（若数据在本地卷里）
   docker compose --profile standalone up -d mysql
   docker compose exec -T mysql mysql -uroot -p<MYSQL_ROOT_PASSWORD> \
     -e "CREATE DATABASE IF NOT EXISTS kokuu CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"

2) 灌数据库
   docker compose exec -T mysql mysql -uroot -p<MYSQL_ROOT_PASSWORD> kokuu < db.sql

3) 还原数据卷
   docker run --rm -v kokuu-credit-admin_kokuu-data:/data \
     -v "$(pwd)":/backup alpine sh -c "tar xzf /backup/data.tar.gz -C /data"

4) 还原 Redis（有积压事件时才需要）
   docker run --rm -v kokuu-credit-admin_kokuu-redis:/data \
     -v "$(pwd)":/backup alpine sh -c "tar xzf /backup/redis.tar.gz -C /data"

5) 起全套
   docker compose --profile standalone up -d
EOF

echo
echo "完成。恢复说明在 $DEST/RESTORE.txt"
echo "⚠️  这个目录含数据库口令与账本数据，按敏感文件对待。"
