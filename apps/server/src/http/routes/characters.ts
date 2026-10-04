/**
 * 皮肤站角色目录。
 *
 * 这是平台的**身份锚点**视图。详见 docs/ECOSYSTEM.md §4.1：
 * 本站 Yggdrasil 用 UUID v3（`md5("OfflinePlayer:" + 角色名)`），
 * 所以名字与 UUID 是等价标识，改名会让两者一起变，**只有 `pid` 不变**。
 *
 * 目录从皮肤站同步而来，平台的封禁靠它才能扛住改名。
 * 因此这里最重要的接口不是「列出角色」，而是 `status` ——
 * 它把「目录有多旧、有多少封禁因此可被绕过」暴露成显式数字。
 */

import type { FastifyInstance } from 'fastify';

import { toProtocolPunishment } from '../../agent/gateway.ts';
import {
  optStr,
  pageParams,
  requirePermission,
  type AppContext,
} from '../context.ts';

function parseJsonArray(raw: string): string[] {
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
}

export function registerCharacterRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * 目录健康度。
   *
   * `renameBypassable` 是关键数字：没有关联 pid 的生效封禁数量。
   * 它 > 0 就说明「有封禁看起来生效、实际能被改名绕过」——
   * 这是最危险的状态，必须让管理员看见，而不是只写进日志。
   */
  app.get('/_api/characters/status', async (request) => {
    requirePermission(request, 'punish.view');
    const status = ctx.store.charactersStatus();

    return {
      ...status,
      // 目录没导入时，前端应该引导去导入，而不是显示「0 个角色」让人以为一切正常。
      configured: status.count > 0,
      hint:
        status.count === 0
          ? '尚未导入皮肤站角色目录。没有目录时，封禁只能按 UUID 匹配 —— ' +
            '而本站 UUID 由角色名派生，玩家改名即可绕过。' +
            '导入方式：node tools/import-characters.mjs --help'
          : status.renameBypassable > 0
            ? `有 ${status.renameBypassable} 条生效封禁未关联角色，改名即可绕过。` +
              '请在角色目录同步后重建这些封禁。'
            : null,
    };
  });

  /** 角色列表，支持按当前名 / 历史名 / uuid / uid / pid 搜索。 */
  app.get('/_api/characters', async (request) => {
    requirePermission(request, 'punish.view');
    const query = request.query as Record<string, unknown>;
    const { page, size } = pageParams(query);
    const kw = optStr(query, 'kw');

    let rows = ctx.store.listCharacters(5000);

    if (kw) {
      const needle = kw.toLowerCase();
      rows = rows.filter((row) => {
        if (String(row.bs_pid) === kw || String(row.bs_uid) === kw) return true;
        if (row.name.toLowerCase().includes(needle)) return true;
        if (row.uuid?.toLowerCase().includes(needle)) return true;
        return parseJsonArray(row.prev_names).some((n) =>
          n.toLowerCase().includes(needle),
        );
      });
    }

    const total = rows.length;
    const start = (page - 1) * size;

    return {
      items: rows.slice(start, start + size).map((row) => {
        const activeBans = ctx.store.listActivePunishmentsForPid(row.bs_pid);
        return {
          bsPid: row.bs_pid,
          bsUid: row.bs_uid,
          name: row.name,
          uuid: row.uuid,
          prevNames: parseJsonArray(row.prev_names),
          prevUuids: parseJsonArray(row.prev_uuids),
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
          source: row.source,
          activePunishments: activeBans.length,
        };
      }),
      total,
      page,
      size,
    };
  });

  /** 单个角色：含它的历史身份与全部封禁（含已撤销）。 */
  app.get<{ Params: { pid: string } }>('/_api/characters/:pid', async (request) => {
    requirePermission(request, 'punish.view');
    const bsPid = Number.parseInt(request.params.pid, 10);
    if (!Number.isInteger(bsPid) || bsPid <= 0) {
      throw Object.assign(new Error('pid 必须是正整数'), { code: 'INVALID_PARAMS' });
    }

    const row = ctx.store.getCharacter(bsPid);
    if (!row) {
      throw Object.assign(new Error(`角色 ${bsPid} 不在目录中`), { code: 'NOT_FOUND' });
    }

    return {
      character: {
        bsPid: row.bs_pid,
        bsUid: row.bs_uid,
        name: row.name,
        uuid: row.uuid,
        prevNames: parseJsonArray(row.prev_names),
        prevUuids: parseJsonArray(row.prev_uuids),
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        source: row.source,
      },
      punishments: ctx.store.listPunishmentsForPid(bsPid).map(toProtocolPunishment),
      activePunishments: ctx.store.listActivePunishmentsForPid(bsPid).length,
    };
  });
}
