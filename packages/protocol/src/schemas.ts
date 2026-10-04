/**
 * 协议参数校验。
 *
 * 只在「进入系统的边界」上校验：服务端校验 REST 输入，
 * Agent 侧校验入站 RPC 参数。内部调用不重复校验。
 *
 * 校验失败一律回 `INVALID_PARAMS`，`data.issues` 带字段级明细 ——
 * 只说「参数错误」的接口在排查时等于没说。
 */

import { z } from 'zod';
import { UUID_RE, NIL_UUID } from './index.ts';

/** 玩家名：MC 只允许 1–16 位字母数字下划线。 */
export const PlayerName = z
  .string()
  .regex(/^[A-Za-z0-9_]{1,16}$/, '玩家名只能是 1–16 位字母、数字或下划线');

/**
 * UUID：严格格式，且排除全 0。
 * 全 0 是 Bukkit 对「从未上线过的名字」的返回值 ——
 * 放进来会把不同玩家合并成同一个账号。
 */
export const Uuid = z
  .string()
  .regex(UUID_RE, 'UUID 格式不正确')
  .refine((v) => v.toLowerCase() !== NIL_UUID, '不接受全 0 UUID');

/** 权限节点：`a.b.c`，允许 `*` 通配。 */
export const PermissionNode = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.*\-]+$/, '权限节点含有非法字符');

/** LuckPerms 组名：小写字母数字下划线，与 LP 自身的约束一致。 */
export const GroupName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_\-]+$/, '组名只能是小写字母、数字、下划线或连字符');

const Reason = z.string().max(500);

export const ServerToAgentParamSchemas = {
  ping: z.object({}).strict(),

  'server.info': z.object({}).strict(),
  'server.metrics': z.object({}).strict(),
  'console.execute': z
    .object({
      command: z
        .string()
        .min(1)
        .max(1000)
        // 换行会把一条命令变成多条 —— 这是控制台注入最基本的入口。
        .refine((v) => !/[\r\n]/.test(v), '命令不能包含换行'),
    })
    .strict(),

  'players.list': z.object({ withIp: z.boolean().optional() }).strict(),
  'players.detail': z.object({ uuid: Uuid }).strict(),
  'players.kick': z.object({ uuid: Uuid, reason: Reason }).strict(),
  'players.setOp': z.object({ uuid: Uuid, value: z.boolean() }).strict(),
  'players.setGamemode': z
    .object({
      uuid: Uuid,
      gamemode: z.enum(['SURVIVAL', 'CREATIVE', 'ADVENTURE', 'SPECTATOR']),
    })
    .strict(),
  'players.setWhitelist': z
    .object({ uuid: Uuid, name: PlayerName, value: z.boolean() })
    .strict(),
  'players.resolve': z.object({ name: PlayerName }).strict(),

  'punish.apply': z
    .object({
      punishment: z
        .object({
          id: z.string().min(1).max(64),
          type: z.enum(['ban', 'mute', 'warn', 'kick']),
          uuid: Uuid,
          name: PlayerName,
          reason: Reason,
          operator: z.string().min(1).max(64),
          nodeId: z.string().min(1).max(64).nullable(),
          createdAt: z.number().int().nonnegative(),
          expiresAt: z.number().int().nonnegative().nullable(),
          active: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  'punish.revoke': z.object({ id: z.string().min(1).max(64) }).strict(),
  'punish.kickNow': z.object({ uuid: Uuid, reason: Reason }).strict(),

  'whitelist.list': z.object({}).strict(),
  'whitelist.setEnabled': z.object({ value: z.boolean() }).strict(),

  'luckperms.permissions.catalog': z
    .object({
      query: z.string().max(64).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    })
    .strict(),

  'luckperms.user.get': z
    .object({ uuid: Uuid, name: PlayerName.optional() })
    .strict(),
  'luckperms.user.setPrimaryGroup': z
    .object({ uuid: Uuid, group: GroupName })
    .strict(),
  'luckperms.user.addGroup': z.object({ uuid: Uuid, group: GroupName }).strict(),
  'luckperms.user.removeGroup': z
    .object({ uuid: Uuid, group: GroupName })
    .strict(),
  'luckperms.user.setPermission': z
    .object({ uuid: Uuid, permission: PermissionNode, value: z.boolean() })
    .strict(),
  'luckperms.user.unsetPermission': z
    .object({ uuid: Uuid, permission: PermissionNode })
    .strict(),
  'luckperms.user.setMeta': z
    .object({
      uuid: Uuid,
      prefix: z.string().max(64).optional(),
      suffix: z.string().max(64).optional(),
    })
    .strict(),

  'luckperms.groups.list': z.object({}).strict(),
  'luckperms.group.create': z.object({ name: GroupName }).strict(),
  'luckperms.group.delete': z.object({ name: GroupName }).strict(),
  'luckperms.group.setPermission': z
    .object({ name: GroupName, permission: PermissionNode, value: z.boolean() })
    .strict(),
  'luckperms.group.unsetPermission': z
    .object({ name: GroupName, permission: PermissionNode })
    .strict(),
  'luckperms.group.setParent': z
    .object({ name: GroupName, parent: GroupName })
    .strict(),
  'luckperms.group.removeParent': z
    .object({ name: GroupName, parent: GroupName })
    .strict(),
  'luckperms.group.setWeight': z
    .object({ name: GroupName, weight: z.number().int().min(-32768).max(32767) })
    .strict(),
  'luckperms.group.setMeta': z
    .object({
      name: GroupName,
      prefix: z.string().max(64).optional(),
      suffix: z.string().max(64).optional(),
    })
    .strict(),

  'economy.getBalance': z
    .object({ uuid: Uuid, name: PlayerName.optional() })
    .strict(),
  'economy.adjust': z
    .object({
      uuid: Uuid,
      name: PlayerName,
      // 不接受 0：一次「加 0 金币」在审计日志里毫无意义，只会制造噪音。
      amount: z
        .number()
        .finite()
        .refine((v) => v !== 0, '调整数额不能为 0'),
      note: z.string().max(200).optional(),
      eventId: z.string().min(1).max(128),
    })
    .strict(),
} as const;

export const AgentToServerParamSchemas = {
  'player.resolve': z
    .object({ uuid: Uuid.optional(), name: PlayerName.optional() })
    .strict()
    // 两个都不给就没法定位玩家。只给一个即可 —— name 用于「按名字查历史」。 
    .refine((v) => Boolean(v.uuid) || Boolean(v.name), {
      message: 'uuid 与 name 至少要给一个',
    }),
  'punish.snapshot': z.object({}).strict(),
  'economy.stats': z.object({}).strict(),
} as const;

/**
 * 握手载荷。
 *
 * **故意不用 `.strict()`**：同一个协议版本内新增字段属于次版本变更，
 * 老平台遇到新插件多带的字段应当忽略而不是拒绝握手。
 * 真正需要拦住的是「协议版本不同」，那由 `protocolVersion` 字段判定。
 */
export const HelloSchema = z
  .object({
    protocolVersion: z.number().int(),
    nodeId: z.string().min(1).max(64),
    secret: z.string().min(1).max(256),
    agent: z
      .object({
        version: z.string().max(32),
        mcVersion: z.string().max(64),
        brand: z.string().max(64),
        javaVersion: z.string().max(32),
      })
      .strict(),
    capabilities: z.array(
      z.enum([
        'console',
        'players',
        'punish',
        'whitelist',
        'luckperms',
        'economy',
      ]),
    ),
  });

export type HelloPayload = z.infer<typeof HelloSchema>;

/**
 * 校验并把 zod 的报错压成协议里的 `data.issues`。
 * 返回 `{ ok: true, value }` 或 `{ ok: false, error }`。
 */
export function validate<T>(
  schema: z.ZodType<T>,
  input: unknown,
):
  | { ok: true; value: T }
  | { ok: false; error: { code: 'INVALID_PARAMS'; message: string; data: unknown } } {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };

  const issues = parsed.error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
  const summary = issues
    .slice(0, 3)
    .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
    .join('；');

  return {
    ok: false,
    error: {
      code: 'INVALID_PARAMS',
      message: summary || '参数校验失败',
      data: { issues },
    },
  };
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: { code: 'INVALID_PARAMS' | 'UNSUPPORTED'; message: string; data: unknown };
    };

/**
 * 校验「平台 → Agent」的方法参数。
 *
 * 存在的意义不只是类型好看：把「未知方法」和「参数不合法」收敛到
 * 同一个入口，避免每个调用点自己写一遍查表逻辑（然后漏掉其中一种）。
 */
export function validateServerToAgentParams(
  method: string,
  params: unknown,
): ValidationResult<unknown> {
  const schema = (
    ServerToAgentParamSchemas as Record<string, z.ZodType<unknown>> | undefined
  )?.[method];
  if (!schema) {
    return {
      ok: false,
      error: {
        code: 'UNSUPPORTED',
        message: `平台不知道方法 ${method} 的参数格式`,
        data: { method },
      },
    };
  }
  return validate(schema, params ?? {}) as ValidationResult<unknown>;
}

/** 校验「Agent → 平台」的方法参数。未知方法回 UNSUPPORTED。 */
export function validateAgentToServerParams(
  method: string,
  params: unknown,
): ValidationResult<unknown> {
  const schema = (
    AgentToServerParamSchemas as Record<string, z.ZodType<unknown>> | undefined
  )?.[method];
  if (!schema) {
    return {
      ok: false,
      error: {
        code: 'UNSUPPORTED',
        message: `平台不支持方法 ${method}`,
        data: { method },
      },
    };
  }
  return validate(schema, params ?? {}) as ValidationResult<unknown>;
}
