// =============================================================
// routehub-speedtest.js — RouteHub, спидтест с телефона (Этап D / H)
// ВЕРСИЯ С ДИАГНОСТИКОЙ (Этап D): подробный лог ssid/пула/ошибок проб.
//
// Тип: cron. Аргумент впечатывает Worker: $argument = "<key>|<origin>".
// За запуск: определяет сеть -> берёт пул [VPN]+[Игры] из RH-АВТО ->
//   меряет батч (отклик + скорость закачки ЧЕРЕЗ узел) -> копит локально ->
//   POST {key,nonce,speeds} на Worker.
// Обходные [Обход] не меряются.
// =============================================================

var BATCH = 6;
var CACHE_MS = 24 * 3600 * 1000;
var DOWN_BYTES = 4000000;
var RTT_TIMEOUT = 10000;          // мс
var DOWN_TIMEOUT = 20000;         // мс
var LOCK_MS = 10 * 60 * 1000;
var POOL_GROUP = 'RH-\u0410\u0412\u0422\u041E';   // RH-АВТО
var DOWN_HOST = 'https://speed.cloudflare.com/__down';
var METRIC_SEP = ' \u00B7 ';

var K_NONCE = 'rh_nonce';
var K_LOCK = 'rh_speed_lock';

function readJSON(key, def) {
  try { var s = $persistentStore.read(key); return s ? JSON.parse(s) : def; } catch (e) { return def; }
}
function writeJSON(key, obj) {
  try { $persistentStore.write(JSON.stringify(obj), key); return true; } catch (e) { return false; }
}
function finish() { try { $persistentStore.write('', K_LOCK); } catch (e) {} $done(); }
function baseName(n) { var i = n.indexOf(METRIC_SEP); return (i >= 0 ? n.slice(0, i) : n).trim(); }

function main() {
  var lockTs = parseInt($persistentStore.read(K_LOCK) || '0', 10) || 0;
  if (lockTs && (Date.now() - lockTs) < LOCK_MS) { console.log('RH-Speed: занято, выход'); $done(); return; }
  $persistentStore.write(String(Date.now()), K_LOCK);

  var arg = (typeof $argument === 'string') ? $argument : '';
  var p = arg.split('|');
  var KEY = p[0] || '', ORIGIN = p[1] || '';
  console.log('RH-Speed: argument=[' + arg + ']');
  if (!/^k\d+$/.test(KEY) || !/^https?:\/\//.test(ORIGIN)) {
    console.log('RH-Speed: битый argument'); finish(); return;
  }

  var NONCE = $persistentStore.read(K_NONCE);
  if (!NONCE) { NONCE = Date.now().toString(36) + Math.random().toString(36).slice(2, 10); $persistentStore.write(NONCE, K_NONCE); }

  var ssid = '';
  try { var cfg = JSON.parse($config.getConfig()); ssid = cfg && cfg.ssid ? String(cfg.ssid) : ''; } catch (e) { console.log('RH-Speed: getConfig err ' + e); }
  var net = ssid ? 'wifi' : 'cell';
  console.log('RH-Speed: ssid=[' + ssid + '] net=' + net);
  var RKEY = (net === 'wifi') ? 'rh_speed_wifi' : 'rh_speed_cell';
  var results = readJSON(RKEY, {});

  function send() {
    var speeds = [];
    for (var nm in results) { if (results.hasOwnProperty(nm)) speeds.push({ name: nm, down: results[nm].down, rtt: results[nm].rtt }); }
    if (!speeds.length) { console.log('RH-Speed: нет данных для отправки'); finish(); return; }
    $httpClient.post({
      url: ORIGIN + '/speed',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: KEY, nonce: NONCE, speeds: speeds }),
      timeout: 15000
    }, function (e, r) {
      if (e) console.log('RH-Speed: POST ошибка ' + e);
      else console.log('RH-Speed: отправлено ' + speeds.length + ' (' + net + '), статус ' + (r && r.status));
      finish();
    });
  }

  function measureNode(name, cb) {
    var t0 = Date.now();
    $httpClient.get({ url: DOWN_HOST + '?bytes=0&t=' + Date.now(), node: name, timeout: RTT_TIMEOUT },
      function (e, r) {
        if (e) { console.log('  x RTT err [' + name + ']: ' + e); cb(null); return; }
        var rtt = Date.now() - t0, s0 = Date.now();
        $httpClient.get({ url: DOWN_HOST + '?bytes=' + DOWN_BYTES + '&t=' + Date.now(), node: name, timeout: DOWN_TIMEOUT },
          function (e2, r2) {
            if (e2 || !r2 || r2.status !== 200) {
              console.log('  ~ DOWN err [' + name + ']: ' + (e2 || ('status ' + (r2 && r2.status))) + ' (rtt ' + rtt + ')');
              cb({ down: 0, rtt: rtt }); return;
            }
            var sec = (Date.now() - s0) / 1000;
            var down = sec > 0 ? Math.round((DOWN_BYTES * 8 / 1e6) / sec) : 0;
            console.log('  ok [' + name + '] ' + down + ' Mbps ' + rtt + 'ms');
            cb({ down: down, rtt: rtt });
          });
      });
  }

  function chain(list, i) {
    if (i >= list.length) { writeJSON(RKEY, results); send(); return; }
    var fullName = list[i];
    measureNode(fullName, function (res) {
      if (res) { res.ts = Date.now(); results[baseName(fullName)] = res; writeJSON(RKEY, results); }
      chain(list, i + 1);
    });
  }

  $config.getSubPolicies(POOL_GROUP, function (subs) {
    if (!subs || !subs.length) { console.log('RH-Speed: пул пуст (' + POOL_GROUP + ')'); finish(); return; }
    console.log('RH-Speed: пул=' + subs.length + ' пример=' + JSON.stringify(subs.slice(0, 3)));
    var due = [];
    for (var i = 0; i < subs.length; i++) {
      var nm = subs[i];
      if (nm.indexOf('[\u041E\u0431\u0445\u043E\u0434') >= 0) continue; // [Обход
      var r = results[baseName(nm)];
      if (!r || (Date.now() - (r.ts || 0)) > CACHE_MS) due.push(nm);
      if (due.length >= BATCH) break;
    }
    if (!due.length) { console.log('RH-Speed: всё свежее, только отправка'); send(); return; }
    console.log('RH-Speed: меряю ' + due.length + ' узлов (' + net + ')');
    chain(due, 0);
  });
}

main();
