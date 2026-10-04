#!/usr/bin/env bash
# 打通本地 -> 服务器 MySQL 的 SSH 隧道。
#
# 为什么需要：MariaDB 只监听服务器的 127.0.0.1:3306，公网进不去。
# 本机跑管理端 -> 通过这条隧道访问数据库，不用改线上任何配置。
#
# 用法：bash ops/tunnel.sh   （前台常驻，Ctrl+C 断开）
set -eu

HOST="38.22.95.63"
KEY="$HOME/.ssh/id_ed25519"
LOCAL_PORT="${LOCAL_PORT:-13306}"

exec ssh -N \
  -o ConnectTimeout=15 \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o IdentitiesOnly=yes \
  -i "$KEY" \
  -L "127.0.0.1:${LOCAL_PORT}:127.0.0.1:3306" \
  "root@${HOST}"
