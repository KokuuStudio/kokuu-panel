/**
 * 身份锚点不变量测试。
 *
 * 这些用例存在的唯一理由：本站 Yggdrasil 用 UUID v3
 * （`md5("OfflinePlayer:" + 角色名)`），所以**改名会让名字与 UUID 一起变**。
 * 封禁若按 UUID 存，玩家改个名就绕过了 —— 而界面上看起来一切正常。
 *
 * 所以这里最重要的是「改名后封禁仍然生效」那一条。
 * 背景见 docs/ECOSYSTEM.md §4.1。
 *
 * 运行：pnpm --filter @kokuu/server test
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { Store } from './index.ts';

let store: Store;

beforeEach(() => {
  store = new Store(':memory:');
});

/** 复刻 yggdrasil-api 的 generateUuidV3：md5 后打版本位与变体位。 */
function uuidV3(name: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${name}`).digest('hex');
  const bytes = hash.split('');
  // version = 3
  bytes[12] = '3';
  // variant = 10xx → 第 17 个 hex 位取 8/9/a/b
  const variant = (Number.parseInt(bytes[16]!, 16) & 0x3) | 0x8;
  bytes[16] = variant.toString(16);
  const h = bytes.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

describe('角色目录', () => {
  test('新建角色', () => {
    const result = store.upsertCharacter({
      bsPid: 1, bsUid: 2, name: 'Kansamu', uuid: uuidV3('Kansamu'),
    });
    assert.equal(result.created, true);
    assert.equal(result.renamed, false);
    assert.equal(store.countCharacters(), 1);
    assert.equal(store.getCharacter(1)?.name, 'Kansamu');
  });

  test('改名：当前名更新，旧名进历史', () => {
    const oldUuid = uuidV3('OldName');
    const newUuid = uuidV3('NewName');

    store.upsertCharacter({ bsPid: 7, bsUid: 2, name: 'OldName', uuid: oldUuid });
    const result = store.upsertCharacter({
      bsPid: 7, bsUid: 2, name: 'NewName', uuid: newUuid,
    });

    assert.equal(result.renamed, true);

    const row = store.getCharacter(7)!;
    assert.equal(row.name, 'NewName', '当前名应当是新名');
    assert.equal(row.uuid, newUuid, '当前 UUID 应当是新 UUID');
    assert.deepEqual(JSON.parse(row.prev_names), ['OldName']);
    assert.deepEqual(JSON.parse(row.prev_uuids), [oldUuid]);
  });

  test('反复导入同一份数据不会堆叠历史（幂等）', () => {
    store.upsertCharacter({ bsPid: 1, bsUid: 2, name: 'Same', uuid: uuidV3('Same') });
    for (let i = 0; i < 5; i += 1) {
      const r = store.upsertCharacter({
        bsPid: 1, bsUid: 2, name: 'Same', uuid: uuidV3('Same'),
      });
      assert.equal(r.created, false);
      assert.equal(r.renamed, false);
    }
    assert.equal(store.countCharacters(), 1);
    assert.deepEqual(JSON.parse(store.getCharacter(1)!.prev_names), []);
  });

  test('按当前名与历史名都能找到同一个人', () => {
    store.upsertCharacter({ bsPid: 7, bsUid: 2, name: 'OldName', uuid: uuidV3('OldName') });
    store.upsertCharacter({ bsPid: 7, bsUid: 2, name: 'NewName', uuid: uuidV3('NewName') });

    assert.equal(store.findCharacterByName('NewName')?.bs_pid, 7);
    assert.equal(store.findCharacterByName('OldName')?.bs_pid, 7, '历史名必须也能命中');
    assert.equal(store.findCharacterByName('nEwNaMe')?.bs_pid, 7, '应当忽略大小写');
    assert.equal(store.findCharacterByName('Someone Else'), undefined);
  });

  test('按当前 UUID 与历史 UUID 都能找到', () => {
    const oldUuid = uuidV3('OldName');
    const newUuid = uuidV3('NewName');
    store.upsertCharacter({ bsPid: 7, bsUid: 2, name: 'OldName', uuid: oldUuid });
    store.upsertCharacter({ bsPid: 7, bsUid: 2, name: 'NewName', uuid: newUuid });

    assert.equal(store.findCharacterByUuid(newUuid)?.bs_pid, 7);
    assert.equal(store.findCharacterByUuid(oldUuid)?.bs_pid, 7);
    assert.equal(store.findCharacterByUuid(uuidV3('Stranger')), undefined);
  });

  test('uuid 为空是合法的（角色从没经 Yggdrasil 登录过）', () => {
    store.upsertCharacter({ bsPid: 9, bsUid: 3, name: 'NeverLoggedIn', uuid: null });
    const row = store.getCharacter(9)!;
    assert.equal(row.uuid, null);
    assert.equal(store.findCharacterByName('NeverLoggedIn')?.bs_pid, 9);
  });

  test('一个账号可以有多个角色', () => {
    store.upsertCharacter({ bsPid: 1, bsUid: 2, name: 'A', uuid: uuidV3('A') });
    store.upsertCharacter({ bsPid: 2, bsUid: 2, name: 'B', uuid: uuidV3('B') });
    store.upsertCharacter({ bsPid: 3, bsUid: 2, name: 'C', uuid: uuidV3('C') });
    store.upsertCharacter({ bsPid: 4, bsUid: 5, name: 'D', uuid: uuidV3('D') });

    const status = store.charactersStatus();
    assert.equal(status.count, 4);
    assert.equal(status.multiCharacterAccounts, 1, '只有 uid=2 是单账号多角色');
  });
});

describe('身份解析', () => {
  beforeEach(() => {
    store.upsertCharacter({ bsPid: 7, bsUid: 2, name: 'Kansamu', uuid: uuidV3('Kansamu') });
  });

  test('按 uuid 解析', () => {
    assert.equal(store.resolveCharacterPid({ uuid: uuidV3('Kansamu') }), 7);
  });

  test('按名字解析', () => {
    assert.equal(store.resolveCharacterPid({ name: 'Kansamu' }), 7);
  });

  test('uuid 优先于名字（两者冲突时以 uuid 为准）', () => {
    // uuid 是确定性的，名字可能被手工改过
    assert.equal(
      store.resolveCharacterPid({ uuid: uuidV3('Kansamu'), name: 'WrongName' }),
      7,
    );
  });

  test('解析不出时返回 null，**不**编造 pid', () => {
    // 编造 pid（比如拿 uuid 哈希当 pid）会把不同的人合并成同一个账号 ——
    // 那比「解析不出」危险得多。
    assert.equal(store.resolveCharacterPid({ uuid: uuidV3('Stranger') }), null);
    assert.equal(store.resolveCharacterPid({ name: 'Stranger' }), null);
    assert.equal(store.resolveCharacterPid({}), null);
  });
});

describe('改名不能绕过封禁（本模块存在的理由）', () => {
  test('封禁按 pid 存，改名后依然生效', () => {
    // 1) 玩家以旧名加入
    const oldUuid = uuidV3('OldName');
    store.upsertCharacter({ bsPid: 7, bsUid: 2, name: 'OldName', uuid: oldUuid });
    store.playerJoin({ uuid: oldUuid, name: 'OldName', nodeId: 'survival-01', ip: null });
    const pid = store.resolveCharacterPid({ uuid: oldUuid, name: 'OldName' });
    assert.equal(pid, 7);

    // 2) 管理员封禁他（带 pid）
    store.createPunishment({
      id: 'p_rename', type: 'ban', uuid: oldUuid, name: 'OldName',
      reason: '作弊', operator: 'admin', nodeId: null, expiresAt: null, bsPid: pid,
    });
    assert.equal(store.listActivePunishmentsForPid(7).length, 1);

    // 3) 玩家改名 —— 名字与 UUID 一起变（这就是 UUID v3 的性质）
    const newUuid = uuidV3('NewName');
    store.upsertCharacter({ bsPid: 7, bsUid: 2, name: 'NewName', uuid: newUuid });

    // 4) 关键断言：新身份解析到同一个 pid，封禁依然查得到
    const newPid = store.resolveCharacterPid({ uuid: newUuid, name: 'NewName' });
    assert.equal(newPid, 7, '改名后必须仍解析到同一个角色');
    assert.equal(
      store.listActivePunishmentsForPid(newPid).length,
      1,
      '改名后封禁必须依然生效 —— 否则玩家改个名就回来了',
    );

    // 5) 反面对照：如果只按 UUID 查（老做法），就查不到了
    assert.equal(
      store.listActivePunishmentsFor(newUuid).length,
      0,
      '按新 UUID 查不到 —— 这正是必须按 pid 存的原因',
    );
  });

  test('刷新身份快照后，Agent 拿到的是新名字与新 UUID', () => {
    const oldUuid = uuidV3('OldName');
    store.createPunishment({
      id: 'p_snap', type: 'ban', uuid: oldUuid, name: 'OldName',
      reason: '测试', operator: 'admin', nodeId: null, expiresAt: null, bsPid: 7,
    });

    const newUuid = uuidV3('NewName');
    const before = store.getPunishRevision();
    const updated = store.updatePunishmentIdentity('p_snap', {
      uuid: newUuid, name: 'NewName',
    });

    assert.ok(updated);
    assert.equal(updated.uuid, newUuid);
    assert.equal(updated.name, 'NewName');
    assert.equal(updated.bs_pid, 7, 'pid 不变');
    assert.equal(
      store.getPunishRevision(),
      before + 1,
      '身份变了就是快照变了，必须递增 revision 才会重新下发',
    );
  });

  test('没有 pid 的封禁被统计为「改名即可绕过」', () => {
    // 目录里没有这个角色（没导入），只能按 uuid 存
    store.createPunishment({
      id: 'p_orphan', type: 'ban', uuid: uuidV3('Ghost'), name: 'Ghost',
      reason: '测试', operator: 'admin', nodeId: null, expiresAt: null, bsPid: null,
    });

    const status = store.charactersStatus();
    assert.equal(status.renameBypassable, 1, '必须被显式统计出来');

    // 补上目录后再封一条，绕过计数不该增加
    store.upsertCharacter({ bsPid: 42, bsUid: 9, name: 'Known', uuid: uuidV3('Known') });
    store.createPunishment({
      id: 'p_safe', type: 'ban', uuid: uuidV3('Known'), name: 'Known',
      reason: '测试', operator: 'admin', nodeId: null, expiresAt: null, bsPid: 42,
    });
    assert.equal(store.charactersStatus().renameBypassable, 1, '有关联的不该计入');
  });

  test('已撤销的孤儿封禁不计入绕过风险', () => {
    store.createPunishment({
      id: 'p_revoked', type: 'ban', uuid: uuidV3('Ghost'), name: 'Ghost',
      reason: '测试', operator: 'admin', nodeId: null, expiresAt: null, bsPid: null,
    });
    assert.equal(store.charactersStatus().renameBypassable, 1);

    store.revokePunishment('p_revoked', 'admin');
    assert.equal(
      store.charactersStatus().renameBypassable,
      0,
      '撤销之后不再是风险',
    );
  });

  test('已过期的孤儿封禁不计入绕过风险', () => {
    store.createPunishment({
      id: 'p_exp', type: 'ban', uuid: uuidV3('Ghost'), name: 'Ghost',
      reason: '测试', operator: 'admin', nodeId: null, expiresAt: Date.now() - 1000, bsPid: null,
    });
    assert.equal(store.charactersStatus().renameBypassable, 0);
  });
});

describe('目录健康度', () => {
  test('目录为空时标记 stale', () => {
    const status = store.charactersStatus();
    assert.equal(status.count, 0);
    assert.equal(status.stale, true);
    assert.equal(status.lastSyncedAt, null);
  });

  test('刚导入后不 stale', () => {
    store.upsertCharacter({ bsPid: 1, bsUid: 2, name: 'A', uuid: uuidV3('A') });
    const status = store.charactersStatus();
    assert.equal(status.stale, false);
    assert.ok(status.lastSyncedAgoMs !== null && status.lastSyncedAgoMs < 5000);
  });

  test('统计有 UUID 的角色数', () => {
    store.upsertCharacter({ bsPid: 1, bsUid: 2, name: 'A', uuid: uuidV3('A') });
    store.upsertCharacter({ bsPid: 2, bsUid: 2, name: 'B', uuid: null });
    const status = store.charactersStatus();
    assert.equal(status.count, 2);
    assert.equal(status.withUuid, 1);
  });
});
