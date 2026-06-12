// =============================================================
// routehub-dash.js v0.2.0 — локальный дашборд RouteHub (диспетчер + HTML).
// Тип: http-request на ^http:\/\/rh\.box (HTTP, без MITM).
// argument = "<key>|<origin>" (Worker инжектит при выдаче /config).
//
// МАРШРУТЫ (все GET):
//   /            -> HTML-дашборд (вшит ниже, 5 вкладок).
//   /local       -> JSON локального состояния: rh_watch, rh_rkn, rh_net_state,
//                   rh_runlog (последние 60), кэш rh_dash (фолбэк страницы).
//   /add?d=      -> добавить домен в список наблюдения (обход ВКЛ) + Worker /addrule.
//   /del?d=      -> удалить домен; если обход был ВКЛ — Worker /delrule.
//   /toggle?d=   -> переключить тумблер обхода; ВКЛ->addrule, ВЫКЛ->delrule.
//   /sync        -> сверка: Worker /mylist vs локальные ВКЛ; досылка/удаление расхождений.
//   /check?d=    -> проверка ОДНОГО домена fetch-ом ПО ПРАВИЛАМ конфига (T1:
//                   node игнорируется, поэтому канал проверки определяют правила:
//                   обход-ВКЛ домен в норме идёт RH-RU->DIRECT (= «ожил?»),
//                   под whitelist -> обход (= «обход спасает?»); результат
//                   подписывается режимом на момент проверки).
//
// ИСТОЧНИК ПРАВДЫ списка — store rh_watch; KV mylist:<kN> — зеркало (только ВКЛ).
// Мутации списка — ТОЛЬКО через этот диспетчер. Чтение /dashboard — страница
// делает напрямую с Worker (CORS открыт с worker v1.7.0).
// Засев rh_watch (решение Дианы 2026-06-12): ТОЛЬКО whoosh.bike (обход ВКЛ).
// =============================================================

var VERSION = 'dash v0.2.0';
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

function resp(status, type, body) {
  $done({ response: { status: status, headers: { 'Content-Type': type, 'Cache-Control': 'no-store' }, body: body } });
}
function json(o) { resp(200, 'application/json; charset=utf-8', JSON.stringify(o)); }
function jerr(msg) { resp(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, err: msg })); }

function wPost(path, body, cb) {
  $httpClient.post({ url: ORIGIN + path, timeout: 5000, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    function (e, r, b) { cb(!e && r && r.status >= 200 && r.status < 300, b || ''); });
}
function wGet(path, cb) {
  $httpClient.get({ url: ORIGIN + path, timeout: 5000 }, function (e, r, b) { cb(!e && r && r.status >= 200 && r.status < 300, b || ''); });
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
// HTML (вшит; плейсхолдеры __KEY__/__ORIGIN__ заменяются при выдаче).
// В JS страницы НЕТ обратных кавычек и "${" — текст безопасен в шаблоне.
// =============================================================
var HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="RouteHub">
<link rel="apple-touch-icon" href="https://raw.githubusercontent.com/spxload/routehub/main/assets/routehub-icon-180.png">
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
button.b{border:1px solid var(--line);background:var(--card);color:var(--acc);border-radius:10px;padding:7px 12px;font-size:14px}
button.b:active,.tab:active{transform:scale(.98)}
button.b.pri{background:var(--acc);border-color:var(--acc);color:#fff}
.btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
input.inp{flex:1;border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:10px;padding:8px 10px;font-size:15px;min-width:0}
.addl{display:flex;gap:8px}
.sw{position:relative;width:46px;height:28px;flex:none}
.sw input{display:none}
.sw i{position:absolute;inset:0;border-radius:99px;background:var(--line);transition:.15s}
.sw i:after{content:'';position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;transition:.15s;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.sw input:checked+i{background:var(--ok)}
.sw input:checked+i:after{left:21px}
.ring{flex:none}
nav{position:fixed;left:0;right:0;bottom:0;background:var(--tabbg);backdrop-filter:blur(14px);border-top:1px solid var(--line);display:flex;padding:6px 4px calc(6px + env(safe-area-inset-bottom))}
.tab{flex:1;border:0;background:transparent;color:var(--mut);font-size:10px;display:flex;flex-direction:column;align-items:center;gap:3px;padding:4px 0}
.tab.on{color:var(--acc)}
.tab svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.skel{height:14px;border-radius:7px;background:linear-gradient(90deg,var(--line),var(--card),var(--line));background-size:200% 100%;animation:sk 1.1s infinite}
@keyframes sk{0%{background-position:0 0}100%{background-position:-200% 0}}
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
    Live:
    <span class="seg" id="liveSeg">
      <button data-s="10">10с</button><button data-s="15" class="on">15с</button><button data-s="30">30с</button><button data-s="0">пауза</button>
    </span>
    <span id="upd" class="mut"></span>
  </div>
</header>
<main id="main"><div class="card"><div class="skel"></div><div class="skel" style="margin-top:8px;width:70%"></div></div></main>
<nav>
  <button class="tab on" data-t="ov"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="8.4"/><path d="M12 3.6v2.2M12 18.2v2.2M3.6 12h2.2M18.2 12h2.2"/></svg>Обзор</button>
  <button class="tab" data-t="nd"><svg viewBox="0 0 24 24"><circle cx="5.5" cy="6" r="2"/><circle cx="18.5" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 7.4 10.7 16M17 7.4 13.3 16M7.5 6h9"/></svg>Узлы</button>
  <button class="tab" data-t="dm"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8M12 3.6c2.6 2.3 3.9 5.1 3.9 8.4s-1.3 6.1-3.9 8.4c-2.6-2.3-3.9-5.1-3.9-8.4s1.3-6.1 3.9-8.4z"/></svg>Домены</button>
  <button class="tab" data-t="hs"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.2V12l3.2 2"/></svg>История</button>
  <button class="tab" data-t="sy"><svg viewBox="0 0 24 24"><rect x="4.5" y="4.5" width="15" height="15" rx="4"/><circle cx="12" cy="12" r="3"/><path d="M12 4.5V7M12 17v2.5M4.5 12H7M17 12h2.5"/></svg>Система</button>
</nav>
<script>
var KEY='__KEY__',ORIGIN='__ORIGIN__';
var S={w:null,l:null,src:'none',tab:'ov',seg:'wifi',sec:15,h:null,busy:false};
function $id(i){return document.getElementById(i)}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function fts(t){if(!t)return '—';var d=new Date(t);if(isNaN(d))return String(t);function p(n){return (n<10?'0':'')+n}return p(d.getDate())+'.'+p(d.getMonth()+1)+' '+p(d.getHours())+':'+p(d.getMinutes())}
function ago(t){if(!t)return '—';var s=Math.round((Date.now()-new Date(t).getTime())/1000);if(s<0)s=0;if(s<90)return s+' с назад';var m=Math.round(s/60);if(m<90)return m+' мин назад';return Math.round(m/60)+' ч назад'}
function modeRu(m){return m==='normal'?'Норма':(m==='whitelist'?'Whitelist РКН':(m==='block'?'Блокировка':(m||'?')))}
function getRkn(){return (S.l&&S.l.rkn&&S.l.rkn.mode)?S.l.rkn:((S.w&&S.w.rkn)||{})}
function jget(u,cb){var x=new XMLHttpRequest();x.open('GET',u,true);x.timeout=8000;x.onreadystatechange=function(){if(x.readyState===4){if(x.status>=200&&x.status<300){try{cb(null,JSON.parse(x.responseText))}catch(e){cb(e)}}else cb(new Error('http '+x.status))}};x.ontimeout=function(){cb(new Error('timeout'))};x.onerror=function(){cb(new Error('net'))};x.send()}
function poll(){
  jget('/local?t='+Date.now(),function(e,l){if(!e&&l)S.l=l;step()});
  function step(){
    jget(ORIGIN+'/dashboard?key='+KEY+'&t='+Date.now(),function(e,w){
      if(!e&&w){S.w=w;S.src='live';try{localStorage.setItem('rh_w',JSON.stringify({ts:Date.now(),w:w}))}catch(x){}}
      else{
        if(S.l&&S.l.cache){S.w=S.l.cache;S.src='cache'}
        else{try{var z=JSON.parse(localStorage.getItem('rh_w')||'');if(z&&z.w){S.w=z.w;S.src='ls'}}catch(x2){}}
      }
      $id('upd').textContent='обновлено '+fts(Date.now());
      render();
    });
  }
}
function render(){
  var d=$id('dot');d.className='dot '+(S.src==='live'?'live':(S.src==='cache'?'cache':(S.src==='ls'?'ls':'')));
  $id('hkey').textContent=KEY;
  var r=getRkn(),b=$id('banner');
  if(r&&r.mode){b.className='banner show '+r.mode;b.textContent='Режим: '+modeRu(r.mode)+' · '+ago(r.ts)}else{b.className='banner'}
  var f={ov:rOv,nd:rNd,dm:rDm,hs:rHs,sy:rSy}[S.tab];if(f)$id('main').innerHTML=f();
}
function card(t,inner){return '<div class="card">'+(t?'<h3>'+t+'</h3>':'')+inner+'</div>'}
function kv(k,v){return '<div class="kv"><span class="mut">'+k+'</span><b>'+v+'</b></div>'}
function rOv(){
  var w=S.w||{},l=S.l||{},net=l.net||{},tr=w.traffic||{},r=getRkn();
  var h='';
  h+=card('Состояние',
    kv('Режим сети',modeRu(r.mode)+' <span class="mut small">'+ago(r.ts)+'</span>')+
    kv('Сеть устройства',esc(net.net||'—')+(net.ssid?' · '+esc(net.ssid):'')+(net.operator?' · '+esc(net.operator):''))+
    kv('Источник данных',S.src==='live'?'Worker (live)':(S.src==='cache'?'кэш rh_dash':(S.src==='ls'?'localStorage':'нет'))));
  h+=card('Подписка',
    kv('Узлов',(w.sub_nodes!=null?w.sub_nodes:'—')+' <span class="mut small">обновл. '+(w.sub_age_min!=null?w.sub_age_min+' мин назад':'—')+'</span>')+
    (tr.left_gb!=null?kv('Трафик',(Math.round(tr.used_gb*10)/10)+' / '+(Math.round(tr.total_gb*10)/10)+' ГБ · ост. '+(Math.round(tr.left_gb*10)/10)):'')+
    (tr.expire?kv('Действует до',fts(tr.expire*1000)):''));
  var ms=(w.metrics&&w.metrics[S.seg])||[];var top=ms.slice(0,3),t3='';
  for(var i=0;i<top.length;i++){t3+='<div class="row">'+ring(top[i].score)+'<div class="grow"><div class="nm">'+esc(top[i].name)+'</div><div class="sub">'+top[i].down+' Мбит · '+top[i].rtt+' мс</div></div></div>'}
  h+=card('Топ узлов ('+(S.seg==='wifi'?'Wi-Fi':'сотовая')+')',t3||'<div class="mut small">нет данных</div>');
  var wl=(l.watch||[]),on=0;for(var j=0;j<wl.length;j++)if(wl[j].on)on++;
  h+=card('Личный список',kv('Под наблюдением',wl.length)+kv('С обходом',on));
  h+=card('Конфиг',kv('Версия',esc(w.conf_ver||'—'))+kv('Worker',esc(w.worker||'—')));
  return h;
}
function ring(sc){
  var col='var(--grey)',v=0;
  if(typeof sc==='number'){v=Math.max(0,Math.min(100,sc));col=sc>=70?'var(--ok)':(sc>=40?'var(--warn)':'var(--bad)')}
  var C=2*Math.PI*13,d=(C*v/100).toFixed(1);
  return '<svg class="ring" width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="13" fill="none" stroke="var(--line)" stroke-width="3.4"/><circle cx="18" cy="18" r="13" fill="none" stroke="'+col+'" stroke-width="3.4" stroke-linecap="round" stroke-dasharray="'+d+' '+C.toFixed(1)+'" transform="rotate(-90 18 18)"/><text x="18" y="22" text-anchor="middle" font-size="11" fill="var(--ink)">'+(typeof sc==='number'?sc:'·')+'</text></svg>';
}
function rNd(){
  var w=S.w||{},ms=(w.metrics&&w.metrics[S.seg])||[];
  var h='<div class="card"><div class="seg" id="ndSeg"><button data-g="wifi" class="'+(S.seg==='wifi'?'on':'')+'">Wi-Fi</button><button data-g="cell" class="'+(S.seg==='cell'?'on':'')+'">Сотовая</button></div></div>';
  var rows='';
  for(var i=0;i<ms.length;i++){var n=ms[i];
    rows+='<div class="row">'+ring(n.score)+'<div class="grow"><div class="nm">'+esc(n.name)+(n.voice?' ☎':'')+'</div><div class="sub">'+n.down+' Мбит · rtt '+n.rtt+' · jit '+n.jit+' · потери '+n.bl+'‰ · ок '+n.pct+'%</div></div></div>'}
  h+=card('Узлы ('+ms.length+')',rows||'<div class="mut small">нет данных спидтеста</div>');
  return h;
}
function chipFor(e){
  if(!e||!e.last)return '<span class="chip na">не проверялся</span>';
  var L=e.last,m=L.mode?(' · '+modeRu(L.mode)):'';
  if(L.ok)return '<span class="chip ok">открылся'+m+' · '+ago(L.ts)+'</span>';
  return '<span class="chip bad">не открылся'+m+' · '+ago(L.ts)+'</span>';
}
function rDm(){
  var l=S.l||{},wl=l.watch||[],r=getRkn();
  var h=card('Добавить домен','<div class="addl"><input class="inp" id="nd" placeholder="example.ru" autocapitalize="none" autocorrect="off"><button class="b pri" onclick="addD()">Добавить</button></div><div class="hint">Новый домен сразу получает обход (попадает в личный список RH-RU).</div>');
  var rows='';
  for(var i=0;i<wl.length;i++){var e=wl[i],d=esc(e.d);
    rows+='<div class="row"><div class="grow"><div class="nm">'+d+'</div><div class="sub">'+chipFor(e)+'</div></div>'+
      '<button class="b" onclick="chk(\''+d+'\')">Проверить</button>'+
      '<label class="sw"><input type="checkbox" '+(e.on?'checked':'')+' onchange="tg(\''+d+'\')"><i></i></label>'+
      '<button class="b" onclick="delD(\''+d+'\')">✕</button></div>'}
  h+=card('Список наблюдения',(rows||'<div class="mut small">пусто</div>')+
    '<div class="btns"><button class="b" onclick="chkAll()">Проверить все</button><button class="b" onclick="syncL()">Синхронизировать</button><button class="b" onclick="applyLoon()">Применить в Loon</button></div>'+
    '<div class="hint">Тумблер = «через обход». Проверка идёт по правилам конфига: в норме домен с обходом-ВКЛ идёт DIRECT (ответ = «ожил?»); под whitelist — через обход. Режим на момент проверки указан в результате.'+(r.mode==='whitelist'?' <b>Сейчас whitelist: вывод «ожил» недостоверен.</b>':'')+'</div>');
  h+='<div id="dmlog" class="mut small"></div>';
  return h;
}
function rHs(){
  var l=S.l||{},w=S.w||{};
  var hist=(l.rkn&&l.rkn.hist)||w.rkn_hist||[],hh='';
  for(var i=0;i<hist.length;i++){hh+='<div class="ev">'+modeRu(hist[i].mode)+'<div class="t">'+fts(hist[i].ts)+'</div></div>'}
  var rl=l.runlog||[],rr='';
  for(var j=rl.length-1;j>=0;j--){var ev=rl[j],tx='';
    if(ev.s==='net')tx='Сеть: '+esc(ev.n||'?')+(ev.w?' · WHITELIST':'')+(ev.o?' · '+esc(ev.o):'');
    else tx=esc(ev.s||'событие')+(ev.note?': '+esc(ev.note):'');
    if(ev.gap)tx+=' <span class="gap">· разрыв '+ev.gap+' мин</span>';
    rr+='<div class="ev">'+tx+'<div class="t">'+fts(ev.t||ev.ts)+'</div></div>'}
  return card('Смены режима РКН',hh||'<div class="mut small">смен не зафиксировано</div>')+
         card('Журнал событий (локальный)',rr||'<div class="mut small">журнал пуст — скрипты ещё не писали</div>');
}
function rSy(){
  var w=S.w||{},l=S.l||{};
  var sc=[
    ['RH-Speed','cron 20 мин','спидтест: метрики узлов (down/rtt/jit/потери), пинг-свип'],
    ['RH-Net','смена сети','флип групп -W/-C, детект сети, журнал'],
    ['RH-RKN','cron 10 мин','режим сети (норма/whitelist/блок), история смен'],
    ['RH-DashCache','cron 15 мин','кэш /dashboard в rh_dash (фолбэк под whitelist)'],
    ['RH-Dash','по запросу','этот дашборд и команды списка'],
    ['RH-Viewer','вручную','таблица узлов в лог Loon']];
  var rows='';for(var i=0;i<sc.length;i++){rows+='<div class="row"><div class="grow"><div class="nm">'+sc[i][0]+' <span class="mut small">'+sc[i][1]+'</span></div><div class="sub">'+sc[i][2]+'</div></div></div>'}
  return card('Инфраструктура',
      kv('Worker',esc(w.worker||'—'))+
      kv('Конфиг',esc(w.conf_ver||'—'))+
      kv('Подписка',(w.sub_age_min!=null?w.sub_age_min+' мин назад':'—'))+
      kv('Узлы (порядок)',w.last_nodes_ts?ago(w.last_nodes_ts):'—')+
      kv('Кэш дашборда',l.cache_ts?ago(l.cache_ts):'—')+
      kv('Дашборд',esc((l.ver||'')+'')))+
    card('Скрипты',rows)+
    card('Loon','<div class="btns"><a class="lk b" href="loon://LogLists">Логи Loon</a><a class="lk b" href="loon://requestLists">Запросы Loon</a></div>');
}
function dmlog(t){var e=$id('dmlog');if(e)e.textContent=t}
function act(u,cb){if(S.busy)return;S.busy=true;jget(u,function(e,r){S.busy=false;cb(e,r)})}
function addD(){var v=($id('nd').value||'').trim().toLowerCase();if(!v)return;
  act('/add?d='+encodeURIComponent(v),function(e,r){
    if(e||!r||!r.ok){dmlog('Ошибка добавления'+(r&&r.err?': '+r.err:''));return}
    dmlog(r.synced?'Добавлен и отправлен на Worker.':'Добавлен локально; Worker недоступен — нажми «Синхронизировать».');
    poll()})}
function tg(d){act('/toggle?d='+encodeURIComponent(d),function(e,r){dmlog(e||!r||!r.ok?'Ошибка переключения':((r.on?'Обход ВКЛ':'Обход ВЫКЛ')+(r.synced?', Worker обновлён.':', Worker недоступен — «Синхронизировать».')));poll()})}
function delD(d){act('/del?d='+encodeURIComponent(d),function(e,r){dmlog(e||!r||!r.ok?'Ошибка удаления':'Удалён.');poll()})}
function chk(d){dmlog('Проверяю '+d+'…');act('/check?d='+encodeURIComponent(d),function(e,r){
  if(e||!r){dmlog('Проверка не выполнилась');return}
  dmlog(d+': '+(r.ok?'открылся':'не открылся')+' ('+(r.status||'—')+', '+r.ms+' мс, режим '+modeRu(r.mode)+')');poll()})}
function chkAll(){var l=S.l||{},wl=l.watch||[],i=0;
  function next(){if(i>=wl.length){dmlog('Проверка всех завершена.');poll();return}
    var d=wl[i].d;i++;dmlog('Проверяю '+d+' ('+i+'/'+wl.length+')…');
    jget('/check?d='+encodeURIComponent(d),function(){setTimeout(next,250)})}
  next()}
function syncL(){dmlog('Синхронизирую…');act('/sync',function(e,r){
  if(e||!r||!r.ok){dmlog('Синхронизация не удалась');return}
  dmlog('Синхронизировано: +'+r.added+' / −'+r.removed+' (в KV: '+r.kv+')');poll()})}
function applyLoon(){location.href='https://nsloon.com/openloon/update?sub=all'}
document.addEventListener('click',function(ev){
  var t=ev.target.closest('.tab');if(t){var bs=document.querySelectorAll('.tab');for(var i=0;i<bs.length;i++)bs[i].classList.remove('on');t.classList.add('on');S.tab=t.getAttribute('data-t');render();return}
  var g=ev.target.closest('#ndSeg button,#liveSeg button');if(!g)return;
  if(g.parentNode.id==='ndSeg'){S.seg=g.getAttribute('data-g');render()}
  else{var bb=g.parentNode.querySelectorAll('button');for(var k=0;k<bb.length;k++)bb[k].classList.remove('on');g.classList.add('on');S.sec=parseInt(g.getAttribute('data-s'),10);restart()}
});
function restart(){if(S.h){clearInterval(S.h);S.h=null}if(S.sec>0)S.h=setInterval(function(){if(!document.hidden)poll()},S.sec*1000)}
document.addEventListener('visibilitychange',function(){if(!document.hidden)poll()});
if(location.hash==='#dm')S.tab='dm';if(location.hash==='#hs')S.tab='hs';
poll();restart();
</script>
</body>
</html>`;

// =============================================================
// Маршруты диспетчера
// =============================================================
function routeHtml() {
  var body = HTML.split('__KEY__').join(KEY).split('__ORIGIN__').join(ORIGIN);
  resp(200, 'text/html; charset=utf-8', body);
}

function routeLocal() {
  var rkn = rj(K_RKN, {}) || {};
  var cache = rj(K_DASH, null);
  var rl = rj(K_RUNLOG, []);
  if (!Array.isArray(rl)) rl = [];
  json({
    ok: true, ver: VERSION, ts: Date.now(), key: KEY, origin: ORIGIN,
    watch: watchLoad(),
    rkn: { mode: rkn.mode, ts: rkn.ts, hist: rkn.hist || [] },
    net: rj(K_NET, null),
    runlog: rl.slice(-60),
    cache: cache && cache.data ? cache.data : cache,
    cache_ts: cache && cache.ts ? cache.ts : null
  });
}

function routeAdd() {
  var d = q('d').toLowerCase();
  if (!DOMAIN_RE.test(d) || d.length > 80) { jerr('невалидный домен'); return; }
  var w = watchLoad();
  for (var i = 0; i < w.length; i++) if (w[i].d === d) { jerr('уже в списке'); return; }
  w.push({ d: d, on: true, ts: Date.now() });
  watchSave(w);
  wPost('/addrule', { key: KEY, domain: d }, function (ok) { json({ ok: true, synced: ok }); });
}

function routeDel() {
  var d = q('d').toLowerCase();
  var w = watchLoad(), wasOn = false, nw = [];
  for (var i = 0; i < w.length; i++) { if (w[i].d === d) { wasOn = !!w[i].on; } else nw.push(w[i]); }
  if (nw.length === w.length) { jerr('нет в списке'); return; }
  watchSave(nw);
  if (wasOn) wPost('/delrule', { key: KEY, domain: d }, function (ok) { json({ ok: true, synced: ok }); });
  else json({ ok: true, synced: true });
}

function routeToggle() {
  var d = q('d').toLowerCase();
  var w = watchLoad(), e = null;
  for (var i = 0; i < w.length; i++) if (w[i].d === d) e = w[i];
  if (!e) { jerr('нет в списке'); return; }
  e.on = !e.on;
  watchSave(w);
  wPost(e.on ? '/addrule' : '/delrule', { key: KEY, domain: d }, function (ok) { json({ ok: true, on: e.on, synced: ok }); });
}

function routeSync() {
  wGet('/mylist?key=' + KEY, function (ok, body) {
    if (!ok) { jerr('Worker недоступен'); return; }
    var remote = {};
    var lines = String(body).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^DOMAIN-SUFFIX,([a-z0-9.-]+),/i) || lines[i].match(/^DOMAIN-SUFFIX,([a-z0-9.-]+)\s*$/i);
      if (m) remote[m[1].toLowerCase()] = true;
    }
    var w = watchLoad(), localOn = {}, i2;
    for (i2 = 0; i2 < w.length; i2++) if (w[i2].on) localOn[w[i2].d] = true;
    var toAdd = [], toDel = [];
    for (var d1 in localOn) if (!remote[d1]) toAdd.push(d1);
    for (var d2 in remote) if (!localOn[d2]) toDel.push(d2);
    var added = 0, removed = 0;
    function doAdd(k) {
      if (k >= toAdd.length) { doDel(0); return; }
      wPost('/addrule', { key: KEY, domain: toAdd[k] }, function (ok2) { if (ok2) added++; doAdd(k + 1); });
    }
    function doDel(k) {
      if (k >= toDel.length) {
        var kvN = 0; for (var x in remote) kvN++;
        json({ ok: true, added: added, removed: removed, kv: kvN - removed + added });
        return;
      }
      wPost('/delrule', { key: KEY, domain: toDel[k] }, function (ok3) { if (ok3) removed++; doDel(k + 1); });
    }
    doAdd(0);
  });
}

function routeCheck() {
  var d = q('d').toLowerCase();
  if (!DOMAIN_RE.test(d)) { jerr('невалидный домен'); return; }
  var rkn = rj(K_RKN, {}) || {};
  var t0 = Date.now();
  function fin(okFlag, status) {
    var ms = Date.now() - t0;
    var w = watchLoad();
    for (var i = 0; i < w.length; i++) if (w[i].d === d) {
      w[i].last = { ok: okFlag, status: status || 0, ms: ms, ts: Date.now(), mode: rkn.mode || '?' };
      watchSave(w);
      break;
    }
    json({ ok: okFlag, status: status || 0, ms: ms, mode: rkn.mode || '?' });
  }
  $httpClient.get({ url: 'https://' + d + '/', timeout: 4000 }, function (e1, r1) {
    if (!e1 && r1 && r1.status) { fin(r1.status < 500, r1.status); return; }
    $httpClient.get({ url: 'http://' + d + '/', timeout: 3000 }, function (e2, r2) {
      if (!e2 && r2 && r2.status) { fin(r2.status < 500, r2.status); return; }
      fin(false, 0);
    });
  });
}

// --- диспетчеризация ---
try {
  if (PATH === '/' || PATH === '/index.html') routeHtml();
  else if (PATH === '/local') routeLocal();
  else if (PATH === '/add') routeAdd();
  else if (PATH === '/del') routeDel();
  else if (PATH === '/toggle') routeToggle();
  else if (PATH === '/sync') routeSync();
  else if (PATH === '/check') routeCheck();
  else resp(404, 'application/json; charset=utf-8', JSON.stringify({ ok: false, err: 'нет маршрута', path: PATH }));
} catch (eX) {
  resp(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, err: 'краш: ' + ((eX && eX.message) || eX) }));
}
