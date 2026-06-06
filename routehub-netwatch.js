// =============================================================
// routehub-netwatch.js — RouteHub, диспетчер смены сети (Этап D, шаг D.7)
var VERSION = 'netwatch v0.1.0 (2026-06-06)';
//
// Тип: network-changed. ЕДИНСТВЕННЫЙ скрипт этого типа (И4: при наличии
//   нескольких вызывается только первый). Аргумент "<key>|<origin>|<opts>"
//   (как у спидтеста; добавляется Worker'ом). opts: autorefresh.
//
// ЗАДАЧИ:
//   1. Определить ТИП сети без геолокации, слоями:
//      Слой 1: ssid из $config.getConfig() -> Wi-Fi (грабли #5: часто пуст).
//      Слой 2 (сотовая): маяки общего интернета (gstatic+cloudflare 204,
//        через DIRECT) vs Яндекс. Общий жив -> cell. Общий мёртв + Яндекс жив
//        -> cell-whitelist (РКН whitelist). Оба мертвы -> offline.
//      Слой 3 (оператор, best-effort): origin/whoami через DIRECT
//        (request.cf.asOrganization); при whitelist Worker может быть недоступен
//        -> фолбэк: страница Яндекса, IP регуляркой, $utils.ipaso(ip).
//   2. Запомнить домашние SSID (rh_home_ssids) и оператора (rh_net_state).
//   3. autorefresh (опц.): при СМЕНЕ типа сети — тап-пуш loon://update?sub=all
//      (полностью тихое обновление в Loon невозможно — только по тапу).
//
// НЕ делает: авто-обход при whitelist (это маршрутизация, Этап F) — только
//   фиксирует флаг whitelist и шлёт пуш. НЕ переключает сеть (Loon не умеет).
// =============================================================

var GEN_BEACONS = ['http://www.gstatic.com/generate_204', 'http://cp.cloudflare.com/generate_204'];
var YANDEX_PING = 'https://ya.ru';                 // Яндекс доступен при whitelist
var ECHO_URL = 'https://yandex.ru/internet/';      // IP в теле; ПРОВЕРИТЬ на устройстве (D.10)
var BEACON_TIMEOUT = 6000;

var NET_KEY = 'rh_net_state';        // {net, ssid, operator, asn, whitelist, ts}
var HOME_KEY = 'rh_home_ssids';      // { ssid: count }
var ASO_KEY = 'rh_home_aso';         // оператор домашней сотовой (на будущее)
var LAST_NET_KEY = 'rh_last_net';    // тип сети прошлого вызова (для autorefresh)

var now = function () { return Date.now(); };
function log(m) { console.log('[RH-Net] ' + m); }
function readJSON(k, d) { try { var s = $persistentStore.read(k); return s ? JSON.parse(s) : d; } catch (e) { return d; } }
function writeJSON(k, o) { try { $persistentStore.write(JSON.stringify(o), k); } catch (e) {} }

function probe(url, direct) {
  return new Promise(function (resolve) {
    var opt = { url: url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now(), timeout: BEACON_TIMEOUT };
    if (direct) opt.node = 'DIRECT';
    $httpClient.get(opt, function (err, resp, body) {
      if (err || !resp) resolve({ ok: false });
      else resolve({ ok: resp.status >= 200 && resp.status < 400, status: resp.status, body: body || '' });
    });
  });
}
async function anyAlive(urls) {
  for (var i = 0; i < urls.length; i++) { var r = await probe(urls[i], true); if (r.ok) return true; }
  return false;
}
function extractIp(text) {
  if (!text) return '';
  var m = text.match(/(?:\d{1,3}\.){3}\d{1,3}/);
  return m ? m[0] : '';
}
async function detectOperator(origin) {
  // a) Worker /whoami через DIRECT
  if (origin && /^https?:\/\//.test(origin)) {
    var r = await probe(origin + '/whoami', true);
    if (r.ok && r.body) {
      try { var j = JSON.parse(r.body); if (j && (j.aso || j.asOrganization)) return { op: j.aso || j.asOrganization, asn: j.asn || null, src: 'whoami' }; } catch (e) {}
    }
  }
  // b) фолбэк: IP из страницы Яндекса -> $utils.ipaso локально
  var e = await probe(ECHO_URL, true);
  var ip = e.ok ? extractIp(e.body) : '';
  if (ip) {
    try { var aso = $utils.ipaso(ip); if (aso) return { op: String(aso), asn: null, src: 'ipaso' }; } catch (e2) {}
    return { op: '', asn: null, src: 'ip:' + ip };
  }
  return { op: '', asn: null, src: 'none' };
}

async function main() {
  log('=== ' + VERSION + ' ===');
  var arg = (typeof $argument === 'string') ? $argument : '';
  var p = arg.split('|');
  var ORIGIN = p[1] || '', OPTS = p[2] || '';
  var autorefresh = OPTS.indexOf('autorefresh') >= 0;

  // Слой 1: ssid
  var ssid = '';
  try { var cfg = JSON.parse($config.getConfig()); ssid = cfg && cfg.ssid ? String(cfg.ssid) : ''; } catch (e) {}

  var net, whitelist = false, operator = '', asn = null;

  if (ssid) {
    net = 'wifi';
    var home = readJSON(HOME_KEY, {});
    home[ssid] = (home[ssid] || 0) + 1;
    writeJSON(HOME_KEY, home);
  } else {
    // Слой 2: сотовая — общий интернет vs Яндекс
    var gen = await anyAlive(GEN_BEACONS);
    if (gen) {
      net = 'cell';
    } else {
      var ya = await probe(YANDEX_PING, true);
      if (ya.ok) { net = 'cell-whitelist'; whitelist = true; }
      else { net = 'offline'; }
    }
    // Слой 3: оператор (best-effort), только если есть связь
    if (net !== 'offline') {
      var op = await detectOperator(ORIGIN);
      operator = op.op; asn = op.asn;
      if (operator) { var prev = $persistentStore.read(ASO_KEY) || ''; if (prev !== operator) $persistentStore.write(operator, ASO_KEY); }
      log('оператор=' + (operator || '?') + ' (' + op.src + ')');
    }
  }

  var st = { net: net, ssid: ssid, operator: operator, asn: asn, whitelist: whitelist, ts: now() };
  writeJSON(NET_KEY, st);
  log('сеть=' + net + (ssid ? ' ssid=[' + ssid + ']' : '') + (whitelist ? ' WHITELIST' : ''));

  // пуш о whitelist (обход — Этап F; здесь только сигнал)
  if (whitelist) {
    $notification.post('\uD83D\uDEA7 RouteHub', 'Похоже на whitelist РКН',
      'Общий интернет недоступен, Яндекс работает. Для обхода может потребоваться группа RH-Обход.');
  }

  // autorefresh: только при СМЕНЕ типа сети — тап-пуш обновления
  var lastNet = $persistentStore.read(LAST_NET_KEY) || '';
  if (net !== lastNet) {
    $persistentStore.write(net, LAST_NET_KEY);
    if (autorefresh && net !== 'offline' && lastNet) {
      $notification.post('\uD83D\uDD04 RouteHub', 'Сеть сменилась: ' + lastNet + ' \u2192 ' + net,
        'Нажмите, чтобы обновить узлы/метки', { 'open-url': 'loon://update?sub=all' });
    }
  }

  $done({});
}

main().catch(function (err) { log('КРАШ: ' + ((err && err.message) || err)); $done({}); });
