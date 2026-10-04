/**
 * 统一资产层。
 *
 * 系统里并存三种「数值」，语义完全不同，混在一起管必然出账：
 *
 *  1. credit —— 皮肤站积分。唯一账本是 kokuu 库的 users.score，
 *     一切变动落 credit_ledger。这是**权威资产**。
 *  2. coin   —— 游戏内经济插件货币（EssentialsX / CMI / Vault 后端）。
 *     真身在游戏服的内存/存档里，中间件**不直连**，只能通过插件下达指令。
 *  3. points —— 游戏内点券（PlayerPoints）。真身在 PlayerPoints 自己的表里。
 *
 * ★ 铁律：只有 credit 能被中间件直接写库。coin / points 的真身在游戏服，
 *   中间件改了数据库也没用（下次插件一覆盖就丢），必须经由插件执行。
 *   所以所有 coin / points 的写操作，最终都编译成一条「给插件的指令」下发。
 */

/** 资产种类。存储位置与写入方式见文件头注释。 */
export const ASSET = {
  CREDIT: 'credit',   // 皮肤站积分，直写数据库
  COIN: 'coin',       // 游戏金币，经插件下发
  POINTS: 'points',   // 游戏点券，经插件下发
};

export const ASSET_META = {
  [ASSET.CREDIT]: {
    label: '皮肤站积分',
    unit: '分',
    writable: 'db',        // 中间件直写
    color: 'blue',
    desc: '权威账本 users.score，每次变动落 credit_ledger',
  },
  [ASSET.COIN]: {
    label: '游戏金币',
    unit: '金',
    writable: 'plugin',    // 经插件
    color: 'amber',
    desc: '经济插件货币，中间件不直连，经 ExchangeBridge 下发指令',
  },
  [ASSET.POINTS]: {
    label: '游戏点券',
    unit: '券',
    writable: 'plugin',
    color: 'purple',
    desc: 'PlayerPoints 余额，经 ExchangeBridge 下发指令',
  },
};

export const ASSET_LIST = [ASSET.CREDIT, ASSET.COIN, ASSET.POINTS];

export function isAsset(v) {
  return ASSET_LIST.includes(v);
}

/**
 * 指令模板。
 *
 * 中间件把「给某人加 100 金币」编译成一条控制台指令，写进 Redis，
 * 插件 BRPOP 取出后在**主线程**执行。
 *
 * 为什么走控制台指令而不是自定义协议：
 *   - 不需要在插件里开 HTTP 端口（安全）
 *   - 复用 Bukkit 已有的指令分发与权限体系
 *   - 玩家离线也能执行（经济插件支持 OfflinePlayer）
 *
 * ⚠️ 数值必须严格校验成纯数字后再拼进指令 ——
 *   拼字符串进控制台指令是命令注入的经典入口。这里只允许 /^-?\d+$/，
 *   玩家名也要过白名单（只允许字母数字下划线短横线），挡住分号与换行。
 */
const SAFE_INT = /^-?\d+$/;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,16}$/;

/**
 * UUID 白名单：Bukkit 的 getUniqueId() 就是标准 8-4-4-4-12 形式。
 *
 * ★ 账本主键是 UUID，所以它同样要过白名单 —— 玩家名能挡分号与换行，
 *   UUID 一样可能被构造成注入串（它会进 Redis 消息体与 SQL 参数）。
 *   严格只接受标准形式，顺带把「全 0 的离线玩家假 UUID」也排除掉：
 *   Bukkit 对从未上线过的名字会返回 00000000-0000-0000-0000-000000000000，
 *   拿它当主键会把不同玩家合并成一个人。
 */
const SAFE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** 校验一个 UUID 可以安全用作账本主键。 */
export function assertSafeUuid(v) {
  const s = String(v || '').trim();
  if (!SAFE_UUID.test(s)) throw new Error(`UUID「${v}」格式非法`);
  if (s.toLowerCase() === NIL_UUID) {
    throw new Error('收到空 UUID（玩家可能从未上线过），无法确定身份');
  }
  return s.toLowerCase();
}

/** 校验一个玩家名是否可以安全地拼进指令。MC 正则名就是这几种字符。 */
export function assertSafeName(name) {
  const n = String(name || '').trim();
  if (!SAFE_NAME.test(n)) {
    throw new Error(`玩家名「${n}」含非法字符，已拒绝（只允许字母/数字/下划线/短横线，1-16 位）`);
  }
  return n;
}

/** 校验一个数值可以安全拼进指令。 */
export function assertSafeInt(v, what = '数值') {
  const s = String(v).trim();
  if (!SAFE_INT.test(s)) throw new Error(`${what}「${v}」非法`);
  return parseInt(s, 10);
}

/**
 * 指令构造器。每种资产一张表，白名单式 —— 不做通用模板拼接。
 */
const BUILDERS = {
  /** 皮肤站→游戏：发金币（原有兑换链路也走这里） */
  [ASSET.COIN]: (name, delta) => {
    const n = assertSafeName(name);
    const d = assertSafeInt(delta, '金币变动');
    return d >= 0
      ? `eco give ${n} ${Math.abs(d)}`
      : `eco take ${n} ${Math.abs(d)}`;
  },
  /** 点券用 /points 命令。give 带正数，take 内部会取绝对值。 */
  [ASSET.POINTS]: (name, delta) => {
    const n = assertSafeName(name);
    const d = assertSafeInt(delta, '点券变动');
    return d >= 0
      ? `points give ${n} ${Math.abs(d)}`
      : `points take ${n} ${Math.abs(d)}`;
  },
};

/** 编译一条资产变更指令。抛异常即拒绝，绝不返回半成品。 */
export function buildCommand(asset, playerName, delta) {
  const b = BUILDERS[asset];
  if (!b) throw new Error(`暂不支持对 ${asset} 下发指令`);
  return b(playerName, delta);
}

/** 查余额用的指令（只读，不改数据）。 */
const QUERY_BUILDERS = {
  [ASSET.COIN]: (n) => `eco balance ${assertSafeName(n)}`,
  [ASSET.POINTS]: (n) => `points look ${assertSafeName(n)}`,
};

export function buildQuery(asset, playerName) {
  const b = QUERY_BUILDERS[asset];
  if (!b) throw new Error(`${asset} 不支持余额查询`);
  return b(playerName);
}
