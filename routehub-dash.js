// =============================================================
// routehub-dash.js v0.4.1 — локальный дашборд RouteHub (диспетчер + HTML).
// Тип: http-request на ^http:\/\/rh\.box (HTTP, без MITM).
// argument = "<key>|<origin>" (Worker инжектит при выдаче /config).
//
// АРХИТЕКТУРА (с v0.3.0): BOOTSTRAP — диспетчер при отдаче HTML САМ собирает
//   данные (локальные из $persistentStore + Worker /dashboard через $httpClient
//   в туннеле) и вшивает в страницу как __BOOT__. Страница НЕ делает XHR
//   (mixed-content https + перехват подзапросов не работают). Мутации — через
//   НАВИГАЦИЮ верхнего уровня (ссылки/форма http://rh.box/...), диспетчер
//   делает действие и 303-редиректит назад.
//
// v0.4.1 (ФИКС регрессии v0.4.0 — «не открывается»):
//   * УБРАН readActive() / $config.getConfig(callback). В Loon 3.3.9 у
//     getConfig нет колбэк-сигнатуры, которую я предположил -> колбэк не
//     вызывался -> serveDashboard не доходил до $done -> страница не
//     открывалась. Плитки «активный узел» теперь показывают лучший узел по
//     баллу (topName) — это и был заложенный фолбэк. ACT убран из BOOT.
//   Урок: не вызывать API Loon с догадочной сигнатурой в критическом пути.
//
// v0.4.0 (дизайн + честный чекер): стиль A+B (плитки/счётчики/графики),
//   авто-тумблер (15 с, по умолч. ВЫКЛ), бесшовный reload (вкладка+скролл),
//   переверстка доменов, ЧЕСТНЫЙ вердикт чекера по (режим)×(обход),
//   кнопка Loon (loon://).
//
// МАРШРУТЫ: / (HTML+BOOT), /add /del /toggle /check /sync (-> 303 назад).
// T6: node работает для имён УЗЛОВ (спидтест достоверен), не для групп.
//   Чекер node НЕ использует — обычный fetch по правилам конфига.
// Засев rh_watch: ТОЛЬКО whoosh.bike (обход ВКЛ).
// =============================================================

var VERSION = 'dash v0.4.1';
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

function htmlResp(body) {
  $done({ response: { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body: body } });
}
function redirect(hash) {
  $done({ response: { status: 303, headers: { 'Location': 'http://rh.box/' + (hash || ''), 'Cache-Control': 'no-store' }, body: '' } });
}

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
  wGet('/dashboard?key=' + KEY, function (ok, body) {
    var remote = null, src = 'none';
    if (ok) { try { remote = JSON.parse(body); src = 'live'; } catch (e) { remote = null; } }
    if (!remote && local.cache) { remote = local.cache; src = 'cache'; }
    var boot = { local: local, remote: remote, src: src };
    var json = JSON.stringify(boot).split('<').join('\\u003c');
    var body2 = HTML.split('__BOOT__').join(json).split('__KEY__').join(KEY);
    htmlResp(body2);
  });
}

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
  var w0 = watchLoad(), wasOn = false;
  for (var z = 0; z < w0.length; z++) if (w0[z].d === d) wasOn = !!w0[z].on;
  var t0 = Date.now();
  function fin(okFlag, status) {
    var ms = Date.now() - t0, w = watchLoad();
    for (var i = 0; i < w.length; i++) if (w[i].d === d) { w[i].last = { ok: okFlag, status: status || 0, ms: ms, ts: Date.now(), mode: rkn.mode || '?', on: wasOn }; watchSave(w); break; }
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
// HTML (вшивается __BOOT__ и __KEY__). Без обратных кавычек и "${" внутри.
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
:root{--bg:#F4F6F5;--card:#FFFFFF;--card2:#EEF2F0;--ink:#10211C;--mut:#5E6E68;--line:#E2E8E5;--acc:#0E7A5F;--acc2:#5DCAA5;--ok:#1F9D6B;--warn:#C7900B;--bad:#C0392B;--grey:#9AA7A1;--tabbg:rgba(255,255,255,.92)}
@media(prefers-color-scheme:dark){:root{--bg:#0B1512;--card:#13201B;--card2:#0F1A16;--ink:#E7F0EC;--mut:#8FA39B;--line:#1E2E27;--acc:#5DCAA5;--acc2:#7FE0C0;--ok:#3DBE8B;--warn:#D9A93C;--bad:#E06A5A;--grey:#5E6E68;--tabbg:rgba(15,24,20,.92)}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,system-ui,'SF Pro Text',sans-serif}
body{padding-bottom:calc(78px + env(safe-area-inset-bottom))}
header{position:sticky;top:0;z-index:5;background:var(--bg);padding:calc(10px + env(safe-area-inset-top)) 16px 8px}
h1{font-size:22px;margin:0;display:flex;align-items:center;gap:8px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--grey)}
.dot.live{background:var(--ok)}.dot.cache{background:var(--warn)}
.banner{margin-top:8px;border-radius:12px;padding:9px 12px;font-size:14px;display:none}
.banner.show{display:block}
.banner.normal{background:rgba(31,157,107,.12);color:var(--ok)}
.banner.whitelist{background:rgba(199,144,11,.16);color:var(--warn)}
.banner.block{background:rgba(192,57,43,.14);color:var(--bad)}
.toolbar{display:flex;align-items:center;gap:10px;margin-top:8px;font-size:13px;color:var(--mut)}
.refresh{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--card);color:var(--acc);border-radius:9px;padding:5px 11px;text-decoration:none;font-size:13px}
.refresh:active{transform:scale(.97)}
.auto{display:inline-flex;align-items:center;gap:7px;margin-left:auto}
.tg{position:relative;width:42px;height:25px;display:inline-block}
.tg input{display:none}
.tg i{position:absolute;inset:0;border-radius:99px;background:var(--line);transition:.15s}
.tg i:after{content:'';position:absolute;top:3px;left:3px;width:19px;height:19px;border-radius:50%;background:#fff;transition:.15s;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.tg input:checked+i{background:var(--ok)}
.tg input:checked+i:after{left:20px}
main{padding:4px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:13px 14px;margin:10px 0}
.card h3{margin:0 0 8px;font-size:12px;color:var(--mut);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.kv{display:flex;justify-content:space-between;gap:10px;padding:4px 0;font-size:15px}
.kv b{font-weight:600}
.mut{color:var(--mut)}.small{font-size:13px}
.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:10px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 13px}
.tile .lbl{font-size:12px;color:var(--mut);margin-bottom:5px}
.tile .big{font-size:18px;font-weight:600;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tile .sub{font-size:12px;color:var(--mut);margin-top:3px}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:10px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:11px 6px;text-align:center}
.stat .n{font-size:21px;font-weight:600;line-height:1}
.stat .c{font-size:11px;color:var(--mut);margin-top:4px}
.bars{display:flex;align-items:flex-end;gap:5px;height:46px;margin-top:4px}
.bars .bar{flex:1;border-radius:3px 3px 0 0;min-height:3px}
.prog{height:7px;background:var(--card2);border-radius:4px;overflow:hidden;margin:7px 0 3px}
.prog>div{height:100%;border-radius:4px}
.row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.grow{flex:1;min-width:0}
.nm{font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sub{font-size:12px;color:var(--mut);margin-top:1px}
.chip{font-size:11px;padding:2px 8px;border-radius:99px;white-space:nowrap}
.chip.ok{background:rgba(31,157,107,.16);color:var(--ok)}
.chip.bad{background:rgba(192,57,43,.16);color:var(--bad)}
.chip.warn{background:rgba(199,144,11,.18);color:var(--warn)}
.chip.na{background:rgba(154,167,161,.2);color:var(--mut)}
a.b,button.b{display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);background:var(--card);color:var(--acc);border-radius:10px;padding:7px 13px;font-size:14px;text-decoration:none}
a.b:active,button.b:active,.tab:active{transform:scale(.98)}
a.b.pri{background:var(--acc);border-color:var(--acc);color:#fff}
a.b.dz{color:var(--bad);border-color:var(--line)}
.btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
input.inp{flex:1;border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:10px;padding:9px 11px;font-size:15px;min-width:0}
.addl{display:flex;gap:8px}
.dmitem{padding:11px 0;border-bottom:1px solid var(--line)}
.dmitem:last-child{border-bottom:0}
.dmtop{display:flex;align-items:center;gap:8px}
.dmname{font-size:16px;font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dmact{display:flex;gap:7px;margin-top:8px}
.dmact a{flex:1}
.sw{display:inline-flex;align-items:center;justify-content:center;font-size:13px;padding:7px 12px;border-radius:10px;text-decoration:none;border:1px solid var(--line)}
.sw.on{background:rgba(31,157,107,.16);color:var(--ok);border-color:transparent}
.sw.off{background:rgba(154,167,161,.18);color:var(--mut)}
.verdict{font-size:12px;margin-top:6px;line-height:1.45}
nav{position:fixed;left:0;right:0;bottom:0;background:var(--tabbg);backdrop-filter:blur(14px);border-top:1px solid var(--line);display:flex;padding:6px 4px calc(6px + env(safe-area-inset-bottom))}
.tab{flex:1;border:0;background:transparent;color:var(--mut);font-size:10px;display:flex;flex-direction:column;align-items:center;gap:3px;padding:4px 0}
.tab.on{color:var(--acc)}
.tab svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.hint{font-size:12px;color:var(--mut);margin-top:8px;line-height:1.45}
.ev{padding:8px 0;border-bottom:1px solid var(--line);font-size:14px}
.ev:last-child{border-bottom:0}
.ev .t{color:var(--mut);font-size:12px;margin-top:1px}
.gap{color:var(--warn)}
a.lk{color:var(--acc);text-decoration:none}
</style>
</head>
<body>
<header>
  <h1><span class="dot" id="dot"></span> RouteHub <span class="mut small" id="hkey"></span></h1>
  <div class="banner" id="banner"></div>
  <div class="toolbar">
    <a class="refresh" href="http://rh.box/"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>Обновить</a>
    <span id="upd"></span>
    <label class="auto">Авто<span class="tg"><input type="checkbox" id="autoTg"><i></i></span></label>
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
var S={tab:'ov',seg:'wifi',h:null,auto:false};
function $id(i){return document.getElementById(i)}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function fts(t){if(!t)return '—';var d=new Date(t);if(isNaN(d))return String(t);function p(n){return (n<10?'0':'')+n}return p(d.getDate())+'.'+p(d.getMonth()+1)+' '+p(d.getHours())+':'+p(d.getMinutes())}
function ago(t){if(!t)return '—';var s=Math.round((Date.now()-new Date(t).getTime())/1000);if(s<0)s=0;if(s<90)return s+' с назад';var m=Math.round(s/60);if(m<90)return m+' мин назад';return Math.round(m/60)+' ч назад'}
function modeRu(m){return m==='normal'?'Норма':(m==='whitelist'?'Whitelist РКН':(m==='block'?'Блокировка':(m||'?')))}
function getRkn(){return (L.rkn&&L.rkn.mode)?L.rkn:((W&&W.rkn)||{})}
function topName(seg){var ms=(W.nodes&&W.nodes[seg])||[];return ms.length?ms[0].name:null}
function card(t,inner){return '<div class="card">'+(t?'<h3>'+t+'</h3>':'')+inner+'</div>'}
function kv(k,v){return '<div class="kv"><span class="mut">'+k+'</span><b>'+v+'</b></div>'}
function tile(lbl,big,sub){return '<div class="tile"><div class="lbl">'+lbl+'</div><div class="big">'+big+'</div>'+(sub?'<div class="sub">'+sub+'</div>':'')+'</div>'}
function stat(n,c,col){return '<div class="stat"><div class="n"'+(col?' style="color:'+col+'"':'')+'>'+n+'</div><div class="c">'+c+'</div></div>'}
function ring(sc){
  var col='var(--grey)',v=0;
  if(typeof sc==='number'){v=Math.max(0,Math.min(100,sc));col=sc>=70?'var(--ok)':(sc>=40?'var(--warn)':'var(--bad)')}
  var C=2*Math.PI*13,d=(C*v/100).toFixed(1);
  return '<svg class="ring" width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="13" fill="none" stroke="var(--line)" stroke-width="3.4"/><circle cx="18" cy="18" r="13" fill="none" stroke="'+col+'" stroke-width="3.4" stroke-linecap="round" stroke-dasharray="'+d+' '+C.toFixed(1)+'" transform="rotate(-90 18 18)"/><text x="18" y="22" text-anchor="middle" font-size="11" fill="var(--ink)">'+(typeof sc==='number'?sc:'·')+'</text></svg>';
}
function speedBars(seg){
  var ms=(W.nodes&&W.nodes[seg])||[];if(!ms.length)return '<div class="mut small">нет данных спидтеста</div>';
  var top=ms.slice(0,7),max=top[0]&&top[0].down||1,b='';
  for(var i=0;i<top.length;i++){var n=top[i],hp=Math.max(8,Math.round((n.down/max)*100));
    var col=n.score>=70?'var(--ok)':(n.score>=40?'var(--warn)':'var(--bad)');
    b+='<div class="bar" style="height:'+hp+'%;background:'+col+'" title="'+esc(n.name)+' '+n.down+' Мбит"></div>'}
  return '<div class="bars">'+b+'</div><div class="sub" style="margin-top:6px">'+(top[0]?top[0].down+' Мбит макс':'')+' · '+top.length+' лучших</div>';
}
function rOv(){
  var net=L.net||{},tr=W.traffic||{};
  var ms=(W.nodes&&W.nodes[S.seg])||[],alive=ms.length,maxd=ms.length?ms[0].down:0,voice=0;
  for(var v=0;v<ms.length;v++)if(ms[v].voice)voice++;
  var aiN=topName(S.seg)||'—';
  var h='';
  h+='<div class="tiles">'+
     tile('Лучший узел сейчас',esc(aiN),'по баллу спидтеста')+
     tile('Узлов с данными',alive+(maxd?' · '+maxd+' Мбит':''),'из подписки')+'</div>';
  var tcard='';
  if(tr.left_gb!=null){
    var pct=tr.total_gb>0?Math.round(tr.used_gb/tr.total_gb*100):0;
    var pcol=pct<70?'var(--ok)':(pct<90?'var(--warn)':'var(--bad)');
    tcard=kv('Осталось',(Math.round(tr.left_gb*10)/10)+' ГБ из '+(Math.round(tr.total_gb*10)/10))+
      '<div class="prog"><div style="width:'+pct+'%;background:'+pcol+'"></div></div>'+
      '<div class="sub">Использовано '+(Math.round(tr.used_gb*10)/10)+' ГБ · '+pct+'%'+(tr.expire?' · до '+fts(tr.expire*1000):'')+'</div>';
  } else tcard='<div class="mut small">нет данных о трафике</div>';
  h+=card('Трафик подписки',tcard);
  h+='<div class="stats">'+
     stat(alive,'узлов с данными','var(--ok)')+
     stat(maxd||'—','Мбит макс')+
     stat(voice,'для звонков','var(--acc)')+'</div>';
  h+=card('Скорость лучших узлов ('+(S.seg==='wifi'?'Wi-Fi':'сотовая')+')',speedBars(S.seg));
  var wl=(L.watch||[]),on=0;for(var j=0;j<wl.length;j++)if(wl[j].on)on++;
  h+=card('Личный список доменов',kv('Под наблюдением',wl.length)+kv('С обходом',on));
  return h;
}
function rNd(){
  var ms=(W.nodes&&W.nodes[S.seg])||[];
  var h='<div class="card"><div style="display:flex;gap:0;border:1px solid var(--line);border-radius:10px;overflow:hidden">'+
    '<button class="segb" data-g="wifi" style="flex:1;border:0;padding:8px;font-size:14px;background:'+(S.seg==='wifi'?'var(--acc)':'transparent')+';color:'+(S.seg==='wifi'?'#fff':'var(--mut)')+'">Wi-Fi</button>'+
    '<button class="segb" data-g="cell" style="flex:1;border:0;padding:8px;font-size:14px;background:'+(S.seg==='cell'?'var(--acc)':'transparent')+';color:'+(S.seg==='cell'?'#fff':'var(--mut)')+'">Сотовая</button></div></div>';
  var rows='';
  for(var i=0;i<ms.length;i++){var n=ms[i];
    rows+='<div class="row">'+ring(n.score)+'<div class="grow"><div class="nm">'+esc(n.name)+(n.voice?' <span class="chip ok">звонки</span>':'')+'</div><div class="sub">'+n.down+' Мбит · пинг '+n.rtt+' мс · джиттер '+n.jit+' · потери '+n.bl+'‰</div></div></div>'}
  h+=card('Узлы ('+ms.length+')',rows||'<div class="mut small">нет данных спидтеста — наполнится после ночного теста</div>');
  return h;
}
function verdict(e){
  if(!e||!e.last)return '';
  var Lx=e.last,m=Lx.mode,on=Lx.on,ok=Lx.ok;
  var t='';
  if(m==='whitelist'){
    if(on&&ok)t='Работает ЧЕРЕЗ обход. Это не значит «ожил» — обход нужен, не убирай.';
    else if(on&&!ok)t='Не открылся даже через обход — проблема не в маршруте (узел/домен).';
    else if(!on&&ok)t='Открылся БЕЗ обхода — обход можно убрать (домен жив напрямую).';
    else t='Без обхода не открывается — обход нужен, включи.';
  } else if(m==='normal'){
    t='Сейчас норма: проверка обхода недостоверна. Чтобы понять, нужен ли обход, проверяй под whitelist.';
  } else t='Режим неизвестен — результат ориентировочный.';
  return '<div class="verdict mut">'+t+'</div>';
}
function chipFor(e){
  if(!e||!e.last)return '<span class="chip na">не проверялся</span>';
  var Lx=e.last;
  if(Lx.ok)return '<span class="chip ok">открылся '+(Lx.status||'')+'</span>';
  return '<span class="chip bad">не открылся</span>';
}
function rDm(){
  var wl=L.watch||[],r=getRkn();
  var h=card('Добавить домен',
    '<form class="addl" action="http://rh.box/add" method="get"><input class="inp" name="d" placeholder="example.ru" autocapitalize="none" autocorrect="off"><button class="b pri" type="submit">Добавить</button></form>'+
    '<div class="hint">Новый домен сразу получает обход (попадает в личный список RH-RU).</div>');
  var rows='';
  for(var i=0;i<wl.length;i++){var e=wl[i],d=esc(e.d),de=encodeURIComponent(e.d);
    rows+='<div class="dmitem"><div class="dmtop"><span class="dmname">'+d+'</span>'+chipFor(e)+'</div>'+
      (e.last?'<div class="sub">проверен '+ago(e.last.ts)+' · '+modeRu(e.last.mode)+(e.last.on?' · был с обходом':' · был без обхода')+'</div>':'')+
      verdict(e)+
      '<div class="dmact">'+
        '<a class="b" href="http://rh.box/check?d='+de+'">Проверить</a>'+
        '<a class="sw '+(e.on?'on':'off')+'" href="http://rh.box/toggle?d='+de+'">'+(e.on?'обход вкл':'обход выкл')+'</a>'+
        '<a class="b dz" href="http://rh.box/del?d='+de+'">Удалить</a>'+
      '</div></div>'}
  h+=card('Список наблюдения ('+wl.length+')',(rows||'<div class="mut small">пусто</div>')+
    '<div class="btns"><a class="b" href="http://rh.box/sync">Синхронизировать с сервером</a><a class="b" href="https://nsloon.com/openloon/update?sub=all">Применить в Loon</a></div>'+
    '<div class="hint"><b>Как пользоваться.</b> «обход вкл» — домен идёт через обходной узел (нужно под whitelist РКН). «Проверить» открывает домен по текущему маршруту и пишет честный вывод с учётом режима. Чтобы узнать, нужен ли домену обход, — выключи обход и проверь ПОД whitelist: откроется без обхода → можно убрать, нет → обход нужен.'+
    (r.mode==='whitelist'?' <b style="color:var(--warn)">Сейчас whitelist.</b>':(r.mode==='normal'?' <b>Сейчас норма — для проверки обхода дождись whitelist.</b>':''))+'</div>');
  return h;
}
function rHs(){
  var hist=(L.rkn&&L.rkn.hist)||W.rkn_hist||[],hh='';
  for(var i=0;i<hist.length;i++){var md=hist[i].mode;var c=md==='normal'?'ok':(md==='whitelist'?'warn':'bad');
    hh+='<div class="ev"><span class="chip '+c+'">'+modeRu(md)+'</span><div class="t">'+fts(hist[i].ts)+'</div></div>'}
  var rl=L.runlog||[],rr='';
  for(var j=rl.length-1;j>=0;j--){var ev=rl[j],tx='';
    if(ev.s==='net')tx='Смена сети: '+esc(ev.n||'?')+(ev.w?' · whitelist':'')+(ev.o?' · '+esc(ev.o):'');
    else if(ev.s==='rkn')tx='Режим изменён: '+modeRu(ev.m);
    else if(ev.s==='dash')tx='Кэш дашборда: '+(ev.ok?'ок':'сбой'+(ev.note?' ('+esc(ev.note)+')':''));
    else if(ev.s==='cron')tx='Спидтест отработал'+(ev.n?' ('+esc(ev.n)+')':'');
    else tx=esc(ev.s||'событие')+(ev.note?': '+esc(ev.note):'');
    if(ev.gap)tx+=' <span class="gap">· перед этим разрыв '+ev.gap+' мин</span>';
    rr+='<div class="ev">'+tx+'<div class="t">'+fts(ev.t||ev.ts)+'</div></div>'}
  return card('Смены режима РКН',hh||'<div class="mut small">смен не зафиксировано</div>')+
         card('Журнал работы скриптов',rr||'<div class="mut small">журнал пуст — скрипты ещё не отрабатывали</div>')+
         card('Что это',('<div class="hint" style="margin-top:0">«Смены режима» — когда сеть переходила между нормой и whitelist РКН. «Журнал» — когда отрабатывали фоновые скрипты (спидтест, смена сети, детектор режима). Разрыв = промежуток, когда VPN/Loon не работал.</div>'));
}
function rSy(){
  var sc=[
    ['Спидтест','каждые 20 мин','меряет скорость, пинг и потери узлов'],
    ['Смена сети','при Wi-Fi↔сотовая','переключает узлы под текущую сеть'],
    ['Детектор РКН','каждые 10 мин','определяет режим: норма / whitelist / блок'],
    ['Кэш дашборда','каждые 15 мин','сохраняет данные для показа под whitelist'],
    ['Этот дашборд','по открытию','показывает состояние и список доменов']];
  var rows='';for(var i=0;i<sc.length;i++){rows+='<div class="row"><div class="grow"><div class="nm">'+sc[i][0]+'</div><div class="sub">'+sc[i][2]+'</div></div><span class="mut small">'+sc[i][1]+'</span></div>'}
  return card('Состояние системы',
      kv('Сервер (Worker)',esc(W.worker||'—'))+
      kv('Конфиг',esc(W.conf_ver||'—'))+
      kv('Дашборд',esc(L.ver||'—'))+
      kv('Подписка обновлена',(W.sub_age_min!=null?W.sub_age_min+' мин назад':'—'))+
      kv('Порядок узлов',W.last_nodes_ts?ago(W.last_nodes_ts):'—')+
      kv('Кэш дашборда',L.cache_ts?ago(L.cache_ts):'—'))+
    card('Фоновые скрипты',rows)+
    card('Loon','<div class="btns"><a class="lk b" href="loon://">Открыть Loon</a></div><div class="hint" style="margin-top:8px">Логи и список запросов смотри внутри приложения Loon.</div>');
}
function render(){
  var d=$id('dot');d.className='dot '+(SRC==='live'?'live':(SRC==='cache'?'cache':''));
  $id('hkey').textContent=KEY;
  $id('upd').textContent='снято '+fts(L.ts);
  var r=getRkn(),b=$id('banner');
  if(r&&r.mode){b.className='banner show '+r.mode;
    var txt=r.mode==='normal'?'Режим: Норма — узлы работают':(r.mode==='whitelist'?'Режим: Whitelist РКН — трафик идёт через обход':'Режим: Блокировка');
    b.textContent=txt+' · '+ago(r.ts)}else{b.className='banner'}
  var f={ov:rOv,nd:rNd,dm:rDm,hs:rHs,sy:rSy}[S.tab];if(f)$id('main').innerHTML=f();
  try{window.scrollTo(0,parseInt(localStorage.getItem('rh_scroll')||'0',10)||0)}catch(e){}
}
function setTab(t){var bs=document.querySelectorAll('.tab');for(var i=0;i<bs.length;i++)bs[i].classList.remove('on');
  for(var j=0;j<bs.length;j++)if(bs[j].getAttribute('data-t')===t)bs[j].classList.add('on');
  S.tab=t;try{localStorage.setItem('rh_tab',t)}catch(e){};render()}
document.addEventListener('click',function(ev){
  var t=ev.target.closest('.tab');if(t){setTab(t.getAttribute('data-t'));return}
  var g=ev.target.closest('.segb');if(g){S.seg=g.getAttribute('data-g');try{localStorage.setItem('rh_seg',S.seg)}catch(e){};render();return}
});
function saveScroll(){try{localStorage.setItem('rh_scroll',String(window.scrollY||window.pageYOffset||0))}catch(e){}}
window.addEventListener('scroll',function(){saveScroll()});
function doReload(){saveScroll();location.href='http://rh.box/'}
var autoEl=$id('autoTg');
try{S.auto=localStorage.getItem('rh_auto')==='1'}catch(e){}
if(autoEl){autoEl.checked=S.auto;
  autoEl.addEventListener('change',function(){S.auto=autoEl.checked;try{localStorage.setItem('rh_auto',S.auto?'1':'0')}catch(e){};armAuto()})}
function armAuto(){if(S.h){clearInterval(S.h);S.h=null}if(S.auto)S.h=setInterval(function(){if(!document.hidden)doReload()},15000)}
(function(){
  var t=null;try{t=localStorage.getItem('rh_tab')}catch(e){}
  var sg=null;try{sg=localStorage.getItem('rh_seg')}catch(e){}
  if(sg==='wifi'||sg==='cell')S.seg=sg;
  if(location.hash==='#dm')t='dm';else if(location.hash==='#hs')t='hs';else if(location.hash==='#nd')t='nd';else if(location.hash==='#sy')t='sy';
  if(t)S.tab=t;
  var bs=document.querySelectorAll('.tab');for(var i=0;i<bs.length;i++){bs[i].classList.remove('on');if(bs[i].getAttribute('data-t')===S.tab)bs[i].classList.add('on')}
})();
render();armAuto();
</script>
</body>
</html>`;

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
