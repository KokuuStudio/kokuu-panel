#!/usr/bin/env bash
# 一键起：开隧道 -> 起后端 -> 起前端
#
# 前置：ops/token.txt 存在（管理口令），server/.env 已生成（node scripts/sync-env.js）
#
# 用法：
#   bash ops/dev.sh          正常起（Ctrl+C 一起停）
#   bash ops/dev.sh --api    只起后端
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="/c/Users/26703/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
NPM="/c/Users/26703/.workbuddy/binaries/node/versions/22.22.2-3/npm.cmd"

[ -f "$ROOT/ops/token.txt" ] || { echo "缺少 ops/token.txt"; exit 1; }
[ -f "$ROOT/server/.env" ]  || { echo "缺少 server/.env，先跑: node scripts/sync-env.js"; exit 1; }

pids=()
cleanup() {
  for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done
  echo; echo "已停止。"
}
trap cleanup EXIT INT TERM

echo "[1/3] SSH 隧道 127.0.0.1:13306 -> 服务器 3306"
ssh -N -o ConnectTimeout=15 -o StrictHostKeyChecking=no \
    -o UserAliveInterval=30 -o ExitOnForwardFailure=yes \
    -o IdentitiesOnly=yes -i "$HOME/.ssh/id_ed25519" \
    -L 127.0.0.1:13306:127.0.0.1:3306 root@38.22.95.63 &
pids+=($!)

# 等隧道就绪
for i in $(seq 1 20); do
  if "$NODE" -e "
    const net=require('net');const s=net.connect(13306,'127.0.0.1');
    s.on('connect',()=>{s.end();process.exit(0)});
    s.on('error',()=>process.exit(1));
    setTimeout(()=>process.exit(1),800);
  " 2>/dev/null; then
    echo "      隧道就绪（第 ${i} 次探测）"
    break
  fi
  [ "$i" = 20 ] && { echo "隧道起不来，检查 SSH 密钥"; exit 1; }
  sleep 1
done

echo "[2/3] 后端 http://127.0.0.1:8787"
(cd "$ROOT/server" && "$NODE" src/index.js) &
pids+=($!)

[ "${1:-}" = "--api" ] && { echo "仅后端模式，Ctrl+C 停止。"; wait; exit 0; }

echo "[3/3] 前端 http://127.0.0.1:5273"
(cd "$ROOT/web" && "$NPM" run dev) &
pids+=($!)

echo
echo "口令在 ops/token.txt —— cat ops/token.txt 复制。"
wait
