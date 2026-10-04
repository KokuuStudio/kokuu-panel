/**
 * 离线渲染验收：headless Edge 打开页面，注入口令，走一遍三个页签并截图。
 * 顺带抓控制台错误 —— 静默的 JS 报错光看截图是发现不了的。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:5273';
const OUT = path.join(process.cwd(), '.shots');
const TOKEN = fs.readFileSync(path.join(process.cwd(), 'ops', 'token.txt'), 'utf8').trim();

fs.mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function get(port, p) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res(d));
    });
    req.on('error', rej);
  });
}

async function waitPort(port, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((res) => {
      const s = net.connect(port, '127.0.0.1');
      s.on('connect', () => { s.end(); res(true); });
      s.on('error', () => res(false));
    });
    if (ok) return true;
    await wait(400);
  }
  return false;
}

/** 用 CDP 驱动页面：注入 token、点击页签、抓 console、截图 */
async function drive(port, steps) {
  return new Promise((resolve, reject) => {
    const proc = spawn(EDGE, [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1440,900',
      '--user-data-dir=' + path.join(OUT, 'profile' + port),
      'about:blank',
    ], { stdio: 'ignore' });

    let id = 0;
    const pending = new Map();
    const logs = [];
    let ws;

    const send = (method, params = {}, sessionId) =>
      new Promise((res, rej) => {
        const msg = { id: ++id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        pending.set(msg.id, { res, rej });
        ws.send(JSON.stringify(msg));
      });

    (async () => {
      try {
        if (!(await waitPort(port))) throw new Error('CDP 端口没起来');
        const list = JSON.parse(await get(port, '/json/list'));
        const target = list.find((t) => t.type === 'page');
        const { WebSocket } = await import('node:worker_threads').then(() => ({ WebSocket: globalThis.WebSocket }));
        ws = new WebSocket(target.webSocketDebuggerUrl);

        await new Promise((r) => (ws.onopen = r));
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) {
            const p = pending.get(m.id);
            pending.delete(m.id);
            m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
          } else if (m.method === 'Runtime.consoleAPICalled' && /error|warning/.test(m.params.type)) {
            logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
          } else if (m.method === 'Runtime.exceptionThrown') {
            logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
          }
        };

        await send('Page.enable');
        await send('Runtime.enable');

        const results = [];
        // 控制台错误按步记录，并标注每条来自哪一步。
        // 为什么要分步：第 1 步是「未登录」，401 是**预期行为**，
        // 把它算进「控制台零错误」就永远达不到 —— 那是把正确的鉴权
        // 当成缺陷，验收标准就废了。
        let logMark = 0;
        const stepLogs = [];
        for (const s of steps) {
          logMark = logs.length;
          await send('Page.navigate', { url: BASE + (s.url || '') });
          await wait(s.wait || 2200);
          if (s.token) {
            await send('Runtime.evaluate', {
              expression: `localStorage.setItem('kk_admin_token', ${JSON.stringify(TOKEN)})`,
            });
            await send('Page.navigate', { url: BASE + (s.url || '') });
            await wait(2000);
          }
          if (s.click) {
            await send('Runtime.evaluate', {
              expression: `(()=>{const t=[...document.querySelectorAll('button,td,a')].find(e=>e.textContent.trim().includes(${JSON.stringify(s.click)}));if(t)t.click();return !!t})()`,
            });
            await wait(s.after || 1600);
          }
          if (s.eval) {
            // ★ awaitPromise: true —— 断言里用了 Promise（等待 DOM 变化后取值），
            //   不加这个参数 CDP 会立刻返回 {} ，看起来像断言失败，
            //   实际是根本没等。症状和「功能坏了」一模一样。
            const r = await send('Runtime.evaluate', {
              expression: s.eval, returnByValue: true, awaitPromise: true,
            });
            results.push({ step: s.name || s.click || s.url, value: r.result.value });
          }
          if (s.shot) {
            const r = await send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(path.join(OUT, s.shot), Buffer.from(r.data, 'base64'));
          }
          if (!s.allowErrors) {
            stepLogs.push(...logs.slice(logMark).map((l) => `[${s.name || s.url}] ${l}`));
          }
        }
        resolve({ results, logs: stepLogs });
      } catch (e) {
        reject(e);
      } finally {
        try { ws?.close(); } catch {}
        proc.kill();
      }
    })();
  });
}

const { results, logs } = await drive(9333, [
  { url: '/', name: '未登录应跳登录页', eval: 'location.hash', wait: 2500, shot: '1-login.png',
    // 未登录时 401 是预期行为，不计入控制台错误
    allowErrors: true },
  { url: '/', token: true, name: '登录后概览', eval: "document.querySelectorAll('.card').length + ' 张卡片'", shot: '2-overview.png' },
  { url: '/#/users', token: true, name: '用户表行数', eval: "document.querySelectorAll('.el-table__body tbody tr').length", shot: '3-users.png' },
  { url: '/#/ledger', token: true, name: '流水表行数', eval: "document.querySelectorAll('.el-table__body tbody tr').length", shot: '4-ledger.png' },
  // ── 新增页面的关键断言 ────────────────────────────────────
  { url: '/#/config', token: true, name: '配置页字段数',
    eval: "document.querySelectorAll('.el-form-item').length", shot: '5-config.png' },
  { url: '/#/config', token: true, name: '换算预览有内容',
    eval: "document.querySelector('.pv-val')?.textContent?.trim() || '(空)'" },

  // ── 金币自动回流：配置区 + 运行状态 ────────────────────────
  { url: '/#/config', token: true, name: '回流配置区存在', shot: '5b-reflow-config.png',
    eval: `(()=>{
      const heads=[...document.querySelectorAll('.el-card__header')]
        .map(e=>e.textContent.trim());
      return heads.some(h=>h.includes('金币自动回流'))?'有':'无（现有：'+heads.join(' / ')+'）';
    })()` },
  { url: '/#/config', token: true, name: '回流两项配置可见',
    eval: `(()=>{
      const labels=[...document.querySelectorAll('.el-form-item__label')]
        .map(e=>e.textContent.trim());
      const a=labels.some(l=>l.includes('金币自动回流开关'));
      const b=labels.some(l=>l.includes('每日回流积分上限'));
      return '开关='+(a?'有':'无')+' 每日上限='+(b?'有':'无');
    })()` },
  { url: '/#/config', token: true, name: '回流默认关闭（危险动作须显式开启）',
    eval: `(()=>{
      // ★ 读 .el-switch 的 is-checked class，不要读 aria-checked：
      //   element-plus 的 el-switch 不保证输出 aria-checked（实测为 null），
      //   读不到会误报成「已开启」，比没有断言更糟。
      const items=[...document.querySelectorAll('.el-form-item')];
      const row=items.find(i=>(i.querySelector('.el-form-item__label')?.textContent||'').includes('金币自动回流开关'));
      if(!row) return '找不到该行';
      const sw=row.querySelector('.el-switch');
      if(!sw) return '不是 switch 控件';
      const on=sw.classList.contains('is-checked');
      return on ? '已开启 ← 不该如此（DEFAULTS 里是 0）' : '已关闭（正确）';
    })()` },
  { url: '/#/config', token: true, name: '回流换算预览说明零头',
    eval: `(()=>{
      const vals=[...document.querySelectorAll('.pv-val')].map(e=>e.textContent.trim());
      return vals.join('  ||  ');
    })()` },
  { url: '/#/config', token: true, name: '回流运行状态区',
    eval: `(()=>{
      const d=[...document.querySelectorAll('.el-descriptions')];
      const reflow=d.find(x=>x.textContent.includes('消费循环'));
      if(!reflow) return '未渲染（可能 /reflow/status 拉取失败）';
      const rows=[...reflow.querySelectorAll('.el-descriptions__cell')]
        .map(e=>e.textContent.trim()).filter(Boolean);
      return rows.slice(0,4).join(' | ');
    })()` },
  { url: '/#/assets', token: true, name: '资产页玩家名校验',
    // 输入非法玩家名后应出现红色提示，且「下发指令」保持禁用
    eval: `(()=>{
      const inp=document.querySelector('input[placeholder="游戏内 ID"]');
      if(!inp) return '找不到输入框';
      const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      set.call(inp,'bad;name'); inp.dispatchEvent(new Event('input',{bubbles:true}));
      return new Promise(r=>setTimeout(()=>r(
        (document.querySelector('.hint.err')?'已提示':'未提示')+' / '+
        (document.querySelector('.el-button--primary')?.disabled?'按钮禁用':'按钮可点')
      ),400));
    })()` },
  { url: '/#/assets', token: true, name: '资产按钮默认值', shot: '6-assets.png',
    eval: "document.querySelectorAll('.el-radio-button').length + ' 种资产'" },
  { url: '/', token: true, name: '顶栏后端标识',
    eval: "document.querySelector('.mode')?.textContent?.trim() || '(无标识)'" },

  // ── 全站流水：时间范围 + 玩家名前缀候选 ─────────────────────
  { url: '/#/ledger', token: true, name: '流水筛选控件', shot: '7-ledger-filters.png',
    eval: `(()=>{
      const picker=document.querySelector('.el-date-editor');
      const combo=document.querySelector('.el-select__wrapper');
      return '时间选择器='+(picker?'有':'无')+' / 玩家下拉='+(combo?'有':'无');
    })()` },
  { url: '/#/ledger', token: true, name: '玩家前缀候选下拉',
    // 在玩家下拉里输入已存在的某个昵称的前缀，应出现候选项。
    // ★ 前缀不能写死（原来写死 'Ko'）：换后端/换测试数据后没有匹配的玩家，
    //   断言就会恒定失败 —— 一个永远红的断言等于没有断言。
    //   所以先从表格里读一个真实昵称，取其前 2 字符当搜索词。
    // ★ 要轮询：组件有 250ms 防抖 + 一次真实 HTTP 请求，
    //   固定 setTimeout 等待会卡在边界上时好时坏 —— 那种 flaky 断言
    //   比没有断言更糟，人会开始不信测试。
    eval: `(()=>{
      const combo=document.querySelector('.el-select__wrapper');
      if(!combo) return '找不到下拉';
      // ★ 取**第二格**（用户列）的第一个 span，那才是昵称。
      //   第一格是时间（含空格），直接取整行文本必然过不了昵称判定 ——
      //   上一版就是因此恒定失败，看起来像「候选功能坏了」。
      const rows=[...document.querySelectorAll('.el-table__body tbody tr')];
      let nick='';
      for(const tr of rows){
        const tds=tr.querySelectorAll('td');
        const t=tds[1]?.querySelector('span')?.textContent?.trim();
        if(t && t.length>=2 && !/^#/.test(t)){ nick=t; break; }
      }
      if(!nick) return '表里读不到可用昵称（流水为空？）';
      const kw=nick.slice(0,2);
      const inp=combo.querySelector('input');
      const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      combo.click();
      set.call(inp,kw); inp.dispatchEvent(new Event('input',{bubbles:true}));
      const t0=Date.now();
      return new Promise(res=>{
        const tick=()=>{
          const items=[...document.querySelectorAll('.el-select-dropdown__item')]
            .map(e=>e.textContent.trim()).filter(t=>t&&t!==kw);
          if(items.length) return res('搜索'+kw+' → '+items.slice(0,3).join(' / '));
          if(Date.now()-t0>5000) return res('无候选（搜索'+kw+'，等待 5s）');
          setTimeout(tick,300);
        };
        tick();
      });
    })()` },
  { url: '/#/ledger', token: true, name: 'UUID 短显现在流水里', shot: '8-ledger-uuid.png',
    eval: `(()=>{
      const t=document.querySelectorAll('.el-table__body tbody tr');
      if(!t.length) return '流水为空';
      return t[0].querySelector('.uid')?.textContent?.trim().replace(/\\s+/g,' ') || '(无 uid 单元格)';
    })()` },
  { url: '/#/ledger', token: true, name: '重置按钮存在',
    eval: "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('重置'))?'有':'无'" },

  // ── 账户页：UUID 列 ───────────────────────────────────────
  { url: '/#/users', token: true, name: '账户页 UUID 列', shot: '9-users-uuid.png',
    eval: `(()=>{
      const heads=[...document.querySelectorAll('.el-table__header th')].map(e=>e.textContent.trim());
      return heads.includes('UUID') ? 'UUID 列存在（'+heads.length+' 列）' : '缺 UUID 列：'+heads.join('/');
    })()` },
]);

console.log('--- 页面断言 ---');
results.forEach((r) => console.log(' ', r.step, '=>', r.value));
console.log('--- 控制台错误 ---');
console.log(logs.length ? logs.join('\n') : '（无）');
console.log('--- 截图 ---');
fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).forEach((f) => console.log(' ', path.join(OUT, f)));
