/**
 * 桥接配置与游戏侧账本表的结构定义（幂等）。
 *
 * 为什么不直接 ALTER 现有表：users / credit_ledger 属于皮肤站内核与
 * kokuu-credit 插件的领地，中间件只读 + 按其约定写，不动结构。
 * 新表一律走 CREATE TABLE IF NOT EXISTS，重复执行安全。
 */

export const SCHEMA = [
  // ── 中间件配置（key-value，后台可改）────────────────────────
  `CREATE TABLE IF NOT EXISTS bridge_config (
     cfg_key    VARCHAR(64)  NOT NULL,
     cfg_value  VARCHAR(255) NOT NULL,
     updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (cfg_key)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── 游戏侧流水：金币 → 积分的每一笔兑换 ─────────────────────
  // 幂等靠 uniq_event 唯一索引，与 credit_ledger 同一套思路。
  `CREATE TABLE IF NOT EXISTS bridge_exchange (
     id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
     uniq_event     VARCHAR(96)  NOT NULL,
     player_name    VARCHAR(64)  NOT NULL,
     player_uuid    CHAR(36)     NOT NULL DEFAULT '',
     uid            INT UNSIGNED NOT NULL,
     coin_delta     INT          NOT NULL,
     credit_delta   INT          NOT NULL,
     credit_after   INT          NOT NULL,
     reason         VARCHAR(64)  NOT NULL DEFAULT 'manual',
     note           VARCHAR(191) NOT NULL DEFAULT '',
     created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uniq_event (uniq_event),
     KEY idx_uid (uid),
     KEY idx_uuid (player_uuid),
     KEY idx_created (created_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── 身份绑定：Minecraft UUID ↔ 皮肤站 uid ──────────────────
  //
  // ★ 为什么不直接把 uuid 塞进 users 表：
  //   users 属于皮肤站内核，中间件不改它的结构（见本文件开头）。
  //   而 players 表（pid, uid, name）也只有名字，没有 uuid。
  //   所以中间件自建一张映射表，插件第一次上报 uuid 时落一条，
  //   之后一律走 uuid —— 玩家改名不影响账户。
  //
  // ★ 为什么必须留这张表：
  //   「按名字找账户」在改名后直接失效（找不到人），
  //   在重名后更糟（找到别人）。uuid 是唯一稳定的锚点。
  `CREATE TABLE IF NOT EXISTS bridge_identity (
     id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
     mc_uuid     CHAR(36)     NOT NULL,
     player_name VARCHAR(64)  NOT NULL DEFAULT '',
     uid         INT UNSIGNED NOT NULL,
     bound_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     seen_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uniq_uuid (mc_uuid),
     KEY idx_uid (uid),
     KEY idx_name (player_name)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

/**
 * 增量补列。
 *
 * ★ 为什么需要这一步：CREATE TABLE IF NOT EXISTS 对**已存在**的表是空操作，
 *   所以老部署升级后不会自动多出新列 —— 表现为「代码要求写 player_uuid，
 *   但表里没这列」→ SQL 报 Unknown column，而且只在 skin 模式炸。
 *   这个坑非常隐蔽：全新安装完全正常，只有升级的站会挂。
 *
 * 每条都先查 information_schema 再决定要不要 ALTER，可重复执行。
 */
export const MIGRATIONS = [
  {
    table: 'bridge_exchange',
    column: 'player_uuid',
    sql: "ALTER TABLE bridge_exchange ADD COLUMN player_uuid CHAR(36) NOT NULL DEFAULT '' AFTER player_name",
  },
  {
    table: 'bridge_exchange',
    column: 'idx_uuid',
    sql: 'ALTER TABLE bridge_exchange ADD KEY idx_uuid (player_uuid)',
  },
];

/**
 * 默认配置。
 *
 * ratio  = 兑换比例：多少游戏金币 = 1 积分。后台可改，改完对新交易立即生效。
 * daily_limit = 单用户每日「金币换积分」获得的积分上限；0 = 不限。
 * single_limit= 单笔最多换多少积分；0 = 不限。
 * enabled = 总开关，关掉后 /game/convert 直接拒绝。
 * min_coin = 单笔最少消耗多少金币，挡掉刷单的小额请求。
 *
 * ★ min_coin 必须 >= ratio，否则开箱即用时每一笔兑换都会被
 *   「金币不足 1 积分」拒掉 —— 看着像功能坏了，其实是配置自相矛盾。
 *   1000 金币换 1 积分，那最少就得 1000 金币起兑。
 *
 * ── 金币回流（reflow_*）────────────────────────────────────
 * 游戏内赚到的金币被插件按比例抽走、自动换成积分。**换算比例不在这里** ——
 * 它必须与插件 config.yml 的 reflow.ratio 一致，而算式在插件侧执行
 * （只有插件能操作经济插件）。这里只留**安全阀**：
 *   reflow_enabled     总开关，默认关（打开后积分会自动增加）
 *   reflow_daily_limit 单用户每日回流积分上限，0 = 不限。与 daily_limit 分开
 *                      算是因为风控诉求不同：手动兑换要限死，自动回流要留余量。
 */
export const DEFAULTS = {
  enabled: '1',
  ratio: '1000',
  daily_limit: '200',
  single_limit: '50',
  min_coin: '1000',
  auto_source: 'game',
  reflow_enabled: '0',
  reflow_daily_limit: '0',
};

export const CONFIG_LABELS = {
  enabled: '金币换积分总开关',
  ratio: '兑换比例（金币:积分）',
  daily_limit: '每日积分上限（0=不限）',
  single_limit: '单笔积分上限（0=不限）',
  min_coin: '单笔最少金币',
  auto_source: '流水来源标记',
  reflow_enabled: '金币自动回流开关',
  reflow_daily_limit: '每日回流积分上限（0=不限）',
};
