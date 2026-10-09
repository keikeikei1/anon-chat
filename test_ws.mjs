// WS_URL / BASE can be overridden with env vars, e.g.
//   WS_URL=wss://your-worker.example.com/ws BASE=https://your-worker.example.com node test_ws.mjs
const WS_URL = process.env.WS_URL || 'wss://anon-chat.example.workers.dev/ws';
const BASE = process.env.BASE || 'https://anon-chat.example.workers.dev';

// 端到端自测：一对一（配对/文字/图片/外链/举报）+ 群聊（开房/广播/带发言人/退出）
const URL = WS_URL;
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(5)}ms]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(name, mode, onMsg) {
  const ws = new WebSocket(URL);
  let ready = false;
  const queue = [];
  const c = { name, ws, mode, got: [], get open(){ return ready; } };
  c.send = o => { if (ready) { try { ws.send(JSON.stringify(o)); } catch {} } else queue.push(o); };
  ws.addEventListener('open', () => {
    ready = true; log(`[${name}] 连上 → join(${mode})`);
    ws.send(JSON.stringify({ t: 'join', mode }));
    queue.splice(0).forEach(o => { try { ws.send(JSON.stringify(o)); } catch {} });
  });
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    c.got.push(m.t + (m.from ? ':from' + m.from : ''));
    const extra = (m.from ? ` from=${m.from}` : '') + (m.tag ? ` tag=${m.tag}` : '')
                + (m.n ? ` n=${m.n}` : '') + (m.v && m.t === 'msg' ? ` "${m.v}"` : '')
                + (m.v && m.t === 'err' ? ` "${m.v}"` : '') + (m.v && m.t === 'sys' ? ` "${m.v}"` : '')
                + (m.t === 'img' ? ` ${ev.data.length}B` : '');
    log(`[${name}] ← ${m.t}${extra}`);
    if (onMsg) onMsg(c, m);
  });
  ws.addEventListener('error', () => log(`[${name}] error`));
  return c;
}
const waitOpen = async (cs) => { for (let i = 0; i < 60 && !cs.every(c => c.open); i++) await sleep(100); };

// ---------- 第一轮：一对一 ----------
log('===== 1v1 测试 =====');
let sent = false;
const A = client('A1', 'one', (c, m) => {
  if (m.t === 'matched' && !sent) {
    sent = true;
    setTimeout(() => c.send({ t: 'msg', v: '你好 from A' }), 250);
    setTimeout(() => c.send({ t: 'img', v: IMG }), 700);
    setTimeout(() => c.send({ t: 'msg', v: 'https://evil.example' }), 1200);
  }
});
await sleep(800);
const B = client('B1', 'one', (c, m) => { if (m.t === 'img') setTimeout(() => c.send({ t: 'report' }), 500); });
await waitOpen([A, B]);
await sleep(6000);

const t1ok = A.got.includes('matched') && B.got.includes('msg') && B.got.includes('img')
          && A.got.includes('err') && B.got.includes('reported');
log('1v1 结果 →', JSON.stringify({ A1: A.got, B1: B.got }), t1ok ? '✅ PASS' : '❌ FAIL');
A.ws.close(); B.ws.close();
await sleep(1500);

// ---------- 第二轮：群聊 ----------
log('===== 群聊测试 =====');
const g1 = client('G1', 'group');
await sleep(500);
const g2 = client('G2', 'group');
await sleep(500);
const g3 = client('G3', 'group');
await waitOpen([g1, g2, g3]);
await sleep(3000);
g1.send({ t: 'msg', v: '大家好，我是G1' });
await sleep(1000);
g2.send({ t: 'img', v: IMG });
await sleep(1200);
const before = [g1.got.length, g2.got.length, g3.got.length];
g3.send({ t: 'skip' });          // 退出房间并重新排队
await sleep(2500);

const all = [g1, g2, g3];
const opened = all.every(c => c.got.includes('room'));
const sawOthers = g2.got.some(x => x.startsWith('msg:from')) && g3.got.some(x => x.startsWith('msg:from'));
const imgBroadcast = g1.got.includes('img:from') && g3.got.includes('img:from');
log('群聊结果 →', JSON.stringify({ G1: g1.got, G2: g2.got, G3: g3.got }));
const t2ok = opened && sawOthers && imgBroadcast;
log('群聊判定 →', t2ok ? '✅ PASS（开房 + 广播 + 带发言人 + 图片）' : '❌ FAIL');
log('===== 总判定 =====', (t1ok && t2ok) ? 'ALL PASS' : '有 FAIL，逐项对照上面日志');
all.forEach(c => c.ws.close());
process.exit(0);
