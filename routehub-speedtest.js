// =============================================================
// routehub-speedtest.js — RouteHub, спидтест с телефона (Этап D / H)
var VERSION = 'speedtest v0.6.1 (2026-06-11)';
//
// Тип: cron (весь день, каждые 20 мин). Аргумент: "<key>|<origin>|<opts>".
//
// v0.6.1 — ЧИСТКА УШЕДШИХ УЗЛОВ: записи кэша, которых нет в текущем пуле
//   (провайдер ротирует/переименовывает узлы), удаляются при каждом прогоне —
//   иначе висят вечно со старой датой. Вернётся узел — перемеряется заново.
// v0.6.0 — ПИНГ-СВИП: когда скорость у всех свежая (нечего мерить полным
//   замером), прогон делает ЛЁГКИЙ свип задержки: 3 пробы generate_204 на
//   узел, обновляются ТОЛЬКО med/rtt/jit (+tsp = время свипа); скорость/bl/ts
//   не трогаются (кэш 24ч). Балл и порядок узлов становятся живыми — следующее
//   обновление подписки раздаёт узлы по текущей задержке. Wi-Fi/cellall — весь
//   пул; сотовая без флага — верхние SWEEP_CELL_TOP (порядок подписки = балл).
//   Мёртвые (на бэкоффе) пропускаются. Бюджет времени SWEEP_BUDGET_MS; не
//   успел — продолжит со следующего прогона (rh_sweep_idx). Ответил — fails=0
//   (ожил); не ответил — fails+1 (как у полного замера).
// v0.5.1: пинг-пробы на cp.cloudflare.com/generate_204 (цель групп Loon); med.
// v0.5.0: пул из RH-АВТО-W/-C по сети; bl=медиана 3; BATCH адаптивный;
//   heartbeat rh_runlog; догон rh_catchup.
// =============================================================

var BATCH_CELL = 10;
var CACHE_MS = 24 * 3600 * 1000;
var RETRY_MS = 15 * 60 * 1000;
var DEAD_MS = 6 * 3600 * 1000;
var MAX_FAILS = 5;
var EWMA_A = 0.6;
var DOWN_BYTES = 4000000;
var DOWN_BIG = 12000000;
var FAST_SEC = 1.5;
var RTT_SAMPLES = 3;
var BL_SAMPLES = 3;
var RTT_TIMEOUT = 10000;
var DOWN_TIMEOUT = 25000;
var LOCK_MS = 10 * 60 * 1000;
var SWEEP_TIMEOUT = 4000;
var SWEEP_CELL_TOP = 15;
var SWEEP_BUDGET_MS = 150 * 1000;
var POOL_W = 'RH-\u0410\u0412\u0422\u041E-W';
var POOL_C = 'RH-\u0410\u0412\u0422\u041E-C';
var DOWN_HOST = 'https://speed.cloudflare.com/__down';
var PING_URL = 'http://cp.cloudflare.com/generate_204';
var METRIC_SEP = ' \u00B7 ';
var GAP_MS = 25 * 60 * 1000;
var RUNLOG_MAX = 50;

var K_NONCE = 'rh_nonce';
var K_LOCK = 'rh_speed_lock';
var K_RUNLOG = 'rh_runlog';
var K_CATCHUP = 'rh_catchup';
var K_SWEEP_IDX = 'rh_sweep_idx';

function readJSON(key, def) { try { var s = $persistentStore.read(key); return s ? JSON.parse(s) : def; } catch (e) { return def; } }
function writeJSON(key, obj) { try { $persistentStore.write(JSON.stringify(obj), key); return true; } catch (e) { return false; } }
function baseName(n) { var i = n.indexOf(METRIC_SEP); return (i >= 0 ? n.slice(0, i) : n).trim(); }
function nameOf(el) {
  if (typeof el === 'string') return el;
  if (el && typeof el === 'object') return el.name || el.policy || el.policyName || el.title || el.tag || '';
  return '';
}
function looksLikeNode(n) { return typeof n === 'string' && n.length >= 5 && n.indexOf('[') >= 0; }

function hb(ev) {
  try {
    var log = readJSON(K_RUNLOG, []);
    if (!Array.isArray(log)) log = [];
    var prev = log.length ? log[log.length - 1] : null;
    ev.t = Date.now();
    if (prev && prev.t && (ev.t - prev.t) > GAP_MS) ev.gap = Math.round((ev.t - prev.t) / 60000);
    log.push(ev);
    if (log.length > RUNLOG_MAX) log = log.slice(-RUNLOG_MAX);
    writeJSON(K_RUNLOG, log);
  } catch (e) {}
}

function isFreshGood(e) { return e && e.down > 0 && e.ts > 0 && (Date.now() - e.ts) <= CACHE_MS; }
function isDue(e, catchup) {
  if (!e) return true;
  if (isFreshGood(e)) return false;
  if (catchup) return true;
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
      if (e.med != null) it.med = e.med;
      if (e.bl != null) it.bl = e.bl;
      out.push(it);
    }
  }
  return out;
}

function median(arr) {
  if (!arr || !arr.length) return null;
  var a = arr.slice().sort(function (x, y) { return x - y; });
  var m = Math.floor(a.length / 2);
  return (a.length % 2) ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

function main() {
  console.log('RH-Speed ' + VERSION);
  var lockTs = parseInt($persistentStore.read(K_LOCK) || '0', 10) || 0;
  if (lockTs && (Date.now() - lockTs) < LOCK_MS) {
    console.log('RH-Speed: занято, выход');
    hb({ s: 'cron', x: 'занято' });
    $done(); return;
  }
  $persistentStore.write(String(Date.now()), K_LOCK);
  function finish() { try { $persistentStore.write('', K_LOCK); } catch (e) {} $done(); }

  var arg = (typeof $argument === 'string') ? $argument : '';
  var p = arg.split('|');
  var KEY = p[0] || '', ORIGIN = p[1] || '', OPTS = p[2] || '';
  if (!/^k\d+$/.test(KEY) || !/^https?:\/\//.test(ORIGIN)) {
    console.log('RH-Speed: битый argument [' + arg + ']');
    hb({ s: 'cron', x: 'битый argument' });
    finish(); return;
  }
  var cellAll = OPTS.indexOf('cellall') >= 0;
  var useEwma = OPTS.indexOf('ewma') >= 0;

  var NONCE = $persistentStore.read(K_NONCE);
  if (!NONCE) { NONCE = Date.now().toString(36) + Math.random().toString(36).slice(2, 10); $persistentStore.write(NONCE, K_NONCE); }

  var ssid = '';
  try { var cfg = JSON.parse($config.getConfig()); ssid = cfg && cfg.ssid ? String(cfg.ssid) : ''; } catch (e) {}
  var net = ssid ? 'wifi' : 'cell';
  var POOL_GROUP = (net === 'wifi') ? POOL_W : POOL_C;

  var catchup = ($persistentStore.read(K_CATCHUP) || '') === '1';
  if (catchup) $persistentStore.write('', K_CATCHUP);

  console.log('RH-Speed: ssid=[' + ssid + '] net=' + net + ' pool=' + POOL_GROUP + ' cellAll=' + cellAll + ' ewma=' + useEwma + (catchup ? ' ДОГОН' : ''));
  var RKEY = (net === 'wifi') ? 'rh_speed_wifi' : 'rh_speed_cell';
  var results = readJSON(RKEY, {});

  var removed = 0;
  for (var bad in results) { if (results.hasOwnProperty(bad) && !looksLikeNode(bad)) { delete results[bad]; removed++; } }
  if (removed) { writeJSON(RKEY, results); console.log('RH-Speed: кэш почищен, удалено ' + removed); }

  var okN = 0, failN = 0;

  function send(poolN, dueN, sweptN) {
    var wifi = buildArr('rh_speed_wifi'), cell = buildArr('rh_speed_cell');
    var ev = { s: 'cron', n: net, p: poolN, d: dueN, m: okN, f: failN };
    if (catchup) ev.c = 1;
    if (sweptN != null) ev.sw = sweptN;
    hb(ev);
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

  function rttSamples(name, n, acc, timeout, cb) {
    if (n <= 0) { cb(acc); return; }
    var t0 = Date.now();
    $httpClient.get({ url: PING_URL + '?t=' + Date.now(), node: name, timeout: timeout },
      function (e) {
        if (!e) acc.push(Date.now() - t0);
        rttSamples(name, n - 1, acc, timeout, cb);
      });
  }

  function rateOf(name, bytes, withLoaded, cb) {
    var s0 = Date.now();
    var loadedArr = [];
    function probe() {
      var p0 = Date.now();
      $httpClient.get({ url: PING_URL + '?t=L' + Date.now() + Math.random(), node: name, timeout: RTT_TIMEOUT },
        function (e) { if (!e) loadedArr.push(Date.now() - p0); });
    }
    if (withLoaded) {
      probe();
      for (var k = 1; k < BL_SAMPLES; k++) setTimeout(probe, k * 700);
    }
    $httpClient.get({ url: DOWN_HOST + '?bytes=' + bytes + '&t=' + Date.now(), node: name, timeout: DOWN_TIMEOUT },
      function (e, r) {
        if (e || !r || r.status !== 200) { cb(null, 0, null); return; }
        var sec = (Date.now() - s0) / 1000;
        cb(sec > 0 ? Math.round((bytes * 8 / 1e6) / sec) : 0, sec, median(loadedArr));
      });
  }

  function measureNode(name, cb) {
    rttSamples(name, RTT_SAMPLES, [], RTT_TIMEOUT, function (acc) {
      if (!acc.length) { console.log('  x RTT [' + name + ']: нет ответа'); cb(null); return; }
      var mn = acc[0], mx = acc[0];
      for (var i = 1; i < acc.length; i++) { if (acc[i] < mn) mn = acc[i]; if (acc[i] > mx) mx = acc[i]; }
      var jit = Math.round(mx - mn);
      var med = median(acc);
      rateOf(name, DOWN_BYTES, true, function (mbps1, sec1, loaded) {
        if (mbps1 === null || mbps1 <= 0) { console.log('  ~ DOWN [' + name + ']: fail (rtt ' + mn + ')'); cb(null); return; }
        var bl = (loaded != null) ? Math.max(0, loaded - mn) : null;
        function done(down) {
          console.log('  ok [' + name + '] ' + down + ' Mbps ' + mn + 'ms m' + med + ' j' + jit + (bl != null ? ' bl' + bl : ''));
          cb({ down: down, rtt: mn, med: med, jit: jit, bl: bl });
        }
        if (sec1 < FAST_SEC) {
          rateOf(name, DOWN_BIG, false, function (mbps2) { done((mbps2 && mbps2 > 0) ? mbps2 : mbps1); });
        } else { done(mbps1); }
      });
    });
  }

  function chain(list, i, poolN) {
    if (i >= list.length) { writeJSON(RKEY, results); send(poolN, list.length, null); return; }
    var fullName = list[i], base = baseName(fullName), prev = results[base] || {};
    measureNode(fullName, function (res) {
      if (res && res.down > 0) {
        okN++;
        var nd = res.down, nr = res.rtt, nm2 = res.med, nj = res.jit, nb = res.bl;
        if (useEwma && prev.down > 0 && prev.ts > 0) {
          nd = Math.round(EWMA_A * res.down + (1 - EWMA_A) * prev.down);
          nr = Math.round(EWMA_A * res.rtt + (1 - EWMA_A) * prev.rtt);
          if (res.med != null && prev.med != null) nm2 = Math.round(EWMA_A * res.med + (1 - EWMA_A) * prev.med);
          if (res.jit != null && prev.jit != null) nj = Math.round(EWMA_A * res.jit + (1 - EWMA_A) * prev.jit);
          if (res.bl != null && prev.bl != null) nb = Math.round(EWMA_A * res.bl + (1 - EWMA_A) * prev.bl);
        }
        results[base] = { down: nd, rtt: nr, med: nm2, jit: nj, bl: nb, ts: Date.now(), tsp: Date.now(), att: Date.now(), fails: 0 };
      } else {
        failN++;
        var f = (prev.fails || 0) + 1;
        results[base] = { down: prev.down || 0, rtt: prev.rtt || 0, med: (prev.med == null ? null : prev.med), jit: prev.jit || 0, bl: (prev.bl == null ? null : prev.bl), ts: prev.ts || 0, tsp: prev.tsp || 0, att: Date.now(), fails: f };
        if (f === MAX_FAILS) console.log('  ! [' + base + '] помечен как мёртвый (' + f + ' неудач)');
      }
      writeJSON(RKEY, results);
      chain(list, i + 1, poolN);
    });
  }

  // ЛЁГКИЙ ПИНГ-СВИП: только med/rtt/jit (+tsp); скорость/bl/ts не трогаются
  function sweepRun(arr) {
    var list = [];
    for (var i = 0; i < arr.length; i++) {
      var nm = nameOf(arr[i]);
      if (!looksLikeNode(nm)) continue;
      if (nm.indexOf('[\u041E\u0431\u0445\u043E\u0434') >= 0) continue;
      var e = results[baseName(nm)];
      if (e && (e.fails || 0) >= MAX_FAILS) continue; // мёртвые — на бэкоффе DEAD_MS
      list.push(nm);
    }
    if (net === 'cell' && !cellAll) list = list.slice(0, SWEEP_CELL_TOP);
    if (!list.length) {
      console.log('RH-Speed: свип: нечего мерить');
      send(arr.length, 0, 0); return;
    }
    var start = parseInt($persistentStore.read(K_SWEEP_IDX) || '0', 10) || 0;
    if (start >= list.length) start = 0;
    var t0 = Date.now(), idx = start, sweptN = 0;
    console.log('RH-Speed: пинг-свип ' + list.length + ' узлов (с #' + (start + 1) + ')');
    function step() {
      if ((idx - start) >= list.length || (Date.now() - t0) > SWEEP_BUDGET_MS) {
        $persistentStore.write(String(idx % list.length), K_SWEEP_IDX);
        writeJSON(RKEY, results);
        var partial = (idx - start) < list.length;
        console.log('RH-Speed: свип готов, узлов ' + sweptN + (partial ? ' (бюджет исчерпан, продолжу со след. прогона)' : ''));
        send(arr.length, 0, sweptN);
        return;
      }
      var name = list[idx % list.length]; idx++;
      var base = baseName(name);
      rttSamples(name, RTT_SAMPLES, [], SWEEP_TIMEOUT, function (acc) {
        var prev = results[base] || {};
        if (acc.length) {
          var mn = acc[0], mx = acc[0];
          for (var i2 = 1; i2 < acc.length; i2++) { if (acc[i2] < mn) mn = acc[i2]; if (acc[i2] > mx) mx = acc[i2]; }
          prev.rtt = mn;
          prev.med = median(acc);
          prev.jit = Math.round(mx - mn);
          prev.tsp = Date.now();
          prev.fails = 0; // ответил — жив
          results[base] = prev;
          sweptN++;
        } else {
          prev.fails = (prev.fails || 0) + 1;
          prev.att = Date.now();
          results[base] = prev;
          if (prev.fails === MAX_FAILS) console.log('  ! [' + base + '] мёртв по свипу (' + prev.fails + ' неудач)');
        }
        step();
      });
    }
    step();
  }

  $config.getSubPolicies(POOL_GROUP, function (subs) {
    var arr = subs;
    if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { console.log('RH-Speed: parse subs err ' + e); arr = []; } }
    if (!Array.isArray(arr) || !arr.length) {
      console.log('RH-Speed: пул пуст/не массив (' + POOL_GROUP + ')');
      hb({ s: 'cron', n: net, p: 0, x: 'пул пуст' });
      finish(); return;
    }
    console.log('RH-Speed: пул=' + arr.length);

    // ЧИСТКА УШЕДШИХ: записи кэша, которых нет в текущем пуле, удаляются
    // (ротация узлов провайдером; вернётся — перемеряется заново)
    var poolSet = {};
    for (var pi = 0; pi < arr.length; pi++) {
      var pn = nameOf(arr[pi]);
      if (looksLikeNode(pn)) poolSet[baseName(pn)] = 1;
    }
    var gone = 0;
    for (var rk in results) {
      if (results.hasOwnProperty(rk) && !poolSet[rk]) { delete results[rk]; gone++; }
    }
    if (gone) { writeJSON(RKEY, results); console.log('RH-Speed: удалено ушедших из подписки: ' + gone); }

    var BATCH = (net === 'wifi' || cellAll) ? arr.length : BATCH_CELL;

    var due = [];
    for (var i = 0; i < arr.length; i++) {
      var nm = nameOf(arr[i]);
      if (!looksLikeNode(nm)) continue;
      if (nm.indexOf('[\u041E\u0431\u0445\u043E\u0434') >= 0) continue; // [Обход
      if (isDue(results[baseName(nm)], catchup)) due.push(nm);
      if (due.length >= BATCH) break;
    }
    if (!due.length) {
      // скорость свежая у всех — лёгкий пинг-свип вместо простоя
      sweepRun(arr);
      return;
    }
    console.log('RH-Speed: меряю ' + due.length + ' узлов (' + net + ', batch=' + BATCH + ')');
    chain(due, 0, arr.length);
  });
}

main();
