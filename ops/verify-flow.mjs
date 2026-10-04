/**
 * 交互验收：真的点开「调整」弹窗，填数，提交，再回滚测试数据。
 * 目的不是看界面好看，是确认从点击到数据库写入这条链路端到端通。
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
const get = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d));
  }).on('error', rej);
});

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

const proc = spawn(EDGE, [
  '--headless=new', '--remote-debugging-port=9334', '--disable-gpu',
  '--hide-scrollbars', '--window-size=1440,900',
  '--user-data-dir=' + path.join(OUT, 'profile9334'), 'about:blank',
], { stdio: 'ignore' });

let id = 0; const pending = new Map(); const logs = []; let ws;
const send = (method, params = {}) => new Promise((res, rej) => {
  const msg = { id: ++id, method, params };
  pending.set(msg.id, { res, rej }); ws.send(JSON.stringify(msg));
});

try {
  await waitPort(9334);
  const list = JSON.parse(await get(9334, '/json/list'));
  ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description || '').slice(0, 200));
    }
  };
  await send('Page.enable'); await send('Runtime.enable');

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 失败');
    return r.result.value;
  };

  // 登录
  await send('Page.navigate', { url: BASE + '/' });
  await wait(2000);
  await evalJs(`localStorage.setItem('kk_admin_token', ${JSON.stringify(TOKEN)})`);

  // 进用户页
  await send('Page.navigate', { url: BASE + '/#/users' });
  await wait(2200);

  const before = await evalJs(`document.querySelectorAll('.el-table__body tbody tr')[0].querySelectorAll('td')[4].innerText.trim()`);
  console.log('弹窗前 uid1 积分(表格):', before);

  // 点「调整」
  const opened = await evalJs(`(()=>{
    const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='调整');
    if(!btn) return false; btn.click(); return true;
  })()`);
  await wait(1500);
  console.log('点开调整弹窗:', opened);

  const dlgVisible = await evalJs(`!!document.querySelector('.el-dialog') && getComputedStyle(document.querySelector('.el-dialog')).display !== 'none'`);
  console.log('弹窗可见:', dlgVisible);

  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '5-dialog.png'), Buffer.from(shot1.data, 'base64'));

  // 把变动值改成 3
  await evalJs(`(()=>{
    const inp=document.querySelector('.el-dialog .el-input-number input');
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(inp,'3');
    inp.dispatchEvent(new Event('input',{bubbles:true}));
    inp.dispatchEvent(new Event('change',{bubbles:true}));
    return inp.value;
  })()`);
  await wait(900);

  const preview = await evalJs(`document.querySelector('.preview b')?.innerText.trim()`);
  console.log('弹窗预览调整后余额:', preview, '(应为 22+3=25)');

  // 提交：Element Plus 的 dialog body 挂在 body 末尾（带 teleport），
  // 所以要在整个 document 里找按钮，且不能只认 .el-footer。
  await evalJs(`(()=>{
    const btn=[...document.querySelectorAll('button')]
      .filter(b=>b.offsetParent!==null)
      .find(b=>b.textContent.includes('确认入账'));
    if(!btn) return 'BUTTON_NOT_FOUND';
    btn.click(); return 'CLICKED';
  })()`);
  await wait(2400);

  const after = await evalJs(`document.querySelectorAll('.el-table__body tbody tr')[0].querySelectorAll('td')[4].innerText.trim()`);
  console.log('提交后 uid1 积分(表格):', after, '(应为 25)');

  const msg = await evalJs(`document.querySelector('.el-message')?.innerText.trim() || '(无提示)'`);
  console.log('提示信息:', msg);

  // 打开明细抽屉看新流水
  await evalJs(`(()=>{
    const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='明细');
    btn.click(); return true;
  })()`);
  await wait(2000);
  const topLog = await evalJs(`(()=>{
    const r=document.querySelectorAll('.el-drawer .el-table__body tbody tr')[0];
    if(!r) return '(空)';
    return [...r.querySelectorAll('td')].map(t=>t.innerText.trim()).join(' | ');
  })()`);
  console.log('明细首行流水:', topLog);

  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '6-detail.png'), Buffer.from(shot2.data, 'base64'));

  console.log('JS 异常:', logs.length ? logs.join('; ') : '（无）');
} catch (e) {
  console.error('验收失败:', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  proc.kill();
}
