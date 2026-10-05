/**
 * 服务入口。
 *
 * 注意这里**没有** `import { pool } from './db.js'` —— 数据库只在
 * runtime.js 的 skin 分支里被动态加载。standalone 模式启动时
 * 模块图上没有 mysql2，进程内存里也不会有连接池。
 */

import express from 'express';
import { loadEnv } from './env.js';
import { createRuntime, runtimeInfo, healthCheck, BACKEND } from './runtime.js';
import { createRoutes } from './routes.js';

// ⚠️ 必须走 loadEnv()，不能直接读 process.env。
//   否则 .env 里的 PORT / HOST / SERVE_WEB 全部失效，
//   表现为「改了 .env 没反应」，是这类部署最常见的坑。
const env = loadEnv();

const app = express();
app.use(express.json({ limit: '64kb' }));

// 开发期前后端分端口，放开 CORS；生产由同一端口伺服前端，不需要
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const rt = await createRuntime();

app.get('/api/ping', async (req, res) => {
  const h = await healthCheck(rt);
  res.json({ ok: h.ok, backend: BACKEND, storage: h.storage, detail: h.detail });
});

app.use('/api', createRoutes(rt));

// 金币回流消费循环。
// ★ 只有 Redis 真能连上才启动 —— 队列是回流的唯一通道，
//   连不上时启动只会每秒打一条错误日志，什么也做不了。
//   总开关（reflow_enabled）在后台配置页，这里只管「有没有能力接」。
if (await rt.queue.ping()) {
  rt.reflow.start();
  console.log('  回流消费  已启动（是否入账由后台配置页的「金币自动回流开关」决定）');
} else {
  console.warn(`  回流消费  未启动 —— Redis 连不上（${rt.queue.lastError || '未知原因'}）。` +
    '兑换与资产下发不受影响，但金币回流不可用。');
}

// 静态前端（生产）：存在 web/dist 就直接伺服，一个端口搞定
const distDir = new URL('../../web/dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
if (env.SERVE_WEB === '1') {
  const { existsSync } = await import('node:fs');
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    // SPA 兜底：非 /api 的路径一律回 index.html
    app.get(/^(?!\/api).*/, (req, res) => res.sendFile(`${distDir}/index.html`));
    console.log(`静态前端  ${distDir}`);
  } else {
    console.warn(`SERVE_WEB=1 但找不到前端产物：${distDir}`);
  }
}

app.use((err, req, res, next) => {
  console.error('[api]', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message });
});

const PORT = Number(env.PORT || 8787);
const HOST = env.HOST || '127.0.0.1';
const server = app.listen(PORT, HOST, () => {
  console.log('─'.repeat(58));
  console.log(`  后端模式  ${runtimeInfo.label}`);
  console.log(`  账本      ${runtimeInfo.ledger}`);
  console.log(`  配置      ${runtimeInfo.settings}`);
  console.log(`  兑换明细  ${runtimeInfo.exchange}`);
  console.log(`  监听      http://${HOST}:${PORT}`);
  console.log('─'.repeat(58));
});

// 优雅关闭。
// ★ 为什么不能只靠进程自然退出：
//   回流消费循环里可能有「已 pop 出事件但还没记账」的半截状态 ——
//   直接退出等于把这次抽取的积分吞掉（玩家的金币已经扣了）。
//   所以先停循环再关连接。
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    console.log(`\n收到 ${sig}，正在关闭…`);
    rt.reflow.stop();
    server.close();
    try { await rt.queue.quit(); } catch { /* 忽略 */ }
    process.exit(0);
  });
}
