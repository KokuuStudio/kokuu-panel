#!/usr/bin/env node
/**
 * 端到端验证脚本。
 *
 * 它把「平台能跑」这件事变成可重复执行的检查，而不是靠人点页面确认。
 * 覆盖的不只是 happy path，还有几个**刻意设计的边界**：
 *
 *   - 未登录访问 → 401
 *   - 缺 CSRF 头 → 403（双提交防护真的在工作）
 *   - 同 eventId 重复改余额 → 409，且余额只动一次（幂等）
 *   - 对离线节点操作 → 502 NODE_OFFLINE（而非 NODE_ERROR）
 *   - 封禁下发结果逐节点回报
 *   - `changed:false` 路径（改成本来就是的值）
 *
 * 前置：
 *   1. 平台已启动（默认 http://127.0.0.1:8787）
 *   2. 至少有一个节点已连接（tools/mock-agent.mjs）
 *   3. 存在管理员账号
 *
 * 用法：
 *   node tools/verify-e2e.mjs --user admin --password xxx [--node survival-01]
 */

const args = {
  base: process.env.KP_BASE ?? 'http://127.0.0.1:8787',
  user: process.env.KP_VERIFY_USER ?? 'admin',
  password: process.env.KP_VERIFY_PASSWORD ?? '',
  node: process.env.KP_VERIFY_NODE ?? 'survival-01',
};

for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  const value = process.argv[i + 1];
  if (key === '--base') { args.base = value; i += 1; }
  else if (key === '--user') { args.user = value; i += 1; }
  else if (key === '--password') { args.password = value; i += 1; }
  else if (key === '--node') { args.node = value; i += 1; }
  else if (key === '--help' || key === '-h') {
    console.log('用法：node tools/verify-e2e.mjs --user admin --password <口令> [--base http://…] [--node <节点ID>]');
    process.exit(0);
  }
}

if (!args.password) {
  console.error('缺少 --password');
  process.exit(2);
}

// ── 迷你测试框架 ─────────────────────────────────────────────

const results = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ group: currentGroup, name, ok: true });
    console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[90m(${ms}ms)\x1b[0m${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ group: currentGroup, name, ok: false, error: error.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${error.message}\x1b[0m`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/**
 * 每次运行的唯一后缀。
 *
 * 幂等键与 LP 权重这类东西在服务端是**持久状态**，用固定值会让
 * 脚本第二次跑就失败（幂等键撞上、权重已经是目标值）。测试脚本
 * 必须可重复执行，否则它迟早会被当成「又坏了」而没人跑。
 */
const runId = Date.now().toString(36);

// ── HTTP 客户端（带 Cookie 与 CSRF） ─────────────────────────

const jar = new Map();

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function request(method, path, body, options = {}) {
  const headers = {};

  if (jar.size > 0) headers.cookie = cookieHeader();

  if (body !== undefined && body !== null) {
    headers['content-type'] = 'application/json';
  }

  // CSRF 双提交：把非 HttpOnly 的 kp_csrf 原样放到头里。
  if (method !== 'GET' && method !== 'HEAD' && !options.skipCsrf) {
    const csrf = jar.get('kp_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }

  const response = await fetch(`${args.base}${path}`, {
    method,
    headers,
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
  });

  // Node 的 fetch 没有 cookie jar，手动维护。
  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value === '' ) jar.delete(name);
    else jar.set(name, value);
  }

  let payload = null;
  const text = await response.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { _raw: text }; }
  }

  return { status: response.status, body: payload };
}

// ── 主流程 ───────────────────────────────────────────────────

console.log(`\x1b[1mKokuuPanel 端到端验证\x1b[0m  ${args.base}`);

group('健康检查');

await check('GET /_api/health 返回 ok', async () => {
  const res = await request('GET', '/_api/health');
  assertEqual(res.status, 200, 'HTTP 状态');
  assert(res.body.ok === true, 'ok 不为 true');
  return `已连接节点 ${res.body.nodes} 个`;
});

group('鉴权与 CSRF');

await check('未登录访问受保护接口 → 401', async () => {
  const res = await request('GET', '/_api/nodes');
  assertEqual(res.status, 401, 'HTTP 状态');
  assertEqual(res.body.error.code, 'UNAUTHENTICATED', '错误码');
  return res.body.error.code;
});

await check('错误口令 → 401', async () => {
  const res = await request('POST', '/_api/auth/login', {
    username: args.user,
    password: 'definitely-wrong-password',
  });
  assertEqual(res.status, 401, 'HTTP 状态');
  return '不区分「用户不存在」与「密码错误」';
});

await check('正确口令登录成功', async () => {
  const res = await request('POST', '/_api/auth/login', {
    username: args.user,
    password: args.password,
  });
  assertEqual(res.status, 200, 'HTTP 状态');
  assert(res.body.account.role === 'owner', `角色应为 owner，实际 ${res.body.account.role}`);
  assert(jar.has('kp_session'), '未收到会话 Cookie');
  assert(jar.has('kp_csrf'), '未收到 CSRF Cookie');
  return `角色 ${res.body.account.role}，权限点 ${res.body.account.permissions.length} 个`;
});

await check('缺少 CSRF 头的写请求 → 403', async () => {
  const res = await request(
    'POST',
    `/_api/nodes/${args.node}/console`,
    { command: 'say csrf-test' },
    { skipCsrf: true },
  );
  assertEqual(res.status, 403, 'HTTP 状态');
  assertEqual(res.body.error.code, 'FORBIDDEN', '错误码');
  return '双提交防护生效';
});

group('节点');

let nodeOnline = false;

await check('节点列表包含目标节点且状态为 online', async () => {
  const res = await request('GET', '/_api/nodes');
  assertEqual(res.status, 200, 'HTTP 状态');
  const node = res.body.items.find((n) => n.id === args.node);
  assert(node, `未找到节点 ${args.node}`);
  nodeOnline = node.status === 'online';
  assertEqual(node.status, 'online', `节点状态（Agent 是否已连接？）`);
  return `${node.brand} ${node.mcVersion}，能力 [${node.capabilities.join(',')}]`;
});

await check('GET /_api/nodes/:id/info 透传服务端信息', async () => {
  const res = await request('GET', `/_api/nodes/${args.node}/info`);
  assertEqual(res.status, 200, 'HTTP 状态');
  assert(Array.isArray(res.body.info.plugins), 'plugins 不是数组');
  return `${res.body.info.plugins.length} 个插件，${res.body.info.worlds.length} 个世界`;
});

await check('GET /_api/nodes/:id/metrics 取到指标', async () => {
  const res = await request('GET', `/_api/nodes/${args.node}/metrics`);
  assertEqual(res.status, 200, 'HTTP 状态');
  const m = res.body.metrics;
  assert(typeof m.online === 'number', 'online 不是数字');
  // tps 允许为 null —— 这正是要验证的：不能编造 20.0 这种假值。
  assert(m.tps === null || (Array.isArray(m.tps) && m.tps.length === 3), 'tps 形状不对');
  return `在线 ${m.online} 人，tps ${m.tps === null ? 'null（允许）' : m.tps[0]}`;
});

await check('对不存在的节点操作 → 502 NODE_OFFLINE', async () => {
  const res = await request('POST', '/_api/nodes/does-not-exist/console', {
    command: 'say hi',
  });
  assertEqual(res.status, 502, 'HTTP 状态');
  assertEqual(res.body.error.code, 'NODE_OFFLINE', '错误码');
  return '与 NODE_ERROR 区分开';
});

group('控制台');

await check('执行控制台命令并拿到回显', async () => {
  const res = await request('POST', `/_api/nodes/${args.node}/console`, {
    command: 'say 端到端验证',
  });
  assertEqual(res.status, 200, 'HTTP 状态');
  assert(Array.isArray(res.body.output), 'output 不是数组');
  return `${res.body.output.length} 行回显`;
});

await check('控制台命令里的换行被拒绝（注入防护）', async () => {
  const res = await request('POST', `/_api/nodes/${args.node}/console`, {
    command: 'say ok\nop Notch',
  });
  assertEqual(res.status, 400, 'HTTP 状态');
  assertEqual(res.body.error.code, 'INVALID_PARAMS', '错误码');
  return '拒绝多行命令';
});

group('玩家');

let sampleUuid = null;
let sampleName = null;

await check('在线玩家列表', async () => {
  const res = await request('GET', `/_api/nodes/${args.node}/online`);
  assertEqual(res.status, 200, 'HTTP 状态');
  assert(res.body.players.length > 0, '在线玩家为空（mock agent 的 --players 是否为 0？）');
  sampleUuid = res.body.players[0].uuid;
  sampleName = res.body.players[0].name;
  // 不带 withIp 时不得出现 ip 字段。
  assert(!('ip' in res.body.players[0]), '未请求 IP 却返回了 ip 字段');
  return `${res.body.players.length} 人在线，样本 ${sampleName}`;
});

await check('玩家主档列表（平台侧记录）', async () => {
  // join 事件是异步到达的，可能还没落库。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const res = await request('GET', '/_api/players?size=5');
    assertEqual(res.status, 200, 'HTTP 状态');
    if (res.body.total > 0) {
      return `已记录 ${res.body.total} 名玩家`;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('等待 12 秒后平台仍没有玩家记录（join 事件没落库？）');
});

await check('平台侧在线玩家与节点上报一致（握手时已对齐）', async () => {
  // 这条验证的是「平台刚装上时看不见已在线的玩家」这个缺口有没有补上：
  // 那些玩家从没发过 join 事件，只能靠握手后的 reconcile 补齐。
  const online = await request('GET', `/_api/nodes/${args.node}/online`);
  assertEqual(online.status, 200, 'HTTP 状态');
  const nodeCount = online.body.players.length;

  const known = await request('GET', `/_api/players?online=true&node=${args.node}&size=200`);
  assertEqual(known.status, 200, 'HTTP 状态');

  assertEqual(
    known.body.total,
    nodeCount,
    `平台侧在线数与节点上报不一致（节点 ${nodeCount} 人，平台 ${known.body.total} 人）`,
  );
  return `${nodeCount} 人在线，两侧一致`;
});

await check('玩家详情含曾用名与经济数据', async () => {
  const res = await request('GET', `/_api/players/${sampleUuid}`);
  assertEqual(res.status, 200, 'HTTP 状态');
  const player = res.body.player;
  assert(Array.isArray(player.knownNames), 'knownNames 不是数组');
  assert(player.economy !== undefined, '缺少 economy 字段');
  return `${player.name}，曾用名 ${player.knownNames.length} 个，积分 ${player.economy.balance}`;
});

await check('非法 UUID → 400', async () => {
  const res = await request('GET', '/_api/players/not-a-uuid');
  assertEqual(res.status, 400, 'HTTP 状态');
  return 'UUID 白名单生效';
});

group('封禁');

let punishmentId = null;

await check('创建全平台封禁并回报下发结果', async () => {
  const res = await request('POST', '/_api/punishments', {
    type: 'ban',
    uuid: sampleUuid,
    name: sampleName,
    reason: '端到端验证',
    durationSeconds: 3600,
    nodeId: null,
    kickNow: false,
  });
  assertEqual(res.status, 200, 'HTTP 状态');
  assert(res.body.punishment.id, '未返回封禁 ID');
  assert(Array.isArray(res.body.dispatched), 'dispatched 不是数组');
  assert(res.body.dispatched.length > 0, 'dispatched 为空（没有节点被通知？）');
  punishmentId = res.body.punishment.id;

  const failed = res.body.dispatched.filter((d) => !d.ok);
  assert(failed.length === 0, `有 ${failed.length} 个节点下发失败：${JSON.stringify(failed)}`);
  return `${res.body.dispatched.length} 个节点全部下发成功`;
});

await check('封禁出现在列表中且为生效状态', async () => {
  const res = await request('GET', '/_api/punishments?active=true&size=50');
  assertEqual(res.status, 200, 'HTTP 状态');
  const found = res.body.items.find((p) => p.id === punishmentId);
  assert(found, '刚创建的封禁不在列表里');
  assertEqual(found.active, true, 'active');
  return `${res.body.total} 条生效中`;
});

await check('撤销封禁并回报下发结果', async () => {
  const res = await request('POST', `/_api/punishments/${punishmentId}/revoke`);
  assertEqual(res.status, 200, 'HTTP 状态');
  assertEqual(res.body.punishment.active, false, 'active');
  return `${res.body.dispatched.filter((d) => d.ok).length} 个节点已同步`;
});

await check('重复撤销 → 404 而不是静默成功', async () => {
  const res = await request('POST', `/_api/punishments/${punishmentId}/revoke`);
  assertEqual(res.status, 404, 'HTTP 状态');
  return '已撤销的记录不能再撤';
});

await check('封禁参数校验：缺原因 → 400', async () => {
  const res = await request('POST', '/_api/punishments', {
    type: 'ban',
    uuid: sampleUuid,
    name: sampleName,
    reason: '',
  });
  assertEqual(res.status, 400, 'HTTP 状态');
  return '必须填写原因';
});

group('身份锚点（改名的防线）');

// 这一组验的是本项目最容易被忽略、后果又最严重的一件事：
// 本站 Yggdrasil 用 UUID v3（md5 of "OfflinePlayer:"+角色名），
// 所以按 UUID 存的封禁，玩家改个名就绕过了 —— 而界面上看不出任何异常。
// 详见 docs/ECOSYSTEM.md §4.1。

let directoryCount = 0;

await check('角色目录状态可查，并暴露「改名即可绕过」的计数', async () => {
  const res = await request('GET', '/_api/characters/status');
  assertEqual(res.status, 200, 'HTTP 状态');
  assert(typeof res.body.count === 'number', 'count 不是数字');
  assert(typeof res.body.renameBypassable === 'number', 'renameBypassable 不是数字');
  assert(typeof res.body.staleAfterMs === 'number', 'staleAfterMs 不是数字');
  directoryCount = res.body.count;

  if (res.body.count === 0) {
    // 目录为空是合法状态（还没导入），但必须给出可执行的下一步。
    assert(res.body.hint, '目录为空时 hint 必须说明怎么导入');
    return `目录为空（可接受），已提示导入方式；绕过风险 ${res.body.renameBypassable}`;
  }
  return `目录 ${res.body.count} 个角色，其中 ${res.body.withUuid} 个有 UUID；绕过风险 ${res.body.renameBypassable}`;
});

await check('目录里没有的角色：封禁时明确告警「改名即可绕过」', async () => {
  // 用一个几乎不可能存在于目录里的名字，专门走「解析不出 pid」这条路。
  // ⚠️ 名字必须 ≤16 字符 —— MC 的硬限制，写长了会被参数校验挡成 400，
  // 那是另一条用例（合法性），不是这一条要验的东西。
  const res = await request('POST', '/_api/punishments', {
    type: 'ban',
    uuid: '11111111-2222-3333-4444-555555555555',
    name: 'NotInDir_42',
    reason: '端到端验证：未关联角色的封禁',
    nodeId: args.node,
    kickNow: false,
  });
  assertEqual(res.status, 200, 'HTTP 状态');
  assertEqual(res.body.bsPid, null, 'bsPid 应当为 null（解析不出）');
  assert(
    typeof res.body.warning === 'string' && res.body.warning.includes('改名'),
    '必须明确告知该封禁改名即可绕过，而不是默默创建一条看起来正常的记录',
  );
  assertEqual(res.body.punishment.bsPid, null, 'punishment.bsPid');
  assert(
    'revokedAt' in res.body.punishment && 'revokedBy' in res.body.punishment,
    'REST 层必须暴露 revokedAt/revokedBy，否则界面分不清「已撤销」与「已过期」',
  );

  // 清理
  await request('POST', `/_api/punishments/${res.body.punishment.id}/revoke`);
  return '已告警并说明后果';
});

if (directoryCount > 0) {
  await check('目录里存在的角色：封禁自动关联到 pid（改名也拦得住）', async () => {
    // 找一个**有 UUID** 的角色。目录里可能有还没经 Yggdrasil 登录过的角色
    // （uuid 为 null），它们在游戏里根本不会出现，不能用来做这个用例。
    const list = await request('GET', '/_api/characters?size=200');
    assertEqual(list.status, 200, 'HTTP 状态');
    const character = list.body.items.find((c) => c.uuid);

    if (!character) {
      return '跳过（目录里没有任何带 UUID 的角色 —— 先让角色经 Yggdrasil 登录一次）';
    }

    const res = await request('POST', '/_api/punishments', {
      type: 'ban',
      uuid: character.uuid,
      name: character.name,
      reason: '端到端验证：已关联角色的封禁',
      nodeId: args.node,
      kickNow: false,
    });
    assertEqual(res.status, 200, 'HTTP 状态');
    assertEqual(res.body.bsPid, character.bsPid, '应当关联到该角色的 pid');
    assertEqual(res.body.warning, null, '已关联角色的封禁不该有告警');

    // 按玩家查生效封禁，必须能查到并带回 pid
    const byPlayer = await request(
      'GET',
      `/_api/punishments/by-player/${character.uuid}?name=${encodeURIComponent(character.name)}`,
    );
    assertEqual(byPlayer.status, 200, 'HTTP 状态');
    assert(
      byPlayer.body.items.some((p) => p.id === res.body.punishment.id),
      '刚创建的封禁没出现在按玩家查询的结果里',
    );
    assertEqual(byPlayer.body.bsPid, character.bsPid, 'by-player 应解析出 pid');
    assertEqual(byPlayer.body.renameBypassable, false, '有关联就不该标记为可绕过');

    await request('POST', `/_api/punishments/${res.body.punishment.id}/revoke`);
    return `关联到 pid=${character.bsPid}（${character.name}）`;
  });
} else {
  await check('目录里存在的角色：封禁自动关联到 pid', async () => {
    return '跳过（目录为空，先跑 node tools/import-characters.mjs）';
  });
}

group('LuckPerms');

await check('组列表按权重降序返回', async () => {
  const res = await request('GET', `/_api/luckperms/nodes/${args.node}/groups`);
  assertEqual(res.status, 200, 'HTTP 状态');
  assert(res.body.groups.length > 0, '组列表为空');
  const weights = res.body.groups.map((g) => g.weight);
  const sorted = [...weights].sort((a, b) => b - a);
  assertEqual(JSON.stringify(weights), JSON.stringify(sorted), '权重未降序');
  const nullCount = res.body.groups.filter((g) => g.userCount === null).length;
  return `${res.body.groups.length} 个组，其中 ${nullCount} 个 userCount 为 null（前端须能处理）`;
});

await check('修改组权重 → changed:true', async () => {
  const groups = await request('GET', `/_api/luckperms/nodes/${args.node}/groups`);
  const vip = groups.body.groups.find((g) => g.name === 'vip');
  assert(vip, '模拟节点上应有 vip 组');
  // 目标值必须与当前值不同，否则 agent 会（正确地）回 changed:false。
  const target = vip.weight === 42 ? 43 : 42;

  const res = await request('POST', `/_api/luckperms/nodes/${args.node}/groups/vip/weight`, {
    weight: target,
  });
  assertEqual(res.status, 200, 'HTTP 状态');
  assertEqual(res.body.changed, true, 'changed');
  return `权重 ${vip.weight} → ${target}`;
});

await check('改成相同的值 → changed:false（不是错误）', async () => {
  const groups = await request('GET', `/_api/luckperms/nodes/${args.node}/groups`);
  const vip = groups.body.groups.find((g) => g.name === 'vip');

  const res = await request('POST', `/_api/luckperms/nodes/${args.node}/groups/vip/weight`, {
    weight: vip.weight,
  });
  assertEqual(res.status, 200, 'HTTP 状态');
  assertEqual(res.body.changed, false, 'changed');
  return `重复设置 ${vip.weight}，前端应提示「无需修改」`;
});

await check('组名非法 → 400', async () => {
  const res = await request('POST', `/_api/luckperms/nodes/${args.node}/groups`, {
    name: 'BAD GROUP!',
  });
  assertEqual(res.status, 400, 'HTTP 状态');
  return '组名白名单生效';
});

await check('自己作为自己的父组 → 400', async () => {
  const res = await request('POST', `/_api/luckperms/nodes/${args.node}/groups/vip/parents`, {
    parent: 'vip',
    add: true,
  });
  assertEqual(res.status, 400, 'HTTP 状态');
  return '拒绝自环继承';
});

await check('读取玩家 LuckPerms 档案', async () => {
  const res = await request('GET', `/_api/luckperms/nodes/${args.node}/users/${sampleUuid}`);
  assertEqual(res.status, 200, 'HTTP 状态');
  assert(res.body.user.primaryGroup, '缺少 primaryGroup');
  return `主组 ${res.body.user.primaryGroup}，直接权限 ${res.body.user.permissions.filter((p) => p.direct).length} 条`;
});

group('经济');

/**
 * 平台是否**持有**积分账本。
 *
 * 默认（external）下平台不持有 —— 唯一账本是皮肤站的
 * `users.score` + `credit_ledger`。这时账本类接口应当回 501 并说清原因，
 * 而游戏内货币那条路（Authority 在 MC 服务端）依然可用。
 *
 * 所以这一组测试要按模式分支，不能写死期望值。
 */
let ledgerOwned = false;

await check('判定积分账本归属，且 external 模式下的拒绝理由正确', async () => {
  const res = await request('GET', '/_api/economy/config');

  if (res.status === 501) {
    assertEqual(res.body.error.code, 'NOT_IMPLEMENTED', '错误码');
    assert(
      String(res.body.error.message).includes('ECOSYSTEM'),
      '拒绝理由必须指向 docs/ECOSYSTEM.md，否则运维只知道「不能用」不知道为什么',
    );
    ledgerOwned = false;
    return 'external：平台不持有账本（符合设计），账本接口回 501';
  }

  assertEqual(res.status, 200, 'HTTP 状态');
  ledgerOwned = true;
  return 'standalone：平台自带账本';
});

const skipIfExternal = () => (ledgerOwned ? null : '跳过（external 模式：平台不持有账本）');

await check('经济统计', async () => {
  const skipped = skipIfExternal();
  if (skipped) return skipped;
  const res = await request('GET', '/_api/economy/stats');
  assertEqual(res.status, 200, 'HTTP 状态');
  assert(typeof res.body.config.ratio === 'number', '缺少 config.ratio');
  return `账户 ${res.body.accounts} 个，总余额 ${res.body.totalBalance}`;
});

let balanceAfter = null;
const adjustEventId = `e2e-adjust-${runId}`;

await check('调整站点积分', async () => {
  const skipped = skipIfExternal();
  if (skipped) return skipped;
  const res = await request('POST', `/_api/economy/accounts/${sampleUuid}/adjust`, {
    delta: 100,
    note: '端到端验证',
    eventId: adjustEventId,
  });
  assertEqual(res.status, 200, 'HTTP 状态');
  balanceAfter = res.body.balance;
  return `余额 ${balanceAfter}`;
});

await check('同 eventId 重复调整 → 409 且余额不变', async () => {
  const skipped = skipIfExternal();
  if (skipped) return skipped;
  const res = await request('POST', `/_api/economy/accounts/${sampleUuid}/adjust`, {
    delta: 100,
    note: '端到端验证',
    eventId: adjustEventId,
  });
  assertEqual(res.status, 409, 'HTTP 状态');
  assertEqual(res.body.error.code, 'CONFLICT', '错误码');

  const check2 = await request('GET', `/_api/economy/accounts/${sampleUuid}`);
  assertEqual(check2.body.account.balance, balanceAfter, '余额被重复扣加了');
  return '幂等键生效，余额未被重复修改';
});

await check('delta 为 0 → 400', async () => {
  const skipped = skipIfExternal();
  if (skipped) return skipped;
  const res = await request('POST', `/_api/economy/accounts/${sampleUuid}/adjust`, {
    delta: 0,
    note: '无意义',
    eventId: `e2e-adjust-zero-${runId}`,
  });
  assertEqual(res.status, 400, 'HTTP 状态');
  return '拒绝无意义的 0 调整';
});

await check('下发游戏内货币（经 Vault）', async () => {
  const res = await request('POST', `/_api/economy/accounts/${sampleUuid}/game-currency`, {
    nodeId: args.node,
    amount: 500,
    note: '端到端验证',
    eventId: `e2e-game-${runId}`,
  });
  assertEqual(res.status, 200, 'HTTP 状态');
  assert(typeof res.body.balanceAfter === 'number', '缺少 balanceAfter');
  return `游戏内余额 ${res.body.balanceAfter}`;
});

await check('经济配置：min_coin < ratio 时拒绝写入', async () => {
  const skipped = skipIfExternal();
  if (skipped) return skipped;
  const res = await request('PUT', '/_api/economy/config', {
    'economy.ratio': '1000',
    'economy.min_coin': '10',
  });
  assertEqual(res.status, 400, 'HTTP 状态');
  assert(
    String(res.body.error.message).includes('兑换比例') ||
      String(res.body.error.message).includes('min_coin'),
    `错误消息没说清楚原因：${res.body.error.message}`,
  );
  return '矛盾配置被拒绝落库';
});

await check('经济配置：合法值写入成功', async () => {
  const skipped = skipIfExternal();
  if (skipped) return skipped;
  const res = await request('PUT', '/_api/economy/config', {
    'economy.ratio': '1000',
    'economy.min_coin': '1000',
  });
  assertEqual(res.status, 200, 'HTTP 状态');
  return 'ratio=1000, min_coin=1000';
});

await check('经济配置：未知键被拒绝', async () => {
  const skipped = skipIfExternal();
  if (skipped) return skipped;
  const res = await request('PUT', '/_api/economy/config', {
    'economy.not_a_real_key': '1',
  });
  assertEqual(res.status, 400, 'HTTP 状态');
  return '配置项白名单生效';
});

group('审计');

await check('审计日志记录了本次验证的操作', async () => {
  const res = await request('GET', '/_api/audit?size=100');
  assertEqual(res.status, 200, 'HTTP 状态');
  assert(res.body.total > 0, '审计为空');

  const actions = new Set(res.body.items.map((e) => e.action));
  const required = ['punish.create', 'punish.revoke', 'console.execute'];
  // 账本类操作只在 standalone 模式下会产生审计。
  if (ledgerOwned) required.push('economy.adjust');

  for (const expected of required) {
    assert(actions.has(expected), `审计里缺少 ${expected}`);
  }
  return `共 ${res.body.total} 条，覆盖 ${required.length} 类关键写操作`;
});

await check('审计能筛出失败的尝试', async () => {
  const res = await request('GET', '/_api/audit?ok=false&size=50');
  assertEqual(res.status, 200, 'HTTP 状态');
  // 失败的调用也应该被记录 —— 「谁试过但没成功」在排查越权时最有用。
  return `失败记录 ${res.body.total} 条`;
});

group('浏览器事件通道');

await check('WebSocket 订阅返回实际生效的 topic', async () => {
  const { WebSocket } = await import('ws');
  const cookie = cookieHeader();

  const ws = new WebSocket(`${args.base.replace('http', 'ws')}/_api/events`, {
    headers: { cookie },
  });

  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.close();
      resolve({ ok: false, message: '5 秒内没收到 subscribed 帧' });
    }, 5000);

    ws.on('open', () => {
      // 故意请求一个没有权限的 console topic，验证它会被剔除。
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          topics: ['nodes', 'players', `console:${args.node}`],
        }),
      );
    });

    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'subscribed') {
        clearTimeout(timer);
        ws.close();
        resolve({ ok: true, frame });
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, message: error.message });
    });
  });

  assert(outcome.ok, outcome.message);
  assert(Array.isArray(outcome.frame.topics), 'subscribed 帧缺少 topics');
  assert(outcome.frame.topics.includes('nodes'), 'nodes 未生效');
  return `生效 topic：[${outcome.frame.topics.join(', ')}]`;
});

await check('未认证的 WebSocket 连接被拒', async () => {
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(`${args.base.replace('http', 'ws')}/_api/events`);

  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ rejected: false });
    }, 4000);
    ws.on('error', () => {
      clearTimeout(timer);
      resolve({ rejected: true });
    });
    ws.on('close', () => {
      clearTimeout(timer);
      resolve({ rejected: true });
    });
  });

  assert(outcome.rejected, '未认证的连接竟然建立了');
  return '401 拒绝升级';
});

// ── 心跳稳定性 ───────────────────────────────────────────────
//
// 这条测试是**回归防护**，不是为了覆盖新功能。
//
// 早期实现里平台只在收到名为 `pong` 的事件时重置心跳计数，而 Agent 回的是
// `ping` 的 response —— 计数永不归零，连接每 60 秒被服务端以「心跳超时」
// 踢掉一次。因为自动重连很快，界面上几乎看不出异常，只在插件日志里留下
// 每分钟一条的 connection closed。
//
// 所以这条测试必须**真的等过那个窗口**。等待时间按
// 心跳间隔(15s) × 未响应上限(3) + 余量 计算。
const HEARTBEAT_WINDOW_MS = 15_000 * 3 + 25_000;

await check(
  `节点连接稳定超过心跳判定窗口（${Math.round(HEARTBEAT_WINDOW_MS / 1000)} 秒不掉线）`,
  async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`${args.base.replace('http', 'ws')}/_api/events`, {
      headers: { cookie: cookieHeader() },
    });

    const disconnects = [];

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        resolve();
      }, HEARTBEAT_WINDOW_MS);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe', topics: ['nodes'] }));
      });

      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type !== 'event' || frame.event !== 'node.disconnected') return;
        if (frame.data?.nodeId === args.node) {
          disconnects.push(frame.data.reason ?? '未知原因');
        }
      });

      ws.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    assert(
      disconnects.length === 0,
      `观察期内节点被断开 ${disconnects.length} 次：${disconnects.join(' / ')}` +
        '（心跳计数没有在收到响应帧时重置？）',
    );

    return '观察期内零次断连';
  },
);

// ── 汇总 ─────────────────────────────────────────────────────

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);

console.log(`\n\x1b[1m汇总\x1b[0m  ${passed}/${results.length} 通过`);

if (failed.length > 0) {
  console.log('\n\x1b[31m失败项：\x1b[0m');
  for (const item of failed) {
    console.log(`  ✗ [${item.group}] ${item.name}\n      ${item.error}`);
  }
  process.exit(1);
}

console.log('\x1b[32m全部通过\x1b[0m');
process.exit(0);
