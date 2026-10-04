#!/usr/bin/env node
/**
 * 模拟 Agent —— 让平台在没有真实 Minecraft 服务端的情况下可被完整验证。
 *
 * 它不是「玩具」：它按 docs/PROTOCOL.md 老老实实握手、回心跳、
 * 实现全部一期方法、按周期上报事件。所以它同时是一份**协议的可执行参考**：
 * 写 Java 插件时拿它对照，比读文档快。
 *
 * 用法：
 *   node tools/mock-agent.mjs --secret <密钥> [选项]
 *
 * 选项：
 *   --url <ws://…>      平台地址（默认 ws://127.0.0.1:8787/agent）
 *   --node-id <id>      节点 ID（默认 survival-01）
 *   --secret <s>        节点密钥（必填）
 *   --players <n>       初始在线玩家数（默认 8）
 *   --name <名称>       服务端显示名
 *   --quiet             不打印事件日志，只打印连接状态
 *   --once              发送一次握手与指标后退出（用于冒烟测试）
 */

import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

// ── 命令行参数 ───────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    url: process.env.KP_AGENT_URL ?? 'ws://127.0.0.1:8787/agent',
    nodeId: process.env.KP_NODE_ID ?? 'survival-01',
    secret: process.env.KP_NODE_SECRET ?? '',
    players: Number.parseInt(process.env.KP_MOCK_PLAYERS ?? '8', 10),
    name: process.env.KP_MOCK_NAME ?? '模拟生存服',
    quiet: false,
    once: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--url': out.url = next(); break;
      case '--node-id': out.nodeId = next(); break;
      case '--secret': out.secret = next(); break;
      case '--players': out.players = Number.parseInt(next(), 10); break;
      case '--name': out.name = next(); break;
      case '--quiet': out.quiet = true; break;
      case '--once': out.once = true; break;
      case '--help': case '-h':
        console.log(
          '用法：node tools/mock-agent.mjs --secret <节点密钥> [--url ws://…] [--node-id id] [--players 8]',
        );
        process.exit(0);
        break;
      default:
        console.error(`未知参数：${arg}`);
        process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.secret) {
  console.error(
    '缺少 --secret。\n' +
      '先在平台「节点」页创建一个节点，把返回的一次性密钥填进来：\n' +
      '  node tools/mock-agent.mjs --secret <密钥>',
  );
  process.exit(2);
}

const log = (...parts) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${ts} [mock-agent]`, ...parts);
};

// ── 假数据 ───────────────────────────────────────────────────

const FIRST_NAMES = ['Steve', 'Alex', 'Notch', 'Herobrine', 'Dinnerbone', 'Jeb_', 'Grumm', 'Villager'];
const WORLDS = ['world', 'world_nether', 'world_the_end'];
const GAMEMODES = ['SURVIVAL', 'CREATIVE', 'ADVENTURE'];
const LP_GROUPS = [
  { name: 'default', displayName: 'Default', weight: 0, parents: [], permissions: [], meta: { prefix: '', suffix: '', weight: 0 } },
  { name: 'vip', displayName: 'VIP', weight: 10, parents: ['default'], permissions: [{ key: 'essentials.fly', value: true, direct: true }], meta: { prefix: '&6[VIP] &r', suffix: '', weight: 10 } },
  { name: 'mvp', displayName: 'MVP', weight: 20, parents: ['vip'], permissions: [{ key: 'essentials.heal', value: true, direct: true }], meta: { prefix: '&b[MVP] &r', suffix: '', weight: 20 } },
  { name: 'admin', displayName: 'Admin', weight: 100, parents: ['mvp'], permissions: [{ key: '*', value: true, direct: true }], meta: { prefix: '&c[Admin] &r', suffix: '', weight: 100 } },
];

const startTime = Date.now();

/** 在线玩家表。key = uuid。 */
const players = new Map();
/** 封禁快照（平台下发）。key = punishment.id */
const punishments = new Map();
/** 幂等缓存：已处理过的 eventId。 */
const processedEvents = new Set();
/** 白名单。 */
let whitelistEnabled = true;
const whitelist = new Map();

function makePlayer(index) {
  const uuid = randomUUID();
  const name = `${FIRST_NAMES[index % FIRST_NAMES.length]}${index >= FIRST_NAMES.length ? index : ''}`;
  const joined = Date.now() - Math.floor(Math.random() * 6 * 3600 * 1000);
  return {
    uuid,
    name,
    displayName: name,
    online: true,
    world: WORLDS[index % WORLDS.length],
    x: Math.round((Math.random() * 2000 - 1000) * 100) / 100,
    y: Math.round(Math.random() * 60 + 60),
    z: Math.round((Math.random() * 2000 - 1000) * 100) / 100,
    ping: Math.floor(Math.random() * 120) + 5,
    gamemode: GAMEMODES[index % GAMEMODES.length],
    health: 20,
    food: 20,
    level: Math.floor(Math.random() * 50),
    op: index === 0,
    whitelisted: true,
    ip: `203.0.113.${(index % 250) + 2}`,
    firstPlayed: joined,
    lastSeen: Date.now(),
    playtimeSeconds: Math.floor((Date.now() - joined) / 1000),
  };
}

for (let i = 0; i < Math.min(args.players, 40); i += 1) {
  const player = makePlayer(i);
  players.set(player.uuid, player);
  whitelist.set(player.uuid, { uuid: player.uuid, name: player.name });
}

/** 游戏内货币余额。key = uuid */
const balances = new Map([...players.keys()].map((uuid) => [uuid, Math.floor(Math.random() * 50000)]));

function metrics() {
  const online = players.size;
  const tps = 20 - Math.random() * 0.6;
  return {
    // 偶尔返回 null 是有意的：真实环境里 1.12.2 拿不到 TPS，
    // 前端必须能处理。这里主动制造这种情况来验证它。
    tps: Math.random() < 0.1 ? null : [Number(tps.toFixed(2)), 19.98, 19.95],
    mspt: Math.round((50 / tps) * 100) / 100,
    online,
    maxPlayers: 100,
    memory: {
      used: Math.floor(1.5e9 + Math.random() * 5e8),
      max: 4e9,
      free: Math.floor(2e9 - Math.random() * 3e8),
    },
    threads: 58 + Math.floor(Math.random() * 8),
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    entities: 900 + Math.floor(Math.random() * 600),
    chunks: 400 + Math.floor(Math.random() * 200),
  };
}

function serverInfo() {
  return {
    name: args.name,
    brand: 'Paper',
    version: '1.20.6-R0.1-SNAPSHOT',
    bukkitVersion: '1.20.6-R0.1-SNAPSHOT',
    port: 25565,
    onlineMode: true,
    maxPlayers: 100,
    viewDistance: 10,
    motd: '模拟服务端 —— 由 tools/mock-agent.mjs 提供',
    plugins: [
      { name: 'LuckPerms', version: '5.4.102' },
      { name: 'Vault', version: '1.7.3' },
      { name: 'EssentialsX', version: '2.20.1' },
      { name: 'KokuuAgent', version: '1.0.0' },
    ],
    worlds: WORLDS.map((world, index) => ({
      name: world,
      environment: index === 0 ? 'NORMAL' : index === 1 ? 'NETHER' : 'THE_END',
      players: [...players.values()].filter((p) => p.world === world).length,
      entities: 200 + Math.floor(Math.random() * 400),
      chunks: 100 + Math.floor(Math.random() * 200),
    })),
    whitelistEnabled,
  };
}

function lpUser(uuid) {
  const player = players.get(uuid);
  const name = player?.name ?? `Player_${uuid.slice(0, 6)}`;
  const group = LP_GROUPS[Math.floor(Math.abs(hashCode(uuid)) % LP_GROUPS.length)];
  return {
    uuid,
    name,
    primaryGroup: group.name,
    groups: [{ name: group.name, weight: group.weight, direct: true }],
    permissions: [
      ...group.permissions.map((p) => ({ ...p, direct: false })),
      { key: 'kokuu.demo', value: true, direct: true },
    ],
    meta: group.meta,
    inheritedPermissionsCount: 218,
  };
}

function hashCode(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

// ── 协议实现 ─────────────────────────────────────────────────

let socket = null;
let seq = 0;
let heartbeatTimer = null;
let metricsTimer = null;
let churnTimer = null;
let reconnectDelay = 1000;
let stopping = false;
let handshaken = false;

const pending = new Map();

function send(frame) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(frame));
}

/** 平台 → Agent 的请求。返回 Promise。 */
function request(method, params, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const id = `m${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`请求 ${method} 超时`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer, method });
    send({ type: 'request', id, method, params });
  });
}

function event(name, data) {
  send({ type: 'event', event: name, ts: Date.now(), data });
}

function respond(id, result) {
  send({ type: 'response', id, ok: true, result });
}

function respondError(id, code, message, data) {
  send({ type: 'response', id, ok: false, error: { code, message, data } });
}

/** 方法处理器表。与 docs/PROTOCOL.md §5 一一对应。 */
const handlers = {
  ping: () => ({ nonce: randomUUID() }),

  'server.info': () => serverInfo(),
  'server.metrics': () => metrics(),

  'console.execute': ({ command }) => {
    if (args.quiet === false) log(`控制台执行：${command}`);
    if (/^\s*(stop|shutdown)\b/i.test(command)) {
      // 模拟真实服务端的行为差异：拒绝危险命令是有意义的示例。
      return { success: false, output: ['[模拟] 该命令已被模拟 Agent 拒绝'] };
    }
    return {
      success: true,
      output: [
        `[${new Date().toISOString().slice(11, 19)}] 执行命令：${command}`,
        `[${new Date().toISOString().slice(11, 19)}] [模拟] 命令执行完毕`,
      ],
    };
  },

  'players.list': ({ withIp }) => {
    const list = [...players.values()];
    // 不带 withIp 时**不能**返回 ip 字段 —— 这是协议约定，
    // 也是「玩家 IP 属于个人信息，默认不传输」这条设计的落点。
    return withIp ? list.map((p) => ({ ...p })) : list.map(({ ip, ...rest }) => rest);
  },

  'players.detail': ({ uuid }) => {
    const player = players.get(uuid);
    if (!player) throw rpcError('NOT_FOUND', '玩家不在线');
    return { ...player };
  },

  'players.kick': ({ uuid, reason }) => {
    const player = players.get(uuid);
    if (!player) throw rpcError('NOT_ONLINE', '玩家不在线');
    log(`踢出 ${player.name}：${reason}`);
    players.delete(uuid);
    event('player.quit', { uuid, name: player.name, playtimeSeconds: player.playtimeSeconds });
    return { ok: true };
  },

  'players.setOp': ({ uuid, value }) => {
    const player = players.get(uuid);
    if (!player) throw rpcError('NOT_ONLINE', '玩家不在线');
    player.op = value;
    log(`${value ? '授予' : '移除'} ${player.name} 的 OP`);
    return { ok: true };
  },

  'players.setGamemode': ({ uuid, gamemode }) => {
    const player = players.get(uuid);
    if (!player) throw rpcError('NOT_ONLINE', '玩家不在线');
    player.gamemode = gamemode;
    log(`${player.name} 游戏模式 → ${gamemode}`);
    return { ok: true };
  },

  'players.setWhitelist': ({ uuid, name, value }) => {
    if (value) whitelist.set(uuid, { uuid, name });
    else whitelist.delete(uuid);
    const player = players.get(uuid);
    if (player) player.whitelisted = value;
    log(`白名单${value ? '新增' : '移除'} ${name}`);
    return { ok: true };
  },

  'players.resolve': ({ name }) => {
    const found = [...players.values()].find(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
    if (!found) throw rpcError('NOT_FOUND', `服务器上没有名为 ${name} 的玩家`);
    return { uuid: found.uuid, name: found.name, online: true };
  },

  'punish.apply': ({ punishment }) => {
    punishments.set(punishment.id, punishment);
    log(
      `收到封禁下发：${punishment.type} ${punishment.name}（${punishment.reason}）` +
        `${punishment.expiresAt ? ' 至 ' + new Date(punishment.expiresAt).toISOString() : ' 永久'}` +
        `，本地快照 ${punishments.size} 条`,
    );
    return { ok: true };
  },

  'punish.revoke': ({ id }) => {
    punishments.delete(id);
    log(`收到解封下发：${id}，本地快照 ${punishments.size} 条`);
    return { ok: true };
  },

  'punish.kickNow': ({ uuid, reason }) => {
    const player = players.get(uuid);
    if (!player) throw rpcError('NOT_ONLINE', '玩家不在线');
    log(`按封禁要求踢出 ${player.name}：${reason}`);
    players.delete(uuid);
    event('player.quit', { uuid, name: player.name, playtimeSeconds: player.playtimeSeconds });
    return { ok: true };
  },

  'whitelist.list': () => [...whitelist.values()],

  'whitelist.setEnabled': ({ value }) => {
    whitelistEnabled = value;
    log(`白名单已${value ? '开启' : '关闭'}`);
    event('whitelist.changed', { enabled: value });
    return { ok: true };
  },

  // ── LuckPerms ──
  'luckperms.user.get': ({ uuid }) => lpUser(uuid),

  'luckperms.user.setPrimaryGroup': ({ uuid, group }) => {
    if (!LP_GROUPS.some((g) => g.name === group)) {
      throw rpcError('NOT_FOUND', `组 ${group} 不存在`);
    }
    log(`设置主组：${uuid.slice(0, 8)} → ${group}`);
    return { ok: true, changed: true };
  },

  'luckperms.user.addGroup': ({ uuid, group }) => {
    log(`添加组：${uuid.slice(0, 8)} += ${group}`);
    return { ok: true, changed: true };
  },

  'luckperms.user.removeGroup': ({ uuid, group }) => {
    log(`移除组：${uuid.slice(0, 8)} -= ${group}`);
    return { ok: true, changed: true };
  },

  'luckperms.user.setPermission': ({ uuid, permission, value }) => {
    log(`设置权限：${uuid.slice(0, 8)} ${permission}=${value}`);
    return { ok: true, changed: true };
  },

  'luckperms.user.unsetPermission': ({ uuid, permission }) => {
    log(`删除权限：${uuid.slice(0, 8)} ${permission}`);
    return { ok: true, changed: true };
  },

  'luckperms.user.setMeta': ({ uuid, prefix, suffix }) => {
    log(`设置前后缀：${uuid.slice(0, 8)} prefix=${JSON.stringify(prefix)} suffix=${JSON.stringify(suffix)}`);
    return { ok: true, changed: true };
  },

  'luckperms.groups.list': () =>
    LP_GROUPS.map((group) => ({
      ...group,
      // 故意让 userCount 为 null —— 协议允许，前端必须能处理。
      userCount: group.name === 'default' ? null : Math.floor(Math.random() * 200),
    })),

  'luckperms.group.create': ({ name }) => {
    if (LP_GROUPS.some((g) => g.name === name)) {
      throw rpcError('CONFLICT', `组 ${name} 已存在`);
    }
    LP_GROUPS.push({
      name, displayName: name, weight: 0, parents: [], permissions: [],
      meta: { prefix: '', suffix: '', weight: 0 },
    });
    log(`创建组：${name}`);
    return { ok: true, changed: true };
  },

  'luckperms.group.delete': ({ name }) => {
    const index = LP_GROUPS.findIndex((g) => g.name === name);
    if (index < 0) throw rpcError('NOT_FOUND', `组 ${name} 不存在`);
    LP_GROUPS.splice(index, 1);
    log(`删除组：${name}`);
    return { ok: true, changed: true };
  },

  'luckperms.group.setPermission': ({ name, permission, value }) => {
    log(`组权限：${name} ${permission}=${value}`);
    return { ok: true, changed: true };
  },

  'luckperms.group.unsetPermission': ({ name, permission }) => {
    log(`组权限删除：${name} ${permission}`);
    return { ok: true, changed: true };
  },

  'luckperms.group.setParent': ({ name, parent }) => {
    if (name === parent) throw rpcError('INVALID_PARAMS', '一个组不能是自己的父组');
    log(`组继承：${name} → ${parent}`);
    return { ok: true, changed: true };
  },

  'luckperms.group.removeParent': ({ name, parent }) => {
    log(`取消继承：${name} → ${parent}`);
    return { ok: true, changed: true };
  },

  'luckperms.group.setWeight': ({ name, weight }) => {
    const group = LP_GROUPS.find((g) => g.name === name);
    if (!group) throw rpcError('NOT_FOUND', `组 ${name} 不存在`);
    const changed = group.weight !== weight;
    group.weight = weight;
    group.meta.weight = weight;
    log(`组权重：${name} → ${weight}`);
    // changed:false 的情形要能出现，前端必须区分「已修改」与「无需修改」。
    return { ok: true, changed };
  },

  'luckperms.group.setMeta': ({ name, prefix, suffix }) => {
    const group = LP_GROUPS.find((g) => g.name === name);
    if (!group) throw rpcError('NOT_FOUND', `组 ${name} 不存在`);
    if (prefix !== undefined) group.meta.prefix = prefix;
    if (suffix !== undefined) group.meta.suffix = suffix;
    log(`组前后缀：${name} prefix=${JSON.stringify(prefix)}`);
    return { ok: true, changed: true };
  },

  // ── 经济 ──
  'economy.getBalance': ({ uuid }) => ({
    balance: balances.get(uuid) ?? 0,
    currency: '金币',
    backend: 'vault',
  }),

  'economy.adjust': ({ uuid, name, amount, note, eventId }) => {
    // 幂等：同一个 eventId 只执行一次。网络重试不能变成发两遍钱。
    if (processedEvents.has(eventId)) {
      log(`幂等命中，跳过重复的 economy.adjust：${eventId}`);
      return { ok: true, balanceAfter: balances.get(uuid) ?? 0 };
    }
    processedEvents.add(eventId);

    const next = (balances.get(uuid) ?? 0) + amount;
    balances.set(uuid, next);
    log(`游戏内货币调整：${name} ${amount > 0 ? '+' : ''}${amount} → ${next}（${note ?? '无备注'}）`);
    return { ok: true, balanceAfter: next };
  },
};

function rpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// ── 入站帧处理 ───────────────────────────────────────────────

function handleFrame(frame) {
  if (frame.type === 'response') {
    const call = pending.get(frame.id);
    if (!call) return;
    pending.delete(frame.id);
    clearTimeout(call.timer);
    if (frame.ok) call.resolve(frame.result);
    else call.reject(rpcError(frame.error?.code ?? 'INTERNAL', frame.error?.message ?? '未知错误'));
    return;
  }

  if (frame.type === 'request') {
    if (!handshaken) {
      respondError(frame.id, 'UNAUTHORIZED', '尚未完成握手');
      return;
    }
    const handler = handlers[frame.method];
    if (!handler) {
      // 必须回 UNSUPPORTED，不能静默忽略 —— 静默会让平台等满超时。
      respondError(frame.id, 'UNSUPPORTED', `模拟 Agent 未实现方法 ${frame.method}`);
      return;
    }
    try {
      respond(frame.id, handler(frame.params ?? {}));
    } catch (error) {
      respondError(frame.id, error.code ?? 'INTERNAL', error.message);
    }
    return;
  }

  if (frame.type === 'event') {
    if (frame.event === 'punish.sync') {
      const { revision, active } = frame.data;
      punishments.clear();
      for (const item of active) punishments.set(item.id, item);
      log(`收到封禁快照 revision=${revision}，共 ${active.length} 条`);
      return;
    }
    log(`收到平台事件 ${frame.event}`);
  }
}

// ── 定时上报 ─────────────────────────────────────────────────

function startTimers() {
  stopTimers();

  metricsTimer = setInterval(() => {
    event('server.metrics', metrics());
  }, 10_000);

  // 随机上下线与聊天，模拟真实活动。
  churnTimer = setInterval(() => {
    const roll = Math.random();

    if (roll < 0.35 && players.size < 30) {
      const player = makePlayer(players.size + Math.floor(Math.random() * 100));
      players.set(player.uuid, player);
      balances.set(player.uuid, Math.floor(Math.random() * 5000));
      whitelist.set(player.uuid, { uuid: player.uuid, name: player.name });
      event('player.join', { uuid: player.uuid, name: player.name, ip: player.ip });
      if (!args.quiet) log(`玩家上线：${player.name}`);
      return;
    }

    if (roll < 0.6 && players.size > 2) {
      const list = [...players.values()];
      const player = list[Math.floor(Math.random() * list.length)];
      players.delete(player.uuid);
      event('player.quit', {
        uuid: player.uuid,
        name: player.name,
        playtimeSeconds: player.playtimeSeconds + 60,
      });
      if (!args.quiet) log(`玩家下线：${player.name}`);
      return;
    }

    if (roll < 0.9) {
      const list = [...players.values()];
      if (list.length === 0) return;
      const player = list[Math.floor(Math.random() * list.length)];
      const messages = [
        '有人在吗',
        '这附近有钻石吗',
        '刚被苦力怕炸了',
        '求组队打末影龙',
        '服务器好流畅',
      ];
      event('player.chat', {
        uuid: player.uuid,
        name: player.name,
        message: messages[Math.floor(Math.random() * messages.length)],
      });
      return;
    }

    // 控制台日志
    event('console.line', {
      line: `[${new Date().toISOString().slice(11, 19)}] [Server thread/INFO]: <${[...players.values()][0]?.name ?? 'Server'}> 模拟日志行`,
      level: 'INFO',
    });
  }, 7000);
}

function stopTimers() {
  if (metricsTimer) clearInterval(metricsTimer);
  if (churnTimer) clearInterval(churnTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  metricsTimer = null;
  churnTimer = null;
  heartbeatTimer = null;
}

// ── 连接 ─────────────────────────────────────────────────────

function connect() {
  log(`正在连接 ${args.url}（节点 ${args.nodeId}）`);
  socket = new WebSocket(args.url);

  socket.on('open', () => {
    log('WebSocket 已建立，发送 hello');
    send({
      type: 'request',
      id: 'hello-1',
      method: 'hello',
      params: {
        protocolVersion: 1,
        nodeId: args.nodeId,
        secret: args.secret,
        agent: {
          version: '1.0.0-mock',
          mcVersion: '1.20.6',
          brand: 'Paper',
          javaVersion: '21.0.5',
        },
        capabilities: ['console', 'players', 'punish', 'whitelist', 'luckperms', 'economy'],
      },
    });
  });

  socket.on('message', (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      log('收到无法解析的帧');
      return;
    }

    // hello 的响应单独处理：它决定连接能不能继续。
    if (!handshaken && frame.type === 'response' && frame.id === 'hello-1') {
      if (!frame.ok) {
        const code = frame.error?.code;
        log(`握手失败 [${code}]：${frame.error?.message}`);

        if (code === 'PROTOCOL_MISMATCH') {
          // 协议不匹配时**停止重连** —— 重连一万次也不会变好。
          log('协议不匹配，停止重连。请升级插件或平台使其版本一致。');
          stopping = true;
          socket.close();
          process.exit(3);
        }

        // 其他失败按退避重连
        return;
      }

      handshaken = true;
      reconnectDelay = 1000;

      const result = frame.result;
      log(
        `握手成功：心跳 ${result.heartbeatIntervalMs}ms，能力 [${result.capabilities.join(',')}]`,
      );
      log(`平台下发封禁快照 revision=${result.punish.revision}，${result.punish.active.length} 条`);
      punishments.clear();
      for (const item of result.punish.active) punishments.set(item.id, item);

      event('server.metrics', metrics());
      startTimers();

      if (args.once) {
        log('--once 模式：已完成握手与首帧上报，退出');
        setTimeout(() => process.exit(0), 300);
      }
      return;
    }

    handleFrame(frame);
  });

  socket.on('close', (code, reason) => {
    handshaken = false;
    stopTimers();
    if (stopping) return;

    log(`连接关闭（${code} ${reason?.toString() ?? ''}），${reconnectDelay}ms 后重连`);
    setTimeout(connect, reconnectDelay);
    // 指数退避，上限 5 分钟。
    reconnectDelay = Math.min(reconnectDelay * 2, 300_000);
  });

  socket.on('error', (error) => {
    log(`连接错误：${error.message}`);
  });
}

process.on('SIGINT', () => {
  stopping = true;
  stopTimers();
  log('收到中断信号，退出');
  socket?.close();
  process.exit(0);
});

connect();
