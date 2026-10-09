// WS_URL / BASE / ADMIN_KEY can be set via env vars
const WS_URL = process.env.WS_URL || 'wss://anon-chat.example.workers.dev/ws';
const BASE = process.env.BASE || 'https://anon-chat.example.workers.dev';

// 验证「长按某条消息举报那一条」：B 只举报 A 的第二条消息，管理页应记录该条内容
const KEY = process.env.ADMIN_KEY || 'CHANGE_ME_random_admin_key';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE = BASE;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let bWs = null, got = [];
const a = new WebSocket(WS_URL);
a.addEventListener('open', () => a.send(JSON.stringify({ t: 'join', mode: 'one' })));
a.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.t === 'matched') {
    setTimeout(() => a.send(JSON.stringify({ t: 'msg', v: '第一条：正常聊天', id: 'test-msg-1' })), 300);
    setTimeout(() => a.send(JSON.stringify({ t: 'msg', v: '第二条：这条要被举报', id: 'test-msg-2' })), 900);
  }
});
await sleep(800);
const b = new WebSocket(WS_URL);
await new Promise(r => b.addEventListener('open', r));
b.send(JSON.stringify({ t: 'join', mode: 'one' }));
b.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  got.push(m.t + (m.id ? ':' + m.id : ''));
  if (m.t === 'msg' && m.id === 'test-msg-2') setTimeout(() => b.send(JSON.stringify({ t: 'report', id: m.id })), 400);
});

await sleep(3500);
console.log('B 收到:', JSON.stringify(got));
await sleep(1500);
const r = await fetch(BASE + '/admin/data?key=' + KEY, { headers: { 'User-Agent': UA } });
const d = await r.json();
const rec = d.reports[0];
console.log('最新举报记录：');
console.log('   被举报的消息 =', JSON.stringify(rec.reported_msg));
console.log('   上下文条数   =', (rec.msgs || []).length);
const ok = rec.reported_msg && String(rec.reported_msg.v).includes('第二条');
console.log(ok ? '✅ PASS：举报精确到了那一条消息' : '❌ FAIL');
try { a.close(); b.close(); } catch {}
process.exit(0);
