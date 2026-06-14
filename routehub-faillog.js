// =============================================================
// routehub-faillog.js v0.2.0 — сборщик доменов + ДИАГНОСТИКА (что ловит скрипт).
// Тип: http-request. Привязывается к фильтру Loon (тип+статус) в UI.
//
// v0.2.0 — РЕЖИМ ДИАГНОСТИКИ: пишем не только домен, но и:
//   * proto — http / https (по схеме $request.url)
//   * method — GET/POST/CONNECT/...
//   * body — есть ли тело запроса (появляется ТОЛЬКО при активном MITM для HTTPS).
//     Если body есть у https-домена → MITM работает на нём. Если нет → без MITM.
//   Это отвечает на вопрос «что вообще ловит скрипт и работает ли MITM».
//   Дашборд (v0.5.0) показывает эти поля у каждой записи.
//
// ВАЖНО про HTTPS без MITM: эмпирически http-домены ловятся, https — нет.
//   Этот скрипт это ПОДТВЕРДИТ или ОПРОВЕРГНЕТ: если https-домен появился с
//   proto=https — значит ловится и без MITM (мы ошибались). Если не появляется —
//   подтверждается, что Loon не отдаёт https скрипту без MITM.
//
// Скрипт НЕ вмешивается в трафик: только читает $request, пишет в store, $done({}).
//
// Формат rh_faillog: { v:2, items:[ {d, n, ts, proto, method, body} ] }
//   d домен, n счётчик, ts время, proto http/https, method метод, body 0/1 (есть тело).
// =============================================================

var K_FAILLOG = 'rh_faillog';
var MAX = 50;

function done() { $done({}); }

try {
  var url = String($request && $request.url || '');
  var method = String($request && $request.method || '').toUpperCase();

  // протокол по схеме URL
  var proto = '';
  var pm = url.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (pm && pm[1]) proto = pm[1].toLowerCase();

  // host
  var host = '';
  var m = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^\/:?#]+)/i);
  if (m && m[1]) host = m[1].toLowerCase();
  if (!host && $request && $request.headers) {
    var hh = $request.headers.Host || $request.headers.host || '';
    if (hh) host = String(hh).split(':')[0].toLowerCase();
  }

  // есть ли тело запроса — индикатор MITM (для https тело видно только при MITM)
  var hasBody = 0;
  try {
    if (typeof $request !== 'undefined' && $request && $request.body != null && String($request.body).length > 0) hasBody = 1;
  } catch (eb) {}

  var isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  var bad = !host || isIp || host === 'rh.box' || host.indexOf('.') < 0;

  if (!bad) {
    var raw = null;
    try { raw = JSON.parse($persistentStore.read(K_FAILLOG) || 'null'); } catch (e) {}
    if (!raw || !raw.items || !(raw.items instanceof Array)) raw = { v: 2, items: [] };
    raw.v = 2;

    var found = false;
    for (var i = 0; i < raw.items.length; i++) {
      if (raw.items[i].d === host) {
        raw.items[i].n = (raw.items[i].n || 1) + 1;
        raw.items[i].ts = Date.now();
        raw.items[i].proto = proto || raw.items[i].proto;
        raw.items[i].method = method || raw.items[i].method;
        if (hasBody) raw.items[i].body = 1;
        found = true; break;
      }
    }
    if (!found) raw.items.push({ d: host, n: 1, ts: Date.now(), proto: proto, method: method, body: hasBody });

    if (raw.items.length > MAX) {
      raw.items.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      raw.items = raw.items.slice(0, MAX);
    }
    try { $persistentStore.write(JSON.stringify(raw), K_FAILLOG); } catch (e2) {}
  }
} catch (eX) {}
done();
