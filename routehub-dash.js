// =============================================================
// routehub-dash.js v0.3.0 — локальный дашборд RouteHub (диспетчер + HTML).
// Тип: http-request на ^http:\/\/rh\.box (HTTP, без MITM).
// argument = "<key>|<origin>" (Worker инжектит при выдаче /config).
//
// ПОЧЕМУ ПЕРЕПИСАНО (полевой тест k1 2026-06-13):
//   v0.2.x грузился бесконечно (скелетон, точка серая, кнопки мертвы).
//   Причина: страница на http://rh.box делала XHR на /local и /dashboard.
//     - /dashboard -> https://...workers.dev = MIXED CONTENT (https со
//       страницы http) -> Safari БЛОКИРУЕТ запрос наглухо.
//     - XHR-подзапросы страницы на /local Loon-перехват http-request НЕ
//       ловит надёжно (ловит навигацию верхнего уровня, не fetch/XHR).
//   РЕШЕНИЕ — BOOTSTRAP: диспетчер при отдаче HTML САМ собирает все данные
//     (локальные из $persistentStore + Worker /dashboard через $httpClient
//     В ТУННЕЛЕ — не mixed-content) и вшивает в страницу как __BOOT__.
//     Страница рисует МГНОВЕННО из BOOT, без единого XHR.
//   МУТАЦИИ (add/del/toggle/check) — через НАВИГАЦИЮ верхнего уровня
//     (location.href = http://rh.box/add?d=...), а не XHR: навигация
//     перехватывается надёжно. Диспетчер выполняет действие и редиректит
//     назад на http://rh.box/#dm (303). Кнопки снова рабочие.
//   Обновление «вживую»: тап по сегменту Live перезагружает страницу
//     (location.reload) — bootstrap соберёт свежие данные. Авто-таймер
//     тоже делает reload (не XHR).
//
// МАРШРУТЫ:
//   GET /            -> HTML со вшитым __BOOT__ (всё состояние внутри).
//   GET /add?d=      -> добавить домен (обход ВКЛ) + Worker /addrule -> 303 /#dm
//   GET /del?d=      -> удалить домен (+ /delrule если был ВКЛ)      -> 303 /#dm
//   GET /toggle?d=   -> переключить обход (+ add/delrule)            -> 303 /#dm
//   GET /check?d=    -> проверить домен fetch-ом по правилам конфига -> 303 /#dm
//   GET /sync        -> сверка Worker /mylist vs локальные ВКЛ       -> 303 /#dm
//
// T1/T6: проверка доменов — обычный fetch (по правилам конфига), node НЕ
//   используется. Засев rh_watch: ТОЛЬКО whoosh.bike (обход ВКЛ).
// =============================================================

var VERSION = 'dash v0.3.0';
var KEY = 'k1', ORIGIN = 'https://routehub.proton4iker.workers.dev';
try {
  var a = (typeof $argument !== 'undefined' && $argument) ? String($argument) : '';
  if (a) { var ap = a.split('|'); if (ap[0]) KEY = ap[0]; if (ap[1]) ORIGIN = ap[1]; }
} catch (e0) {}

var K_WATCH = 'rh_watch';
var K_RKN = 'rh_rkn';
var K_NET = 'rh_net_state';
var K_RUNLOG = 'rh_runlog';
var K_DASH = 'rh_dash';
var DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function rj(k, d) { try { var s = $persistentStore.read(k); return s ? JSON.parse(s) : d; } catch (e) { return d; } }
function wj(k, o) { try { $persistentStore.write(JSON.stringify(o), k); } catch (e) {} }

function watchLoad() {
  var w = rj(K_WATCH, null);
  if (!Array.isArray(w)) { w = [{ d: 'whoosh.bike', on: true, ts: Date.now() }]; wj(K_WATCH, w); }
  return w;
}
function watchSave(w) { wj(K_WATCH, w); }

function wPost(path, body, cb) {
  $httpClient.post({ url: ORIGIN + path, timeout: 5000, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    function (e, r, b) { cb(!e && r && r.status >= 200 && r.status < 300, b || ''); });
}
function wGet(path, cb) {
  $httpClient.get({ url: ORIGIN + path, timeout: 6000 }, function (e, r, b) { cb(!e && r && r.status >= 200 && r.status < 300, b || ''); });
}

// HTML-ответ
function htmlResp(body) {
  $done({ response: { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body: body } });
}
// редирект назад на дашборд (после мутации)
function redirect(hash) {
  $done({ response: { status: 303, headers: { 'Location': 'http://rh.box/' + (hash || ''), 'Cache-Control': 'no-store' }, body: '' } });
}

// --- разбор URL ---
var URLS = String($request && $request.url || '');
var mm = URLS.match(/^https?:\/\/[^\/]+(\/[^?]*)?(?:\?(.*))?$/);
var PATH = (mm && mm[1]) || '/';
var QS = (mm && mm[2]) || '';
function q(name) {
  var parts = QS.split('&');
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].split('=');
    if (kv[0] === name) return decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
  }
  return '';
}

// =============================================================
// Сборка BOOT — всё состояние, вшиваемое в страницу.
// local: watch, rkn, net, runlog, cache(rh_dash). remote: Worker /dashboard.
// =============================================================
function buildLocal() {
  var rkn = rj(K_RKN, {}) || {};
  var cache = rj(K_DASH, null);
  var rl = rj(K_RUNLOG, []);
  if (!Array.isArray(rl)) rl = [];
  return {
    ver: VERSION, ts: Date.now(), key: KEY, origin: ORIGIN,
    watch: watchLoad(),
    rkn: { mode: rkn.mode, ts: rkn.ts, hist: rkn.hist || [] },
    net: rj(K_NET, null),
    runlog: rl.slice(-60),
    cache: cache && cache.data ? cache.data : cache,
    cache_ts: cache && cache.ts ? cache.ts : null
  };
}

function serveDashboard() {
  var local = buildLocal();
  // Worker /dashboard — серверным запросом В ТУННЕЛЕ (не mixed-content)
  wGet('/dashboard?key=' + KEY, function (ok, body) {
    var remote = null, src = 'none';
    if (ok) { try { remote = JSON.parse(body); src = 'live'; } catch (e) { remote = null; } }
    if (!remote && local.cache) { remote = local.cache; src = 'cache'; }
    var boot = { local: local, remote: remote, src: src };
    var json = JSON.stringify(boot).split('<').join('\\u003c'); // безопасно в <script>
    var body2 = HTML.split('__BOOT__').join(json).split('__KEY__').join(KEY);
    htmlResp(body2);
  });
}

// =============================================================
// Мутации (через навигацию -> 303 назад)
// =============================================================
function doAdd() {
  var d = q('d').toLowerCase();
  if (!DOMAIN_RE.test(d) || d.length > 80) { redirect('#dm'); return; }
  var w = watchLoad(), exists = false;
  for (var i = 0; i < w.length; i++) if (w[i].d === d) exists = true;
  if (!exists) { w.push({ d: d, on: true, ts: Date.now() }); watchSave(w); }
  wPost('/addrule', { key: KEY, domain: d }, function () { redirect('#dm'); });
}
function doDel() {
  var d = q('d').toLowerCase();
  var w = watchLoad(), wasOn = false, nw = [];
  for (var i = 0; i < w.length; i++) { if (w[i].d === d) wasOn = !!w[i].on; else nw.push(w[i]); }
  watchSave(nw);
  if (wasOn) wPost('/delrule', { key: KEY, domain: d }, function () { redirect('#dm'); });
  else redirect('#dm');
}
function doToggle() {
  var d = q('d').toLowerCase();
  var w = watchLoad(), e = null;
  for (var i = 0; i < w.length; i++) if (w[i].d === d) e = w[i];
  if (!e) { redirect('#dm'); return; }
  e.on = !e.on; watchSave(w);
  wPost(e.on ? '/addrule' : '/delrule', { key: KEY, domain: d }, function () { redirect('#dm'); });
}
function doCheck() {
  var d = q('d').toLowerCase();
  if (!DOMAIN_RE.test(d)) { redirect('#dm'); return; }
  var rkn = rj(K_RKN, {}) || {};
  var t0 = Date.now();
  function fin(okFlag, status) {
    var ms = Date.now() - t0, w = watchLoad();
    for (var i = 0; i < w.length; i++) if (w[i].d === d) { w[i].last = { ok: okFlag, status: status || 0, ms: ms, ts: Date.now(), mode: rkn.mode || '?' }; watchSave(w); break; }
    redirect('#dm');
  }
  $httpClient.get({ url: 'https://' + d + '/', timeout: 4000 }, function (e1, r1) {
    if (!e1 && r1 && r1.status) { fin(r1.status < 500, r1.status); return; }
    $httpClient.get({ url: 'http://' + d + '/', timeout: 3000 }, function (e2, r2) {
      if (!e2 && r2 && r2.status) { fin(r2.status < 500, r2.status); return; }
      fin(false, 0);
    });
  });
}
function doSync() {
  wGet('/mylist?key=' + KEY, function (ok, body) {
    if (!ok) { redirect('#dm'); return; }
    var remote = {}, lines = String(body).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^DOMAIN-SUFFIX,([a-z0-9.-]+)/i);
      if (m) remote[m[1].toLowerCase()] = true;
    }
    var w = watchLoad(), localOn = {};
    for (var i2 = 0; i2 < w.length; i2++) if (w[i2].on) localOn[w[i2].d] = true;
    var toAdd = [], toDel = [];
    for (var d1 in localOn) if (!remote[d1]) toAdd.push(d1);
    for (var d2 in remote) if (!localOn[d2]) toDel.push(d2);
    function doA(k) {
      if (k >= toAdd.length) { doD(0); return; }
      wPost('/addrule', { key: KEY, domain: toAdd[k] }, function () { doA(k + 1); });
    }
    function doD(k) {
      if (k >= toDel.length) { redirect('#dm'); return; }
      wPost('/delrule', { key: KEY, domain: toDel[k] }, function () { doD(k + 1); });
    }
    doA(0);
  });
}

// =============================================================
// HTML (вшивается __BOOT__ = всё состояние, __KEY__ = ключ).
// Без обратных кавычек и "${" внутри script страницы.
// =============================================================
var HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="RouteHub">
<link rel="apple-touch-icon" href="https://routehub.proton4iker.workers.dev/apple-touch-icon.png">
<title>RouteHub</title>
<style>
:root{--bg:#F4F6F5;--card:#FFFFFF;--ink:#10211C;--mut:#5E6E68;--line:#E2E8E5;--acc:#0E7A5F;--acc2:#5DCAA5;--ok:#1F9D6B;--warn:#C7900B;--bad:#C0392B;--grey:#9AA7A1;--tabbg:rgba(255,255,255,.92)}
@media(prefers-color-scheme:dark){:root{--bg:#0B1512;--card:#13201B;--ink:#E7F0EC;--mut:#8FA39B;--line:#1E2E27;--acc:#5DCAA5;--acc2:#7FE0C0;--ok:#3DBE8B;--warn:#D9A93C;--bad:#E06A5A;--grey:#5E6E68;--tabbg:rgba(15,24,20,.92)}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,system-ui,'SF Pro Text',sans-serif}
body{padding-bottom:calc(76px + env(safe-area-inset-bottom))}
header{position:sticky;top:0;z-index:5;background:var(--bg);padding:calc(10px + env(safe-area-inset-top)) 16px 8px}
h1{font-size:22px;margin:0;display:flex;align-items:center;gap:8px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--grey)}
.dot.live{background:var(--ok)}.dot.cache{background:var(--warn)}.dot.ls{background:var(--grey)}
.banner{margin-top:8px;border-radius:12px;padding:8px 12px;font-size:14px;display:none}
.banner.show{display:block}
.banner.normal{background:rgba(31,157,107,.12);color:var(--ok)}
.banner.whitelist{background:rgba(199,144,11,.14);color:var(--warn)}
.banner.block{background:rgba(192,57,43,.14);color:var(--bad)}
.live{display:flex;gap:6px;margin-top:8px;align-items:center;font-size:13px;color:var(--mut)}
.seg{display:inline-flex;background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden}
.seg button{border:0;background:transparent;color:var(--mut);padding:5px 10px;font-size:13px}
.seg button.on{background:var(--acc);color:#fff}
main{padding:4px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin:10px 0}
.card h3{margin:0 0 6px;font-size:13px;color:var(--mut);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.kv{display:flex;justify-content:space-between;gap:10px;padding:4px 0;font-size:15px}
.kv b{font-weight:600}
.mut{color:var(--mut)}.small{font-size:13px}
.row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.grow{flex:1;min-width:0}
.nm{font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sub{font-size:12px;color:var(--mut)}
.chip{font-size:11px;padding:2px 8px;border-radius:99px;white-space:nowrap}
.chip.ok{background:rgba(31,157,107,.14);color:var(--ok)}
.chip.bad{background:rgba(192,57,43,.14);color:var(--bad)}
.chip.na{background:rgba(154,167,161,.18);color:var(--mut)}
a.b,button.b{display:inline-block;border:1px solid var(--line);background:var(--card);color:var(--acc);border-radius:10px;padding:7px 12px;font-size:14px;text-decoration:none}
a.b:active,button.b:active,.tab:active{transform:scale(.98)}
a.b.pri{background:var(--acc);border-color:var(--acc);color:#fff}
.btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
input.inp{flex:1;border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:10px;padding:8px 10px;font-size:15px;min-width:0}
.addl{display:flex;gap:8px}
.sw{display:inline-block;font-size:12px;padding:4px 9px;border-radius:99px;border:1px solid var(--line);text-decoration:none}
.sw.on{background:rgba(31,157,107,.16);color:var(--ok);border-color:transparent}
.sw.off{background:rgba(154,167,161,.16);color:var(--mut)}
.ring{flex:none}
nav{position:fixed;left:0;right:0;bottom:0;background:var(--tabbg);backdrop-filter:blur(14px);border-top:1px solid var(--line);display:flex;padding:6px 4px calc(6px + env(safe-area-inset-bottom))}
.tab{flex:1;border:0;background:transparent;color:var(--mut);font-size:10px;display:flex;flex-direction:column;align-items:center;gap:3px;padding:4px 0}
.tab.on{color:var(--acc)}
.tab svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.hint{font-size:12px;color:var(--mut);margin-top:6px}
.ev{padding:7px 0;border-bottom:1px solid var(--line);font-size:14px}
.ev:last-child{border-bottom:0}
.ev .t{color:var(--mut);font-size:12px}
.gap{color:var(--warn)}
a.lk{color:var(--acc);text-decoration:none}
</style>
</head>
<body>
<header>
  <h1><span class="dot" id="dot"></span> RouteHub <span class="mut small" id="hkey"></span></h1>
  <div class="banner" id="banner"></div>
  <div class="live">
    Обновить:
    <span class="seg" id="liveSeg">
      <button data-s="0" class="on">сейчас</button><button data-s="15">15с</button><button data-s="30">30с</button>
    </span>
    <span id="upd" class="mut"></span>
  </div>
</header>
<main id="main"></main>
<nav>
  <button class="tab on" data-t="ov"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8.4"/><path d="M12 3.6v2.2M12 18.2v2.2M3.6 12h2.2M18.2 12h2.2"/></svg>Обзор</button>
  <button class="tab" data-t="nd"><svg viewBox="0 0 24 24"><circle cx="5.5" cy="6" r="2"/><circle cx="18.5" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 7.4 10.7 16M17 7.4 13.3 16M7.5 6h9"/></svg>Узлы</button>
  <button class="tab" data-t="dm"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8M12 3.6c2.6 2.3 3.9 5.1 3.9 8.4s-1.3 6.1-3.9 8.4c-2.6-2.3-3.9-5.1-3.9-8.4s1.3-6.1 3.9-8.4z"/></svg>Домены</button>
  <button class="tab" data-t="hs"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.2V12l3.2 2"/></svg>История</button>
  <button class="tab" data-t="sy"><svg viewBox="0 0 24 24"><rect x="4.5" y="4.5" width="15" height="15" rx="4"/><circle cx="12" cy="12" r="3"/><path d="M12 4.5V7M12 17v2.5M4.5 12H7M17 12h2.5"/></svg>Система</button>
</nav>
<script>
var BOOT=__BOOT__;
var KEY='__KEY__';
var L=BOOT.local||{},W=BOOT.remote||{},SRC=BOOT.src||'none';
var S={tab:'ov',seg:'wifi',h:null};
function $id(i){return document.getElementById(i)}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function fts(t){if(!t)return '—';var d=new Date(t);if(isNaN(d))return String(t);function p(n){return (n<10?'0':'')+n}return p(d.getDate())+'.'+p(d.getMonth()+1)+' '+p(d.getHours())+':'+p(d.getMinutes())}
function ago(t){if(!t)return '—';var s=Math.round((Date.now()-new Date(t).getTime())/1000);if(s<0)s=0;if(s<90)return s+' с назад';var m=Math.round(s/60);if(m<90)return m+' мин назад';return Math.round(m/60)+' ч назад'}
function modeRu(m){return m==='normal'?'Норма':(m==='whitelist'?'Whitelist РКН':(m==='block'?'Блокировка':(m||'?')))}
function getRkn(){return (L.rkn&&L.rkn.mode)?L.rkn:((W&&W.rkn)||{})}
function card(t,inner){return '<div class="card">'+(t?'<h3>'+t+'</h3>':'')+inner+'</div>'}
function kv(k,v){return '<div class="kv"><span class="mut">'+k+'</span><b>'+v+'</b></div>'}
function ring(sc){
  var col='var(--grey)',v=0;
  if(typeof sc==='number'){v=Math.max(0,Math.min(100,sc));col=sc>=70?'var(--ok)':(sc>=40?'var(--warn)':'var(--bad)')}
  var C=2*Math.PI*13,d=(C*v/100).toFixed(1);
  return '<svg class="ring" width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="13" fill="none" stroke="var(--line)" stroke-width="3.4"/><circle cx="18" cy="18" r="13" fill="none" stroke="'+col+'" stroke-width="3.4" stroke-linecap="round" stroke-dasharray="'+d+' '+C.toFixed(1)+'" transform="rotate(-90 18 18)"/><text x="18" y="22" text-anchor="middle" font-size="11" fill="var(--ink)">'+(typeof sc==='number'?sc:'·')+'</text></svg>';
}
function rOv(){
  var net=L.net||{},tr=W.traffic||{},r=getRkn();
  var h='';
  h+=card('Состояние',
    kv('Режим сети',modeRu(r.mode)+' <span class="mut small">'+ago(r.ts)+'</span>')+
    kv('Сеть устройства',esc(net.net||'—')+(net.ssid?' · '+esc(net.ssid):'')+(net.operator?' · '+esc(net.operator):''))+
    kv('Источник',SRC==='live'?'Worker (live)':(SRC==='cache'?'кэш rh_dash':'нет связи')));
  h+=card('Подписка',
    kv('Узлов',(W.sub_nodes!=null?W.sub_nodes:'—')+' <span class="mut small">обновл. '+(W.sub_age_min!=null?W.sub_age_min+' мин назад':'—')+'</span>')+
    (tr.left_gb!=null?kv('Трафик',(Math.round(tr.used_gb*10)/10)+' / '+(Math.round(tr.total_gb*10)/10)+' ГБ · ост. '+(Math.round(tr.left_gb*10)/10)):'')+
    (tr.expire?kv('Действует до',fts(tr.expire*1000)):''));
  var ms=(W.nodes&&W.nodes[S.seg])||[];var top=ms.slice(0,3),t3='';
  for(var i=0;i<top.length;i++){t3+='<div class="row">'+ring(top[i].score)+'<div class="grow"><div class="nm">'+esc(top[i].name)+'</div><div class="sub">'+top[i].down+' Мбит · '+top[i].rtt+' мс</div></div></div>'}
  h+=card('Топ узлов ('+(S.seg==='wifi'?'Wi-Fi':'сотовая')+')',t3||'<div class="mut small">нет данных спидтеста</div>');
  var wl=(L.watch||[]),on=0;for(var j=0;j<wl.length;j++)if(wl[j].on)on++;
  h+=card('Личный список',kv('Под наблюдением',wl.length)+kv('С обходом',on));
  h+=card('Версии',kv('Конфиг',esc(W.conf_ver||'—'))+kv('Worker',esc(W.worker||'—'))+kv('Дашборд',esc(L.ver||'—')));
  return h;
}
function rNd(){
  var ms=(W.nodes&&W.nodes[S.seg])||[];
  var h='<div class="card"><div class="seg" id="ndSeg"><button data-g="wifi" class="'+(S.seg==='wifi'?'on':'')+'">Wi-Fi</button><button data-g="cell" class="'+(S.seg==='cell'?'on':'')+'">Сотовая</button></div></div>';
  var rows='';
  for(var i=0;i<ms.length;i++){var n=ms[i];
    rows+='<div class="row">'+ring(n.score)+'<div class="grow"><div class="nm">'+esc(n.name)+(n.voice?' ☎':'')+'</div><div class="sub">'+n.down+' Мбит · rtt '+n.rtt+' · jit '+n.jit+' · потери '+n.bl+'‰ · ок '+n.pct+'%</div></div></div>'}
  h+=card('Узлы ('+ms.length+')',rows||'<div class="mut small">нет данных спидтеста</div>');
  return h;
}
function chipFor(e){
  if(!e||!e.last)return '<span class="chip na">не проверялся</span>';
  var Lx=e.last,m=Lx.mode?(' · '+modeRu(Lx.mode)):'';
  if(Lx.ok)return '<span class="chip ok">открылся'+m+' · '+ago(Lx.ts)+'</span>';
  return '<span class="chip bad">не открылся'+m+' · '+ago(Lx.ts)+'</span>';
}
function rDm(){
  var wl=L.watch||[],r=getRkn();
  var h=card('Добавить домен',
    '<form class="addl" action="http://rh.box/add" method="get"><input class="inp" name="d" placeholder="example.ru" autocapitalize="none" autocorrect="off"><button class="b pri" type="submit">Добавить</button></form>'+
    '<div class="hint">Новый домен сразу получает обход (попадает в личный список RH-RU).</div>');
  var rows='';
  for(var i=0;i<wl.length;i++){var e=wl[i],d=esc(e.d),de=encodeURIComponent(e.d);
    rows+='<div class="row"><div class="grow"><div class="nm">'+d+'</div><div class="sub">'+chipFor(e)+'</div></div>'+
      '<a class="b" href="http://rh.box/check?d='+de+'">Проверить</a>'+
      '<a class="sw '+(e.on?'on':'off')+'" href="http://rh.box/toggle?d='+de+'">'+(e.on?'обход':'выкл')+'</a>'+
      '<a class="b" href="http://rh.box/del?d='+de+'">✕</a></div>'}
  h+=card('Список наблюдения',(rows||'<div class="mut small">пусто</div>')+
    '<div class="btns"><a class="b" href="http://rh.box/sync">Синхронизировать</a><a class="b" href="https://nsloon.com/openloon/update?sub=all">Применить в Loon</a></div>'+
    '<div class="hint">«обход»/«выкл» — тап переключает маршрут. «Проверить» — fetch по правилам конфига; режим на момент проверки в результате.'+(r.mode==='whitelist'?' <b>Сейчас whitelist: «ожил» недостоверен.</b>':'')+'</div>');
  return h;
}
function rHs(){
  var hist=(L.rkn&&L.rkn.hist)||W.rkn_hist||[],hh='';
  for(var i=0;i<hist.length;i++){hh+='<div class="ev">'+modeRu(hist[i].mode)+'<div class="t">'+fts(hist[i].ts)+'</div></div>'}
  var rl=L.runlog||[],rr='';
  for(var j=rl.length-1;j>=0;j--){var ev=rl[j],tx='';
    if(ev.s==='net')tx='Сеть: '+esc(ev.n||'?')+(ev.w?' · WHITELIST':'')+(ev.o?' · '+esc(ev.o):'');
    else if(ev.s==='rkn')tx='Режим: '+modeRu(ev.m);
    else if(ev.s==='dash')tx='Кэш дашборда: '+(ev.ok?'ок':'сбой'+(ev.note?' ('+esc(ev.note)+')':''));
    else if(ev.s==='cron')tx='Спидтест'+(ev.n?' ('+esc(ev.n)+')':'')+(ev.m!=null?': +'+ev.m+' узлов':'')+(ev.x?' — '+esc(ev.x):'');
    else tx=esc(ev.s||'событие')+(ev.note?': '+esc(ev.note):'');
    if(ev.gap)tx+=' <span class="gap">· разрыв '+ev.gap+' мин</span>';
    rr+='<div class="ev">'+tx+'<div class="t">'+fts(ev.t||ev.ts)+'</div></div>'}
  return card('Смены режима РКН',hh||'<div class="mut small">смен не зафиксировано</div>')+
         card('Журнал событий (локальный)',rr||'<div class="mut small">журнал пуст — скрипты ещё не писали</div>');
}
function rSy(){
  var sc=[
    ['RH-Speed','cron 20 мин','спидтест: метрики узлов (down/rtt/jit/потери), пинг-свип'],
    ['RH-Net','смена сети','флип групп -W/-C, детект сети, журнал'],
    ['RH-RKN','cron 10 мин','режим сети (норма/whitelist/блок), история смен'],
    ['RH-DashCache','cron 15 мин','кэш /dashboard в rh_dash (фолбэк под whitelist)'],
    ['RH-Dash','по запросу','этот дашборд и команды списка'],
    ['RH-Viewer','вручную','таблица узлов в лог Loon']];
  var rows='';for(var i=0;i<sc.length;i++){rows+='<div class="row"><div class="grow"><div class="nm">'+sc[i][0]+' <span class="mut small">'+sc[i][1]+'</span></div><div class="sub">'+sc[i][2]+'</div></div></div>'}
  return card('Инфраструктура',
      kv('Worker',esc(W.worker||'—'))+
      kv('Конфиг',esc(W.conf_ver||'—'))+
      kv('Подписка',(W.sub_age_min!=null?W.sub_age_min+' мин назад':'—'))+
      kv('Узлы (порядок)',W.last_nodes_ts?ago(W.last_nodes_ts):'—')+
      kv('Кэш дашборда',L.cache_ts?ago(L.cache_ts):'—'))+
    card('Скрипты',rows)+
    card('Loon','<div class="btns"><a class="lk b" href="loon://LogLists">Логи Loon</a><a class="lk b" href="loon://requestLists">Запросы Loon</a></div>');
}
function render(){
  var d=$id('dot');d.className='dot '+(SRC==='live'?'live':(SRC==='cache'?'cache':''));
  $id('hkey').textContent=KEY;
  $id('upd').textContent='снято '+fts(L.ts);
  var r=getRkn(),b=$id('banner');
  if(r&&r.mode){b.className='banner show '+r.mode;b.textContent='Режим: '+modeRu(r.mode)+' · '+ago(r.ts)}else{b.className='banner'}
  var f={ov:rOv,nd:rNd,dm:rDm,hs:rHs,sy:rSy}[S.tab];if(f)$id('main').innerHTML=f();
}
document.addEventListener('click',function(ev){
  var t=ev.target.closest('.tab');if(t){var bs=document.querySelectorAll('.tab');for(var i=0;i<bs.length;i++)bs[i].classList.remove('on');t.classList.add('on');S.tab=t.getAttribute('data-t');render();return}
  var g=ev.target.closest('#ndSeg button');if(g){S.seg=g.getAttribute('data-g');render();return}
  var sv=ev.target.closest('#liveSeg button');if(sv){
    var s=parseInt(sv.getAttribute('data-s'),10);
    if(s===0){location.reload();return}
    var bb=sv.parentNode.querySelectorAll('button');for(var k=0;k<bb.length;k++)bb[k].classList.remove('on');sv.classList.add('on');
    if(S.h)clearInterval(S.h);S.h=setInterval(function(){if(!document.hidden)location.reload()},s*1000);
  }
});
document.addEventListener('visibilitychange',function(){if(!document.hidden&&S.h){/* таймер сам перезагрузит */}});
if(location.hash==='#dm')S.tab='dm';if(location.hash==='#hs')S.tab='hs';if(location.hash==='#nd')S.tab='nd';if(location.hash==='#sy')S.tab='sy';
render();
</script>
</body>
</html>`;

// =============================================================
// Диспетчеризация
// =============================================================
try {
  if (PATH === '/' || PATH === '/index.html') serveDashboard();
  else if (PATH === '/add') doAdd();
  else if (PATH === '/del') doDel();
  else if (PATH === '/toggle') doToggle();
  else if (PATH === '/check') doCheck();
  else if (PATH === '/sync') doSync();
  else redirect('');
} catch (eX) {
  htmlResp('<!DOCTYPE html><meta charset="utf-8"><body style="font:16px -apple-system;padding:20px">RouteHub: ошибка диспетчера — ' + ((eX && eX.message) || eX) + '</body>');
}
