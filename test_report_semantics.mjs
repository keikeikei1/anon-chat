// WS_URL / BASE can be overridden with env vars, e.g.
//   WS_URL=wss://your-worker.example.com/ws BASE=https://your-worker.example.com node test_report_semantics.mjs
const WS_URL = process.env.WS_URL || 'wss://anon-chat.example.workers.dev/ws';
const BASE = process.env.BASE || 'https://anon-chat.example.workers.dev';

// 验证「举报不再自动处置」：A、B 配对 → B 举报 → A 应当**继续留在会话里**（不再收到 left/被断开）
const sleep = ms => new Promise(r => setTimeout(r, ms));
const evA = [], evB = [];
function mk(name, arr, onMsg) {
  const ws = new WebSocket(WS_URL);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'join', mode: 'one' })));
  ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch { return; } arr.push(m.t); if (onMsg) onMsg(ws, m); });
  ws.addEventListener('error', () => arr.push('error'));
  ws.addEventListener('close', e => arr.push('close:' + e.code));
  return ws;
}
const A = mk('A', evA);
await sleep(900);
const B = mk('B', evB, (ws, m) => { if (m.t === 'matched') setTimeout(() => ws.send(JSON.stringify({ t: 'report' })), 600); });
await sleep(3000);
console.log('B 举报后 —— A 收到的事件:', JSON.stringify(evA));
console.log('              B 收到的事件:', JSON.stringify(evB));
const aStillIn = !evA.includes('left') && !evA.some(x => String(x).startsWith('close'));
console.log(aStillIn ? '✅ PASS：A 没有被断开（举报只上报，等人工审核）' : '❌ FAIL：A 仍被自动断开');
A.close(); B.close();
process.exit(0);
