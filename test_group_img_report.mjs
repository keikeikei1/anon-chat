
const KEY = process.env.ADMIN_KEY || 'CHANGE_ME';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const IMG = 'data:image/jpeg;base64,' + 'B'.repeat(40000);
const MID = 'gimg-' + Date.now().toString(36);

const a = new WebSocket((process.env.BASE || 'https://anon-chat.example.workers.dev').replace(/^http/, 'ws') + '/ws');
await new Promise(r => a.addEventListener('open', r));
a.send(JSON.stringify({ t: 'join', mode: 'group' }));
await sleep(1500);
a.send(JSON.stringify({ t: 'img', v: IMG, id: MID }));
await sleep(1500);

const b = new WebSocket((process.env.BASE || 'https://anon-chat.example.workers.dev').replace(/^http/, 'ws') + '/ws');
await new Promise(r => b.addEventListener('open', r));
b.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.t === 'history' && m.items) {
    const hit = m.items.find(x => x.id === MID);
    console.log('B 收到历史条数:', m.items.length, '| 含目标图:', !!hit);
    if (hit) setTimeout(() => b.send(JSON.stringify({ t: 'report', id: MID })), 800);
  }
});
b.send(JSON.stringify({ t: 'join', mode: 'group' }));
await sleep(6000);

const d = await (await fetch((process.env.BASE || 'https://anon-chat.example.workers.dev') + '/admin/data?key=' + KEY, { headers: { 'User-Agent': UA } })).json();
const rec = (d.reports || []).find(r => (r.reported_msg_id === MID) || JSON.stringify(r).includes(MID));
const rm = (rec && rec.reported_msg) || {};
console.log('找到举报记录:', !!rec, '| k =', rm.k, '| has_img =', rm.has_img, '| v 长度 =', String(rm.v || '').length);
const ctxImg = ((rec || {}).msgs || []).filter(x => x.k === 'img');
console.log('上下文里图片条目长度:', ctxImg.map(x => String(x.v || '').length).join(',') || '(无)');
console.log((rec && rm.k === 'img' && (rm.has_img || String(rm.v || '').length > 30000)) ? '✅ PASS：群聊举报图片能取到原图' : '❌ FAIL');
try { a.close(); b.close(); } catch {}
process.exit(0);
