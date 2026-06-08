// =============================================================
// routehub-netwatch.js — RouteHub, диспетчер смены сети (Этап E, модель двух подписок)
var VERSION = 'netwatch v0.4.0 (2026-06-08)';
//
// Тип: network-changed. ЕДИНСТВЕННЫЙ скрипт этого типа (И4).
//   Аргумент "<key>|<origin>|<opts>".
//
// ЗАДАЧИ (модель двух подписок, C-draft-14):
//   1. Детект типа сети: ssid -> маяки generate_204 -> Яндекс.
//   2. Детект whitelist РКН (пуш).
//   3. ФЛИП родительских select-групп по сети: RH-AI/RH-АВТО/RH-Звонки -> *-W или *-C.
//      Узел внутри выбирает fallback-ребёнок сам (Германия-якорь порядком фильтров,
//      обход последним). Скрипт узлы НЕ выбирает (RH-Core/RH-Health выключены).
//
// Сеть не переключает. Гонка: RH_script_lock вокруг флипа.
// =============================================================

var FLIP_GROUPS = ['RH-AI', 'RH-АВТО', 'RH-Звонки'];

var GEN_BEACONS = ['http://www.gstatic.com/generate_204', 'http://cp.cloudflare.com/generate_204'];
var YANDEX_PING = 'https://ya.ru';
var ECHO_URL = 'https://yandex.ru/internet/';      // IP в теле; ПРОВЕРИТЬ на устройстве
var BEACON_TIMEOUT = 6000;

var NET_KEY = 'rh_net_state';
var HOME_KEY = 'rh_home_ssids';
var ASO_KEY = 'rh_home_aso';
var LAST_NET_KEY = 'rh_last_net';
var LOCK_KEY = 'RH_script_lock';

var now = function () { return Date.now(); };
function log(m) { console.log('[RH-Net] ' + m); }
function readJSON(k, d) { try { var s = $persistentStore.read(k); return s ? JSON.parse(s) : d; } catch (e) { return d; } }
function writeJSON(k, o) { try { $persistentStore.write(JSON.stringify(o), k); } catch (e) {} }

function setPolicy(group, node) {
  try { var r = $config.setSelectPolicy(group, node); if (r === true || r === undefined) return true; } catch (e) {}
  try { return $config.getConfig(group, node) !== false; } catch (e2) { return false; }
}

// флип родительских select-групп на ребёнка текущей сети
function flip(netTag) {
  var suf = (netTag === 'cell') ? '-C' : '-W';
  $persistentStore.write(String(now()), LOCK_KEY);
  var done = [];
  for (var i = 0; i < FLIP_GROUPS.length; i++) {
    var g = FLIP_GROUPS[i];
    var ok = setPolicy(g, g + suf);
    done.push(g + suf + (ok ? '' : '!'));
  }
  $persistentStore.write('', LOCK_KEY);
  log('флип -> ' + done.join(', '));
}

function probeDirect(url) {
  return new Promise(function (resolve) {
    var opt = { url: url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now(), timeout: BEACON_TIMEOUT, node: 'DIRECT' };
    $httpClient.get(opt, function (err, resp, body) {
      if (err || !resp) resolve({ ok: false });
      else resolve({ ok: resp.status >= 200 && resp.status < 400, status: resp.status, body: body || '' });
    });
  });
}
async function anyAlive(urls) {
  for (var i = 0; i < urls.length; i++) { var r = await probeDirect(urls[i]); if (r.ok) return true; }
  return false;
}
function extractIp(text) { if (!text) return ''; var m = text.match(/(?:\d{1,3}\.){3}\d{1,3}/); return m ? m[0] : ''; }
async function detectOperator(origin) {
  if (origin && /^https?:\/\//.test(origin)) {
    var r = await probeDirect(origin + '/whoami');
    if (r.ok && r.body) {
      try { var j = JSON.parse(r.body); if (j && (j.aso || j.asOrganization)) return { op: j.aso || j.asOrganization, src: 'whoami' }; } catch (e) {}
    }
  }
  var e = await probeDirect(ECHO_URL);
  var ip = e.ok ? extractIp(e.body) : '';
  if (ip) { try { var aso = $utils.ipaso(ip); if (aso) return { op: String(aso), src: 'ipaso' }; } catch (e2) {} return { op: '', src: 'ip:' + ip }; }
  return { op: '', src: 'none' };
}

async function main() {
  log('=== ' + VERSION + ' ===');
  var arg = (typeof $argument === 'string') ? $argument : '';
  var p = arg.split('|');
  var KEY = p[0] || '', ORIGIN = p[1] || '';

  var ssid = '';
  try { var cfg = JSON.parse($config.getConfig()); ssid = cfg && cfg.ssid ? String(cfg.ssid) : ''; } catch (e) {}

  var net, whitelist = false, operator = '';

  if (ssid) {
    net = 'wifi';
    var home = readJSON(HOME_KEY, {});
    home[ssid] = (home[ssid] || 0) + 1;
    writeJSON(HOME_KEY, home);
  } else {
    var gen = await anyAlive(GEN_BEACONS);
    if (gen) {
      net = 'cell';
    } else {
      var ya = await probeDirect(YANDEX_PING);
      if (ya.ok) { net = 'cell-whitelist'; whitelist = true; }
      else { net = 'offline'; }
    }
  }

  // флип СРАЗУ (кроме offline) — это главное действие
  var netTag = (net === 'wifi') ? 'wifi' : ((net === 'cell' || net === 'cell-whitelist') ? 'cell' : '');
  if (netTag) flip(netTag);

  // оператор (диагностика / Этап F) — только на сотовой
  if (net === 'cell' || net === 'cell-whitelist') {
    var op = await detectOperator(ORIGIN);
    operator = op.op;
    if (operator) { var prev = $persistentStore.read(ASO_KEY) || ''; if (prev !== operator) $persistentStore.write(operator, ASO_KEY); }
    log('оператор=' + (operator || '?') + ' (' + op.src + ')');
  }

  writeJSON(NET_KEY, { net: net, ssid: ssid, operator: operator, whitelist: whitelist, ts: now() });
  log('сеть=' + net + (ssid ? ' ssid=[' + ssid + ']' : '') + (whitelist ? ' WHITELIST' : ''));
  $persistentStore.write(net, LAST_NET_KEY);

  if (whitelist) {
    $notification.post('\uD83D\uDEA7 RouteHub', 'Похоже на whitelist РКН',
      'Общий интернет недоступен, Яндекс работает. Для обхода может понадобиться RH-Обход.');
  }

  $done({});
}

main().catch(function (err) { log('КРАШ: ' + ((err && err.message) || err)); try { $persistentStore.write('', LOCK_KEY); } catch (e) {} $done({}); });
