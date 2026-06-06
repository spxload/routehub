// =============================================================
// routehub-speedtest.js — RouteHub, спидтест с телефона (Этап D / H)
var VERSION = 'speedtest v0.4.13 (2026-06-06)';
//
// Тип: cron (весь день, каждые 20 мин). Аргумент: "<key>|<origin>|<opts>".
//   opts: cellall — сотовая мерит все; ewma — сглаживание.
// Пул [VPN]+[Игры] из RH-АВТО (getSubPolicies -> JSON-СТРОКА).
// Метрики (спека ЭТАП_D_ФОРМУЛА.md): down, rtt(min из 3), jit(=max-min проб),
//   bl(=отклик под нагрузкой - rtt; проба параллельно скачиванию, approx).
// EWMA (флаг): сглаживание down/rtt/jit/bl.
// НАДЁЖНОСТЬ: 0/сбой не «готов», бэкофф RETRY_MS; после MAX_FAILS -> мёртв
//   (DEAD_MS, маркер ⛔); на сервер только хорошие (down>0) или мёртвые.
// Wi-Fi: все; сотовая: 5 либо все при cellall. ОТПРАВКА: оба кэша.
// =============================================================

var BATCH_ALL = 80;
var BATCH_CELL = 5;
var CACHE_MS = 24 * 3600 * 1000;
var RETRY_MS = 15 * 60 * 1000;
var DEAD_MS = 6 * 3600 * 1000;
var MAX_FAILS = 5;
var EWMA_A = 0.6;
var DOWN_BYTES = 4000000;
var DOWN_BIG = 12000000;
var FAST_SEC = 1.5;
var RTT_BYTES = 1;
var RTT_SAMPLES = 3;
var RTT_TIMEOUT = 10000;
var DOWN_TIMEOUT = 25000;
var LOCK_MS = 10 * 60 * 1000;
var POOL_GROUP = 'RH-\u0410\u0412\u0422\u041E';
var DOWN_HOST = 'https://speed.cloudflare.com/__down';
var METRIC_SEP = ' \u00B7 ';

var K_NONCE = 'rh_nonce';
var K_LOCK = 'rh_speed_lock';

function readJSON(key, def) { try { var s = $persistentStore.read(key); return s ? JSON.parse(s) : def; } catch (e) { return def; } }
function writeJSON(key, obj) { try { $persistentStore.write(JSON.stringify(obj), key); return true; } catch (e) { return false; } }
function finish() { try { $persistentStore.write('', K_LOCK); } catch (e) {} $done(); }
function baseName(n) { var i = n.indexOf(METRIC_SEP); return (i >= 0 ? n.slice(0, i) : n).trim(); }
function nameOf(el) {
  if (typeof el === 'string') return el;
  if (el && typeof el === 'object') return el.name || el.policy || el.policyName || el.title || el.tag || '';
  return '';
}
function looksLikeNode(n) { return typeof n === 'string' && n.length >= 5 && n.indexOf('[') >= 0; }

function isFreshGood(e) { return e && e.down > 0 && e.ts > 0 && (Date.now() - e.ts) <= CACHE_MS; }
function isDue(e) {
  if (!e) return true;
  if (isFreshGood(e)) return false;
  var dead = (e.fails || 0) >= MAX_FAILS;
  var wait = dead ? DEAD_MS : RETRY_MS;
  return (Date.now() - (e.att || 0)) > wait;
}

function buildArr(cacheKey) {
  var c = readJSON(cacheKey, {}); var out = [];
  for (var nm in c) {
    if (!c.hasOwnProperty(nm) || !looksLikeNode(nm)) continue;
    var e = c[nm];
    if ((e.fails || 0) >= MAX_FAILS) { out.push({ name: nm, dead: true }); continue; }
    if (e.down > 0) {
      var it = { name: nm, down: e.down, rtt: e.rtt, jit: e.jit || 0 };
      if (e.bl != null) it.bl = e.bl;
      out.push(it);
    }
  }
  return out;
}

function main() {
  console.log('RH-Speed ' + VERSION);
  var lockTs = parseInt($persistentStore.read(K_LOCK) || '0', 10) || 0;
  if (lockTs && (Date.now() - lockTs) < LOCK_MS) { console.log('RH-Speed: занято, выход'); $done(); return; }
  $persistentStore.write(String(Date.now()), K_LOCK);

  var arg = (typeof $argument === 'string') ? $argument : '';
  var p = arg.split('|');
  var KEY = p[0] || '', ORIGIN = p[1] || '', OPTS = p[2] || '';
  if (!/^k\d+$/.test(KEY) || !/^https?:\/\//.test(ORIGIN)) { console.log('RH-Speed: битый argument [' + arg + ']'); finish(); return; }
  var cellAll = OPTS.indexOf('cellall') >= 0;
  var useEwma = OPTS.indexOf('ewma') >= 0;

  var NONCE = $persistentStore.read(K_NONCE);
  if (!NONCE) { NONCE = Date.now().toString(36) + Math.random().toString(36).slice(2, 10); $persistentStore.write(NONCE, K_NONCE); }

  var ssid = '';
  try { var cfg = JSON.parse($config.getConfig()); ssid = cfg && cfg.ssid ? String(cfg.ssid) : ''; } catch (e) {}
  var net = ssid ? 'wifi' : 'cell';
  var BATCH = (net === 'wifi' || cellAll) ? BATCH_ALL : BATCH_CELL;
  console.log('RH-Speed: ssid=[' + ssid + '] net=' + net + ' cellAll=' + cellAll + ' ewma=' + useEwma + ' batch=' + BATCH);
  var RKEY = (net === 'wifi') ? 'rh_speed_wifi' : 'rh_speed_cell';
  var results = readJSON(RKEY, {});

  var removed = 0;
  for (var bad in results) { if (results.hasOwnProperty(bad) && !looksLikeNode(bad)) { delete results[bad]; removed++; } }
  if (removed) { writeJSON(RKEY, results); console.log('RH-Speed: кэш почищен, удалено ' + removed); }

  function send() {
    var wifi = buildArr('rh_speed_wifi'), cell = buildArr('rh_speed_cell');
    if (!wifi.length && !cell.length) { console.log('RH-Speed: нет данных'); finish(); return; }
    $httpClient.post({
      url: ORIGIN + '/speed',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: KEY, nonce: NONCE, wifi: wifi, cell: cell }),
      timeout: 15000
    }, function (e, r) {
      if (e) console.log('RH-Speed: POST ошибка ' + e);
      else console.log('RH-Speed: отправлено wifi=' + wifi.length + ' cell=' + cell.length + ', статус ' + (r && r.status));
      finish();
    });
  }

  // N проб задержки -> массив времён (для min и джиттера)
  function rttSamples(name, n, acc, cb) {
    if (n <= 0) { cb(acc); return; }
    var t0 = Date.now();
    $httpClient.get({ url: DOWN_HOST + '?bytes=' + RTT_BYTES + '&t=' + Date.now(), node: name, timeout: RTT_TIMEOUT },
      function (e) {
        if (!e) acc.push(Date.now() - t0);
        rttSamples(name, n - 1, acc, cb);
      });
  }

  // скачивание; при withLoaded — параллельная проба задержки под нагрузкой
  function rateOf(name, bytes, withLoaded, cb) {
    var s0 = Date.now();
    var loaded = null;
    if (withLoaded) {
      var p0 = Date.now();
      $httpClient.get({ url: DOWN_HOST + '?bytes=' + RTT_BYTES + '&t=L' + Date.now(), node: name, timeout: RTT_TIMEOUT },
        function (e) { if (!e) loaded = Date.now() - p0; });
    }
    $httpClient.get({ url: DOWN_HOST + '?bytes=' + bytes + '&t=' + Date.now(), node: name, timeout: DOWN_TIMEOUT },
      function (e, r) {
        if (e || !r || r.status !== 200) { cb(null, 0, null); return; }
        var sec = (Date.now() - s0) / 1000;
        cb(sec > 0 ? Math.round((bytes * 8 / 1e6) / sec) : 0, sec, loaded);
      });
  }

  function measureNode(name, cb) {
    rttSamples(name, RTT_SAMPLES, [], function (acc) {
      if (!acc.length) { console.log('  x RTT [' + name + ']: нет ответа'); cb(null); return; }
      var mn = acc[0], mx = acc[0];
      for (var i = 1; i < acc.length; i++) { if (acc[i] < mn) mn = acc[i]; if (acc[i] > mx) mx = acc[i]; }
      var jit = Math.round(mx - mn);
      rateOf(name, DOWN_BYTES, true, function (mbps1, sec1, loaded) {
        if (mbps1 === null || mbps1 <= 0) { console.log('  ~ DOWN [' + name + ']: fail (rtt ' + mn + ')'); cb(null); return; }
        var bl = (loaded != null) ? Math.max(0, loaded - mn) : null;
        function done(down) {
          console.log('  ok [' + name + '] ' + down + ' Mbps ' + mn + 'ms j' + jit + (bl != null ? ' bl' + bl : ''));
          cb({ down: down, rtt: mn, jit: jit, bl: bl });
        }
        if (sec1 < FAST_SEC) {
          rateOf(name, DOWN_BIG, false, function (mbps2) { done((mbps2 && mbps2 > 0) ? mbps2 : mbps1); });
        } else { done(mbps1); }
      });
    });
  }

  function chain(list, i) {
    if (i >= list.length) { writeJSON(RKEY, results); send(); return; }
    var fullName = list[i], base = baseName(fullName), prev = results[base] || {};
    measureNode(fullName, function (res) {
      if (res && res.down > 0) {
        var nd = res.down, nr = res.rtt, nj = res.jit, nb = res.bl;
        if (useEwma && prev.down > 0 && prev.ts > 0) {
          nd = Math.round(EWMA_A * res.down + (1 - EWMA_A) * prev.down);
          nr = Math.round(EWMA_A * res.rtt + (1 - EWMA_A) * prev.rtt);
          if (res.jit != null && prev.jit != null) nj = Math.round(EWMA_A * res.jit + (1 - EWMA_A) * prev.jit);
          if (res.bl != null && prev.bl != null) nb = Math.round(EWMA_A * res.bl + (1 - EWMA_A) * prev.bl);
        }
        results[base] = { down: nd, rtt: nr, jit: nj, bl: nb, ts: Date.now(), att: Date.now(), fails: 0 };
      } else {
        var f = (prev.fails || 0) + 1;
        results[base] = { down: prev.down || 0, rtt: prev.rtt || 0, jit: prev.jit || 0, bl: (prev.bl == null ? null : prev.bl), ts: prev.ts || 0, att: Date.now(), fails: f };
        if (f === MAX_FAILS) console.log('  ! [' + base + '] помечен как мёртвый (' + f + ' неудач)');
      }
      writeJSON(RKEY, results);
      chain(list, i + 1);
    });
  }

  $config.getSubPolicies(POOL_GROUP, function (subs) {
    var arr = subs;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { console.log('RH-Speed: parse subs err ' + e); arr = []; } }
    if (!Array.isArray(arr) || !arr.length) { console.log('RH-Speed: пул пуст/не массив'); finish(); return; }
    console.log('RH-Speed: пул=' + arr.length);

    var due = [];
    for (var i = 0; i < arr.length; i++) {
      var nm = nameOf(arr[i]);
      if (!looksLikeNode(nm)) continue;
      if (nm.indexOf('[\u041E\u0431\u0445\u043E\u0434') >= 0) continue; // [Обход
      if (isDue(results[baseName(nm)])) due.push(nm);
      if (due.length >= BATCH) break;
    }
    if (!due.length) { console.log('RH-Speed: всё готово, замер не нужен'); finish(); return; }
    console.log('RH-Speed: меряю ' + due.length + ' узлов (' + net + ')');
    chain(due, 0);
  });
}

main();
