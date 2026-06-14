// =============================================================
// routehub-faillog.js v0.1.0 — сборщик упавших доменов (ШАГ 1, диагностика).
// Тип: http-request (БЕЗ MITM). Привязывается к фильтру Loon со статусом
//   «Не удалось» (настраивается в UI Loon вручную — скрипт фильтр не создаёт).
//
// НАЗНАЧЕНИЕ: когда соединение падает (как whoosh.bike под whitelist),
//   записать ДОМЕН в rh_faillog. Дашборд покажет список кандидатов на обход.
//   Пользователь переносит нужные в личный список (вкладка «Домены»).
//
// ВАЖНО (без MITM): скрипт видит ДОМЕН (host из $request.url / SNI), но НЕ тело.
//   Этого достаточно для списка «что упало». Содержимое не читаем — приватность.
//
// ПРОВЕРКА (ШАГ 1): не уверены, доходит ли УПАВШЕЕ соединение до http-request
//   скрипта. Поэтому пишем ВСЁ, что пришло через фильтр, + помечаем. На устройстве
//   смотрим в дашборде, появляются ли домены. Если да — ШАГ 2 (полный UI переноса).
//
// НЕ ловит Магнит: он не шлёт упавших запросов (молчит за плашкой VPN). Это
//   инструмент для доменов, которые ПЫТАЮТСЯ грузиться и падают (как whoosh).
//
// Формат rh_faillog: { items: [ {d, n, ts} ], v:1 }
//   d — домен, n — счётчик падений, ts — время последнего. Кольцо 50, дедуп по d.
// =============================================================

var K_FAILLOG = 'rh_faillog';
var MAX = 50;

function done() { $done({}); }

try {
  var url = String($request && $request.url || '');
  // host из URL: после схемы, до пути/порта/конца
  var host = '';
  var m = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^\/:?#]+)/i);
  if (m && m[1]) host = m[1].toLowerCase();
  // если host пуст — пробуем заголовок Host
  if (!host && $request && $request.headers) {
    var hh = $request.headers.Host || $request.headers.host || '';
    if (hh) host = String(hh).split(':')[0].toLowerCase();
  }

  // отбрасываем мусор: IP-адреса, пусто, локальное, свой дашборд
  var isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  var bad = !host || isIp || host === 'rh.box' || host.indexOf('.') < 0;

  if (!bad) {
    var raw = null;
    try { raw = JSON.parse($persistentStore.read(K_FAILLOG) || 'null'); } catch (e) {}
    if (!raw || !raw.items || !(raw.items instanceof Array)) raw = { v: 1, items: [] };

    var found = false;
    for (var i = 0; i < raw.items.length; i++) {
      if (raw.items[i].d === host) { raw.items[i].n = (raw.items[i].n || 1) + 1; raw.items[i].ts = Date.now(); found = true; break; }
    }
    if (!found) raw.items.push({ d: host, n: 1, ts: Date.now() });

    // кольцо: оставить последние MAX по времени
    if (raw.items.length > MAX) {
      raw.items.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      raw.items = raw.items.slice(0, MAX);
    }
    try { $persistentStore.write(JSON.stringify(raw), K_FAILLOG); } catch (e2) {}
  }
} catch (eX) {
  // молча: сбор лога не должен влиять на трафик
}
done();
