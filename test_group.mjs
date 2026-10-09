// WS_URL / BASE can be overridden with env vars, e.g.
//   WS_URL=wss://your-worker.example.com/ws BASE=https://your-worker.example.com node test_group.mjs
const WS_URL = process.env.WS_URL || 'wss://anon-chat.example.workers.dev/ws';
const BASE = process.env.BASE || 'https://anon-chat.example.workers.dev';

// 群聊专项自测：开房 → 广播 → 历史记录（后进来的人能看到之前的聊天）
const URL = WS_URL;
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
const t0 = Date.now();
const log = (...a) => console.log(`[${String(Date.now() - t0).padStart(5)}ms]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client(name, mode) {
  const ws = new WebSocket(URL);
  let ready = false; const queue = [];
  const c = { name, ws, got: [], history: null, tag: 0, n: 0, get open(){ return ready; } };
  c.send = o => { if (ready) { try { ws.send(JSON.stringify(o)); } catch {} } else queue.push(o); };
  ws.addEventListener('open', () => {
    ready = true; log(`[${name}] 连上 → join(${mode})`);
    ws.send(JSON.stringify({ t: 'join', mode }));
    queue.splice(0).forEach(o => { try { ws.send(JSON.stringify(o)); } catch {} });
  });
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'history') { c.history = m.items || []; }
    if (m.t === 'room') { c.tag = m.tag; c.n = m.n; }
    c.got.push(m.t);
    const extra = (m.from ? ` from=${m.from}` : '') + (m.tag ? ` tag=${m.tag}` : '')
                + (m.n ? ` n=${m.n}` : '') + (m.v && m.t !== 'img' ? ` "${String(m.v).slice(0,40)}"` : '')
                + (m.t === 'history' ? ` 共${(m.items||[]).length}条` : '');
    log(`[${name}] ← ${m.t}${extra}`);
  });
  ws.addEventListener('error', (e) => log(`[${name}] error ${e && e.message ? e.message : ''}`));
  ws.addEventListener('close', (e) => log(`[${name}] close code=${e.code}`));
  return c;
}
const waitOpen = async cs => { for (let i = 0; i < 80 && !cs.every(c => c.open); i++) await sleep(100); };

const g1 = client('G1', 'group');
await sleep(400);
const g2 = client('G2', 'group');
await sleep(400);
const g3 = client('G3', 'group');
await waitOpen([g1, g2, g3]);
await sleep(2500);                       // 等开房
g1.send({ t: 'msg', v: '大家好，我是G1（这条应该被历史记住）' });
await sleep(700);
g2.send({ t: 'img', v: IMG });
await sleep(1200);

log('--- 现在让 G4 后进来，看能不能看到历史 ---');
const g4 = client('G4', 'group');
await waitOpen([g4]);
await sleep(2500);

const histItems = g4.history || [];
const histText = histItems.filter(x => x.k === 'text').map(x => x.v);
const histHasImg = histItems.some(x => x.k === 'img' || x.k === 'imgph');
log('G4 收到的历史:', JSON.stringify(histItems.map(x => ({ k: x.k, from: x.from, v: (x.v || '').slice(0, 30) }))));

const t1 = [g1, g2, g3].every(c => c.got.includes('room'));
const t2 = g2.got.includes('msg') && g3.got.includes('msg') && g1.got.includes('img');
const t3 = g4.got.includes('room') && g4.got.includes('history') && histText.some(v => v.includes('我是G1'));
const t4 = histHasImg;   // 历史里图片留了一张（更早的降级成 imgph）
log('开房:', t1 ? '✅' : '❌', '广播:', t2 ? '✅' : '❌', '历史文字:', t3 ? '✅' : '❌', '历史图片:', t4 ? '✅' : '❌');
log('===== 判定 =====', (t1 && t2 && t3) ? 'PASS：群聊 + 广播 + 历史记录 全通' : 'FAIL，对照上面日志');
[g1, g2, g3, g4].forEach(c => c.ws.close());
process.exit(0);
