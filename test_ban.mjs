// WS_URL / BASE can be overridden with env vars, e.g.
//   WS_URL=wss://your-worker.example.com/ws BASE=https://your-worker.example.com node test_ban.mjs
const WS_URL = process.env.WS_URL || 'wss://anon-chat.example.workers.dev/ws';
const BASE = process.env.BASE || 'https://anon-chat.example.workers.dev';

// 封禁闭环实测：先在脚本里造一条新举报（拿当前出口的真实 IP 哈希）→ 封 → 试连应被拒 → 解封 → 试连恢复
const KEY = process.env.ADMIN_KEY || 'CHANGE_ME_random_admin_key';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jget = async p => { const r = await fetch(BASE + p, { headers: { 'User-Agent': UA } }); return { status: r.status, body: await r.text() }; };

function conn(mode) {
  return new Promise(res => {
    let done = false;
    const fin = v => { if (!done) { done = true; try { ws.close(); } catch {} res(v); } };
    const ws = new WebSocket(WS_URL);
    const t = setTimeout(() => fin('超时'), 15000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ t: 'join', mode: mode || 'one' })));
    ws.addEventListener('message', e => { clearTimeout(t); fin('连上了 → ' + String(e.data).slice(0, 30)); });
    ws.addEventListener('error', () => { clearTimeout(t); fin('❌ 连接被拒'); });
    ws.addEventListener('close', e => { clearTimeout(t); fin('被关闭 code=' + e.code); });
  });
}

// 1) 造一条新举报（用当前出口 IP）
console.log('① 造一条举报记录（拿当前出口的哈希）…');
const a = new WebSocket(WS_URL);
await new Promise(r => a.addEventListener('open', r));
a.send(JSON.stringify({ t: 'join', mode: 'one' }));
await sleep(600);
const b = new WebSocket(WS_URL);
await new Promise(r => b.addEventListener('open', r));
b.send(JSON.stringify({ t: 'join', mode: 'one' }));
let matched = false;
b.addEventListener('message', e => { if (String(e.data).includes('matched') && !matched) { matched = true; setTimeout(() => b.send(JSON.stringify({ t: 'report' })), 400); } });
await sleep(2500);
try { a.close(); b.close(); } catch {}
await sleep(1500);

const d = JSON.parse((await jget('/admin/data?key=' + KEY)).body);
const iph = d.reports[0].reporter_ip_hash;
console.log('   最新举报的 IP 哈希:', iph.slice(0, 20) + '…  (共 ' + d.reports.length + ' 条记录)');

console.log('② 封禁前试连 →', await conn('one'));
const banRes = await jget('/admin/ban?key=' + KEY + '&iph=' + iph + '&days=7');
console.log('③ 封禁接口 →', banRes.status, banRes.body.slice(0, 100));
await sleep(3000);
console.log('④ 封禁后试连 →', await conn('one'), '（期望：被拒）');
console.log('   群聊也试一下 →', await conn('group'));

const u = await jget('/admin/unban?key=' + KEY + '&iph=' + iph);
console.log('⑤ 解封接口 →', u.status, u.body.slice(0, 80));
await sleep(3000);
console.log('⑥ 解封后试连 →', await conn('one'), '（期望：恢复）');
const d3 = JSON.parse((await jget('/admin/data?key=' + KEY)).body);
console.log('   剩余封禁数:', (d3.bans || []).length);
process.exit(0);
