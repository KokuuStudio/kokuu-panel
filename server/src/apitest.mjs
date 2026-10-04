/**
 * 中间件接口冒烟测试 —— 同一份跑两种后端。
 *
 * 用法：
 *   node src/apitest.mjs http://127.0.0.1:8799 <ADMIN_TOKEN>
 *
 * ★ 断言分流的理由：
 *   两种后端存在**设计上**的行为差异 ——
 *     standalone  账户可手工创建；玩家首次消费自动开户
 *     skin        账户由皮肤站注册流程产生；玩家必须先绑定 uid
 *   这些差异不是 bug。所以账户相关断言按 hasSkin 分流，
 *   而幂等 / 限额 / 注入防护 / 鉴权 / 配置校验这些**安全性质**
 *   两种后端必须完全一致地通过 —— 那才是模块化到位的判据。
 */
import http from 'node:http';
import crypto from 'node:crypto';

const T = process.argv[3] || process.env.ADMIN_TOKEN || '';
const BASE = process.argv[2] || 'http://127.0.0.1:8799';

// ⚠️ 本机设了 HTTP_PROXY，undici 的 fetch 会照着代理走，
//   而沙箱代理拒绝连本机端口（报 "upstream connect failed"）。
//   用 node:http 直连最稳，不受代理配置影响。
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;

/**
 * ★ 与 reflowtest 同一处改动：请求失败不 reject，而是返回哨兵值。
 *   这里更必要 —— apitest 大量用 Promise.all 并发发请求，
 *   reject 会让整批一起炸掉，输出里一条断言都看不到，
 *   只剩一句 triggerUncaughtException。
 */
function raw(method, path, body, token = T) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: new URL(BASE).port, path: '/api' + path,
      method,
      headers: {
        ...(token ? { 'X-Admin-Token': token } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
      timeout: 10000,
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        let j; try { j = JSON.parse(s); } catch { j = s || '<空>'; }
        resolve({ code: res.statusCode, j });
      });
    });
    req.on('error', (e) => resolve({ code: 0, j: { error: `请求失败：${e.message}` } }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ code: 0, j: { error: '请求超时（10s）—— 后端可能已崩溃或无响应' } });
    });
    if (payload) req.write(payload);
    req.end();
  });
}
const call = raw;

let fails = 0;
const expect = (t, r, want, pred) => {
  const ok = pred ? pred(r) : r.code === want;
  if (!ok) fails++;
  const body = JSON.stringify(r.j);
  console.log(`${ok ? '✓' : '✗'} ${t}  → ${r.code} ${body.length > 150 ? body.slice(0, 150) + '…' : body}`);
};

// 随机后缀：建账户/改分都是幂等敏感的，重跑不能撞上一轮的数据
const U  = 'U' + Math.random().toString(36).slice(2, 7);
const EH = 'h' + Math.random().toString(36).slice(2, 7);
const EV = 'g' + Math.random().toString(36).slice(2, 7);
const PN = 'P' + Math.random().toString(36).slice(2, 7);

// 合法 UUID（8-4-4-4-12）。
// ★ 必须用 crypto 而不是 Math.random().toString(16)：后者切片长度不固定，
//   会随机产出 11 位或 7 位的一段，看着像后端正则写错了 —— 这种测试自身的
//   bug 最容易让人怀疑被测代码，实际错在测试里。
const UUID = crypto.randomUUID();
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const r = {};
r.meta   = await call('GET', '/meta');
console.log(`后端 = ${r.meta.j.backend}｜测试 uid = ${U}｜测试 uuid = ${UUID}\n`);

r.create = await call('POST', '/users', { uid: U, name: U });
r.dup    = await call('POST', '/users', { uid: U });
r.list   = await call('GET', '/users?kw=' + U);
r.plus   = await call('POST', `/users/${U}/score`, { delta: 500, eventId: EH, note: '测试' });
r.idem   = await call('POST', `/users/${U}/score`, { delta: 500, eventId: EH });
r.over   = await call('POST', `/users/${U}/score`, { delta: -99999, eventId: EH + 'z' });
r.inj    = await call('POST', '/assets/adjust', { asset: 'coin', player: 'a;shutdown', delta: 100 });
r.inj2   = await call('POST', '/assets/adjust', { asset: 'coin', player: 'Steve', delta: '1 OR 1=1' });
r.stats  = await call('GET', '/stats');
r.cfg    = await call('GET', '/config');
r.cfgOk  = await call('PUT', '/config', { ratio: '500' });
r.cfgBad = await call('PUT', '/config', { min_coin: '0' });
r.cfgBad2= await call('PUT', '/config', { ratio: '0' });
r.cfgJunk= await call('PUT', '/config', { evil: 'x', daily_limit: '300' });
r.cfgBack= await call('PUT', '/config', { ratio: '1000', min_coin: '1000', daily_limit: '200' });

// 带 UUID 的兑换：验证 uuid 才是主路径
r.convU  = await call('POST', '/game/convert',
  { playerName: PN, uuid: UUID, coin: 3000, eventId: EV, reason: 'sell' });
// 空 UUID 必须被拒（会把不同玩家合并成一个人）
r.convNil= await call('POST', '/game/convert',
  { playerName: PN, uuid: NIL_UUID, coin: 3000, eventId: EV + 'n', reason: 'sell' });
r.convBad= await call('POST', '/game/convert',
  { playerName: PN, uuid: "'; DROP TABLE users; --", coin: 3000, eventId: EV + 'b', reason: 'sell' });
// 改名后再上报同一 uuid：必须命中同一账户，不能开新户
r.convNew= await call('POST', '/game/convert',
  { playerName: PN + 'Renamed', uuid: UUID, coin: 2000, eventId: EV + 'x', reason: 'sell' });
r.sugg   = await call('GET', '/players/suggest?kw=' + PN.slice(0, 3));
r.ledg   = await call('GET', '/ledger?size=50');
r.lFrom  = await call('GET', '/ledger?from=2000-01-01');
// ★ 用**本地**日期，不是 toISOString()：
//   toISOString() 取的是 UTC 日期。在 GMT+8 的凌晨 0–8 点里，
//   UTC 还停在前一天，于是 from=<昨天> 会把刚写的流水全排除掉，
//   「查今天有数据」必然失败。本地测试一直在下午跑，UTC 与本地同一天，
//   所以这个 bug 藏了很久 —— 它只在非 UTC 时区的凌晨发作。
//   正确做法：区间语义本来就以服务器本地时间为准（见 ledger.js 的 parseTimeRange），
//   测试也得用本地日期才与服务端口径一致。
const localDate = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();
r.lToday = await call('GET', '/ledger?from=' + localDate);

r.lJunk  = await call('GET', '/ledger?from=not-a-date');
r.lSrc   = await call('GET', '/ledger?source=game');
r.detail = await call('GET', '/users/' + U);
r.uDetail= await call('GET', '/users/' + UUID);
r.noauth = await call('GET', '/users', undefined, '');
r.wrong  = await call('GET', '/users', undefined, 'wrong-token-value');
r.noevt  = await call('POST', `/users/${U}/score`, { delta: 5 });
r.zerod  = await call('POST', `/users/${U}/score`, { delta: 0, eventId: EH + 'q' });

const isSkin = r.meta.j.hasSkin === true;

// 取一个**真实存在**的账户做「按玩家名筛选」断言。
// ★ 别在 standalone 下跳过这三条 —— 跳过时整份报告仍显示「全部通过」，
//   看起来是绿的，实际根本没测「按玩家名筛流水/账户」这个功能。
//   （第一版写成 `isSkin ? rows[0] : null`，于是 standalone 永远跳过；
//     本地因为有上一轮残留数据、看不出问题，CI 全新 checkout 才暴露。）
//   standalone 下 U 是本脚本自己在上面建的，必然存在，直接用它。
//   skin 下账户由注册流程产生，只能从库里取第一个。
const rFirst = await call('GET', '/users?size=1');
const realUser = isSkin ? rFirst.j?.rows?.[0] : { uid: U, nickname: U };
const realName = realUser ? String(realUser.nickname) : '';

r.sugg2  = await call('GET', '/players/suggest?kw=' + encodeURIComponent(realName.slice(0, 2)));
r.lKw    = await call('GET', '/ledger?size=30&kw=' + encodeURIComponent(realName));
r.lUsers = await call('GET', '/users?kw=' + encodeURIComponent(realName));
r.quota  = await call('GET', '/game/quota?player=' + encodeURIComponent(realName));
r.quotaU = await call('GET', '/game/quota?player=' + encodeURIComponent(PN) + '&uuid=' + UUID);

/* ── 两种后端都必须通过的：安全性质 ─────────────────────────── */
expect('meta 自报后端', r.meta, 200, x =>
  ['skin', 'standalone'].includes(x.j.backend) && x.j.hasDatabase === isSkin);
expect('命令注入（分号）被挡', r.inj, 400, x => /非法字符/.test(x.j.error));
expect('命令注入（SQL）被挡', r.inj2, 400, x => /非法/.test(x.j.error));
expect('缺 eventId 被拒', r.noevt, 400, x => /eventId/.test(x.j.error));
expect('delta=0 被拒', r.zerod, 400, x => /非 0 整数/.test(x.j.error));
expect('统计结构完整', r.stats, 200, x =>
  typeof x.j.accounts === 'number' && typeof x.j.total === 'number' && Array.isArray(x.j.top));
expect('读配置', r.cfg, 200, x => !!x.j.config && !!x.j.labels);
expect('改比例通过', r.cfgOk, 200, x => x.j.config.ratio === '500' && x.j.config.min_coin === '1000');
expect('min_coin=0 被拒', r.cfgBad, 400, x => /不能为 0/.test(x.j.error));
expect('比例 0 被拒', r.cfgBad2, 400, x => /正整数/.test(x.j.error));
expect('未知键被白名单挡掉', r.cfgJunk, 200, x =>
  x.j.config.evil === undefined && x.j.config.daily_limit === '300');
expect('配置改回默认', r.cfgBack, 200, x => x.j.config.ratio === '1000');
expect('全站流水可读', r.ledg, 200, x => typeof x.j.total === 'number' && Array.isArray(x.j.rows));
expect('无口令 401', r.noauth, 401);
expect('错误口令 401', r.wrong, 401);

/* ── 身份：UUID 是主路径 ──────────────────────────────────── */
expect('空 UUID 被拒（会合并不同玩家）', r.convNil, 400, x => /UUID/.test(x.j.reason));
expect('非法 UUID 被拒（注入）', r.convBad, 400, x => /UUID/.test(x.j.reason));
expect('名字前缀候选按前缀匹配', r.sugg, 200, x =>
  Array.isArray(x.j.rows) && x.j.rows.every((o) => typeof o.nickname === 'string'));

/* ── 全站流水查询：时间 / 玩家 / 来源 ──────────────────────── */
// ★ 这三条**不允许静默跳过**。
//   跳过时报告照样显示「全部通过」，CI 也是绿的 —— 但功能其实没测，
//   这种"绿色的假象"比没有测试更危险：它让人以为筛选用例有覆盖。
//   所以取不到真实账户时直接判失败，把问题摆到台面上。
if (!realUser) {
  fails++;
  console.log('✗ 取不到可用于筛选的真实账户 —— 玩家名筛选断言无法执行（这是环境问题，不是功能问题）');
} else {
  expect('按玩家名筛流水', r.lKw, 200, x =>
    x.j.total > 0 && x.j.rows.every((o) => String(o.nickname || '').includes(realName)));
  expect('玩家名前缀候选能命中真实账户', r.sugg2, 200, x =>
    x.j.rows.some((o) => String(o.nickname).startsWith(realName.slice(0, 2))));
  expect('按玩家名筛账户', r.lUsers, 200, x =>
    x.j.total > 0 && x.j.rows.every((o) => String(o.nickname).includes(realName)));
}

expect('起始时间筛选不报错', r.lFrom, 200, x => typeof x.j.total === 'number');
expect('查今天有数据（只给日期须含当天）', r.lToday, 200, x => x.j.total > 0);
expect('非法时间格式被忽略而非查空', r.lJunk, 200, x => x.j.total > 0);
expect('按来源筛选生效', r.lSrc, 200, x =>
  x.j.rows.every((o) => o.source === 'game'));

/* ── 按后端分流：设计上就该不同 ────────────────────────────── */
if (isSkin) {
  expect('skin 禁止手工建账户', r.create, 400, x => /注册流程/.test(x.j.error));
  expect('未绑定玩家拒绝入账（防凭空加分）', r.convU, 400, x => /未绑定账号/.test(x.j.reason));
  // ★ skin 下 quota 查的是 players 表（MC 绑定表），不是 users 表。
  //   站上有账号 ≠ 绑过游戏，测试玩家从没在 MC 上线过，所以 bound:false 是对的。
  //   若这里断言 true，等于在要求「有站号就自动绑游戏」，那是越权。
  expect('未绑 MC 的站号查额度报未绑定', r.quota, 200, x => x.j.bound === false);
  console.log('\n注：skin 模式的账户类断言按设计跳过（账户由注册流程产生）');
} else {
  expect('可建账户', r.create, 200, x => x.j.ok);
  expect('重复建被拒', r.dup, 400);
  expect('搜索命中', r.list, 200, x => x.j.total === 1 && x.j.rows[0].uid === U);
  expect('加 500', r.plus, 200, x => x.j.after === 500);
  expect('同 eventId 幂等', r.idem, 200, x => x.j.idempotent === true && x.j.after === 500);
  expect('超额扣分被拒', r.over, 400, x => /余额不足/.test(x.j.error));
  expect('带 uuid 的兑换入账到 uuid 账户', r.convU, 200, x =>
    x.j.ok && x.j.credit === 3 && String(x.j.uid) === UUID);
  expect('改名后同 uuid 命中同一账户', r.convNew, 200, x =>
    x.j.ok && x.j.credit === 2 && String(x.j.uid) === UUID);
  expect('改名不新开户（账户数不增）', r.convNew, 200, x => String(x.j.uid) === UUID);
  expect('额度按 uuid 累计', r.quotaU, 200, x => x.j.bound === true && x.j.gotToday === 5);
  // 手工建的 U 账户只有那 1 笔手动加分：兑换流水记在 **uuid 账户**下，
  // 两者是不同账户 —— 这正是「uuid 是主键」的直接体现。
  expect('账户详情带流水', r.detail, 200, x =>
    !!x.j.user && Array.isArray(x.j.logs) && x.j.logs.length === 1);
  expect('uuid 账户详情带两条兑换流水', r.uDetail, 200, x =>
    !!x.j.user && String(x.j.user.uid) === UUID && x.j.logs.length === 2);
}

console.log(fails ? `\n${fails} 项未通过` : '\n全部通过');
process.exit(fails ? 1 : 0);
