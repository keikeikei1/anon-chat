// anon-chat —— 匿名随机聊天（Cloudflare Workers + Durable Objects）
//
// 模式：
//   * one   —— 一对一随机配对（文字 + 图片）
//   * group —— 单一大厅（所有人一个群，软上限 HALL_MAX）
//
// 设计要点：
//   * 单个全局 Lobby DO 管队列、配对、大厅广播；无外部数据库
//   * 图片走 WebSocket 直传（前端压到 ≤1280px / JPEG），服务器不存文件
//   * 落盘只有三样：举报快照（仅有人举报时）、封禁名单、聊天历史窗口（默认 3 天）
//     后两者的过期清理靠 DO alarm；原始 IP 永不落库，只存加盐哈希
//   * 举报 = 只上报，处置（踢出/封禁/清除内容/忽略）全由管理员在面板里点
//   * 界面中文、手机优先（16px 输入防 iOS 缩放、safe-area、44px 触摸区）
//   * 心跳 60 秒 + 4 分钟无动静判僵尸 + 客户端断线自动重连（不丢正在聊的会话）

const MAX_TEXT = 500;
const MAX_IMG_CHARS = 320000;      // data URL 上限（约 240 KB 图）
const RATE_MSG = 12, RATE_IMG = 6; // 每 10 秒
const RATE_WINDOW_MS = 10000;
const KEEP_MSGS = 20;
const HALL_MAX = 500;              // 大厅软上限（防单实例被压垮）
const HISTORY_TTL_MS = 3 * 24 * 3600 * 1000;  // 聊天记录保留 3 天
const HISTORY_LIMIT = 100;         // 新人进群一次最多补 100 条
const HISTORY_IMG_MAX = 2;         // 历史里最多重发 2 张图，更早的显示 [图片]
const STALE_MS = 240000;           // 超过这么久没动静视为僵尸（须 > 心跳间隔）
const BLOCK_WORDS = ['http://', 'https://', 'www.'];  // 挡外链，防广告/钓鱼

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const ADMIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>管理 · 匿名聊天</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0b0d12;color:#e8eaed;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding:16px;max-width:900px}
  h1{font-size:18px;margin:0 0 14px;display:flex;align-items:center;gap:10px}
  h2{font-size:14px;margin:22px 0 10px;color:#8b93a5;font-weight:600}
  .card{background:#0f1219;border:1px solid #1d2230;border-radius:14px;padding:14px;margin-bottom:12px}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .kv{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:14px}
  .kv b{display:block;font-size:22px;color:#fff;line-height:1.2}
  .kv span{font-size:12px;color:#6b7385}
  button{font:inherit;background:#1b2030;border:1px solid #232a3a;color:#e8eaed;border-radius:10px;padding:9px 14px;min-height:42px;cursor:pointer}
  button.d{background:#3a1520;border-color:#5c2030;color:#ffb4c0}
  .rep{border-left:3px solid #2b5cff}
  .rep.new{border-left-color:#ff6b6b}
  .rep.done{opacity:.55}
  .tag{display:inline-block;font-size:11px;padding:2px 7px;border-radius:6px;background:#1b2030;color:#9aa4b8;margin-left:6px}
  pre{white-space:pre-wrap;word-break:break-word;font:13px/1.5 ui-monospace,Menlo,monospace;color:#c3c9d6;margin:9px 0 0;max-height:280px;overflow:auto;background:#0b0f16;border-radius:8px;padding:10px}
  .empty{color:#5d6577;font-size:13px;padding:14px 0}
  .ok{color:#7ee787;font-size:13px;margin-left:4px}
  .meta{font-size:12px;color:#8b93a5;margin-top:6px;word-break:break-all}
</style></head>
<body>
<h1>匿名聊天 · 管理 <button id="rf" style="margin-left:auto">刷新</button></h1>
<div class="card"><div class="kv" id="kv"></div>
  <div class="row">
    <button id="reset" class="d">清场（踢掉所有连接）</button>
    <button id="clr" class="d">清空举报记录</button>
    <span id="msg" class="ok"></span>
  </div></div>
<h2 id="rh">举报记录</h2>
<div class="row" style="margin:-4px 0 10px">
  <label style="margin:0;font-size:13px;display:flex;gap:8px;align-items:center">
    <input type="checkbox" id="onlynew" style="width:18px;height:18px;accent-color:#2b5cff"> 只看未处理
  </label>
  <span class="meta" id="cnt2" style="margin:0"></span>
</div>
<div id="list"></div>
<h2 id="bh">封禁列表</h2>
<div id="bans"></div>
<script>
var K = new URLSearchParams(location.search).get('key') || '';
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
function say(t){ document.getElementById('msg').textContent = t; setTimeout(function(){ document.getElementById('msg').textContent = ''; }, 4000); }
async function api(p){ var r = await fetch('/admin/' + p + (p.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(K)); if (!r.ok) throw new Error(r.status); return r.json(); }
async function load(){
  var d;
  try { d = await api('data'); }
  catch (e) { document.body.innerHTML = '<p style="padding:20px;color:#ffb4c0">密钥不对或已失效（HTTP ' + esc(e.message) + '）</p>'; return; }
  document.getElementById('kv').innerHTML =
      '<div><b>' + d.hall + '</b><span>大厅在线</span></div>'
    + '<div><b>' + d.queue + '</b><span>1v1 排队</span></div>'
    + '<div><b>' + d.conns + '</b><span>总连接</span></div>'
    + '<div><b>' + d.reports.length + '</b><span>举报记录</span></div>'
    + '<div><b>' + d.retention_days + '</b><span>记录保留（天）</span></div>'
    + '<div><b>' + ((d.bans || []).length) + '</b><span>封禁中</span></div>';
  var onlyNew = document.getElementById('onlynew').checked;
  var shown = onlyNew ? d.reports.filter(function(x){ return !x.handled; }) : d.reports;
  document.getElementById('rh').textContent = '举报记录（' + d.reports.length + '）';
  document.getElementById('cnt2').textContent = onlyNew ? ('只看未处理：' + shown.length + ' 条') : '';
  var h = '';
  if (!shown.length) h = '<div class="empty">' + (onlyNew ? '没有未处理的举报了 🎉' : '暂无举报记录（平时不落盘，只有举报时才存）') + '</div>';
  for (var i = 0; i < shown.length; i++) {
    var r = shown[i], lines = '';
    (r.msgs || []).forEach(function(m){ lines += (m.tag ? '陌生人' + m.tag : (m.me ? '我' : '对方')) + '：' + esc(String(m.v || '').slice(0, 400)) + String.fromCharCode(10); });
    h += '<div class="card rep ' + (r.handled ? 'done' : 'new') + '"><div class="row"><b>' + esc(r.at || '') + '</b>'
      +  '<span class="tag">' + esc(r.mode === 'group' ? '群聊' : '一对一') + '</span>'
      +  (r.mode === 'group' ? '<span class="tag">举报者 #' + esc(r.reporter_tag || '-') + '</span>' : '') + '</div>'
      +  '<div class="meta">举报者 IP 哈希 ' + esc(String(r.reporter_ip_hash || '').slice(0, 20)) + '…'
      +  ' · 被举报 IP 哈希 ' + esc(String(r.reported_ip_hash || '').slice(0, 20)) + '…</div>'
      +  (r.reviewed_by ? '<div class="meta">处理人：' + esc(r.reviewed_by) + '（' + esc(r.reviewed_action || '') + ' · ' + esc(r.reviewed_at || '') + '）</div>' : '')
      +  (r.content_cleared ? '<div class="meta">（聊天内容已清除）</div>' : '')
      +  (r.reported_msg ? '<div class="meta" style="color:#ffb4c0">被举报的消息：' + (r.reported_msg.tag ? ('陌生人 ' + esc(r.reported_msg.tag)) : '对方') + '：' + esc(String(r.reported_msg.v || '').slice(0, 300)) + '</div>' : '')
      +  (r.room_staff && r.room_staff.length ? '<div class="meta">当时在场：' + r.room_staff.map(function(s){ return '#' + s.tag; }).join(' ') + '</div>' : '')
      +  '<div class="meta" id="ai-' + esc(r.key).replace(/[^a-zA-Z0-9]/g, '') + '"></div>'
      +  (lines ? '<pre>' + lines + '</pre>' : '')
      +  '<div class="row" style="margin-top:10px">'
      +    (r.reported_ip_hash ? '<button data-kick="' + esc(r.reported_ip_hash) + '">踢出（在线）</button>' : '')
      +    (r.reported_ip_hash ? '<button class="d" data-banh="' + esc(r.reported_ip_hash) + '" data-h="8" data-who="被举报方">封禁 8 小时</button>' : '')
      +    (r.reported_ip_hash ? '<button class="d" data-banh="' + esc(r.reported_ip_hash) + '" data-h="168" data-who="被举报方">封禁 7 天</button>' : '')
      +    (r.content_cleared ? '<span class="tag">聊天内容已清除</span>' : '<button data-clear="' + esc(r.key) + '">清除聊天内容</button>')
      +    '<button data-ai="' + esc(r.key) + '">AI 审核</button>'
      +    (r.handled ? '<span class="tag">已忽略</span>' : '<button data-handled="' + esc(r.key) + '">忽略</button>')
      +  '</div>'
      +  '<div class="row" style="margin-top:8px">'
      +    '<button data-banh="' + esc(r.reporter_ip_hash) + '" data-h="168" data-who="举报方">封禁举报方 7 天</button>'
      +  '</div>'
      +  '</div>';
  }
  document.getElementById('list').innerHTML = h;

  document.getElementById('bh').textContent = '封禁列表（' + ((d.bans || []).length) + '）';
  var bh = '';
  if (!d.bans || !d.bans.length) bh = '<div class="empty">没有封禁记录</div>';
  for (var j = 0; j < (d.bans || []).length; j++) {
    var b = d.bans[j];
    bh += '<div class="card"><div class="row"><code style="font-size:12px">' + esc(String(b.iph).slice(0, 24)) + '…</code>'
       +  '<span class="tag">到期 ' + esc(new Date(b.until).toLocaleString('zh-CN')) + '</span>'
       +  '<button data-unban="' + esc(b.iph) + '">解封</button></div></div>';
  }
  document.getElementById('bans').innerHTML = bh;
}
async function doKick(iph){
  if (!confirm('踢掉这个 IP 哈希当前在线的连接？（不封禁，他可以再进来）')) return;
  var r = await api('kick?iph=' + encodeURIComponent(iph));
  say('已踢掉 ' + (r.kicked || 0) + ' 条在线连接'); load();
}
async function doBanH(iph, hours, who){
  var label = hours >= 24 ? (hours / 24) + ' 天' : hours + ' 小时';
  if (!confirm('确定封禁「' + who + '」' + label + '？同一 WiFi / 同一出口后面的人会一起被封。')) return;
  var r = await api('ban?iph=' + encodeURIComponent(iph) + '&h=' + encodeURIComponent(hours));
  say('已封禁「' + who + '」' + label + '，踢掉在线 ' + (r.kicked || 0) + ' 条连接'); load();
}
async function doClear(k){
  if (!confirm('清除这条举报里的聊天内容？（举报记录本身保留，只抹掉内容快照）')) return;
  await api('clearmessages?k=' + encodeURIComponent(k));
  say('聊天内容已清除'); load();
}
async function doAI(k){
  var box = document.getElementById('ai-' + k.replace(/[^a-zA-Z0-9]/g, ''));
  if (box) box.textContent = 'AI 审核中…（几秒）';
  try {
    var r = await api('ai?k=' + encodeURIComponent(k));
    if (!r.ok) { if (box) box.textContent = 'AI 审核失败：' + (r.error || '未知'); return; }
    var p = r.parsed || {};
    var line = 'AI：风险 ' + (p.risk || '?') + ' · ' + (p.category || '?') + ' · 建议 ' + (p.suggest || '?') + ' —— ' + (p.reason || r.verdict);
    if (box) { box.style.color = (p.risk === 'high') ? '#ffb4c0' : (p.risk === 'medium' ? '#ffd479' : '#7ee787'); box.textContent = line; }
  } catch (e) { if (box) box.textContent = 'AI 审核失败：' + e.message; }
}
async function doHandled(k){
  await api('handled?k=' + encodeURIComponent(k));
  say('已忽略这条举报'); load();
}
async function doUnban(iph){
  if (!confirm('解除这条封禁？')) return;
  await api('unban?iph=' + encodeURIComponent(iph));
  say('已解封'); load();
}
document.getElementById('list').addEventListener('click', function(ev){
  var k = ev.target.closest('button[data-kick]');
  if (k) { doKick(k.getAttribute('data-kick')); return; }
  var hd = ev.target.closest('button[data-handled]');
  if (hd) { doHandled(hd.getAttribute('data-handled')); return; }
  var bh = ev.target.closest('button[data-banh]');
  if (bh) { doBanH(bh.getAttribute('data-banh'), Number(bh.getAttribute('data-h')) || 168, bh.getAttribute('data-who')); return; }
  var cl = ev.target.closest('button[data-clear]');
  if (cl) { doClear(cl.getAttribute('data-clear')); return; }
  var ai = ev.target.closest('button[data-ai]');
  if (ai) { doAI(ai.getAttribute('data-ai')); return; }
});
document.getElementById('bans').addEventListener('click', function(ev){
  var b = ev.target.closest('button[data-unban]'); if (!b) return;
  doUnban(b.getAttribute('data-unban'));
});
document.getElementById('onlynew').addEventListener('change', load);
document.getElementById('rf').onclick = load;
document.getElementById('reset').onclick = async function(){ if (confirm('确定踢掉所有连接？')) { var r = await api('reset'); say('已清场，踢掉 ' + r.kicked + ' 人'); load(); } };
document.getElementById('clr').onclick = async function(){ if (confirm('确定清空所有举报记录？')) { var r = await api('clearreports'); say('已清空 ' + r.deleted + ' 条'); load(); } };
load();
</script>
</body></html>`;

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0d12">
<meta name="format-detection" content="telephone=no">
<title>匿名聊天</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  html,body{height:100%}
  body{margin:0;font:16px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
       background:#0b0d12;color:#e8eaed;display:flex;flex-direction:column;height:100dvh;overflow:hidden}
  header{padding:calc(8px + env(safe-area-inset-top)) 12px 8px;border-bottom:1px solid #1d2230;
         display:flex;align-items:center;gap:8px;font-size:13px;color:#8b93a5;flex:none;min-height:52px}
  header b{color:#e8eaed;font-weight:600;font-size:15px;white-space:nowrap}
  #stat{font-size:12px;color:#6b7385;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #next{margin-left:auto;padding:8px 12px;min-height:36px;font-size:13px;flex:none}
  #log{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px;display:flex;flex-direction:column;gap:8px}
  .m{max-width:80%;padding:9px 13px;border-radius:16px;white-space:pre-wrap;word-break:break-word;font-size:15px}
  .me{align-self:flex-end;background:#2b5cff;color:#fff;border-bottom-right-radius:5px}
  .you{align-self:flex-start;background:#1b2030;border-bottom-left-radius:5px}
  .who{display:block;font-size:11.5px;color:#7f8aa3;margin-bottom:2px}
  .sys{align-self:center;font-size:12.5px;color:#6b7385;background:none;text-align:center;max-width:92%}
  .m{position:relative}
  .m img{display:block;max-width:100%;border-radius:10px;cursor:zoom-in}
  .rbtn{position:absolute;top:-9px;right:-9px;display:none;width:26px;height:26px;min-height:26px;padding:0;
        border-radius:50%;border:1px solid #2b5cff;background:#2b5cff;color:#fff;font-size:13px;line-height:1;cursor:pointer}
  .m:hover .rbtn{display:block}
  @media (hover:none){ .rbtn{display:none !important} }
  .mtip{font-size:11.5px;color:#5d6577;text-align:center}
  footer{padding:8px 10px calc(8px + env(safe-area-inset-bottom));border-top:1px solid #1d2230;
         display:flex;gap:7px;align-items:center;flex:none;background:#0b0d12}
  input,button{font:inherit}
  #in{flex:1;min-width:0;background:#151a24;border:1px solid #232a3a;color:#e8eaed;border-radius:12px;
      padding:11px 13px;outline:none;font-size:16px}
  #in:focus{border-color:#2b5cff}
  button{background:#1b2030;border:1px solid #232a3a;color:#e8eaed;border-radius:12px;
         padding:11px 14px;min-height:44px;cursor:pointer;white-space:nowrap}
  button.p{background:#2b5cff;border-color:#2b5cff;color:#fff}
  button:disabled{opacity:.4}
  #gate{position:fixed;inset:0;background:#0b0d12;display:flex;align-items:center;justify-content:center;
        padding:22px;z-index:9;overflow-y:auto}
  #gate .box{max-width:430px;width:100%;border:1px solid #1d2230;border-radius:18px;padding:22px;background:#0f1219}
  #gate h1{font-size:19px;margin:0 0 10px;line-height:1.4}
  #gate p{color:#8b93a5;font-size:13.5px;margin:0 0 14px}
  label{display:flex;gap:10px;align-items:flex-start;font-size:13.5px;color:#c3c9d6;margin-bottom:16px}
  label input{width:20px;height:20px;flex:none;margin-top:1px;accent-color:#2b5cff}
  .modes{display:flex;gap:9px;margin-bottom:16px}
  .modes button{flex:1;flex-direction:column;align-items:center;gap:3px;display:flex;padding:12px 8px;line-height:1.35}
  .modes button.on{background:#2b5cff;border-color:#2b5cff;color:#fff}
  .modes small{font-size:11px;opacity:.75}
  #lb{position:fixed;inset:0;background:#000d;display:none;align-items:center;justify-content:center;z-index:20;padding:14px}
  #lb.on{display:flex}
  #lb img{max-width:100%;max-height:100%;border-radius:8px}
  .tip{font-size:12px;color:#5d6577;text-align:center;margin-top:14px;line-height:1.6}
</style>
</head>
<body>
<header>
  <b>匿名聊天</b><span id="stat">连接中…</span>
  <button id="next" disabled>换一个 ▸</button>
</header>
<div id="log"></div>
<footer>
  <input id="in" placeholder="说点什么…" disabled autocomplete="off" enterkeyhint="send">
  <input type="file" id="file" accept="image/*" style="display:none">
  <button id="pic" disabled title="发图片" style="padding:11px 12px"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="9" r="1.5" fill="currentColor" stroke="none"/><path d="M21 15l-5-5L5 21"/></svg></button>
  <button id="send" class="p" disabled>发送</button>
  <button id="rep" disabled title="举报">⚑</button>
</footer>

<div id="lb"><img id="lbi" alt=""></div>

<div id="gate"><div class="box">
  <h1>18+ · 匿名 · 不留痕</h1>
  <p>随机配到陌生人聊天，文字和图片都行。<b>平时什么都不存</b>；只有出现举报时，才会把该会话最近记录和双方 IP 哈希保存 7 天。</p>
  <div class="modes">
    <button id="m-one" class="on">一对一<small>私聊一个人</small></button>
    <button id="m-group">群聊<small>所有人一个群</small></button>
  </div>
  <label><input type="checkbox" id="ok">
    <span>我已满 18 岁，并理解这是一个<b>无人实时审核</b>的空间，可能遇到令人不适的内容。</span></label>
  <button id="go" class="p" style="width:100%" disabled>进入</button>
  <div class="tip">请守规矩。违法内容会导致整个服务被关停。</div>
</div></div>

<script>
const $ = s => document.querySelector(s);
const log = $('#log'), stat = $('#stat'), input = $('#in');
let ws = null, joined = false, inChat = false, mode = 'one', myTag = 0, groupSize = 0;

// 上次来过且确认过年龄 → 刷新后直接回到聊天（换模式请点页面顶部的「换一个」或清站点数据）
(function autoResume(){
  let age = null, md = null;
  try { age = localStorage.getItem('anonchat:age'); md = localStorage.getItem('anonchat:mode'); } catch (e) {}
  if (age === '1') {
    if (md === 'group') { mode = 'group'; $('#m-group').classList.add('on'); $('#m-one').classList.remove('on'); }
    document.getElementById('ok').checked = true;
    document.getElementById('go').disabled = false;
    setTimeout(() => { document.getElementById('gate').style.display = 'none'; connect(); }, 30);
  }
})();

$('#m-one').addEventListener('click', () => { mode = 'one'; $('#m-one').classList.add('on'); $('#m-group').classList.remove('on'); });
$('#m-group').addEventListener('click', () => { mode = 'group'; $('#m-group').classList.add('on'); $('#m-one').classList.remove('on'); });
$('#ok').addEventListener('change', e => { $('#go').disabled = !e.target.checked; });
$('#go').addEventListener('click', () => {
  $('#gate').style.display = 'none';
  remember('age', '1'); remember('mode', mode);
  connect();
});

function el(cls, txt){ const d=document.createElement('div'); d.className='m '+cls; if(txt!==undefined) d.textContent=txt; log.appendChild(d); log.scrollTop=1e9; return d; }
function sys(t){ el('sys', t); }
function attachReport(el, id){
  if (!id) return;
  el.dataset.id = id;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'rbtn'; b.title = '举报这条消息'; b.textContent = '⚑';
  b.addEventListener('click', ev => { ev.stopPropagation(); ev.preventDefault(); askReport(id); });
  el.appendChild(b);
  let timer = null;
  const start = () => { clearTimeout(timer); timer = setTimeout(() => askReport(id), 600); };
  const cancel = () => clearTimeout(timer);
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchend', cancel); el.addEventListener('touchmove', cancel);
  el.addEventListener('mousedown', start); el.addEventListener('mouseup', cancel); el.addEventListener('mouseleave', cancel);
  el.addEventListener('contextmenu', e => { e.preventDefault(); askReport(id); });
}
function askReport(id){
  if (!inChat) return;
  if (confirm('举报这条消息？管理员会看到这条内容和上下文。')) send({ t: 'report', id });
}
function msg(t, me, from, id){ const d = el(me?'me':'you'); if (from) { const w=document.createElement('span'); w.className='who'; w.textContent='陌生人 '+from; d.appendChild(w); } d.appendChild(document.createTextNode(t)); attachReport(d, id); return d; }
function img(src, me, from, id){ const d = el(me?'me':'you',''); if (from) { const w=document.createElement('span'); w.className='who'; w.textContent='陌生人 '+from; d.appendChild(w); }
  const i = new Image(); i.src = src;
  i.addEventListener('click', () => { $('#lbi').src = src; $('#lb').classList.add('on'); }); d.appendChild(i); attachReport(d, id); return d; }
$('#lb').addEventListener('click', () => { $('#lb').classList.remove('on'); $('#lbi').src=''; });

function setState(s){
  stat.textContent = s;
  const on = s === '聊天中' || s === '群聊中';
  input.disabled = !on; $('#send').disabled = !on; $('#pic').disabled = !on;
  $('#next').disabled = !joined; $('#rep').disabled = !on;
  inChat = on;
}

function startHeartbeat(){ clearInterval(window.__hb); window.__hb = setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({t:'ping'})); }, 60000); }

// 记住上次的模式与年龄确认：刷新后直接回到原来的位置，不用重走一遍
function remember(k, v){ try { localStorage.setItem('anonchat:' + k, v); } catch (e) {} }
function recall(k){ try { return localStorage.getItem('anonchat:' + k); } catch (e) { return null; } }

let reconnectTry = 0, reconnectTimer = null, autoReconnect = true, loadTipEl = null;

function connect(){
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  ws = new WebSocket((location.protocol==='https:'?'wss://':'ws://') + location.host + '/ws');
  ws.onopen = () => {
    reconnectTry = 0;
    joined = true; ws.send(JSON.stringify({t:'join', mode}));
    setState(mode === 'group' ? '凑人中…' : '排队中');
    sys(mode === 'group' ? '正在进入大厅…' : '正在寻找陌生人…');
    startHeartbeat();
  };
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'waiting') { sys(mode === 'group' ? '正在凑人开一间群聊…' : '正在寻找陌生人…'); setState(mode === 'group' ? '凑人中…' : '排队中'); }
    else if (m.t === 'matched') { sys('已配对 —— 打个招呼吧'); setState('聊天中'); }
    else if (m.t === 'room') {
      myTag = m.tag || 0; groupSize = m.n || 0;
      sys('已进入大厅，当前 ' + groupSize + ' 人（你是陌生人 ' + myTag + '）');
      loadTipEl = el('sys', '正在加载最近的聊天记录…');
      setState('群聊中');
    }
    else if (m.t === 'roominfo') { groupSize = m.n || groupSize; stat.textContent = '群聊中 · ' + groupSize + ' 人'; }
    else if (m.t === 'msg') { msg(m.v, false, m.from, m.id); }
    else if (m.t === 'img') { img(m.v, false, m.from, m.id); }
    else if (m.t === 'history') {
      if (loadTipEl) { try { loadTipEl.remove(); } catch (e) {} loadTipEl = null; }
      if (m.items && m.items.length) {
        sys('—— 以下是最近 3 天的聊天记录 ——');
        m.items.forEach(it => {
          if (it.k === 'text') msg(it.v, false, it.from, it.id);
          else if (it.k === 'img') img(it.v, false, it.from, it.id);
          else sys('陌生人 ' + it.from + '：[图片]');
        });
        sys('—— 以上是之前的聊天 ——');
      }
    }
    else if (m.t === 'left') { sys('对方离开了，点右上角「换一个」'); setState('排队中'); }
    else if (m.t === 'reported') { sys('已举报，已提交管理员审核'); }
    else if (m.t === 'err') { sys(m.v); }
    else if (m.t === 'pong') {}
  };
  ws.onclose = () => {
    joined = false;
    if (!autoReconnect) { setState('离线'); return; }
    reconnectTry++;
    const wait = Math.min(8000, 800 * Math.pow(1.7, Math.min(reconnectTry, 6)));
    setState('重连中…');
    sys('连接断开，' + Math.round(wait / 1000) + ' 秒后自动重连…（已重连 ' + reconnectTry + ' 次）');
    reconnectTimer = setTimeout(connect, wait);
  };
  ws.onerror = () => {};
}
function send(o){ if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); else sys('未连接'); }

function newId(){ return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function sendText(){
  const v = input.value.trim(); if (!v) return;
  const id = newId();
  input.value = ''; msg(v, true, 0, id); send({t:'msg', v, id});
}
$('#send').addEventListener('click', sendText);
input.addEventListener('keydown', e => { if (e.key === 'Enter') sendText(); });
$('#next').addEventListener('click', () => {
  log.innerHTML = ''; loadTipEl = null;
  sys(mode === 'group' ? '重新进入大厅…' : '换人中…');
  send({t: 'skip'});
  setState(mode === 'group' ? '凑人中…' : '排队中');
});
$('#rep').addEventListener('click', () => {
  if (!inChat) return;
  if (!confirm('要举报某一条具体消息：手机长按那条消息、电脑把鼠标移到消息上点右上角 ⚑。' + String.fromCharCode(10) + String.fromCharCode(10) + '点「确定」则举报整个会话（不带具体消息），点「取消」回去选具体那条。')) return;
  send({t: 'report'});
});
$('#pic').addEventListener('click', () => $('#file').click());

// 选图 → 压缩到 ≤1280px / JPEG → 直传
$('#file').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (!f.type.startsWith('image/')) { sys('只能发图片'); return; }
  try {
    const d = await compress(f);
    if (d.length > 320000) { sys('图片太大，换一张小点的'); return; }
    const id = newId();
    img(d, true, 0, id); send({t:'img', v:d, id});
  } catch { sys('图片处理失败'); }
});

function compress(file){
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const i = new Image();
    i.onload = () => {
      const max = 1280, s = Math.min(1, max / Math.max(i.width, i.height));
      const c = document.createElement('canvas');
      c.width = Math.round(i.width * s); c.height = Math.round(i.height * s);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(i, 0, 0, c.width, c.height);
      let q = 0.72, out = c.toDataURL('image/jpeg', q);
      while (out.length > 300000 && q > 0.32) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
      URL.revokeObjectURL(url); res(out);
    };
    i.onerror = rej; i.src = url;
  });
}
</script>
</body></html>`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      return env.LOBBY.get(env.LOBBY.idFromName('global')).fetch(req);
    }
    const adminKey = url.searchParams.get('key') || '';
    const isAdmin = !!env.ADMIN_KEY && adminKey === env.ADMIN_KEY;
    if (url.pathname === '/admin') {
      if (!isAdmin) return new Response('forbidden', { status: 403 });
      return new Response(ADMIN_PAGE, { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }
    // ---- 给外部机器人用的审核 API（同一个 ADMIN_KEY）----
    if (url.pathname === '/api/pending') {
      if (!isAdmin) return new Response(JSON.stringify({ ok: false, error: 'bad key' }),
        { status: 403, headers: { 'content-type': 'application/json;charset=utf-8' } });
      const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const onlyNew = url.searchParams.get('status') !== 'all';
      const d = await env.LOBBY.get(env.LOBBY.idFromName('global')).fetch(new Request('https://do/stats'));
      const js = await d.json();
      let items = js.reports || [];
      if (onlyNew) items = items.filter(r => !r.handled);
      items = items.slice(0, limit).map(r => ({
        key: r.key, at: r.at, mode: r.mode, handled: !!r.handled, content_cleared: !!r.content_cleared,
        reporter_tag: r.reporter_tag, reporter_ip_hash: r.reporter_ip_hash, reported_ip_hash: r.reported_ip_hash,
        reported_tag: r.reported_tag, reported_msg: r.reported_msg || null, msgs: r.msgs || [],
      }));
      return new Response(JSON.stringify({ ok: true, count: items.length, pending_total: (js.reports || []).filter(r => !r.handled).length, items }, null, 2),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/api/action') {
      if (!isAdmin) return new Response(JSON.stringify({ ok: false, error: 'bad key' }),
        { status: 403, headers: { 'content-type': 'application/json;charset=utf-8' } });
      const action = url.searchParams.get('action') || '';
      const k = url.searchParams.get('k') || '';
      const iph = url.searchParams.get('iph') || '';
      const hours = url.searchParams.get('hours') || url.searchParams.get('h') || '168';
      const by = (url.searchParams.get('by') || 'external').slice(0, 40);
      const stub = env.LOBBY.get(env.LOBBY.idFromName('global'));
      let ep = null;
      if (action === 'ban') ep = '/ban?iph=' + encodeURIComponent(iph) + '&h=' + encodeURIComponent(hours);
      else if (action === 'unban') ep = '/unban?iph=' + encodeURIComponent(iph);
      else if (action === 'kick') ep = '/kick?iph=' + encodeURIComponent(iph);
      else if (action === 'clear') ep = '/clearmessages?k=' + encodeURIComponent(k);
      else if (action === 'ignore') ep = '/handled?k=' + encodeURIComponent(k);
      else return new Response(JSON.stringify({ ok: false, error: 'unknown action, use ban|unban|kick|clear|ignore' }),
        { status: 400, headers: { 'content-type': 'application/json;charset=utf-8' } });
      const r = await stub.fetch(new Request('https://do' + ep));
      // 记录是谁批的（审计）
      if (k && (action === 'ban' || action === 'ignore' || action === 'clear')) {
        try {
          const rec = await stub.fetch(new Request('https://do/markreviewed?k=' + encodeURIComponent(k) + '&by=' + encodeURIComponent(by) + '&action=' + action));
          await rec.text();
        } catch {}
      }
      const body = await r.text();
      return new Response('{"ok":' + (r.ok ? 'true' : 'false') + ',"action":"' + action + '","by":"' + by + '","result":' + (body || 'null') + '}',
        { status: r.status, headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/admin/ai') {
      if (!isAdmin) return new Response('forbidden', { status: 403 });
      const k = url.searchParams.get('k') || '';
      const rr = await env.LOBBY.get(env.LOBBY.idFromName('global'))
        .fetch(new Request('https://do/getreport?k=' + encodeURIComponent(k)));
      if (!rr.ok) return new Response('report not found', { status: 404 });
      const rec = await rr.json();
      const parts = [];
      if (rec.reported_msg && rec.reported_msg.v) parts.push('【被举报的那条】' + rec.reported_msg.v);
      (rec.msgs || []).slice(-12).forEach(m => { if (m && m.v) parts.push('【上下文】' + String(m.v).slice(0, 300)); });
      const text = parts.join('\n').slice(0, 3000);
      if (!env.AI) return new Response(JSON.stringify({ ok: false, error: 'no-ai-binding' }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
      try {
        const out = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [
            { role: 'system', content: '你是中文匿名聊天室的审核助手。根据举报内容判断风险，并只输出一行 JSON，不要多余文字。\n字段：risk 取 high/medium/low；category 用中文短词（色情/暴力/违法交易/涉未成年人/骚扰辱骂/垃圾广告/正常）；reason 中文一句话；suggest 取 ban 或 kick 或 ignore。' },
            { role: 'user', content: text || '(举报内容为空)' },
          ],
          max_tokens: 220,
        });
        let verdict = '';
        if (out && typeof out.response === 'string') verdict = out.response;
        else if (out && out.choices && out.choices[0] && out.choices[0].message) verdict = out.choices[0].message.content;
        else verdict = JSON.stringify(out).slice(0, 400);
        let parsed = null;
        try { const mm = String(verdict).match(/\{[\s\S]*\}/); if (mm) parsed = JSON.parse(mm[0]); } catch {}
        return new Response(JSON.stringify({ ok: true, verdict: String(verdict).slice(0, 600), parsed }),
          { headers: { 'content-type': 'application/json;charset=utf-8' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e).slice(0, 200) }),
          { headers: { 'content-type': 'application/json;charset=utf-8' } });
      }
    }
    if (url.pathname === '/admin/kick' || url.pathname === '/admin/handled' || url.pathname === '/admin/clearmessages') {
      if (!isAdmin) return new Response('forbidden', { status: 403 });
      const what = url.pathname.split('/').pop();
      const ep = what === 'kick'
        ? '/kick?iph=' + encodeURIComponent(url.searchParams.get('iph') || '')
        : '/' + what + '?k=' + encodeURIComponent(url.searchParams.get('k') || '');
      return env.LOBBY.get(env.LOBBY.idFromName('global')).fetch(new Request('https://do' + ep));
    }
    if (url.pathname === '/admin/ban' || url.pathname === '/admin/unban') {
      if (!isAdmin) return new Response('forbidden', { status: 403 });
      const iph = url.searchParams.get('iph') || '';
      const hours = url.searchParams.get('h') || '168';
      const ep = url.pathname === '/admin/ban'
        ? '/ban?iph=' + encodeURIComponent(iph) + '&h=' + encodeURIComponent(hours)
        : '/unban?iph=' + encodeURIComponent(iph);
      return env.LOBBY.get(env.LOBBY.idFromName('global')).fetch(new Request('https://do' + ep));
    }
    if (url.pathname === '/admin/data' || url.pathname === '/admin/clearreports') {
      if (!isAdmin) return new Response('forbidden', { status: 403 });
      const ep = url.pathname === '/admin/data' ? '/stats' : '/clearreports';
      return env.LOBBY.get(env.LOBBY.idFromName('global')).fetch(new Request('https://do' + ep));
    }
    if (url.pathname === '/admin/reset') {
      const key = url.searchParams.get('key') || '';
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return new Response('forbidden', { status: 403 });
      return env.LOBBY.get(env.LOBBY.idFromName('global'))
        .fetch(new Request('https://do/reset', { headers: { 'x-admin': '1' } }));
    }
    if (url.pathname === '/admin/reports') {
      // 旧链接：过去返回裸 JSON，容易让人以为页面坏了 → 直接跳到管理页
      if (!isAdmin) return new Response('forbidden', { status: 403 });
      return Response.redirect('https://' + url.host + '/admin?key=' + encodeURIComponent(adminKey), 302);
    }
    return new Response(PAGE, { headers: { 'content-type': 'text/html;charset=utf-8' } });
  },
};

export class Lobby {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.waiting = null;        // 1v1 等待者
    this.hall = null;           // 大厅：所有群聊的人都在同一个群里
    this.pairs = new Map();
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/reports') return this.listReports();
    if (url.pathname === '/kick') {
      const iph = url.searchParams.get('iph') || '';
      let kicked = 0;
      for (const c of [...this.pairs.values()]) {
        if (c.iph === iph) { try { c.ws.close(1001, 'kicked'); } catch {} kicked++; }
      }
      return new Response(JSON.stringify({ ok: true, kicked }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/clearmessages') {
      const key = url.searchParams.get('k') || '';
      const rec = await this.state.storage.get(key);
      if (!rec) return new Response(JSON.stringify({ ok: false, error: 'gone' }),
        { status: 404, headers: { 'content-type': 'application/json' } });
      rec.msgs = []; rec.reported_msg = null;
      rec.content_cleared = true; rec.cleared_at = new Date().toISOString();
      await this.state.storage.put(key, rec);
      return new Response(JSON.stringify({ ok: true }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/handled') {
      const key = url.searchParams.get('k') || '';
      const rec = await this.state.storage.get(key);
      if (!rec) return new Response(JSON.stringify({ ok: false, error: 'gone' }),
        { status: 404, headers: { 'content-type': 'application/json' } });
      rec.handled = true; rec.handled_at = new Date().toISOString();
      await this.state.storage.put(key, rec);
      return new Response(JSON.stringify({ ok: true }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/ban') {
      const iph = url.searchParams.get('iph') || '';
      const hours = Math.max(1, Math.min(8760, parseInt(url.searchParams.get('h') || url.searchParams.get('hours') || '168', 10) || 168));
      if (!/^[0-9a-f]{64}$/.test(iph)) return new Response(JSON.stringify({ ok: false, error: 'bad iph' }),
        { status: 400, headers: { 'content-type': 'application/json' } });
      const rec = { iph, at: new Date().toISOString(), until: Date.now() + hours * 3600000, hours };
      await this.state.storage.put('ban:' + iph, rec);
      let kicked = 0;
      for (const c of [...this.pairs.values()]) {
        if (c.iph === iph) { try { c.ws.close(1001, 'banned'); } catch {} kicked++; }
      }
      return new Response(JSON.stringify({ ok: true, kicked, ...rec }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/unban') {
      const iph = url.searchParams.get('iph') || '';
      await this.state.storage.delete('ban:' + iph);
      return new Response(JSON.stringify({ ok: true, iph }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/markreviewed') {
      const key = url.searchParams.get('k') || '';
      const rec = await this.state.storage.get(key);
      if (!rec) return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
      rec.reviewed_by = (url.searchParams.get('by') || '').slice(0, 40);
      rec.reviewed_action = (url.searchParams.get('action') || '').slice(0, 20);
      rec.reviewed_at = new Date().toISOString();
      if (rec.reviewed_action === 'ignore') rec.handled = true;
      await this.state.storage.put(key, rec);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/getreport') {
      const key = url.searchParams.get('k') || '';
      const rec = await this.state.storage.get(key);
      if (!rec) return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true, key, ...rec }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/stats') {
      const hall = this.hall ? [...this.hall.members].filter(c => this.alive(c)).length : 0;
      const rep = await this.state.storage.list({ prefix: 'report:', limit: 200 });
      const arr = [...rep].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => (a.at < b.at ? 1 : -1));
      const bl = await this.state.storage.list({ prefix: 'ban:', limit: 500 });
      const bans = [...bl.values()].filter(b => b && b.until > Date.now()).sort((a, b) => (a.until < b.until ? 1 : -1));
      return new Response(JSON.stringify({
        hall, queue: this.waiting ? 1 : 0, conns: this.pairs.size,
        retention_days: Math.round(HISTORY_TTL_MS / 86400000), reports: arr, bans,
      }), { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/clearreports') {
      const list = await this.state.storage.list({ prefix: 'report:', limit: 1000 });
      for (const k of list.keys()) await this.state.storage.delete(k);
      return new Response(JSON.stringify({ ok: true, deleted: list.size }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/reset') {
      for (const c of this.pairs.values()) { try { c.ws.close(1000, 'reset'); } catch {} }
      const n = this.hall ? this.hall.members.size : 0;
      this.waiting = null; this.hall = null; this.pairs.clear();
      return new Response(JSON.stringify({ ok: true, kicked: n }), { headers: { 'content-type': 'application/json' } });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
    const iph = await sha256hex(ip + '|' + (this.env.IP_SALT || 'anon-chat-salt'));
    const ban = await this.state.storage.get('ban:' + iph);
    if (ban && ban.until > Date.now()) {
      try { server.close(1001, 'banned'); } catch {}
      return new Response(JSON.stringify({ error: 'banned', until: ban.until }), {
        status: 403, headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    const conn = {
      ws: server,
      iph,
      mode: null, peer: null, room: null, tag: 0,
      msgs: [], nMsg: 0, nImg: 0, winStart: Date.now(), lastSeen: Date.now(),
    };
    this.pairs.set(server, conn);
    server.addEventListener('message', ev => this.onMessage(conn, ev.data));
    server.addEventListener('close', () => this.onClose(conn));
    server.addEventListener('error', () => this.onClose(conn));
    return new Response(null, { status: 101, webSocket: client });
  }

  send(conn, obj) { try { conn.ws.send(JSON.stringify(obj)); } catch {} }
  alive(conn) { return conn && conn.ws.readyState === 1 && Date.now() - conn.lastSeen < STALE_MS; }

  // ---------- 一对一 ----------
  enqueue(conn) {
    conn.mode = 'one';
    if (this.waiting && !this.alive(this.waiting)) { try { this.waiting.ws.close(1000, 'timeout'); } catch {} this.waiting = null; }
    if (this.waiting && this.waiting !== conn && this.waiting.ws.readyState === 1) {
      const a = this.waiting; this.waiting = null;
      a.peer = conn; conn.peer = a; a.msgs = []; conn.msgs = [];
      this.send(a, { t: 'matched' }); this.send(conn, { t: 'matched' });
    } else {
      this.waiting = conn; this.send(conn, { t: 'waiting' });
    }
  }

  unpair(conn, requeue) {
    const peer = conn.peer;
    conn.peer = null;
    if (peer) { peer.peer = null; this.send(peer, { t: 'left' }); if (requeue) this.enqueue(conn); }
    else if (requeue) { if (this.waiting === conn) this.waiting = null; this.enqueue(conn); }
  }

  // ---------- 群聊大厅（所有人一个群，记录存 3 天） ----------
  joinHall(conn) {
    conn.mode = 'group';
    if (!this.hall) this.hall = { members: new Set(), nextTag: 1 };
    const h = this.hall;
    for (const c of [...h.members]) {          // 先清掉大厅里的死连接
      if (!this.alive(c)) { try { c.ws.close(1000, 'timeout'); } catch {} h.members.delete(c); }
    }
    if (h.members.size >= HALL_MAX) { this.send(conn, { t: 'err', v: '大厅人数已满，稍后再试' }); return; }

    conn.tag = h.nextTag++; conn.msgs = []; conn.lastSeen = Date.now();
    conn.room = h; h.members.add(conn);
    this.send(conn, { t: 'room', tag: conn.tag, n: h.members.size });
    try { this.state.waitUntil(this.sendHallHistory(conn)); } catch {}
    this.hallBroadcast({ t: 'sys', v: '陌生人 ' + conn.tag + ' 加入了' }, conn);
    this.hallInfo();
    this.scheduleCleanup();
  }

  // 把最近 3 天的记录补给刚进来的人（图片最多重发 2 张，其余显示占位）
  async sendHallHistory(conn) {
    try {
      const cutoff = Date.now() - HISTORY_TTL_MS;
      const list = await this.state.storage.list({ prefix: 'm:', reverse: true, limit: HISTORY_LIMIT });
      const items = []; let imgs = 0;
      for (const [, v] of list) {
        if (!v || !v.at || v.at < cutoff) continue;
        if (v.k === 'img') { if (++imgs <= HISTORY_IMG_MAX) items.push(v); else items.push({ from: v.from, k: 'imgph', at: v.at }); }
        else items.push(v);
      }
      if (items.length) this.send(conn, { t: 'history', items: items.reverse() });
    } catch {}
  }

  hallBroadcast(obj, except) {
    const h = this.hall; if (!h) return;
    for (const c of h.members) { if (c !== except) this.send(c, obj); }
  }
  hallInfo() {
    const h = this.hall; if (!h) return;
    for (const c of h.members) this.send(c, { t: 'roominfo', n: h.members.size });
  }

  leaveHall(conn) {
    const h = conn.room; conn.room = null;
    if (!h || !h.members) return;
    h.members.delete(conn);
    if (h.members.size > 0) { this.hallBroadcast({ t: 'sys', v: '陌生人 ' + conn.tag + ' 离开了' }); this.hallInfo(); }
  }

  // 落盘一条聊天记录（key 按时间戳有序，过期由 alarm 清）
  saveHistory(item) {
    const key = 'm:' + String(item.at).padStart(15, '0') + ':' + Math.random().toString(36).slice(2, 6);
    try { this.state.waitUntil(this.state.storage.put(key, item)); } catch {}
  }

  async cleanupHistory() {
    try {
      const cutoff = Date.now() - HISTORY_TTL_MS;
      const old = await this.state.storage.list({ prefix: 'm:', end: 'm:' + String(cutoff).padStart(15, '0') });
      for (const k of old.keys()) await this.state.storage.delete(k);
    } catch {}
  }

  scheduleCleanup() { try { this.state.storage.setAlarm(Date.now() + 6 * 3600 * 1000); } catch {} }
  async alarm() { await this.cleanupHistory(); this.scheduleCleanup(); }



  // ---------- 通用 ----------
  rate(conn, isImg) {
    const now = Date.now();
    if (now - conn.winStart > RATE_WINDOW_MS) { conn.winStart = now; conn.nMsg = 0; conn.nImg = 0; }
    if (isImg) { if (++conn.nImg > RATE_IMG) return false; }
    else if (++conn.nMsg > RATE_MSG) return false;
    return true;
  }

  deliver(conn, entry, out) {
    // 记入自己的留证缓冲
    conn.msgs.push(entry); if (conn.msgs.length > KEEP_MSGS) conn.msgs.shift();
    if (conn.room) {                       // 大厅：落盘记录 + 广播
      this.saveHistory({ id: entry.id, from: conn.tag, k: entry.k, v: out.v, at: entry.at });
      this.hallBroadcast(Object.assign({ from: conn.tag }, out), conn);
    } else if (conn.peer) {               // 一对一：转发
      conn.peer.msgs.push(Object.assign({}, entry, { me: 0 }));
      if (conn.peer.msgs.length > KEEP_MSGS) conn.peer.msgs.shift();
      this.send(conn.peer, out);
    }
  }

  onMessage(conn, data) {
    conn.lastSeen = Date.now();
    let m; try { m = JSON.parse(typeof data === 'string' ? data : ''); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'ping') { this.send(conn, { t: 'pong' }); return; }

    if (m.t === 'join') {
      if (m.mode === 'group') this.joinHall(conn); else this.enqueue(conn);
      return;
    }
    if (m.t === 'skip') {
      if (conn.mode === 'group') { if (!conn.room) this.joinHall(conn); }
      else this.unpair(conn, true);
      return;
    }
    if (m.t === 'report') { this.report(conn, String(m.id || '')); return; }

    if (m.t === 'msg') {
      if (!this.rate(conn, false)) { this.send(conn, { t: 'err', v: '发太快了，慢一点' }); return; }
      const v = String(m.v || '').slice(0, MAX_TEXT).trim();
      if (!v) return;
      if (BLOCK_WORDS.some(w => v.toLowerCase().includes(w))) { this.send(conn, { t: 'err', v: '这里不允许发链接' }); return; }
      const id = String(m.id || '').slice(0, 40) || ('s' + Date.now().toString(36));
      this.deliver(conn, { id, me: 1, k: 'text', tag: conn.tag, v, at: Date.now() }, { t: 'msg', v, id });
      return;
    }

    if (m.t === 'img') {
      if (!this.rate(conn, true)) { this.send(conn, { t: 'err', v: '图片发太快了' }); return; }
      const v = String(m.v || '');
      if (!/^data:image\/(jpeg|png|webp|gif);base64,/.test(v)) { this.send(conn, { t: 'err', v: '图片格式不支持' }); return; }
      if (v.length > MAX_IMG_CHARS) { this.send(conn, { t: 'err', v: '图片太大' }); return; }
      const imgId = String(m.id || '').slice(0, 40) || ('s' + Date.now().toString(36));
      this.deliver(conn, { id: imgId, me: 1, k: 'img', tag: conn.tag, v: v.slice(0, 200) + '…(图，已省略)', at: Date.now() }, { t: 'img', v, id: imgId });
      return;
    }
  }

  async report(conn, msgId) {
    const msgs = conn.msgs || [];
    const idx = msgId ? msgs.findIndex(x => x && x.id === msgId) : -1;
    const target = idx >= 0 ? msgs[idx] : null;
    // 举报 = 只上报给管理员，不自动处置（不断开、不踢人、不退群）
    const peer = conn.peer, room = conn.room;
    const record = {
      at: new Date().toISOString(),
      mode: room ? 'group' : 'one',
      reporter_ip_hash: conn.iph,
      reporter_tag: conn.tag || 0,
      reported_ip_hash: peer ? peer.iph : (target && room && target.tag ? (() => {
        for (const c of room.members) { if (c.tag === target.tag) return c.iph; }
        return null;
      })() : null),
      reported_tag: (target && target.tag) ? target.tag : (peer ? 0 : null),
      room_staff: room ? [...room.members].map(c => ({ tag: c.tag, iph: c.iph })) : [],
      reported_msg_id: msgId || null,
      reported_msg: target ? { tag: target.tag || 0, k: target.k, v: String(target.v || '').slice(0, 500), at: target.at } : null,
      msgs: idx >= 0 ? msgs.slice(Math.max(0, idx - 3), idx + 4) : msgs.slice(-KEEP_MSGS),
      handled: false,
    };
    try { await this.state.storage.put('report:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8), record); } catch {}
    this.send(conn, { t: 'reported' });
  }

  async listReports() {
    const out = [];
    const list = await this.state.storage.list({ prefix: 'report:', limit: 200 });
    for (const [k, v] of list) out.push({ key: k, ...v });
    out.sort((a, b) => (a.at < b.at ? 1 : -1));
    return new Response(JSON.stringify({ count: out.length, reports: out }, null, 2),
      { headers: { 'content-type': 'application/json;charset=utf-8' } });
  }

  onClose(conn) {
    if (this.waiting === conn) this.waiting = null;
    if (conn.room) this.leaveHall(conn);
    const peer = conn.peer;
    if (peer) { peer.peer = null; this.send(peer, { t: 'left' }); }
    this.pairs.delete(conn);
  }
}
