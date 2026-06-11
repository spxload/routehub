// =============================================================
// routehub-dashcache.js v0.1.0 — обновлятор локального кэша дашборда.
// Тип: cron (раз в 15 мин). Ходит на Worker /dashboard?key=kN,
// кладёт JSON в $persistentStore["rh_dash"] — его читает перехватчик
// routehub-dash.js при открытии http://routehub.local.
//
// При сбое Worker НЕ трёт старый кэш (дашборд покажет последнее
// известное состояние + плашку "кэш"). Под whitelist РКН Worker
// доступен только через обходной узел; сбой -> просто пропуск цикла.
//
// argument = "<key>|<origin>" (Worker подставляет: tag=RH-DashCache).
// =============================================================

var KEY = "k1", ORIGIN = "";
try {
  var a = (typeof $argument !== "undefined" && $argument) ? String($argument) : "";
  if (a) { var p = a.split("|"); if (p[0]) KEY = p[0]; if (p[1]) ORIGIN = p[1]; }
} catch (e) {}

if (!ORIGIN || ORIGIN.indexOf("http") !== 0) {
  // origin не задан — без него ходить некуда
  $done();
} else {
  var url = ORIGIN + "/dashboard?key=" + KEY;
  $httpClient.get({ url: url, timeout: 8000 }, function (err, resp, body) {
    if (err) { $done(); return; }
    if (!resp || resp.status !== 200 || !body) { $done(); return; }
    // проверим, что это валидный JSON и без ошибки доступа
    var ok = false;
    try {
      var j = JSON.parse(body);
      ok = j && !j.error;
    } catch (e) { ok = false; }
    if (ok) {
      try { $persistentStore.write(body, "rh_dash"); } catch (e) {}
    }
    // при невалидном ответе старый кэш сохраняем нетронутым
    $done();
  });
}
