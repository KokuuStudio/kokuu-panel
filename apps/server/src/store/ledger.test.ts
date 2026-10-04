/**
 * 存储层不变量测试。
 *
 * 这些是**账本三原则**的可执行版本 —— 光写在文档里的原则，
 * 下一次重构就会被悄悄改掉。
 *
 * 运行：pnpm --filter @kokuu/server test
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Store, IdempotencyConflict, ConfigValidationError } from './index.ts';

const UUID_A = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
const UUID_B = 'b50ad385-829d-4554-9b4d-42a9b5b0ee0e';

let store: Store;

beforeEach(() => {
  // 每个用例一个干净的内存库。用 :memory: 而不是临时文件，
  // 免得测试之间通过文件系统串味。
  store = new Store(':memory:');
});

describe('账本：幂等', () => {
  test('同 eventId 第二次调整抛 IdempotencyConflict，且余额不变', () => {
    const first = store.adjustBalance({
      uuid: UUID_A,
      delta: 100,
      source: 'admin',
      note: '首次',
      operator: 'tester',
      eventId: 'evt-1',
    });
    assert.equal(first.balance, 100);

    assert.throws(
      () =>
        store.adjustBalance({
          uuid: UUID_A,
          delta: 100,
          source: 'admin',
          note: '重复提交',
          operator: 'tester',
          eventId: 'evt-1',
        }),
      IdempotencyConflict,
    );

    // 关键断言：余额没有被加两次。这是「网络重试不会发两遍钱」的全部意义。
    assert.equal(store.getEconomyAccount(UUID_A)?.balance, 100);
    assert.equal(store.listLedger({ uuid: UUID_A, page: 1, size: 10 }).total, 1);
  });

  test('eventId 冲突时事务完整回滚（不留半条流水）', () => {
    store.adjustBalance({
      uuid: UUID_A, delta: 50, source: 'admin', note: '', operator: 't', eventId: 'evt-x',
    });

    try {
      store.adjustBalance({
        uuid: UUID_A, delta: 70, source: 'admin', note: '', operator: 't', eventId: 'evt-x',
      });
      assert.fail('应当抛出 IdempotencyConflict');
    } catch (error) {
      assert.ok(error instanceof IdempotencyConflict);
    }

    const ledger = store.listLedger({ uuid: UUID_A, page: 1, size: 10 });
    assert.equal(ledger.total, 1, '不该留下第二条流水');
    assert.equal(ledger.items[0]!.delta, 50, '第一条流水的值不该被改动');
  });

  test('不同 eventId 可以正常累加', () => {
    store.adjustBalance({
      uuid: UUID_A, delta: 100, source: 'admin', note: '', operator: 't', eventId: 'e1',
    });
    const second = store.adjustBalance({
      uuid: UUID_A, delta: -30, source: 'admin', note: '', operator: 't', eventId: 'e2',
    });
    assert.equal(second.balance, 70);
  });
});

describe('账本：余额一律从库里读', () => {
  test('余额允许为负，且 balance_after 精确反映每一笔', () => {
    store.adjustBalance({
      uuid: UUID_B, delta: 10, source: 'admin', note: '', operator: 't', eventId: 'n1',
    });
    store.adjustBalance({
      uuid: UUID_B, delta: -25, source: 'admin', note: '', operator: 't', eventId: 'n2',
    });

    const ledger = store.listLedger({ uuid: UUID_B, page: 1, size: 10 });
    const deltas = ledger.items.map((row) => row.delta).sort((a, b) => a - b);
    assert.deepEqual(deltas, [-25, 10]);

    const latest = ledger.items[0]!;
    assert.equal(latest.balance_after, -15);
    assert.equal(store.getEconomyAccount(UUID_B)?.balance, -15);
  });

  test('流水按时间倒序返回', () => {
    for (let i = 0; i < 5; i += 1) {
      store.adjustBalance({
        uuid: UUID_A, delta: 1, source: 'admin', note: `#${i}`, operator: 't', eventId: `seq-${i}`,
      });
    }
    const ledger = store.listLedger({ uuid: UUID_A, page: 1, size: 10 });
    const notes = ledger.items.map((row) => row.note);
    assert.deepEqual(notes, ['#4', '#3', '#2', '#1', '#0']);
  });
});

describe('封禁：快照版本与过期', () => {
  test('新增封禁会递增 revision', () => {
    const before = store.getPunishRevision();
    store.createPunishment({
      id: 'p1', type: 'ban', uuid: UUID_A, name: 'Alex', reason: '测试',
      operator: 'tester', nodeId: null, expiresAt: null,
    });
    assert.equal(store.getPunishRevision(), before + 1);
  });

  test('撤销封禁会递增 revision；重复撤销返回 undefined 且不再递增', () => {
    store.createPunishment({
      id: 'p2', type: 'ban', uuid: UUID_A, name: 'Alex', reason: '测试',
      operator: 'tester', nodeId: null, expiresAt: null,
    });
    const before = store.getPunishRevision();

    assert.ok(store.revokePunishment('p2', 'tester'));
    assert.equal(store.getPunishRevision(), before + 1);

    const mid = store.getPunishRevision();
    assert.equal(store.revokePunishment('p2', 'tester'), undefined);
    assert.equal(store.getPunishRevision(), mid, '重复撤销不该再动 revision');
  });

  test('过期封禁被清扫，且**同时**递增 revision', () => {
    // 这条最关键：如果不递增 revision，Agent 手里那份快照就永远
    // 认为这个人还在被封状态 —— 「封禁到期」这件事传不到游戏侧。
    store.createPunishment({
      id: 'p-expired', type: 'ban', uuid: UUID_A, name: 'Alex', reason: '已过期',
      operator: 'tester', nodeId: null, expiresAt: Date.now() - 1000,
    });

    const before = store.getPunishRevision();
    const expired = store.expirePunishments();

    assert.deepEqual(expired, ['p-expired']);
    assert.equal(store.getPunishRevision(), before + 1, '过期清扫必须递增 revision');
    assert.equal(store.listAllActivePunishments().length, 0);
  });

  test('未过期的封禁不会被清扫', () => {
    store.createPunishment({
      id: 'p-future', type: 'ban', uuid: UUID_A, name: 'Alex', reason: '还没到期',
      operator: 'tester', nodeId: null, expiresAt: Date.now() + 3600_000,
    });
    assert.deepEqual(store.expirePunishments(), []);
    assert.equal(store.listAllActivePunishments().length, 1);
  });

  test('全平台封禁也在节点维度筛选结果里出现', () => {
    store.createPunishment({
      id: 'p-global', type: 'ban', uuid: UUID_A, name: 'Alex', reason: '全平台',
      operator: 'tester', nodeId: null, expiresAt: null,
    });
    store.createPunishment({
      id: 'p-other', type: 'ban', uuid: UUID_B, name: 'Steve', reason: '只针对另一个服',
      operator: 'tester', nodeId: 'creative-01', expiresAt: null,
    });

    const scoped = store.listPunishments({
      nodeId: 'survival-01', page: 1, size: 10,
    });
    const ids = scoped.items.map((row) => row.id);

    assert.ok(ids.includes('p-global'), '全平台封禁必须出现在任何节点的筛选结果里');
    assert.ok(!ids.includes('p-other'), '别的节点的封禁不该混进来');
  });
});

describe('配置：矛盾配置必须被拒绝', () => {
  test('min_coin < ratio 被拒绝', () => {
    assert.throws(
      () => store.setConfig({ 'economy.ratio': '1000', 'economy.min_coin': '10' }),
      ConfigValidationError,
    );
  });

  test('拒绝后库里的值没有被改动（整批原子性）', () => {
    const before = store.getConfig();
    try {
      store.setConfig({
        'economy.ratio': '1000',
        'economy.min_coin': '10',
        'economy.currency_name': '不该被写进去',
      });
    } catch {
      /* 预期 */
    }
    const after = store.getConfig();
    assert.deepEqual(after, before, '失败时不能有任何部分写入');
  });

  test('合法配置写入成功', () => {
    const merged = store.setConfig({ 'economy.ratio': '500', 'economy.min_coin': '500' });
    assert.equal(merged['economy.ratio'], '500');
    assert.equal(store.getConfig()['economy.min_coin'], '500');
  });

  test('未知配置键被拒绝', () => {
    assert.throws(
      () => store.setConfig({ 'economy.made_up': '1' }),
      ConfigValidationError,
    );
  });

  test('非整数与越界被拒绝', () => {
    assert.throws(() => store.setConfig({ 'economy.ratio': 'abc' }), ConfigValidationError);
    assert.throws(() => store.setConfig({ 'economy.ratio': '0' }), ConfigValidationError);
    assert.throws(() => store.setConfig({ 'economy.enabled': 'yes' }), ConfigValidationError);
  });
});

describe('在线玩家对齐', () => {
  test('从零补齐在线玩家（平台刚装上时看不到任何人的那种情况）', () => {
    const result = store.reconcileOnlinePlayers('survival-01', [
      { uuid: UUID_A, name: 'Alex' },
      { uuid: UUID_B, name: 'Steve' },
    ]);

    assert.equal(result.known, 2);
    assert.equal(store.getPlayer(UUID_A)?.online, 1);
    assert.equal(store.listPlayers({ online: true, page: 1, size: 10 }).total, 2);
  });

  test('重复对齐不会产生重复的开放 session', () => {
    const players = [{ uuid: UUID_A, name: 'Alex' }];
    store.reconcileOnlinePlayers('survival-01', players);
    store.reconcileOnlinePlayers('survival-01', players);
    store.reconcileOnlinePlayers('survival-01', players);

    const sessions = store.getPlayerSessions(UUID_A, 10);
    assert.equal(sessions.length, 1, `应当只有 1 条 session，实际 ${sessions.length}`);
  });

  test('align 时不在列表里的玩家被标记为离线', () => {
    store.reconcileOnlinePlayers('survival-01', [
      { uuid: UUID_A, name: 'Alex' },
      { uuid: UUID_B, name: 'Steve' },
    ]);
    assert.equal(store.listPlayers({ online: true, page: 1, size: 10 }).total, 2);

    // Steve 走了
    const result = store.reconcileOnlinePlayers('survival-01', [
      { uuid: UUID_A, name: 'Alex' },
    ]);

    assert.equal(result.markedOffline, 1);
    assert.equal(store.getPlayer(UUID_B)?.online, 0);
    assert.equal(store.listPlayers({ online: true, page: 1, size: 10 }).total, 1);
  });

  test('改名后靠旧名仍能找到同一个 uuid', () => {
    store.reconcileOnlinePlayers('survival-01', [{ uuid: UUID_A, name: 'OldName' }]);
    store.reconcileOnlinePlayers('survival-01', [{ uuid: UUID_A, name: 'NewName' }]);

    // 主档用新名
    assert.equal(store.getPlayer(UUID_A)?.name, 'NewName');
    // 旧名依然能定位到同一个 uuid —— 这是「UUID 作身份锚点」的兑现
    assert.equal(store.findPlayerByName('OldName')?.uuid, UUID_A);
    assert.equal(store.findPlayerByName('newname')?.uuid, UUID_A, '应当忽略大小写');
  });
});

describe('会话与在线时长', () => {
  test('上下线一轮会累计在线时长', async () => {
    store.playerJoin({ uuid: UUID_A, name: 'Alex', nodeId: 'survival-01', ip: '203.0.113.7' });
    // 让时间差至少 1 秒，否则 measured 为 0 会走 Agent 兜底值。
    await new Promise((resolve) => setTimeout(resolve, 1100));
    store.playerQuit({
      uuid: UUID_A, name: 'Alex', nodeId: 'survival-01', playtimeSeconds: 99999,
    });

    const playtime = store.getPlayer(UUID_A)?.playtime_seconds ?? 0;
    assert.ok(playtime >= 1, `在线时长应当 >= 1，实际 ${playtime}`);
    // 以实测时间差为准，不采信 Agent 报的 99999
    assert.ok(playtime < 60, `不该采信 Agent 报的夸张值，实际 ${playtime}`);
    assert.equal(store.getPlayer(UUID_A)?.online, 0);
  });

  test('IP 历史按次数累加', () => {
    store.playerJoin({ uuid: UUID_A, name: 'Alex', nodeId: 'survival-01', ip: '203.0.113.7' });
    store.playerQuit({ uuid: UUID_A, name: 'Alex', nodeId: 'survival-01', playtimeSeconds: 1 });
    store.playerJoin({ uuid: UUID_A, name: 'Alex', nodeId: 'survival-01', ip: '203.0.113.7' });

    const ips = store.getPlayerIps(UUID_A);
    assert.equal(ips.length, 1);
    assert.equal(ips[0]!.seen_count, 2);
  });

  test('节点掉线时该节点所有开放 session 被关闭', () => {
    store.playerJoin({ uuid: UUID_A, name: 'Alex', nodeId: 'survival-01', ip: null });
    store.playerJoin({ uuid: UUID_B, name: 'Steve', nodeId: 'survival-01', ip: null });

    store.markNodePlayersOffline('survival-01');

    assert.equal(store.listPlayers({ online: true, page: 1, size: 10 }).total, 0);
    const sessions = store.getPlayerSessions(UUID_A, 10);
    assert.ok(sessions[0]!.left_at !== null, 'session 应当被关闭');
  });
});

describe('审计', () => {
  test('按目标与动作筛选', () => {
    store.audit({
      actor: 'admin', actorIp: '127.0.0.1', action: 'punish.create',
      targetType: 'player', targetId: UUID_A, ok: true,
    });
    store.audit({
      actor: 'admin', actorIp: '127.0.0.1', action: 'economy.adjust',
      targetType: 'player', targetId: UUID_A, ok: false, error: '测试',
    });

    assert.equal(store.listAudit({ action: 'punish.', page: 1, size: 10 }).total, 1);
    assert.equal(store.listAudit({ targetId: UUID_A, page: 1, size: 10 }).total, 2);
    assert.equal(store.listAudit({ ok: false, page: 1, size: 10 }).total, 1);
  });

  test('审计写入失败不会抛出去拖垮业务操作', () => {
    // params 里放一个循环引用，JSON.stringify 会抛。
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    assert.doesNotThrow(() => {
      store.audit({
        actor: 'admin', actorIp: null, action: 'test.circular', ok: true,
        params: circular,
      });
    });
  });
});
