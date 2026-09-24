/*
 * RouteHub — ПРОБА STASH ST19, часть 2: КОМАНДА ПО ССЫЛКЕ (перехват запроса).
 * ===========================================================================
 * ВОПРОС: может ли страница по https командовать Stash, если не лезть к
 * контроллеру из браузера (это закрыто, ADR-04 §4), а перейти по обычной
 * http-ссылке, которую перехватывает скрипт самого Stash.
 *
 * КАК. Override ST19 включает HTTP-движок для одного хоста
 * (`force-http-engine: rh-cmd.example.net:80`) и вешает на него request-скрипт.
 * Переход на http://rh-cmd.example.net/st19 — это навигация, а не запрос со
 * страницы, поэтому запрета смешанного содержимого нет; MITM не нужен (он
 * нужен только для https — stash.wiki/en/http-engine/mitm). Скрипт отвечает
 * сам через `$done({response})` — «no longer actually send the HTTP request»
 * (stash.wiki/en/script/rewrite-requests), до сервера запрос не доходит.
 * Правило override `DOMAIN,rh-cmd.example.net,DIRECT` — на случай, если
 * перехват не сработает: тогда запрос уйдёт напрямую и упадёт на DNS, через
 * узлы он не пойдёт (правило 1).
 *
 * ЧТО ДЕЛАЕТ. /st19 — страница с текущим выбором тестовой группы
 * RH-Т19-Команда и двумя ссылками-кнопками; ?n=<член> — PUT и страница с
 * результатом. Пишет ТОЛЬКО в RH-Т19-Команда и только имя из её списка
 * членов (белый список в коде). Результат кладёт в $persistentStore
 * (RH_ST19_cmd): cron-часть ST19 выводит его, даже если страница не
 * отобразилась.
 *
 * ФОРМА ОТВЕТА в вики не описана (researcher, 24.09): отдаются оба варианта
 * имени кода — status и statusCode. Какой сработал, видно по тому, открылась
 * ли страница.
 *
 * ВРЕМЯ: timeout $httpClient — секунды; худший честный путь — три запроса
 * по CTRL_SEC = 2 с, 6 с; сторож 8 с (скрипт интерактивный, в фоне не
 * живёт). Ровно один $done.
 */

var REV = 'ST19-cmd';
var GROUP = 'RH-Т19-Команда';
var ALLOWED = ['RH-Т19-Прямо', 'DIRECT'];
var CTRL_SEC = 2;           // три запроса подряд — 6 с, сторож 8 с позже (ловушка ST14)
var G = (typeof globalThis !== 'undefined') ? globalThis : this;
var FIN = false;
var out = { rev: REV, ts: new Date().toISOString() };

var CTRL = 'http://127.0.0.1:9090', AUTH = '';
try {
  CTRL = String(($environment && $environment['controller-url']) || CTRL).replace(/\/+$/, '');
  AUTH = ($environment && $environment['controller-authorization']) || '';
} catch (e) {}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function param(url, k) {
  var m = String(url || '').match(new RegExp('[?&]' + k + '=([^&#]*)'));
  if (!m) return null;
  try { return decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) { return null; }
}

function req(method, body, cb) {
  var o = { url: CTRL + '/proxies/' + encodeURIComponent(GROUP), timeout: CTRL_SEC, headers: {} };
  if (AUTH) o.headers.Authorization = AUTH;
  if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  var done = false;
  function once(r) { if (!done) { done = true; cb(r); } }
  try {
    G.$httpClient[method](o, function (e, r, d) {
      once({ status: r ? (r.status || r.statusCode || null) : null, error: e ? String(e) : null, body: d ? String(d) : '' });
    });
  } catch (e2) { once({ status: null, error: 'throw: ' + String(e2), body: '' }); }
}

function nowOf(r) {
  try { var j = JSON.parse(r.body); return typeof j.now === 'string' ? j.now : null; } catch (e) { return null; }
}

function page(title, rows) {
  var links = ALLOWED.map(function (n) {
    return '<a href="/st19?n=' + encodeURIComponent(n) + '">Выбрать ' + esc(n) + '</a>';
  }).join('');
  return '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>RouteHub ST19</title><style>' +
    'body{font:16px -apple-system,sans-serif;margin:0;padding:20px 16px;background:#f3f5f4;color:#15201d}' +
    '@media (prefers-color-scheme:dark){body{background:#0f1514;color:#e4ecea}a{background:#16312d!important;color:#4fc2b1!important}}' +
    'h1{font-size:20px}p{margin:6px 0}a{display:block;margin:10px 0;padding:14px;border-radius:10px;' +
    'background:#dcefeb;color:#0f6e62;text-decoration:none;font-weight:600;text-align:center}' +
    'code{font-size:13px;word-break:break-all}</style></head><body>' +
    '<h1>' + esc(title) + '</h1>' +
    rows.map(function (r) { return '<p>' + r + '</p>'; }).join('') +
    links + '</body></html>';
}

function finish(title, rows) {
  if (FIN) return;
  FIN = true;
  try { G.$persistentStore.write(JSON.stringify(out), 'RH_ST19_cmd'); } catch (e) {}
  try { console.log('[' + REV + '] ' + JSON.stringify(out)); } catch (e) {}
  try {
    $done({ response: {
      status: 200, statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      body: page(title, rows)
    } });
  } catch (e) { try { $done({}); } catch (e2) {} }
}

setTimeout(function () { out.ошибка = 'сторож 8 с'; finish('RouteHub ST19: не успел', ['Контроллер не ответил за 8 с.']); }, 8000);

try {
  var url = (typeof $request !== 'undefined' && $request) ? $request.url : null;
  out.запрос = { есть: !!url, метод: (typeof $request !== 'undefined' && $request) ? $request.method : null };
  var objs = [];
  for (var k in G) if (k.charAt(0) === '$') objs.push(k);
  out.объекты = objs.sort();
  var want = param(url, 'n');
  if (!url || typeof G.$httpClient === 'undefined') {
    out.ошибка = !url ? 'нет $request' : 'нет $httpClient';
    finish('RouteHub ST19: среда без запроса', [esc(out.ошибка)]);
  } else if (want === null) {
    req('get', null, function (r) {
      out.чтение = { код: r.status, now: nowOf(r), ошибка: r.error };
      finish('RouteHub ST19: команда по ссылке', [
        'Перехват сработал: страницу отдал скрипт Stash.',
        'Группа ' + esc(GROUP) + ': выбрано <b>' + esc(out.чтение.now || ('? ' + (r.status || r.error))) + '</b>',
        '<code>$-объекты: ' + esc(objs.join(', ')) + '</code>'
      ]);
    });
  } else if (ALLOWED.indexOf(want) < 0) {
    out.отказ = 'имя вне белого списка';
    finish('RouteHub ST19: отказ', ['Имя вне белого списка: ' + esc(want)]);
  } else {
    req('get', null, function (r0) {
      var was = nowOf(r0);
      req('put', { name: want }, function (p) {
        req('get', null, function (r1) {
          out.команда = { ждали: want, было: was, код: p.status, стало: nowOf(r1), ошибка: p.error,
            сработала: nowOf(r1) === want };
          finish(out.команда.сработала ? 'RouteHub ST19: переключено' : 'RouteHub ST19: не переключено', [
            esc(was || '?') + ' → <b>' + esc(out.команда.стало || '?') + '</b> (PUT ' + esc(p.status || p.error) + ')'
          ]);
        });
      });
    });
  }
} catch (e) {
  out.ошибка = 'сбой: ' + String(e);
  finish('RouteHub ST19: сбой', [esc(String(e))]);
}
// конец файла — хвостовой страж (вывод 49)
