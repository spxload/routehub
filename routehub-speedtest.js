// =============================================================
// routehub-speedtest.js — RouteHub, спидтест с телефона (Этап D / H)
var VERSION = 'speedtest v0.4.10 (2026-06-05)';
//
// Тип: cron. Аргумент впечатывает Worker: $argument = "<key>|<origin>|<opts>".
// Пул [VPN]+[Игры] из RH-АВТО (getSubPolicies -> JSON-СТРОКА).
// Отклик: min из RTT_SAMPLES проб bytes=1 (НЕ чистый пинг — TCP+TLS).
// Скорость: ступенчато 4 МБ -> 12 МБ на быстрых.
// НАДЁЖНОСТЬ: сбой/0 НЕ кэшируется как «готово» (хорошее значение не
//   затирается нулём), сбойные узлы перемеряются по бэкоффу RETRY_MS,
//   пока не дадут down>0. На сервер уходят только хорошие (down>0).
//   Узел «готов» = down>0 и свежий (<CACHE_MS). Запуски вхолостую, когда
//   всё готово. Работает одинаково при cell_unlim true/false.
// Wi-Fi: все узлы; сотовая: 5, либо все при cell_unlim (devices.json).
// ОТПРАВКА: оба кэша (wifi+cell) -> Worker впишет обе метки.
// =============================================================

var BATCH_ALL = 80;
var BATCH_CELL = 5;
var CACHE_MS = 24 * 3600 * 1000;
var RETRY_MS = 15 * 60 * 1000;    // бэкофф повтора для сбойных/непроверенных
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

// узел "готов": есть хорошее значение (down>0) и оно свежее
function isFreshGood(e) { return e && e.down > 0 && e.ts > 0 && (Date.now() - e.ts) <= CACHE_MS; }
// узел нужно (пере)мерить
function isDue(e) {
  if (!e) return true;
  if (isFreshGood(e)) return false;
  return (Date.now() - (e.att || 0)) > RETRY_MS;   // сбойный/просроченный — по бэкоффу
}

function buildArr(cacheKey) {
  var c = readJSON(cacheKey, {}); var out = [];
  for (var nm in c) { if (c.hasOwnProperty(nm) && looksLikeNode(nm) && c[nm].down > 0) out.push({ name: nm, down: c[nm].down, rtt: c[nm].rtt }); }
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

  var NONCE = $persistentStore.read(K_NONCE);
  if (!NONCE) { NONCE = Date.now().toString(36) + Math.random().toString(36).slice(2, 10); $persistentStore.write(NONCE, K_NONCE); }

  var ssid = '';
  try { var cfg = JSON.parse($config.getConfig()); ssid = cfg && cfg.ssid ? String(cfg.ssid) : ''; } catch (e) {}
  var net = ssid ? 'wifi' : 'cell';
  var BATCH = (net === 'wifi' || cellAll) ? BATCH_ALL : BATCH_CELL;
  console.log('RH-Speed: ssid=[' + ssid + '] net=' + net + ' cellAll=' + cellAll + ' batch=' + BATCH);
  var RKEY = (net === 'wifi') ? 'rh_speed_wifi' : 'rh_speed_cell';
  var results = readJSON(RKEY, {});

  var removed = 0;
  for (var bad in results) { if (results.hasOwnProperty(bad) && !looksLikeNode(bad)) { delete results[bad]; removed++; } }
  if (removed) { writeJSON(RKEY, results); console.log('RH-Speed: кэш почищен, удалено ' + removed); }

  function send() {
    var wifi = buildArr('rh_speed_wifi'), cell = buildArr('rh_speed_cell');
    if (!wifi.length && !cell.length) { console.log('RH-Speed: нет хороших данных'); finish(); return; }
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

  function rttProbe(name, n, best, cb) {
    if (n <= 0) { cb(best); return; }
    var t0 = Date.now();
    $httpClient.get({ url: DOWN_HOST + '?bytes=' + RTT_BYTES + '&t=' + Date.now(), node: name, timeout: RTT_TIMEOUT },
      function (e) {
        if (!e) { var d = Date.now() - t0; if (best === null || d < best) best = d; }
        rttProbe(name, n - 1, best, cb);
      });
  }

  function rateOf(name, bytes, cb) {
    var s0 = Date.now();
    $httpClient.get({ url: DOWN_HOST + '?bytes=' + bytes + '&t=' + Date.now(), node: name, timeout: DOWN_TIMEOUT },
      function (e, r) {
        if (e || !r || r.status !== 200) { cb(null, 0); return; }
        var sec = (Date.now() - s0) / 1000;
        cb(sec > 0 ? Math.round((bytes * 8 / 1e6) / sec) : 0, sec);
      });
  }

  function measureNode(name, cb) {
    rttProbe(name, RTT_SAMPLES, null, function (rtt) {
      if (rtt === null) { console.log('  x RTT [' + name + ']: нет ответа'); cb(null); return; }
      rateOf(name, DOWN_BYTES, function (mbps1, sec1) {
        if (mbps1 === null || mbps1 <= 0) { console.log('  ~ DOWN [' + name + ']: fail (rtt ' + rtt + ')'); cb(null); return; }
        if (sec1 < FAST_SEC) {
          rateOf(name, DOWN_BIG, function (mbps2) {
            var down = (mbps2 === null || mbps2 <= 0) ? mbps1 : mbps2;
            console.log('  ok [' + name + '] ' + down + ' Mbps ' + rtt + 'ms');
            cb({ down: down, rtt: rtt });
          });
        } else {
          console.log('  ok [' + name + '] ' + mbps1 + ' Mbps ' + rtt + 'ms');
          cb({ down: mbps1, rtt: rtt });
        }
      });
    });
  }

  function chain(list, i) {
    if (i >= list.length) { writeJSON(RKEY, results); send(); return; }
    var fullName = list[i], base = baseName(fullName), prev = results[base] || {};
    measureNode(fullName, function (res) {
      if (res && res.down > 0) {
        results[base] = { down: res.down, rtt: res.rtt, ts: Date.now(), att: Date.now() };
      } else {
        // сбой/0 — НЕ затираем хорошее значение, только отметка попытки
        results[base] = { down: prev.down || 0, rtt: prev.rtt || 0, ts: prev.ts || 0, att: Date.now() };
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
