// ADMIN_KEY / BASE can be set via env vars

// 验证：举报一条图片消息后，管理端能拿到完整图片（不是截断的 base64）
const KEY = process.env.ADMIN_KEY || 'CHANGE_ME_random_admin_key';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE = process.env.BASE || 'https://anon-chat.example.workers.dev';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 造一张稍大的图（约 40KB base64），保证"截断版"和"完整版"能区分开
const IMG = 'data:image/jpeg;base64,' + 'A'.repeat(40000);

const a = new WebSocket('wss://anon-chat.example.workers.dev/ws');
a.addEventListener('open', () => a.send(JSON.stringify({ t: 'join', mode: 'one' })));
let matched = false;
a.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.t === 'matched' && !matched) {
    matched = true;
    setTimeout(() => a.send(JSON.stringify({ t: 'img', v: IMG, id: 'img-test-1' })), 400);
  }
});
await sleep(900);
const b = new WebSocket('wss://anon-chat.example.workers.dev/ws');
await new Promise(r => b.addEventListener('open', r));
b.send(JSON.stringify({ t: 'join', mode: 'one' }));
b.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.t === 'img' && m.id === 'img-test-1') setTimeout(() => b.send(JSON.stringify({ t: 'report', id: m.id })), 500);
});
await sleep(4000);
const d = await (await fetch(BASE + '/admin/data?key=' + KEY, { headers: { 'User-Agent': UA } })).json();
const rec = d.reports[0];
const v = (rec.reported_msg || {}).v || '';
console.log('举报记录 mode =', rec.mode, '| 被举报消息 k =', (rec.reported_msg || {}).k);
console.log('被举报图片长度 =', v.length, '| 是否完整 data URL =', /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v));
console.log('前 40 字符:', v.slice(0, 40));
console.log((v.length > 39000) ? '✅ PASS：审核端拿到的是完整图片' : '❌ FAIL：仍是截断版');
try { a.close(); b.close(); } catch {}
process.exit(0);
