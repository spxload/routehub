// =============================================================
// routehub-dashcache.js v0.2.0 — обновлятор локального кэша дашборда.
// Тип: cron (раз в 15 мин). Ходит на Worker /dashboard?key=kN,
// кладёт JSON в $persistentStore["rh_dash"] — его читает перехватчик
// routehub-dash.js при открытии http://rh.box (фолбэк, когда Worker
// напрямую со страницы недоступен — например, под whitelist РКН).
//
// v0.2.0:
//   * Кэш пишется В ОБЁРТКЕ {ts, data} — диспетчер routehub-dash.js
//     (routeLocal) читает cache.data и показывает возраст cache.ts.
//     Раньше писался голый JSON -> возраст кэша на вкладке «Система» был пуст.
//   * Сбой обновления пишется в общий журнал rh_runlog ({s:'dash', ok:0}).
//     Успех НЕ пишем — иначе журнал забивается (важны только сбои).
//   * Домен в комментарии исправлен routehub.local -> rh.box.
//
// При сбое Worker НЕ трёт старый кэш (дашборд покажет последнее
// известное состояние + плашку «кэш»). Под whitelist РКН Worker
// доступен только через обходной узел; сбой -> просто пропуск цикла.
//
// argument = "<key>|<origin>" (Worker подставляет: tag=RH-DashCache).
// =============================================================

var KEY = "k1", ORIGIN = "";
try {
  var a = (typeof $argument !== "undefined" && $argument) ? String($argument) : "";
  if (a) { var p = a.split("|"); if (p[0]) KEY = p[0]; if (p[1]) ORIGIN = p[1]; }
} catch (e) {}

var K_RUNLOG = "rh_runlog";
var RUNLOG_MAX = 50;
var GAP_MS = 25 * 60 * 1000;

function readJSON(k, d) { try { var s = $persistentStore.read(k); return s ? JSON.parse(s) : d; } catch (e) { return d; } }
function writeJSON(k, o) { try { $persistentStore.write(JSON.stringify(o), k); } catch (e) {} }

// общий журнал rh_runlog (формат как у speedtest/netwatch/rkn)
function hb(ev) {
  try {
    var lg = readJSON(K_RUNLOG, []);
    if (!Array.isArray(lg)) lg = [];
    var prev = lg.length ? lg[lg.length - 1] : null;
    ev.t = Date.now();
    if (prev && prev.t && (ev.t - prev.t) > GAP_MS) ev.gap = Math.round((ev.t - prev.t) / 60000);
    lg.push(ev);
    if (lg.length > RUNLOG_MAX) lg = lg.slice(-RUNLOG_MAX);
    writeJSON(K_RUNLOG, lg);
  } catch (e) {}
}

if (!ORIGIN || ORIGIN.indexOf("http") !== 0) {
  // origin не задан — без него ходить некуда
  $done();
} else {
  var url = ORIGIN + "/dashboard?key=" + KEY;
  $httpClient.get({ url: url, timeout: 8000 }, function (err, resp, body) {
    if (err) { hb({ s: "dash", ok: 0, note: "сеть" }); $done(); return; }
    if (!resp || resp.status !== 200 || !body) { hb({ s: "dash", ok: 0, note: "http " + (resp && resp.status) }); $done(); return; }
    // проверим, что это валидный JSON и без ошибки доступа
    var ok = false, parsed = null;
    try {
      parsed = JSON.parse(body);
      ok = parsed && !parsed.error;
    } catch (e) { ok = false; }
    if (ok) {
      // обёртка {ts,data}: диспетчер читает cache.data, показывает возраст cache.ts
      try { $persistentStore.write(JSON.stringify({ ts: Date.now(), data: parsed }), "rh_dash"); } catch (e) {}
    } else {
      hb({ s: "dash", ok: 0, note: "невалидный ответ" });
    }
    // при невалидном ответе старый кэш сохраняем нетронутым
    $done();
  });
}
