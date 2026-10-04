/**
 * 服务入口。
 *
 * 装配顺序：存储 → 事件中枢 → Agent 网关 → HTTP。
 * 关停顺序相反：先把 Agent 断开（让插件知道平台要走了，
 * 而不是傻等心跳超时），再关 HTTP，最后关数据库。
 */

import type { IncomingMessage } from 'node:http';

import { config, describeConfig } from './config.ts';
import { createLedger } from './ledger/index.ts';
import { createLogger, log } from './logger.ts';
import { Store, type AccountRow } from './store/index.ts';
import { AgentGateway, toProtocolPunishment, type AgentConnection } from './agent/gateway.ts';
import { EventsHub } from './events/hub.ts';
import { bootstrapAdmin, buildApp } from './http/app.ts';
import type { AppContext } from './http/context.ts';
import { unsignSession } from './lib/crypto.ts';
import { isSafeUuid, type Metrics, type Punishment } from '@kokuu/protocol';

const agentLog = createLogger('agent:handler');

/** 定时任务周期。 */
const MAINTENANCE_INTERVAL_MS = 60_000;

function main(): void {
  log.info(`KokuuPanel 启动中\n         ${describeConfig()}`);

  const store = new Store(config.dbFile);
  const startedAt = Date.now();

  // ── 事件中枢（浏览器侧） ───────────────────────────────────
  // 它自己鉴权：从 Cookie 里解出会话，而不是复用 HTTP 的 preHandler
  // （WebSocket 的 upgrade 不走 Fastify 的路由钩子）。
  const hub = new EventsHub(async (request: IncomingMessage): Promise<AccountRow | null> => {
    const cookieHeader = request.headers.cookie;
    if (!cookieHeader) return null;

    const cookies = parseCookies(cookieHeader);
    const signed = cookies['kp_session'];
    if (!signed) return null;

    const sessionId = unsignSession(signed, config.sessionSecret);
    if (!sessionId) return null;

    const session = store.findSession(sessionId);
    if (!session || session.expires_at < Date.now()) return null;

    const account = store.findAccountById(session.account_id);
    if (!account || account.disabled === 1) return null;

    return account;
  });

  // ── Agent 网关 ─────────────────────────────────────────────
  const ctxRef: { current: AppContext | null } = { current: null };

  const gateway = new AgentGateway(
    store,
    {
      onConnected(node, connection) {
        hub.publish('nodes', 'node.connected', {
          nodeId: node.id,
          name: node.name,
          capabilities: [...connection.capabilities],
        });

        // 主动拉一次服务端信息与指标，让前端立刻有数据可显示，
        // 而不是等第一个定时上报（最长 10 秒）。
        void Promise.allSettled([
          connection
            .call('server.info', {})
            .then((info) => ctxRef.current?.serverInfo.set(node.id, { data: info, ts: Date.now() })),
          connection
            .call('server.metrics', {})
            .then((metrics) => ctxRef.current?.metrics.set(node.id, { data: metrics, ts: Date.now() })),
        ]);

        // 对齐在线玩家。
        //
        // 平台是后来才装的，或者平台自己重启过 —— 这两种情况下服务器上
        // **已经在线的玩家从没发过 join 事件**，平台侧一条记录都没有。
        // 不补这一步，管理员打开界面会看到「0 人在线」，而服务器里明明
        // 站着几十个人，第一印象就是「这平台不准」。
        //
        // 不带 withIp：对齐只需要 uuid 与名字，玩家 IP 属于个人信息，
        // 没有明确需要时不在链路上传输。
        void connection
          .call('players.list', { withIp: false })
          .then((players) => {
            const result = store.reconcileOnlinePlayers(
              node.id,
              players.map((p) => ({
                uuid: p.uuid,
                name: p.name,
                firstPlayed: p.firstPlayed,
              })),
            );
            log.info(
              `节点 ${node.id} 在线玩家已对齐：${result.known} 人` +
                (result.markedOffline > 0
                  ? `，另有 ${result.markedOffline} 人标记为离线`
                  : ''),
            );
          })
          .catch((error) => {
            log.warn(`对齐节点 ${node.id} 的在线玩家失败`, error);
          });
      },

      onDisconnected(nodeId, reason) {
        ctxRef.current?.metrics.delete(nodeId);
        ctxRef.current?.serverInfo.delete(nodeId);
        hub.publish('nodes', 'node.disconnected', { nodeId, reason });
      },

      onEvent(nodeId, event, data) {
        handleAgentEvent(nodeId, event, data);
      },
    },

    // Agent → 平台的请求
    async (connection: AgentConnection, method, params) => {
      switch (method) {
        case 'player.resolve': {
          const p = params as { uuid?: string; name?: string };
          const row = p.uuid
            ? store.getPlayer(p.uuid)
            : p.name
              ? store.findPlayerByName(p.name)
              : undefined;

          if (!row) {
            // 平台不认识这个玩家。返回一个「未知」结果而不是报错 ——
            // 插件那边可能只是装了个新服，第一个玩家就没人认识。
            return {
              uuid: p.uuid ?? '',
              name: p.name ?? '',
              known: false,
              punishments: [],
            };
          }

          return {
            uuid: row.uuid,
            name: row.name,
            known: true,
            punishments: store.listActivePunishmentsFor(row.uuid).map(toProtocolPunishment),
          };
        }

        case 'punish.snapshot': {
          return {
            revision: store.getPunishRevision(),
            active: store
              .listAllActivePunishments()
              .filter((row) => row.node_id === null || row.node_id === connection.nodeId)
              .map(toProtocolPunishment),
          };
        }

        case 'economy.stats': {
          const stats = store.economyStats();
          return {
            accounts: stats.accounts,
            totalBalance: stats.totalBalance,
            ledgerCount: stats.ledgerCount,
          };
        }

        default:
          throw new Error(`平台未实现的方法：${method}`);
      }
    },
  );

  // ── 上下文 ─────────────────────────────────────────────────
  const ctx: AppContext = {
    store,
    ledger: createLedger(config, store),
    gateway,
    hub,
    startedAt,
    metrics: new Map(),
    serverInfo: new Map(),
  };
  ctxRef.current = ctx;

  function handleAgentEvent(nodeId: string, event: string, data: unknown): void {
    switch (event) {
      case 'player.join': {
        const p = data as { uuid: string; name: string; ip?: string };
        if (!isSafeUuid(p.uuid)) {
          agentLog.warn(`节点 ${nodeId} 上报了非法 UUID 的 join 事件，已丢弃`, p);
          return;
        }
        store.playerJoin({
          uuid: p.uuid,
          name: p.name,
          nodeId,
          ip: p.ip ?? null,
        });

        // 身份解析：把游戏里的 uuid/name 关联到皮肤站角色。
        //
        // 没有这一步，界面上看不出「这个游戏身份属于哪个皮肤站角色」，
        // 而且判罚只能按 UUID 走 —— 而本站 UUID 由角色名派生，
        // 改名即失效。详见 docs/ECOSYSTEM.md §4.1。
        const bsPid = store.resolveCharacterPid({ uuid: p.uuid, name: p.name });
        store.linkPlayerToCharacter(p.uuid, bsPid);

        if (bsPid === null && store.countCharacters() > 0) {
          // 目录里没有这个人 —— 可能是新注册的角色（目录还没同步），
          // 也可能是皮肤站那边改名了。都值得让管理员知道。
          agentLog.info(
            `节点 ${nodeId} 的玩家 ${p.name}（${p.uuid.slice(0, 8)}…）不在角色目录中，` +
              '已按未关联处理；该玩家的封禁将无法扛住改名。' +
              '请同步角色目录：node tools/import-characters.mjs --file <导出文件>',
          );
        }

        hub.publish('players', 'player.join', { nodeId, bsPid, ...p });
        return;
      }

      case 'player.quit': {
        const p = data as { uuid: string; name: string; playtimeSeconds?: number };
        if (!isSafeUuid(p.uuid)) return;
        store.playerQuit({
          uuid: p.uuid,
          name: p.name,
          nodeId,
          playtimeSeconds: p.playtimeSeconds ?? 0,
        });
        hub.publish('players', 'player.quit', { nodeId, ...p });
        return;
      }

      case 'player.chat':
      case 'player.death':
      case 'player.command':
      case 'whitelist.changed':
      case 'agent.log': {
        hub.publish('players', event, { nodeId, ...(data as object) });
        return;
      }

      case 'console.line': {
        const p = data as { line: string; level: string; dropped?: number };
        if (p.dropped) hub.noteConsoleDropped(nodeId, p.dropped);
        hub.pushConsole(nodeId, p.line, p.level);
        return;
      }

      case 'server.metrics': {
        ctx.metrics.set(nodeId, { data: data as Metrics, ts: Date.now() });
        hub.publish('nodes', 'node.metrics', { nodeId, metrics: data });
        return;
      }

      case 'punish.applied': {
        // 游戏内 `/kp ban` 走这条路进平台。
        // 幂等：同 id 已存在就跳过，避免重连重放时重复落库。
        const incoming = data as Punishment;
        if (!isSafeUuid(incoming.uuid) || store.getPunishment(incoming.id)) {
          gateway.broadcastPunishSnapshot();
          return;
        }
        store.createPunishment({
          id: incoming.id,
          type: incoming.type,
          uuid: incoming.uuid,
          name: incoming.name,
          reason: incoming.reason,
          operator: incoming.operator,
          nodeId: incoming.nodeId ?? nodeId,
          expiresAt: incoming.expiresAt,
        });
        gateway.broadcastPunishSnapshot();
        hub.publish('punish', 'punish.applied', incoming);
        return;
      }

      case 'punish.revoked': {
        const p = data as { id: string };
        store.revokePunishment(p.id, `ingame:${nodeId}`);
        gateway.broadcastPunishSnapshot();
        hub.publish('punish', 'punish.revoked', p);
        return;
      }

      default:
        agentLog.debug(`节点 ${nodeId} 上报了未处理的事件 ${event}`);
    }
  }

  // ── HTTP ───────────────────────────────────────────────────
  const app = buildApp(store, ctx);
  bootstrapAdmin(store);

  // WebSocket 的 upgrade 不走 Fastify 钩子，手动挂。
  gateway.attach(app.server);
  hub.attach(app.server);

  // 兜底：升级请求打到了未知路径就别晾着 —— 不处理的话连接会一直挂着，
  // 占用一个 socket 直到客户端超时。
  app.server.on('upgrade', (request, socket) => {
    const path = new URL(request.url ?? '/', 'http://placeholder').pathname;
    if (path === '/agent' || path === '/_api/events' || path === '/api/events') return;
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });

  void app
    .listen({ host: config.host, port: config.port })
    .then((address) => {
      log.info(`已就绪 → ${address}`);
      log.info(`Agent 接入点：ws${config.isProduction ? 's' : ''}://${config.host}:${config.port}/agent`);
    })
    .catch((error) => {
      log.error('监听失败', error);
      process.exit(1);
    });

  // ── 定时维护 ───────────────────────────────────────────────
  const maintenance = setInterval(() => {
    try {
      const expired = store.expirePunishments();
      if (expired.length > 0) {
        // 到期必须广播新快照，否则「封禁到期」这件事永远传不到游戏侧。
        gateway.broadcastPunishSnapshot();
        hub.publish('punish', 'punish.expired', { ids: expired });
        log.info(`已解除 ${expired.length} 条到期封禁`);
      }

      const sessions = store.purgeExpiredSessions();
      if (sessions > 0) log.debug(`清理了 ${sessions} 个过期会话`);

      store.pruneLoginAttempts(24 * 3600 * 1000);
    } catch (error) {
      log.error('定时维护任务失败', error);
    }
  }, MAINTENANCE_INTERVAL_MS);
  maintenance.unref?.();

  // ── 优雅关停 ───────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`收到 ${signal}，开始关停`);

    clearInterval(maintenance);

    try {
      await gateway.closeAll();
      await hub.close();
      await app.close();
    } catch (error) {
      log.error('关停过程中出错', error);
    } finally {
      store.close();
      log.info('已关停');
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 拒绝', reason);
  });
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

main();
