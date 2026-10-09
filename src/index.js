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
const HISTORY_IMG_TTL_MS = 24 * 3600 * 1000;  // 图片只保留 1 天（比文字短）
const STALE_MS = 240000;           // 超过这么久没动静视为僵尸（须 > 心跳间隔）
// 链接放开了：不再拦截 http/https/www（运营者要能在群里发链接；挡得住职业引流的人，只烦正常人）
const IMG_PLACEHOLDER = '…(图，已省略)';
// DO 实例身份由 idFromName 的 name 决定：改了 DO 代码而不换 name，实例会一直粘着旧代码。
// 所以「部署后行为没变」时，把 DO_NAME 加个后缀就是最可靠的生效手段（旧 name 的数据仍可读）。
const DO_NAME = 'main11';   // 缓冲里图片只留占位，完整图不进每人的内存

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
  .repimg{display:block;max-width:260px;max-height:260px;border-radius:10px;margin-top:8px;cursor:zoom-in;border:1px solid #232a3a}
  #bigimg{position:fixed;inset:0;background:#000d;display:none;align-items:center;justify-content:center;z-index:30;padding:16px}
  #bigimg.on{display:flex}
  #bigimg img{max-width:100%;max-height:100%;border-radius:8px}
</style></head>
<body>
<div id="login">
  <div class="lbox">
    <h1 style="margin:0 0 6px;font-size:17px">匿名聊天 · 管理后台</h1>
    <p class="meta" style="margin:0 0 14px">输入管理密钥进入。密钥只存在这台设备的浏览器里，不会出现在地址栏。</p>
    <input id="lkey" type="password" placeholder="管理密钥" autocomplete="current-password" style="width:100%;background:#151a24;border:1px solid #232a3a;color:#e8eaed;border-radius:10px;padding:12px;font:inherit">
    <label style="display:flex;gap:8px;align-items:center;margin:12px 0 14px;font-size:13px">
      <input type="checkbox" id="lremember" style="width:18px;height:18px;accent-color:#2b5cff"> 在这台设备上记住（公用电脑别勾）
    </label>
    <button id="lgo" class="p" style="width:100%">进入</button>
    <div id="lerr" style="color:#ffb4c0;font-size:13px;margin-top:10px;min-height:18px"></div>
  </div>
</div>
<div id="panel" style="display:none">
<h1>匿名聊天 · 管理
  <button id="chkey" style="margin-left:auto;font-size:12px;padding:6px 10px;min-height:34px">退出</button>
  <button id="rf">刷新</button></h1>
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
  <input id="q" placeholder="搜索（IP 哈希 / 内容 / 时间）" style="flex:1;min-width:180px;background:#151a24;border:1px solid #232a3a;color:#e8eaed;border-radius:10px;padding:9px 12px;font:inherit">
  <span class="meta" id="cnt2" style="margin:0"></span>
</div>
<div class="row" id="pager" style="margin:-4px 0 10px"></div>
<div id="list"></div>
<div id="bigimg"><img id="bigimgi" alt=""></div>
<h2>机器人 / API（同一个 key，可给外部程序用）</h2>
<div class="card">
  <div class="meta" style="margin:0 0 10px">把 &lt;KEY&gt; 换成地址栏里的 key，返回都是 JSON。</div>
  <pre id="api-help"></pre>
  <div class="row" style="margin-top:10px">
    <button id="copyapi">复制接口说明</button>
    <span class="ok" id="apimsg"></span>
  </div>
</div>
<h2 id="bh">封禁列表</h2>
<div id="bans"></div>
<script>
var K = (function () {
  var u = new URLSearchParams(location.search).get('key');
  if (u) { try { localStorage.setItem('anonchat:adminkey', u); } catch (e) {} 
           try { history.replaceState(null, '', location.pathname); } catch (e) {}   // 从地址栏抹掉 key
           return u; }
  try { return localStorage.getItem('anonchat:adminkey') || ''; } catch (e) { return ''; }
})();
function showLogin(msg) {
  var el = document.getElementById('login');
  try { document.getElementById('panel').style.display = 'none'; } catch (e) {}   // 未登录：管理界面整块不显示
  el.classList.add('on');
  document.getElementById('lerr').textContent = msg || '';
  setTimeout(function(){ try { document.getElementById('lkey').focus(); } catch (e) {} }, 60);
}
function hideLogin() { document.getElementById('login').classList.remove('on'); }
function askKey() { showLogin(''); }
(function bindLogin(){
  var inp = document.getElementById('lkey'), err = document.getElementById('lerr');
  function submit(){
    var v = inp.value.trim();
    if (!v) { err.textContent = '请输入密钥'; return; }
    K = v;
    api('data?limit=1').then(function(){ 
      try { if (document.getElementById('lremember').checked) localStorage.setItem('anonchat:adminkey', v); else localStorage.removeItem('anonchat:adminkey'); } catch (e) {}
      document.getElementById('lerr').textContent = ''; hideLogin();
      try { document.getElementById('panel').style.display = ''; } catch (e) {}
      load();
    }).catch(function(){ err.textContent = '密钥不对'; K = ''; });
  }
  document.getElementById('lgo').onclick = submit;
  inp.addEventListener('keydown', function(e){ if (e.key === 'Enter') submit(); });
})();
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
function say(t){ document.getElementById('msg').textContent = t; setTimeout(function(){ document.getElementById('msg').textContent = ''; }, 4000); }
async function api(p){ var r = await fetch('/admin/' + p, { headers: { 'x-admin-key': K } }); if (!r.ok) throw new Error(r.status); return r.json(); }
var OFFSET = 0, LIMIT = 20, Q = '', SEQ = 0;
async function load(){
  var d, my = ++SEQ;
  try { d = await api('data?offset=' + OFFSET + '&limit=' + LIMIT + '&q=' + encodeURIComponent(Q)); }
  catch (e) {
    if (my !== SEQ) return;                                  // 已被更新的请求取代，忽略
    try { localStorage.removeItem('anonchat:adminkey'); } catch (x) {}
    K = ''; showLogin('密钥无效或已失效，请重新输入'); return;
  }
  if (my !== SEQ) return;
  try { document.getElementById('panel').style.display = ''; } catch (e) {}
  document.getElementById('kv').innerHTML =
      '<div><b>' + d.hall + '</b><span>大厅在线</span></div>'
    + '<div><b>' + d.queue + '</b><span>1v1 排队</span></div>'
    + '<div><b>' + d.conns + '</b><span>总连接</span></div>'
    + '<div><b>' + d.reports.length + '</b><span>举报记录</span></div>'
    + '<div><b>' + d.retention_days + '</b><span>记录保留（天）</span></div>'
    + '<div><b>' + ((d.bans || []).length) + '</b><span>封禁中</span></div>';
  var onlyNew = document.getElementById('onlynew').checked;
  var shown = onlyNew ? d.reports.filter(function(x){ return !x.handled; }) : d.reports;
  var total = (d.reports_total === undefined ? d.reports.length : d.reports_total);
  var all = (d.reports_all === undefined ? total : d.reports_all);
  document.getElementById('rh').textContent = '举报记录（' + total + (Q ? ' / 共 ' + all : '') + '）';
  document.getElementById('cnt2').textContent = onlyNew ? ('本页未处理：' + shown.length + ' 条') : ('本页 ' + shown.length + ' 条');
  var pages = Math.max(1, Math.ceil(total / LIMIT)), cur = Math.floor(OFFSET / LIMIT) + 1;
  document.getElementById('pager').innerHTML =
      '<button id="pprev"' + (OFFSET <= 0 ? ' disabled' : '') + '>‹ 上一页</button>'
    + '<span class="meta" style="margin:0">第 ' + cur + ' / ' + pages + ' 页</span>'
    + '<button id="pnext"' + (OFFSET + LIMIT >= total ? ' disabled' : '') + '>下一页 ›</button>'
    + '<button id="plast">跳到最新</button>';
  var pv = document.getElementById('pprev'), nx = document.getElementById('pnext'), ls = document.getElementById('plast');
  if (pv) pv.onclick = function(){ OFFSET = Math.max(0, OFFSET - LIMIT); load(); };
  if (nx) nx.onclick = function(){ OFFSET = OFFSET + LIMIT; load(); };
  if (ls) ls.onclick = function(){ OFFSET = 0; load(); };
  var h = '';
  if (!shown.length) h = '<div class="empty">' + (Q ? '没有匹配「' + esc(Q) + '」的记录' : (onlyNew ? '本页没有未处理的举报了 🎉' : '暂无举报记录（平时不落盘，只有举报时才存）')) + '</div>';
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
      +  (r.reported_msg && r.reported_msg.k === 'img'
            ? '<div class="meta" style="color:#ffb4c0">被举报的是图片' + (r.reported_msg.tag ? ('（陌生人 ' + esc(r.reported_msg.tag) + '）') : '') + '</div>'
              + '<div class="row" style="margin-top:8px"><button data-showimg="' + esc(r.key) + '">🖼 查看这张图</button></div>'
              + '<div class="imgbox" data-imgbox="' + esc(r.key) + '"></div>'
            : (r.reported_msg ? '<div class="meta" style="color:#ffb4c0">被举报的消息：' + (r.reported_msg.tag ? ('陌生人 ' + esc(r.reported_msg.tag)) : '对方') + '：' + esc(String(r.reported_msg.v || '').slice(0, 300)) + '</div>' : '<div class="meta">（这条举报没抓到具体消息内容）</div>'))
      +  (r.room_staff && r.room_staff.length ? '<div class="meta">当时在场：' + r.room_staff.map(function(s){ return '#' + s.tag; }).join(' ') + '</div>' : '')
      +  (lines ? '<pre>' + lines + '</pre>' : '')
      +  '<div class="row" style="margin-top:10px">'
      +    (r.reported_ip_hash ? '<button data-kick="' + esc(r.reported_ip_hash) + '">踢出（在线）</button>' : '')
      +    (r.reported_ip_hash ? '<button class="d" data-banh="' + esc(r.reported_ip_hash) + '" data-h="8" data-who="被举报方">封禁 8 小时</button>' : '')
      +    (r.reported_ip_hash ? '<button class="d" data-banh="' + esc(r.reported_ip_hash) + '" data-h="168" data-who="被举报方">封禁 7 天</button>' : '')
      +    (r.content_cleared ? '<span class="tag">聊天内容已清除</span>' : '<button data-clear="' + esc(r.key) + '">清除聊天内容</button>')
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
  var si = ev.target.closest('button[data-showimg]');
  if (si) {
    var kk = si.getAttribute('data-showimg');
    var box = document.querySelector('.imgbox[data-imgbox="' + kk.replace(/"/g, '') + '"]');
    if (box) {
      fetch('/admin/image?k=' + encodeURIComponent(kk), { headers: { 'x-admin-key': K } })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); })
        .then(function (b) { var u = URL.createObjectURL(b); box.innerHTML = '<img class="repimg" src="' + u + '" alt="reported image">'; })
        .catch(function () { box.textContent = '取图失败'; });
      si.disabled = true; si.textContent = '🖼 已展开';
    }
    return;
  }
});
document.getElementById('bans').addEventListener('click', function(ev){
  var b = ev.target.closest('button[data-unban]'); if (!b) return;
  doUnban(b.getAttribute('data-unban'));
});
document.getElementById('api-help').textContent = [
  '① 读待审（默认只给未处理，加 &status=all 拿全部）',
  '   GET /api/pending?key=<KEY>&limit=20',
  '',
  '② 批复 / 处置（by= 会记进记录，管理页显示处理人）',
  '   GET /api/action?key=<KEY>&action=ignore&k=<记录key>&by=bot',
  '   GET /api/action?key=<KEY>&action=clear&k=<记录key>&by=bot',
  '   GET /api/action?key=<KEY>&action=ban&iph=<IP哈希>&hours=8&by=bot',
  '   GET /api/action?key=<KEY>&action=kick&iph=<IP哈希>&by=bot',
  '   GET /api/action?key=<KEY>&action=unban&iph=<IP哈希>&by=bot',
  '',
  '③ 数据 / 运维',
  '   GET /admin/data?key=<KEY>    # 统计 + 举报记录 + 封禁列表',
  '   （管理页与所有 /admin/* 也支持请求头 x-admin-key: <KEY>，更安全）',
  '   GET /admin/reset?key=<KEY>   # 清场（踢掉所有在线连接）',
].join(String.fromCharCode(10));
document.getElementById('bigimg').addEventListener('click', function(){ this.classList.remove('on'); document.getElementById('bigimgi').src = ''; });
document.getElementById('list').addEventListener('click', function(ev){
  var im = ev.target.closest('img.repimg'); if (!im) return;
  document.getElementById('bigimgi').src = im.src;
  document.getElementById('bigimg').classList.add('on');
});
document.getElementById('copyapi').onclick = function(){
  try {
    navigator.clipboard.writeText(document.getElementById('api-help').textContent).then(function(){
      document.getElementById('apimsg').textContent = '已复制';
      setTimeout(function(){ document.getElementById('apimsg').textContent = ''; }, 2500);
    });
  } catch (e) { document.getElementById('apimsg').textContent = '复制失败，手动选中吧'; }
};
document.getElementById('onlynew').addEventListener('change', function(){ OFFSET = 0; load(); });
(function(){
  var qi = document.getElementById('q'), tm = null;
  qi.addEventListener('input', function(){ clearTimeout(tm); tm = setTimeout(function(){ Q = qi.value.trim(); OFFSET = 0; load(); }, 350); });
  qi.addEventListener('keydown', function(e){ if (e.key === 'Enter') { clearTimeout(tm); Q = qi.value.trim(); OFFSET = 0; load(); } });
})();
document.getElementById('rf').onclick = function(){ load(); };
document.getElementById('chkey').onclick = function(){ K = ''; try { localStorage.removeItem('anonchat:adminkey'); } catch (e) {} showLogin('已退出，请重新输入密钥'); };
if (!K) showLogin(''); else load();   // 有 key 也要先用它成功取一次数据，才显示管理界面（校验不过会自动退回登录卡）
document.getElementById('reset').onclick = async function(){ if (confirm('确定踢掉所有连接？')) { var r = await api('reset'); say('已清场，踢掉 ' + r.kicked + ' 人'); load(); } };
document.getElementById('clr').onclick = async function(){ if (confirm('确定清空所有举报记录？')) { var r = await api('clearreports'); say('已清空 ' + r.deleted + ' 条'); load(); } };
</div><!-- /#panel -->
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
  #next,#toGroup{margin-left:auto;padding:7px 10px;min-height:34px;font-size:12.5px;flex:none;white-space:nowrap}
  #next{margin-left:6px}
  @media (max-width:430px){ #stat{display:none} }   /* 小屏别让状态文字把按钮挤掉 */
  #log{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px;display:flex;flex-direction:column;gap:8px}
  .m{max-width:80%;padding:9px 13px;border-radius:16px;white-space:pre-wrap;word-break:break-word;font-size:15px}
  .me{align-self:flex-end;background:#2b5cff;color:#fff;border-bottom-right-radius:5px}
  .you{align-self:flex-start;background:#1b2030;border-bottom-left-radius:5px}
  .who{display:block;font-size:11.5px;color:#7f8aa3;margin-bottom:2px;padding-right:58px}
  .sys{align-self:center;font-size:12.5px;color:#6b7385;background:none;text-align:center;max-width:92%}
  .m{position:relative}
  .m img{display:block;max-width:100%;max-height:46vh;width:auto;border-radius:10px;cursor:zoom-in;object-fit:contain}
  .m{padding-top:12px}
  .rbtn{position:absolute;top:3px;right:3px;display:block;height:19px;min-height:19px;padding:0 7px;line-height:17px;
        border-radius:10px;border:1px solid rgba(255,255,255,.3);background:rgba(0,0,0,.32);color:#e8eaed;
        font-size:11px;cursor:pointer;opacity:.9}
  .m:hover .rbtn{opacity:1;border-color:#2b5cff;background:#2b5cff;color:#fff}
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
  #pad{position:fixed;inset:0;background:#0b0d12;z-index:26;display:none;flex-direction:column}
  #pad.on{display:flex}
  #pad .pbar{display:flex;gap:6px;align-items:center;padding:8px;border-bottom:1px solid #1d2230;flex-wrap:wrap}
  #pad .pbar button{min-height:38px;padding:7px 11px;font-size:13px}
  #pad .pbar button.on{background:#2b5cff;border-color:#2b5cff;color:#fff}
  #pad .pwrap{flex:1;display:flex;align-items:center;justify-content:center;padding:10px}
  #pcv{width:100%;aspect-ratio:4/3;max-height:100%;background:#fff;touch-action:none;display:block;
       border-radius:12px;box-shadow:0 6px 20px #0006}
  .sw{width:30px;height:30px;border-radius:50%;border:2px solid #555;display:inline-block;cursor:pointer;vertical-align:middle}
  .sw.on{border-color:#2b5cff;box-shadow:0 0 0 2px #2b5cff55}
  #emoji{position:fixed;display:none;z-index:25;background:#161b26;border:1px solid #232a3a;border-radius:14px;
         padding:6px;gap:2px;box-shadow:0 8px 24px #0009}
  #emoji.on{display:flex}
  #emoji button{background:none;border:none;padding:6px 7px;min-height:38px;font-size:22px;line-height:1;border-radius:9px;cursor:pointer}
  #emoji button:hover{background:#232a3a}
  .rsum{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}
  .rchip{display:inline-flex;align-items:center;gap:3px;font-size:12.5px;background:#232a3a;color:#c3c9d6;
         border-radius:9px;padding:2px 7px;line-height:1.5}
  #login{position:fixed;inset:0;background:#0b0d12;display:none;align-items:center;justify-content:center;z-index:40;padding:18px}
  #login.on{display:flex}
  #login .lbox{width:100%;max-width:380px;background:#0f1219;border:1px solid #1d2230;border-radius:16px;padding:20px}
  button.p{background:#2b5cff;border-color:#2b5cff;color:#fff}
  .rbtn2{position:absolute;top:3px;right:58px;display:block;height:19px;min-height:19px;padding:0 7px;line-height:17px;
         border-radius:10px;border:1px solid rgba(255,255,255,.3);background:rgba(0,0,0,.32);color:#e8eaed;
         font-size:11px;cursor:pointer;opacity:.9}
  .m:hover .rbtn2{opacity:1;border-color:#2b5cff;background:#2b5cff;color:#fff}
</style>
</head>
<body>
<header>
  <b id="brand">匿名聊天</b><span id="stat">连接中…</span>
  <button id="lang" title="switch language" style="margin-left:auto;padding:7px 10px;min-height:34px;font-size:12.5px">EN</button>
  <button id="toGroup" style="display:none">群聊 ▸</button>
  <button id="next" disabled>换一个 ▸</button>
</header>
<div id="log"></div>
<footer>
  <input id="in" placeholder="说点什么…" disabled autocomplete="off" enterkeyhint="send">
  <input type="file" id="file" accept="image/*" style="display:none">
  <button id="draw" disabled title="涂鸦" style="padding:11px 12px"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg></button>
  <button id="pic" disabled title="发图片" style="padding:11px 12px"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="9" r="1.5" fill="currentColor" stroke="none"/><path d="M21 15l-5-5L5 21"/></svg></button>
  <button id="send" class="p" disabled>发送</button>
</footer>

<div id="lb"><img id="lbi" alt=""></div>
<div id="emoji"></div>
<div id="pad">
  <div class="pbar">
    <span id="pcolors"></span>
    <button id="pthin" class="on">细</button>
    <button id="pfat">粗</button>
    <button id="pundo">撤销</button>
    <button id="pclear">清空</button>
    <button id="pcancel">取消</button>
    <button id="psend" class="p">发送</button>
  </div>
  <div class="pwrap"><canvas id="pcv"></canvas></div>
</div>

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

// ---------- 中英双语 ----------
const STR = {
  zh: {
    brand: '匿名聊天', next: '换一个 ▸', langBtn: 'EN',
    in: '说点什么…', send: '发送', pic: '发图片', rep: '举报',
    st_connecting: '连接中…', st_queue: '排队中', st_chat: '聊天中', st_group: '群聊中',
    st_off: '离线', st_reconnect: '重连中…', st_joining: '凑人中…', st_hall: '群聊中 · {n} 人',
    gate_h: '18+ · 匿名 · 不留痕',
    gate_p: '随机配到陌生人聊天，文字和图片都行。平时什么都不存；只有出现举报时，才会把该会话最近记录和双方 IP 哈希保存 7 天。',
    gate_ok: '我已满 18 岁，并理解这是一个无人实时审核的空间，可能遇到令人不适的内容。',
    gate_go: '进入', gate_tip: '请守规矩。违法内容会导致整个服务被关停。',
    m_one: '一对一', m_one_s: '私聊一个人', m_group: '群聊', m_group_s: '所有人一个群',
    to_group: '去群聊 ▸',
    searching: '正在寻找陌生人…', entering: '正在进入大厅…', matched: '已配对 —— 打个招呼吧',
    room_join: '已进入大厅，当前 {n} 人（你是陌生人 {t}）',
    loading_hist: '正在加载最近的聊天记录…', hist_head: '—— 以下是最近 3 天的聊天记录 ——', hist_tail: '—— 以上是之前的聊天 ——',
    sys_join: '陌生人 {n} 加入了', sys_part: '陌生人 {n} 离开了', img_ph: '陌生人 {n}：[图片]',
    left: '对方离开了，点右上角「换一个」', reported: '已举报，已提交管理员审核', to_one: '切成一对一 ▸',
    disc: '连接断开，{s} 秒后自动重连…（已重连 {c} 次）', offline: '连接已断开',
    err_notconn: '未连接', err_net: '网络异常', err_fast: '发太快了，慢一点', err_link: '这里不允许发链接',
    err_imgfast: '图片发太快了', err_imgbig: '图片太大', err_badimg: '图片格式不支持', err_onlyimg: '只能发图片',
    err_process: '图片处理失败', err_toobig: '图片太大，换一张小点的', who: '陌生人 {n}',
    rep_q: '举报这条消息？管理员会看到这条内容和上下文。',
    rep_ask: '要举报某一条具体消息：手机长按那条消息、电脑把鼠标移到消息上点右上角 ⚑。先点「取消」，然后长按/悬停选具体那条。',
    rep_title: '举报这条消息', rep_btn: '⚑ 举报', removed: '管理员移除了一条消息',
    react_title: '发个表情', ebtn: '☺', draw: '涂鸦', p_send: '发送', p_cancel: '取消',
    p_undo: '撤销', p_clear: '清空', p_thin: '细', p_fat: '粗', err_drawbig: '画得太满，发送失败，清一下重画',
  },
  en: {
    brand: 'anon chat', next: 'next ▸', langBtn: '中文',
    in: 'say something…', send: 'send', pic: 'send image', rep: 'report',
    st_connecting: 'connecting…', st_queue: 'waiting', st_chat: 'in chat', st_group: 'in lobby',
    st_off: 'offline', st_reconnect: 'reconnecting…', st_joining: 'joining…', st_hall: 'lobby · {n} online',
    gate_h: '18+ · anonymous · no logs',
    gate_p: 'You will be paired with a random stranger, text and images. Nothing is stored by default; only when someone reports, the last messages and both IP hashes are kept for 7 days.',
    gate_ok: 'I am 18 or older and understand this is an unmoderated space where I may see unpleasant content.',
    gate_go: 'enter', gate_tip: 'Be decent. Anything illegal gets the whole service shut down.',
    m_one: '1-on-1', m_one_s: 'chat with one person', m_group: 'lobby', m_group_s: 'everyone together',
    to_group: 'lobby ▸',
    searching: 'looking for a stranger…', entering: 'entering the lobby…', matched: 'matched — say hi',
    room_join: 'joined the lobby, {n} online (you are stranger {t})',
    loading_hist: 'loading recent messages…', hist_head: '—— recent messages (last 3 days) ——', hist_tail: '—— end of history ——',
    sys_join: 'stranger {n} joined', sys_part: 'stranger {n} left', img_ph: 'stranger {n}: [image]',
    left: 'stranger left — tap "next" in the corner', reported: 'reported — sent to the moderator', to_one: 'switch to 1-on-1 ▸',
    disc: 'disconnected, reconnecting in {s}s… (attempt {c})', offline: 'disconnected',
    err_notconn: 'not connected', err_net: 'network error', err_fast: 'slow down', err_link: 'links are not allowed here',
    err_imgfast: 'sending images too fast', err_imgbig: 'image too large', err_badimg: 'unsupported image format', err_onlyimg: 'images only',
    err_process: 'image processing failed', err_toobig: 'image too large, pick a smaller one', who: 'stranger {n}',
    rep_q: 'Report this message? The moderator will see it with its context.',
    rep_ask: 'To report one specific message: long-press it on mobile, or hover and click the ⚑ in the corner on desktop. Press Cancel, then pick that message.',
    rep_title: 'report this message', rep_btn: '⚑ report', removed: 'a message was removed by the moderator',
    react_title: 'react', ebtn: '☺', draw: 'draw', p_send: 'send', p_cancel: 'cancel',
    p_undo: 'undo', p_clear: 'clear', p_thin: 'thin', p_fat: 'thick', err_drawbig: 'drawing too heavy to send, clear some',
  },
};
let LANG = (function () {
  try { const s = localStorage.getItem('anonchat:lang'); if (s === 'zh' || s === 'en') return s; } catch (e) {}
  return String(navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
})();
function T(k, vars) {
  let s = (STR[LANG] && STR[LANG][k] !== undefined) ? STR[LANG][k] : k;
  if (vars) for (const p in vars) s = s.split('{' + p + '}').join(vars[p]);
  return s;
}
function applyLang() {
  document.documentElement.lang = (LANG === 'zh' ? 'zh-CN' : 'en');
  document.title = T('brand');
  $('#brand').textContent = T('brand');
  $('#lang').textContent = T('langBtn');
  $('#next').textContent = T('next');
  $('#toGroup').textContent = T('to_group');
  input.placeholder = T('in');
  $('#send').textContent = T('send');
  $('#pic').title = T('pic');
  $('#draw').title = T('draw');
  $('#m-one').innerHTML = T('m_one') + '<small>' + T('m_one_s') + '</small>';
  $('#m-group').innerHTML = T('m_group') + '<small>' + T('m_group_s') + '</small>';
  $('#gate').querySelector('h1').textContent = T('gate_h');
  $('#gate').querySelector('p').innerHTML = T('gate_p');
  $('#gate').querySelector('label span').innerHTML = T('gate_ok');
  $('#go').textContent = T('gate_go');
  $('#gate').querySelector('.tip').textContent = T('gate_tip');
  if (!inChat) stat.textContent = T('st_connecting');
}
function setLang(l) { LANG = l; try { localStorage.setItem('anonchat:lang', l); } catch (e) {} applyLang(); }

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

$('#lang').addEventListener('click', () => setLang(LANG === 'zh' ? 'en' : 'zh'));
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
  if (!id) id = 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  el.dataset.id = id;
  const rb = document.createElement('button');
  rb.type = 'button'; rb.className = 'rbtn2'; rb.title = T('react_title'); rb.textContent = T('ebtn');
  rb.addEventListener('click', ev => { ev.stopPropagation(); ev.preventDefault(); openEmoji(id, el); });
  el.appendChild(rb);
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'rbtn'; b.title = T('rep_title'); b.textContent = T('rep_btn');
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
const EMOJIS = ['👍','😂','❤️','😮','😢','👎'];
let emojiTarget = null;
function openEmoji(id, el){
  if (!inChat) return;
  emojiTarget = id;
  const box = $('#emoji');
  box.innerHTML = '';
  EMOJIS.forEach(e => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = e;
    b.addEventListener('click', ev => { ev.stopPropagation(); box.classList.remove('on'); send({t:'react', id, e}); addReact(el, e, 1); });
    box.appendChild(b);
  });
  box.classList.add('on');
  const r = el.getBoundingClientRect();
  const w = box.offsetWidth || 300;
  let left = Math.min(Math.max(6, r.left), window.innerWidth - w - 6);
  let top = r.bottom + 6;
  if (top + 60 > window.innerHeight) top = Math.max(6, r.top - 54);
  box.style.left = left + 'px'; box.style.top = top + 'px';
}
document.addEventListener('click', ev => { if (!ev.target.closest('#emoji')) $('#emoji').classList.remove('on'); });
document.addEventListener('scroll', () => $('#emoji').classList.remove('on'), true);

// 在消息上显示/累加一个表情计数
function addReact(el, e, n){
  if (!el) return;
  let box = el.querySelector('.rsum');
  if (!box) { box = document.createElement('div'); box.className = 'rsum'; el.appendChild(box); }
  const chip = [...box.querySelectorAll('.rchip')].find(c => c.dataset.e === e);
  if (chip) { chip.dataset.n = String(Number(chip.dataset.n || 1) + n); chip.querySelector('b').textContent = chip.dataset.n; return; }
  const c2 = document.createElement('span');
  c2.className = 'rchip'; c2.dataset.e = e; c2.dataset.n = '1';
  c2.appendChild(document.createTextNode(e + ' '));
  const bb = document.createElement('b'); bb.textContent = '1'; c2.appendChild(bb);
  box.appendChild(c2);
}

function askReport(id){
  if (!inChat) return;
  if (confirm(T('rep_q'))) send({ t: 'report', id });
}
function msg(t, me, from, id){ const d = el(me?'me':'you'); if (from) { const w=document.createElement('span'); w.className='who'; w.textContent=T('who',{n:from}); d.appendChild(w); } d.appendChild(document.createTextNode(t)); attachReport(d, id); return d; }
function img(src, me, from, id){ const d = el(me?'me':'you',''); if (from) { const w=document.createElement('span'); w.className='who'; w.textContent=T('who',{n:from}); d.appendChild(w); }
  const i = new Image(); i.src = src;
  i.addEventListener('click', () => { $('#lbi').src = src; $('#lb').classList.add('on'); }); d.appendChild(i); attachReport(d, id); return d; }
$('#lb').addEventListener('click', () => { $('#lb').classList.remove('on'); $('#lbi').src=''; });

function setState(key, vars){
  stat.textContent = T(key, vars);
  const on = key === 'st_chat' || key === 'st_group';
  input.disabled = !on; $('#send').disabled = !on; $('#pic').disabled = !on; $('#draw').disabled = !on;
  $('#next').disabled = !joined;
  // 群聊里没有「换一个」的意义，改成「切成一对一」，免得住进来就出不去
  $('#next').textContent = (mode === 'group') ? T('to_one') : T('next');
  // 一对一时给一条去群聊的路（群聊里则由 #next 变成「切成一对一」，两个方向都通）
  $('#toGroup').style.display = (mode === 'group') ? 'none' : '';
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
    setState(mode === 'group' ? 'st_joining' : 'st_queue');
    sys(mode === 'group' ? T('entering') : T('searching'));
    startHeartbeat();
  };
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'waiting') { sys(mode === 'group' ? T('entering') : T('searching')); setState(mode === 'group' ? 'st_joining' : 'st_queue'); }
    else if (m.t === 'matched') { sys(T('matched')); setState('st_chat'); }
    else if (m.t === 'room') {
      myTag = m.tag || 0; groupSize = m.n || 0;
      sys(T('room_join', { n: groupSize, t: myTag }));
      loadTipEl = el('sys', T('loading_hist'));
      setState('st_group');
    }
    else if (m.t === 'roominfo') { groupSize = m.n || groupSize; stat.textContent = T('st_hall', { n: groupSize }); }
    else if (m.t === 'msg') { msg(m.v, false, m.from, m.id); }
    else if (m.t === 'img') { img(m.v, false, m.from, m.id); }
    else if (m.t === 'history') {
      if (loadTipEl) { try { loadTipEl.remove(); } catch (e) {} loadTipEl = null; }
      if (m.items && m.items.length) {
        sys(T('hist_head'));
        m.items.forEach(it => {
          if (it.k === 'text') msg(it.v, false, it.from, it.id);
          else if (it.k === 'img') img(it.v, false, it.from, it.id);
          else sys(T('img_ph', { n: it.from }));
        });
        sys(T('hist_tail'));
      }
    }
    else if (m.t === 'left') { sys(T('left')); setState(mode === 'group' ? 'st_joining' : 'st_queue'); }
    else if (m.t === 'reported') { sys(T('reported')); }
    else if (m.t === 'react') {
      const el2 = log.querySelector('[data-id="' + String(m.id || '').replace(/"/g, '') + '"]');
      if (el2) addReact(el2, m.e, 1);
    }
    else if (m.t === 'del') {
      // 管理员清除了这些消息 → 从界面上也拿掉
      let n = 0;
      (m.ids || []).forEach(function(id){
        const el2 = log.querySelector('[data-id="' + String(id).replace(/"/g, '') + '"]');
        if (el2) { el2.remove(); n++; }
      });
      if (n) sys(T('removed'));
    }
    else if (m.t === 'err') { sys(m.k ? T('err_' + m.k) : (m.v || '')); }
    else if (m.t === 'sys') { sys(m.k ? T('sys_' + m.k, { n: m.n }) : (m.v || '')); }
    else if (m.t === 'pong') {}
  };
  ws.onclose = () => {
    joined = false;
    if (!autoReconnect) { setState('st_off'); return; }
    reconnectTry++;
    const wait = Math.min(8000, 800 * Math.pow(1.7, Math.min(reconnectTry, 6)));
    setState('st_reconnect');
    sys(T('disc', { s: Math.round(wait / 1000), c: reconnectTry }));
    reconnectTimer = setTimeout(connect, wait);
  };
  ws.onerror = () => {};
}
function send(o){ if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); else sys(T('err_notconn')); }

function newId(){ return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function sendText(){
  const v = input.value.trim(); if (!v) return;
  const id = newId();
  input.value = ''; msg(v, true, 0, id); send({t:'msg', v, id});
}
$('#send').addEventListener('click', sendText);
input.addEventListener('keydown', e => { if (e.key === 'Enter') sendText(); });
$('#toGroup').addEventListener('click', () => {
  mode = 'group'; remember('mode', 'group');
  $('#m-group').classList.add('on'); $('#m-one').classList.remove('on');
  log.innerHTML = ''; loadTipEl = null;
  sys(T('entering'));
  send({t: 'join', mode: 'group'});            // 直接声明目标模式，服务端会先解掉旧的配对
  setState('st_joining');
});
$('#next').addEventListener('click', () => {
  // 群聊里这个按钮 = 换成一对一（否则进来就出不去了）
  if (mode === 'group') {
    mode = 'one'; remember('mode', 'one');
    $('#m-one').classList.add('on'); $('#m-group').classList.remove('on');
  }
  log.innerHTML = ''; loadTipEl = null;
  sys(mode === 'group' ? T('entering') : T('searching'));
  send(mode === 'group' ? {t: 'join', mode: 'group'} : {t: 'skip'});
  setState(mode === 'group' ? 'st_joining' : 'st_queue');
});
$('#pic').addEventListener('click', () => $('#file').click());

// 选图 → 压缩到 ≤1280px / JPEG → 直传
$('#file').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (!f.type.startsWith('image/')) { sys(T('err_onlyimg')); return; }
  try {
    const d = await compress(f);
    if (d.length > 320000) { sys(T('err_toobig')); return; }
    const id = newId();
    img(d, true, 0, id); send({t:'img', v:d, id});
  } catch { sys(T('err_process')); }
});

// ---------- 涂鸦 ----------
const PCOLORS = ['#111111', '#e5484d', '#2b5cff', '#12a150', '#f5a524'];
let pcolor = PCOLORS[0], pfat = false, pHist = [], pDrawing = false;
function padInit(){
  const cv = document.getElementById('pcv'), g = cv.getContext('2d');
  cv.style.width = '100%';   // 尺寸交给 CSS（4:3），这里只按渲染结果建位图
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#fff'; g.fillRect(0, 0, r.width, r.height);
  g.lineCap = 'round'; g.lineJoin = 'round';
  pHist = []; pDrawing = false;
  // 颜色
  const cbox = document.getElementById('pcolors'); cbox.innerHTML = '';
  PCOLORS.forEach((c, i) => {
    const s = document.createElement('span');
    s.className = 'sw' + (i === 0 ? ' on' : ''); s.style.background = c;
    s.addEventListener('click', () => { pcolor = c; [...cbox.children].forEach(x => x.classList.remove('on')); s.classList.add('on'); });
    cbox.appendChild(s);
  });
  document.getElementById('pthin').classList.add('on'); document.getElementById('pfat').classList.remove('on');
  document.getElementById('pthin').textContent = T('p_thin'); document.getElementById('pfat').textContent = T('p_fat');
  document.getElementById('pundo').textContent = T('p_undo'); document.getElementById('pclear').textContent = T('p_clear');
  document.getElementById('pcancel').textContent = T('p_cancel'); document.getElementById('psend').textContent = T('p_send');
}
function pPos(cv, ev){
  const r = cv.getBoundingClientRect();
  const p = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
  return { x: p.clientX - r.left, y: p.clientY - r.top };
}
(function bindPad(){
  const cv = document.getElementById('pcv'), g = cv.getContext('2d');
  const down = ev => {
    ev.preventDefault();
    try { pHist.push(cv.toDataURL('image/jpeg', 0.6)); if (pHist.length > 12) pHist.shift(); } catch (e) {}
    pDrawing = true;
    const { x, y } = pPos(cv, ev);
    g.beginPath(); g.moveTo(x, y); g.strokeStyle = pcolor; g.lineWidth = pfat ? 7 : 3;
    g.lineTo(x + 0.1, y + 0.1); g.stroke();
  };
  const move = ev => { if (!pDrawing) return; ev.preventDefault(); const { x, y } = pPos(cv, ev); g.lineTo(x, y); g.stroke(); };
  const up = () => { pDrawing = false; };
  cv.addEventListener('mousedown', down); cv.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  cv.addEventListener('touchstart', down, { passive: false });
  cv.addEventListener('touchmove', move, { passive: false });
  cv.addEventListener('touchend', up); cv.addEventListener('touchcancel', up);
})();
$('#draw').addEventListener('click', () => { document.getElementById('pad').classList.add('on'); padInit(); });
$('#pthin').addEventListener('click', () => { pfat = false; $('#pthin').classList.add('on'); $('#pfat').classList.remove('on'); });
$('#pfat').addEventListener('click', () => { pfat = true; $('#pfat').classList.add('on'); $('#pthin').classList.remove('on'); });
$('#pclear').addEventListener('click', () => {
  const cv = document.getElementById('pcv'), g = cv.getContext('2d'), r = cv.getBoundingClientRect();
  try { pHist.push(cv.toDataURL('image/jpeg', 0.6)); } catch (e) {}
  g.fillStyle = '#fff'; g.fillRect(0, 0, r.width, r.height);
});
$('#pundo').addEventListener('click', () => {
  const cv = document.getElementById('pcv'), g = cv.getContext('2d');
  const last = pHist.pop(); if (!last) return;
  const i = new Image();
  i.onload = () => { const r = cv.getBoundingClientRect(); g.clearRect(0, 0, r.width, r.height); g.drawImage(i, 0, 0, r.width, r.height); };
  i.src = last;
});
$('#pcancel').addEventListener('click', () => document.getElementById('pad').classList.remove('on'));
$('#psend').addEventListener('click', () => {
  const cv = document.getElementById('pcv');
  // 缩到宽 ≤720 再编码，保证体积可控
  const w0 = cv.width, h0 = cv.height, scale = Math.min(1, 720 / w0);
  const c2 = document.createElement('canvas'); c2.width = Math.round(w0 * scale); c2.height = Math.round(h0 * scale);
  const g2 = c2.getContext('2d'); g2.fillStyle = '#fff'; g2.fillRect(0, 0, c2.width, c2.height); g2.drawImage(cv, 0, 0, c2.width, c2.height);
  const d = c2.toDataURL('image/jpeg', 0.85);
  if (d.length > 320000) { sys(T('err_drawbig')); return; }
  document.getElementById('pad').classList.remove('on');
  const id = newId(); img(d, true, 0, id); send({t:'img', v:d, id});
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
      return env.LOBBY.get(env.LOBBY.idFromName(DO_NAME)).fetch(req);
    }
    // key 优先从请求头取（不再默认走 URL，避免进浏览器历史和日志）；URL 参数仅为兼容旧链接/机器人
    const adminKey = req.headers.get('x-admin-key') || url.searchParams.get('key') || '';
    const isAdmin = !!env.ADMIN_KEY && adminKey === env.ADMIN_KEY;
    const adminHeaders = { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store, no-cache, must-revalidate, max-age=0' };
    if (url.pathname === '/admin') {
      return new Response(ADMIN_PAGE, { headers: adminHeaders });   // 未登录也能拿到页面，页面自己弹输入框
    }
    // ---- 给外部机器人用的审核 API（同一个 ADMIN_KEY）----
    if (url.pathname === '/api/pending') {
      if (!isAdmin) return new Response(JSON.stringify({ ok: false, error: 'bad key' }),
        { status: 403, headers: { 'content-type': 'application/json;charset=utf-8' } });
      const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const onlyNew = url.searchParams.get('status') !== 'all';
      const d = await env.LOBBY.get(env.LOBBY.idFromName(DO_NAME)).fetch(new Request('https://do/stats'));
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
      const stub = env.LOBBY.get(env.LOBBY.idFromName(DO_NAME));
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
      const rr = await env.LOBBY.get(env.LOBBY.idFromName(DO_NAME))
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
    if (url.pathname === '/admin/image') {
      if (!isAdmin) return new Response('forbidden', { status: 403 });
      return env.LOBBY.get(env.LOBBY.idFromName(DO_NAME))
        .fetch(new Request('https://do/reportimage?k=' + encodeURIComponent(url.searchParams.get('k') || '')));
    }
    if (url.pathname === '/admin/kick' || url.pathname === '/admin/handled' || url.pathname === '/admin/clearmessages') {
      if (!isAdmin) return new Response('forbidden', { status: 403 });
      const what = url.pathname.split('/').pop();
      const ep = what === 'kick'
        ? '/kick?iph=' + encodeURIComponent(url.searchParams.get('iph') || '')
        : '/' + what + '?k=' + encodeURIComponent(url.searchParams.get('k') || '');
      return env.LOBBY.get(env.LOBBY.idFromName(DO_NAME)).fetch(new Request('https://do' + ep));
    }
    if (url.pathname === '/admin/ban' || url.pathname === '/admin/unban') {
      if (!isAdmin) return new Response('forbidden', { status: 403 });
      const iph = url.searchParams.get('iph') || '';
      const hours = url.searchParams.get('h') || '168';
      const ep = url.pathname === '/admin/ban'
        ? '/ban?iph=' + encodeURIComponent(iph) + '&h=' + encodeURIComponent(hours)
        : '/unban?iph=' + encodeURIComponent(iph);
      return env.LOBBY.get(env.LOBBY.idFromName(DO_NAME)).fetch(new Request('https://do' + ep));
    }
    if (url.pathname === '/admin/data' || url.pathname === '/admin/clearreports') {
      if (!isAdmin) return new Response('forbidden', { status: 403 });
      const ep = url.pathname === '/admin/data' ? '/stats' : '/clearreports';
      const qs = url.pathname === '/admin/data'
        ? '?offset=' + encodeURIComponent(url.searchParams.get('offset') || '0')
          + '&limit=' + encodeURIComponent(url.searchParams.get('limit') || '20')
          + '&q=' + encodeURIComponent(url.searchParams.get('q') || '')
        : '';
      return env.LOBBY.get(env.LOBBY.idFromName(DO_NAME)).fetch(new Request('https://do' + ep + qs));
    }
    if (url.pathname === '/admin/olddata') {
      if (!isAdmin) return new Response('forbidden', { status: 403 });
      const nm = url.searchParams.get('do') || 'global';
      return env.LOBBY.get(env.LOBBY.idFromName(nm)).fetch(new Request('https://do/stats?limit=100'));
    }
    if (url.pathname === '/admin/importold') {
      // 一次性：把旧 DO 名字下的聊天历史 / 举报 / 封禁并进当前实例（幂等，同名 key 覆盖）
      if (!isAdmin) return new Response('forbidden', { status: 403 });
      const from = url.searchParams.get('do') || 'global';
      const stub = env.LOBBY.get(env.LOBBY.idFromName(from));
      const res = {};
      for (const prefix of ['m:', 'report:', 'ban:']) {
        const r = await stub.fetch(new Request('https://do/dump?prefix=' + encodeURIComponent(prefix)));
        if (!r.ok) { res[prefix] = 'src ' + r.status; continue; }
        const js = await r.json();
        const entries = js.entries || [];
        if (entries.length) {
          await env.LOBBY.get(env.LOBBY.idFromName(DO_NAME)).fetch(new Request('https://do/load', {
            method: 'POST', body: JSON.stringify({ entries }),
          }));
        }
        res[prefix] = entries.length;
      }
      return new Response(JSON.stringify({ ok: true, from, imported: res }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/admin/export') {
      if (!isAdmin) return new Response('forbidden', { status: 403 });
      const stub = env.LOBBY.get(env.LOBBY.idFromName(url.searchParams.get('do') || DO_NAME));
      const prefix = url.searchParams.get('prefix') || 'report:';
      const after = url.searchParams.get('after') || '';
      return stub.fetch(new Request('https://do/export?prefix=' + encodeURIComponent(prefix) +
        '&after=' + encodeURIComponent(after) + '&limit=' + encodeURIComponent(url.searchParams.get('limit') || '500')));
    }
    if (url.pathname === '/admin/import' && req.method === 'POST') {
      if (!isAdmin) return new Response('forbidden', { status: 403 });
      const stub = env.LOBBY.get(env.LOBBY.idFromName(DO_NAME));
      const body = await req.text();
      return stub.fetch(new Request('https://do/import', { method: 'POST', body }));
    }
    if (url.pathname === '/admin/reset') {
      const key = url.searchParams.get('key') || '';
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return new Response('forbidden', { status: 403 });
      return env.LOBBY.get(env.LOBBY.idFromName(DO_NAME))
        .fetch(new Request('https://do/reset', { headers: { 'x-admin': '1' } }));
    }
    if (url.pathname === '/admin/reports') {
      // 旧链接：过去返回裸 JSON，容易让人以为页面坏了 → 直接跳到管理页
      if (!isAdmin) return new Response('forbidden', { status: 403 });
      return Response.redirect('https://' + url.host + '/admin?key=' + encodeURIComponent(adminKey), 302);
    }
    return new Response(PAGE, { headers: {
      'content-type': 'text/html;charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      'pragma': 'no-cache', 'expires': '0',
    } });
  },
};

export class Lobby3 {
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
      const rec = await this.dbGet(key);
      if (!rec) return new Response(JSON.stringify({ ok: false, error: 'gone' }),
        { status: 404, headers: { 'content-type': 'application/json' } });
      // 要删的消息 id：被举报那条 + 记录里的上下文
      const ids = [];
      if (rec.reported_msg_id) ids.push(rec.reported_msg_id);
      if (rec.reported_msg && rec.reported_msg.id) ids.push(rec.reported_msg.id);
      for (const m of (rec.msgs || [])) { if (m && m.id) ids.push(m.id); }
      const uniq = [...new Set(ids)];
      // ① 清举报快照
      rec.msgs = []; rec.reported_msg = null;
      rec.content_cleared = true; rec.cleared_at = new Date().toISOString();
      await this.dbPut(key, rec);
      // ② 从聊天历史库里删掉这些消息（按 id 匹配）
      let histDeleted = 0;
      if (uniq.length) {
        try {
          const list = await this.dbList({ prefix: 'm:', limit: 1000 });
          for (const [hk, v] of list) {
            if (v && uniq.indexOf(v.id) >= 0) { await this.dbDel(hk); histDeleted++; }
          }
        } catch {}
      }
      // ③ 通知所有在线的人（大厅 + 一对一）把这几条从界面上移除
      let notified = 0;
      if (uniq.length) {
        for (const c of this.pairs.values()) { this.send(c, { t: 'del', ids: uniq }); notified++; }
      }
      return new Response(JSON.stringify({ ok: true, ids: uniq.length, history_deleted: histDeleted, notified }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/handled') {
      const key = url.searchParams.get('k') || '';
      const rec = await this.dbGet(key);
      if (!rec) return new Response(JSON.stringify({ ok: false, error: 'gone' }),
        { status: 404, headers: { 'content-type': 'application/json' } });
      rec.handled = true; rec.handled_at = new Date().toISOString();
      await this.dbPut(key, rec);
      return new Response(JSON.stringify({ ok: true }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/ban') {
      const iph = url.searchParams.get('iph') || '';
      const hours = Math.max(1, Math.min(8760, parseInt(url.searchParams.get('h') || url.searchParams.get('hours') || '168', 10) || 168));
      if (!/^[0-9a-f]{64}$/.test(iph)) return new Response(JSON.stringify({ ok: false, error: 'bad iph' }),
        { status: 400, headers: { 'content-type': 'application/json' } });
      const rec = { iph, at: new Date().toISOString(), until: Date.now() + hours * 3600000, hours };
      await this.dbPut('ban:' + iph, rec);
      let kicked = 0;
      for (const c of [...this.pairs.values()]) {
        if (c.iph === iph) { try { c.ws.close(1001, 'banned'); } catch {} kicked++; }
      }
      return new Response(JSON.stringify({ ok: true, kicked, ...rec }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/unban') {
      const iph = url.searchParams.get('iph') || '';
      await this.dbDel('ban:' + iph);
      return new Response(JSON.stringify({ ok: true, iph }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/markreviewed') {
      const key = url.searchParams.get('k') || '';
      const rec = await this.dbGet(key);
      if (!rec) return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
      rec.reviewed_by = (url.searchParams.get('by') || '').slice(0, 40);
      rec.reviewed_action = (url.searchParams.get('action') || '').slice(0, 20);
      rec.reviewed_at = new Date().toISOString();
      if (rec.reviewed_action === 'ignore') rec.handled = true;
      await this.dbPut(key, rec);
      return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/reportimage') {
      const key = url.searchParams.get('k') || '';
      const rec = await this.dbGet(key);
      const v = (rec && rec.reported_msg && typeof rec.reported_msg.v === 'string') ? rec.reported_msg.v : '';
      const mm = v.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
      if (!mm) return new Response('no image', { status: 404 });
      const bin = Uint8Array.from(atob(mm[2]), c => c.charCodeAt(0));
      return new Response(bin, { headers: { 'content-type': mm[1], 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/getreport') {
      const key = url.searchParams.get('k') || '';
      const rec = await this.dbGet(key);
      if (!rec) return new Response(JSON.stringify({ ok: false }), { status: 404, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true, key, ...rec }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/dump') {
      const prefix = url.searchParams.get('prefix') || 'm:';
      const list = await this.dbList({ prefix, limit: 1000 });
      const entries = [...list].map(([k, v]) => ({ k, v }));
      return new Response(JSON.stringify({ ok: true, count: entries.length, entries }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/load' && req.method === 'POST') {
      let body; try { body = await req.json(); } catch { return new Response('{"ok":false}', { status: 400, headers: { 'content-type': 'application/json' } }); }
      const entries = (body && body.entries) || [];
      for (const e of entries) { if (e && e.k) await this.dbPut(e.k, e.v); }
      return new Response(JSON.stringify({ ok: true, loaded: entries.length }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/export') {
      // 全量导出（分批，避免一次拉太多）：prefix=m:|report:|ban:，offset 从 0 开始
      const prefix = url.searchParams.get('prefix') || 'report:';
      const after = url.searchParams.get('after') || '';
      const lim = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '500', 10) || 500));
      const list = await this.dbList({ prefix, limit: lim, ...(after ? { startAfter: after } : {}) });
      const entries = [...list].map(([k, v]) => ({ k, v }));
      const last = entries.length ? entries[entries.length - 1].k : null;
      return new Response(JSON.stringify({ ok: true, prefix, count: entries.length, entries, next: (entries.length === lim ? last : null) }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/import' && req.method === 'POST') {
      let body; try { body = await req.json(); } catch { return new Response('{"ok":false,"error":"bad json"}', { status: 400, headers: { 'content-type': 'application/json' } }); }
      const entries = (body && body.entries) || [];
      let n = 0;
      for (const e of entries) { if (e && typeof e.k === 'string') { await this.dbPut(e.k, e.v); n++; } }
      return new Response(JSON.stringify({ ok: true, imported: n }),
        { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/stats') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const off = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const lim = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '20', 10) || 20));
      const hall = this.hall ? [...this.hall.members].filter(c => this.alive(c)).length : 0;
      const rep = await this.dbList({ prefix: 'report:', limit: 1000 });
      const arr = [...rep].map(([k, v]) => {
        const o = { key: k, ...v };
        if (o.reported_msg && o.reported_msg.k === 'img' && typeof o.reported_msg.v === 'string' && o.reported_msg.v.length > 300) {
          o.reported_msg = Object.assign({}, o.reported_msg, { v: '', has_img: true });   // 图片按需单独取，列表保持轻量
        }
        return o;
      }).sort((a, b) => (a.at < b.at ? 1 : -1));
      const filtered = q ? arr.filter(r => JSON.stringify(r).toLowerCase().indexOf(q) >= 0) : arr;
      const page = filtered.slice(off, off + lim);
      const bl = await this.dbList({ prefix: 'ban:', limit: 500 });
      const bans = [...bl.values()].filter(b => b && b.until > Date.now()).sort((a, b) => (a.until < b.until ? 1 : -1));
      return new Response(JSON.stringify({
        build: 'b20261009-2225', hall, queue: this.waiting ? 1 : 0, conns: this.pairs.size,
        retention_days: Math.round(HISTORY_TTL_MS / 86400000),
        reports: page, reports_total: filtered.length, reports_all: arr.length, offset: off, limit: lim, q,
        bans,
      }), { headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    if (url.pathname === '/clearreports') {
      const list = await this.dbList({ prefix: 'report:', limit: 1000 });
      for (const k of list.keys()) await this.dbDel(k);
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
    const ban = await this.dbGet('ban:' + iph);
    if (ban && ban.until > Date.now()) {
      try { server.close(1001, 'banned'); } catch {}
      return new Response(JSON.stringify({ error: 'banned', until: ban.until }), {
        status: 403, headers: { 'content-type': 'application/json;charset=utf-8' } });
    }
    const conn = {
      ws: server,
      iph,
      mode: null, peer: null, room: null, tag: 0, lastImg: null,
      msgs: [], nMsg: 0, nImg: 0, winStart: Date.now(), lastSeen: Date.now(),
    };
    this.pairs.set(server, conn);
    server.addEventListener('message', ev => this.onMessage(conn, ev.data));
    server.addEventListener('close', () => this.onClose(conn));
    server.addEventListener('error', () => this.onClose(conn));
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- 数据层：全部走 D1（数据不再绑在这个实例上，换实例名/重启都不丢）----------
  async dbPut(k, v) {
    await this.env.DB.prepare('INSERT INTO kv (k, body, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET body = excluded.body')
      .bind(k, JSON.stringify(v), Date.now()).run();
  }
  async dbGet(k) {
    const r = await this.env.DB.prepare('SELECT body FROM kv WHERE k = ?').bind(k).first();
    return r ? JSON.parse(r.body) : undefined;
  }
  async dbDel(k) { await this.env.DB.prepare('DELETE FROM kv WHERE k = ?').bind(k).run(); }
  async dbList(opts) {
    opts = opts || {};
    const prefix = opts.prefix || '';
    const limit = Math.max(1, Math.min(1000, opts.limit || 1000));
    const desc = !!opts.reverse;
    let sql = 'SELECT k, body FROM kv WHERE k LIKE ?';
    const binds = [prefix.replace(/[%_]/g, m => '\\' + m) + '%'];
    if (opts.end) { sql += ' AND k < ?'; binds.push(opts.end); }        // DO storage 的 end 是「不含」
    if (opts.startAfter) { sql += ' AND k > ?'; binds.push(opts.startAfter); }
    sql += ' ORDER BY k ' + (desc ? 'DESC' : 'ASC') + ' LIMIT ?';
    binds.push(limit);
    const res = await this.env.DB.prepare(sql + ' -- ').bind(...binds).all();
    const m = new Map();
    for (const row of (res.results || [])) m.set(row.k, JSON.parse(row.body));
    return m;
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
    this.hallBroadcast({ t: 'sys', k: 'join', n: conn.tag }, conn);
    this.hallInfo();
    this.scheduleCleanup();
  }

  // 把最近 3 天的记录补给刚进来的人（图片最多重发 2 张，其余显示占位）
  async sendHallHistory(conn) {
    try {
      const cutoff = Date.now() - HISTORY_TTL_MS;
      const list = await this.dbList({ prefix: 'm:', reverse: true, limit: HISTORY_LIMIT });
      const items = []; let imgs = 0;
      const imgCutoff = Date.now() - HISTORY_IMG_TTL_MS;
      for (const [, v] of list) {
        if (!v || !v.at || v.at < cutoff) continue;
        if (v.k === 'img') {
          if (v.at >= imgCutoff && ++imgs <= HISTORY_IMG_MAX) items.push(v);
          else items.push({ from: v.from, k: 'imgph', at: v.at });
        } else items.push(v);
      }
      // 老记录没有 id（加 id 之前存的）→ 这里补上，否则历史消息永远没有举报按钮
      for (const it of items) {
        if (!it.id) it.id = 'h' + (it.at || Date.now());
      }
      items.reverse();
      // 历史也放进这条连接的留证缓冲：这样举报任何一条历史消息，服务器都拿得到内容
      // 文字存全量；图片只存占位（原图留在历史库里，举报时按 id 取回），否则 100 人 × 300KB 会撑爆内存
      for (const it of items) {
        conn.msgs.push({ id: it.id, me: 0, k: it.k, tag: it.from, at: it.at,
          v: it.k === 'img' ? IMG_PLACEHOLDER : it.v });
        if (conn.msgs.length > KEEP_MSGS) conn.msgs.shift();
      }
      if (items.length) this.send(conn, { t: 'history', items });
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
    if (h.members.size > 0) { this.hallBroadcast({ t: 'sys', k: 'part', n: conn.tag }); this.hallInfo(); }
  }

  // 落盘一条聊天记录（key 按时间戳有序，过期由 alarm 清）
  saveHistory(item) {
    const key = 'm:' + String(item.at).padStart(15, '0') + ':' + Math.random().toString(36).slice(2, 6);
    try { this.dbPut(key, item); } catch {}
  }

  // 从聊天历史里按消息 id 找回原图（只在有人举报图片时才调用）
  async findHistoryImg(id) {
    if (!id) return null;
    try {
      const list = await this.dbList({ prefix: 'm:', reverse: true, limit: HISTORY_LIMIT });
      for (const [, v] of list) {
        if (v && v.k === 'img' && v.id === id && typeof v.v === 'string' && v.v.length > 300) return v.v;
      }
    } catch {}
    return null;
  }

  async cleanupHistory() {
    try {
      const cutoff = Date.now() - HISTORY_TTL_MS;
      const old = await this.dbList({ prefix: 'm:', end: 'm:' + String(cutoff).padStart(15, '0') });
      for (const k of old.keys()) await this.dbDel(k);
    } catch {}
  }

  scheduleCleanup() { try { this.state.storage.setAlarm(Date.now() + 6 * 3600 * 1000); } catch {} }   // alarm 仍用 DO 机制（调度，不是数据）
  async alarm() { await this.cleanupHistory(); this.scheduleCleanup(); }



  // ---------- 通用 ----------
  rate(conn, isImg) {
    const now = Date.now();
    if (now - conn.winStart > RATE_WINDOW_MS) { conn.winStart = now; conn.nMsg = 0; conn.nImg = 0; }
    if (isImg) { if (++conn.nImg > RATE_IMG) return false; }
    else if (++conn.nMsg > RATE_MSG) return false;
    return true;
  }

  // 缓冲里最多保留 3 张完整图，更早的降级成占位（省内存，又保证近期举报能看到原图）
  trimImgs(arr) {
    let n = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      const it = arr[i];
      if (it && it.k === 'img' && typeof it.v === 'string' && it.v.length > 300) {
        if (++n > 3) it.v = it.v.slice(0, 200) + '…(图，已省略)';
      }
    }
  }

  deliver(conn, entry, out) {
    // 记入自己的留证缓冲
    conn.msgs.push(entry.k === 'img' ? { id: entry.id, me: 1, k: 'img', tag: conn.tag, v: IMG_PLACEHOLDER, at: entry.at } : entry);
    if (conn.msgs.length > KEEP_MSGS) conn.msgs.shift();
    if (conn.room) {                       // 大厅：落盘记录 + 广播
      this.saveHistory({ id: entry.id, from: conn.tag, k: entry.k, v: out.v, at: entry.at });
      if (entry.k === 'img' && out.v) conn.lastImg = { id: entry.id, v: out.v, at: entry.at };   // 只有自己这一份完整图
      const h = conn.room;
      for (const c of h.members) {
        if (c === conn) continue;
        // 只记占位：完整图不进每个人的内存（人多图多会撑爆 DO 的 128MB 内存）
        // 举报图片时再去历史库按 id 取原图（历史里存的是完整图）
        if (entry.k === 'img') {
          c.msgs.push({ id: entry.id, me: 0, k: 'img', tag: conn.tag, v: IMG_PLACEHOLDER, at: entry.at });
          if (c.msgs.length > KEEP_MSGS) c.msgs.shift();
        }
        this.send(c, Object.assign({ from: conn.tag }, out));
      }
    } else if (conn.peer) {               // 一对一：转发
      const forPeer = Object.assign({}, entry, { me: 0 });
      if (entry.k === 'img') forPeer.v = IMG_PLACEHOLDER;   // 占位，完整图放 lastImg
      conn.peer.msgs.push(forPeer);
      if (conn.peer.msgs.length > KEEP_MSGS) conn.peer.msgs.shift();
      if (entry.k === 'img' && out.v) conn.peer.lastImg = { id: entry.id, v: out.v, at: entry.at };
      this.send(conn.peer, out);
    }
  }

  onMessage(conn, data) {
    conn.lastSeen = Date.now();
    let m; try { m = JSON.parse(typeof data === 'string' ? data : ''); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'ping') { this.send(conn, { t: 'pong' }); return; }

    if (m.t === 'join') {
      // 换模式：先把旧状态清干净（退大厅 / 解开配对），否则会同时挂在两个地方
      if (conn.room) this.leaveHall(conn);
      if (conn.peer || this.waiting === conn) this.unpair(conn, false);
      if (m.mode === 'group') this.joinHall(conn); else this.enqueue(conn);
      return;
    }
    if (m.t === 'skip') {
      if (conn.mode === 'group') { if (!conn.room) this.joinHall(conn); }
      else this.unpair(conn, true);
      return;
    }
    if (m.t === 'report') { this.report(conn, String(m.id || '')); return; }
    if (m.t === 'react') {
      // 表情回应：只做「谁对哪条消息回了个什么」的轻量广播，不落库（不改变匿名/不留痕的取向）
      if (!this.rate(conn, false)) return;
      const id = String(m.id || '').slice(0, 40);
      const e = String(m.e || '').slice(0, 8);
      if (!id || !e) return;
      const out = { t: 'react', id, e, from: conn.tag || 0 };
      conn.msgs.push({ id, me: 1, k: 'react', tag: conn.tag, v: e, at: Date.now() });
      if (conn.msgs.length > KEEP_MSGS) conn.msgs.shift();
      // 不回给发送者：前端点选时已本地 +1，回传会变成 2
      if (conn.room) { const h = conn.room; for (const c of h.members) { if (c !== conn) this.send(c, out); } }
      else if (conn.peer) { this.send(conn.peer, out); }
      return;
    }

    if (m.t === 'msg') {
      if (!this.rate(conn, false)) { this.send(conn, { t: 'err', k: 'fast' }); return; }
      const v = String(m.v || '').slice(0, MAX_TEXT).trim();
      if (!v) return;
      const id = String(m.id || '').slice(0, 40) || ('s' + Date.now().toString(36));
      this.deliver(conn, { id, me: 1, k: 'text', tag: conn.tag, v, at: Date.now() }, { t: 'msg', v, id });
      return;
    }

    if (m.t === 'img') {
      if (!this.rate(conn, true)) { this.send(conn, { t: 'err', k: 'imgfast' }); return; }
      const v = String(m.v || '');
      if (!/^data:image\/(jpeg|png|webp|gif);base64,/.test(v)) { this.send(conn, { t: 'err', k: 'badimg' }); return; }
      if (v.length > MAX_IMG_CHARS) { this.send(conn, { t: 'err', k: 'imgbig' }); return; }
      const imgId = String(m.id || '').slice(0, 40) || ('s' + Date.now().toString(36));
      // 缓冲里保留完整图（审核要看到原图）；更早的第 4 张起才降级，避免内存无限涨
      this.deliver(conn, { id: imgId, me: 1, k: 'img', tag: conn.tag, v, at: Date.now() }, { t: 'img', v, id: imgId });
      return;
    }
  }

  async report(conn, msgId) {
    const msgs = conn.msgs || [];
    let idx = msgId ? msgs.findIndex(x => x && x.id === msgId) : -1;
    // 兜底：历史的旧消息没有 id（或前端补的临时 id），就取最近一条「对方的」消息当被举报内容
    if (idx < 0) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i] && msgs[i].me === 0) { idx = i; break; }
      }
      if (idx < 0 && msgs.length) idx = msgs.length - 1;
    }
    let target = idx >= 0 ? msgs[idx] : null;
    // 举报的是图片 → 想办法拿到完整原图，审核看不到图就没法判定
    if (target && target.k === 'img' && (typeof target.v !== 'string' || target.v.length < 300)) {
      let full = null;
      if (conn.lastImg && conn.lastImg.id === target.id) full = conn.lastImg.v;   // 一对一：刚收到的原图
      if (!full) full = await this.findHistoryImg(target.id);                     // 群聊：回历史库按 id 找
      if (full) target = Object.assign({}, target, { v: full });
    }
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
      reported_msg: target ? { tag: target.tag || 0, k: target.k, at: target.at, v: (target.k === 'img' ? String(target.v || '') : String(target.v || '').slice(0, 500)) } : null,
      msgs: (idx >= 0 ? msgs.slice(Math.max(0, idx - 3), idx + 4) : msgs.slice(-KEEP_MSGS)).map(x =>
        (x && x.k === 'img' && typeof x.v === 'string' && x.v.length > 300)
          ? Object.assign({}, x, { v: IMG_PLACEHOLDER }) : x),
      handled: false,
    };
    try { await this.dbPut('report:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8), record); } catch {}
    this.send(conn, { t: 'reported' });
  }

  async listReports() {
    const out = [];
    const list = await this.dbList({ prefix: 'report:', limit: 200 });
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
