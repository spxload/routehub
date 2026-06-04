// =============================================================
// routehub-speedtest.js — RouteHub, спидтест с телефона (Этап D / H)
// Тип: cron. Расписание задаёт routehub.conf (окно Wi-Fi 2-6 ночью).
//   Аргумент впечатывает Worker:  $argument = "<key>|<origin>"
//   (key=kN, origin=https://...workers.dev)
//
// За один запуск:
//   1) определяет сеть (Wi-Fi / сотовая) по ssid;
//   2) берёт пул узлов [VPN]+[Игры] из группы RH-АВТО (getSubPolicies);
//   3) меряет батч узлов (отклик + скорость закачки ЧЕРЕЗ сам узел);
//   4) копит результаты локально (отдельно Wi-Fi и сотовая);
//   5) POST {key,nonce,speeds} на Worker -> он пересобирает nodes-kN.
//
// Надёжность (Раздел 17): флаг-блокировка с протуханием, try/catch на
//   JSON.parse, промежуточное сохранение поузлово, ошибка узла не роняет прогон.
// Обходные [Обход] НЕ меряются (в RH-АВТО их нет; платный трафик).
// =============================================================

// ---- параметры (позже вынесем в [Argument]) ----
var BATCH = 6;                    // узлов за прогон
var CACHE_MS = 24 * 3600 * 1000;  // не перемерять чаще раза в сутки
var DOWN_BYTES = 4000000;         // 4 МБ на замер
var RTT_TIMEOUT = 8000;           // мс
var DOWN_TIMEOUT = 20000;         // мс
var LOCK_MS = 10 * 60 * 1000;     // протухание блокировки
var POOL_GROUP = 'RH-\u0410\u0412\u0422\u041E';   // RH-АВТО (пул [VPN]+[Игры])
var DOWN_HOST = 'https://speed.cloudflare.com/__down';
var METRIC_SEP = ' \u00B7 ';      // такой же разделитель, как у Worker

// ---- ключи хранилища ----
var K_NONCE = 'rh_nonce';
var K_LOCK = 'rh_speed_lock';

function readJSON(key, def) {
  try { var s = $persistentStore.read(key); return s ? JSON.parse(s) : def; }
  catch (e) { return def; }
}
function writeJSON(key, obj) {
  try { $persistentStore.write(JSON.stringify(obj), key); return true; } catch (e) { return false; }
}
function finish() { try { $persistentStore.write('', K_LOCK); } catch (e) {} $done(); }
// базовое имя (без нашей метрики) — стабильный ключ кэша при смене имён
function baseName(n) { var i = n.indexOf(METRIC_SEP); return (i >= 0 ? n.slice(0, i) : n).trim(); }

function main() {
  // блокировка
  var lockTs = parseInt($persistentStore.read(K_LOCK) || '0', 10) || 0;
  if (lockTs && (Date.now() - lockTs) < LOCK_MS) { console.log('RH-Speed: занято, выход'); $done(); return; }
  $persistentStore.write(String(Date.now()), K_LOCK);

  // аргумент: key|origin
  var arg = (typeof $argument === 'string') ? $argument : '';
  var p = arg.split('|');
  var KEY = p[0] || '', ORIGIN = p[1] || '';
  if (!/^k\d+$/.test(KEY) || !/^https?:\/\//.test(ORIGIN)) {
    console.log('RH-Speed: битый argument: ' + arg); finish(); return;
  }

  // nonce устройства
  var NONCE = $persistentStore.read(K_NONCE);
  if (!NONCE) { NONCE = Date.now().toString(36) + Math.random().toString(36).slice(2, 10); $persistentStore.write(NONCE, K_NONCE); }

  // сеть
  var net = 'cell';
  try { var cfg = JSON.parse($config.getConfig()); if (cfg && cfg.ssid && String(cfg.ssid).length) net = 'wifi'; } catch (e) {}
  var RKEY = (net === 'wifi') ? 'rh_speed_wifi' : 'rh_speed_cell';
  var results = readJSON(RKEY, {}); // {baseName:{down,rtt,ts}}

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
    // отклик: лёгкий запрос через узел (bytes=0)
    $httpClient.get({ url: DOWN_HOST + '?bytes=0&t=' + Date.now(), node: name, timeout: RTT_TIMEOUT, alpn: 'h2' },
      function (e) {
        if (e) { cb(null); return; }            // узел недоступен сейчас — пропуск
        var rtt = Date.now() - t0, s0 = Date.now();
        $httpClient.get({ url: DOWN_HOST + '?bytes=' + DOWN_BYTES + '&t=' + Date.now(), node: name, timeout: DOWN_TIMEOUT, alpn: 'h2' },
          function (e2, r2) {
            if (e2 || !r2 || r2.status !== 200) { cb({ down: 0, rtt: rtt }); return; }
            var sec = (Date.now() - s0) / 1000;
            cb({ down: sec > 0 ? Math.round((DOWN_BYTES * 8 / 1e6) / sec) : 0, rtt: rtt });
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
