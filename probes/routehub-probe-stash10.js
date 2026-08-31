/*
 * RouteHub — ПРОБА STASH ST10. Один вопрос, по схеме ST7–ST9.
 * ===========================================================================
 * ВОПРОС: годится ли контроллер Stash для ВНЕШНЕЙ ПАНЕЛИ, и каким способом
 * такая панель должна к нему подключаться.
 *
 * ПОЧЕМУ ИМЕННО ЭТОТ. Замер 31.08 закрыл путь «страница по https»: браузер
 * отклоняет запрос к 127.0.0.1 до сети (ADR-04, раздел 4.0). Остался ровно
 * один путь для браузерной панели — страница, отданная ПО HTTP: так живут
 * панели экосистемы Clash, их держат на http именно поэтому. Но у этого пути
 * два условия, и оба не проверены:
 *   1. Отдаёт ли контроллер заголовки CORS. Без них чужая страница ДОЙДЁТ до
 *      контроллера, но прочитать ответ не сможет — а панели нужно читать.
 *   2. Принимает ли контроллер секрет параметром адреса (`?token=`). Панели
 *      экосистемы передают его так; если Stash принимает только заголовок
 *      Authorization, потребуется предзапрос OPTIONS, и тогда важен пункт 1
 *      уже для метода OPTIONS.
 * Проба отвечает на оба, НЕ ВВОДЯ СЕКРЕТ НИКУДА, кроме локального запроса.
 *
 * ПОЧЕМУ ЭТО НЕ ПРОВЕРИТЬ БРАУЗЕРОМ. Со страницы по https до контроллера не
 * дойти вовсе (замер выше), а страницы по http у нас нет: Worker на
 * workers.dev отдаёт только https. Скрипт внутри Stash — единственный
 * доступный клиент, который может задать посторонний Origin и увидеть ответ.
 *
 * ПОБОЧНЫЙ ОТВЕТ, НУЖНЫЙ СБОРЩИКУ МЕТРИК: видны ли скрипту ЗАГОЛОВКИ ответа
 * вообще. Если нет — отпадает не только проверка CORS, но и всякий разбор
 * ответов по заголовкам в будущем сборщике.
 *
 * СЕКРЕТ В ВЫГРУЗКУ НЕ ПОПАДАЕТ. Он берётся из $environment, используется в
 * локальном запросе и нигде не сохраняется: в отчёте только код ответа.
 *
 * ТОЛЬКО ЧТЕНИЕ. GET, HEAD и OPTIONS. Ни PUT /proxies, ни PATCH /configs —
 * запись в боевую маршрутизацию пробам запрещена жёстким правилом 2.
 * Обходные узлы не затронуты: все запросы идут на 127.0.0.1, а не через узлы.
 *
 * КАК ЗАПУСКАТЬ. Расписанием `cron` — плитка на Stash 3.4.1 нажатием скрипт
 * не запускает (проверено 24.08). Туннель должен быть поднят.
 */

var REV = 'ST10';
var T0 = Date.now();
var BUDGET_MS = 12000;
var ORIGIN = 'http://board.zash.run.place';   // реальный адрес http-панели

var rep = { rev: REV, ts: new Date().toISOString(), ans: {}, err: [] };
var G = (typeof globalThis !== 'undefined') ? globalThis : this;

var CTRL = 'http://127.0.0.1:9090', AUTH = '';
try {
  CTRL = ($environment && $environment['controller-url']) || CTRL;
  AUTH = ($environment && $environment['controller-authorization']) || '';
  rep.ans.stash = ($environment && $environment['stash-version']) || '?';
} catch (e) { rep.err.push('нет $environment'); }
CTRL = String(CTRL).replace(/\/+$/, '');

// Секрет из заголовка: значение приходит уже со словом Bearer (замер ST3).
// В отчёт НЕ КЛАДЁТСЯ — только используется.
var SECRET = String(AUTH).replace(/^\s*Bearer\s+/i, '');

// Какие методы вообще есть у клиента. Перебираем, а не полагаемся на память:
// состав менялся между версиями, и OPTIONS нужен именно для предзапроса.
var METHODS = {};
try {
  ['get', 'head', 'post', 'put', 'patch', 'delete', 'options'].forEach(function (m) {
    METHODS[m] = (G.$httpClient && typeof G.$httpClient[m] === 'function');
  });
} catch (e) { rep.err.push('нет $httpClient'); }
rep.ans.методы_клиента = METHODS;

// Заголовки ответа клиенты называют по-разному; ищем перебором известных
// имён, а не гадаем одно. Возвращаем и сам объект, и то, где он нашёлся.
function headersOf(r) {
  if (!r || typeof r !== 'object') return null;
  var keys = ['headers', 'header', 'allHeaderFields', 'responseHeaders'];
  for (var i = 0; i < keys.length; i++) {
    if (r[keys[i]] && typeof r[keys[i]] === 'object') return { где: keys[i], h: r[keys[i]] };
  }
  return null;
}

function pickCors(h) {
  var want = ['access-control-allow-origin', 'access-control-allow-headers',
    'access-control-allow-methods', 'access-control-allow-credentials'];
  var out = {}, found = 0;
  for (var k in h) {
    var lk = String(k).toLowerCase();
    if (want.indexOf(lk) >= 0) { out[lk] = String(h[k]).slice(0, 80); found++; }
  }
  return { есть: found, поля: out };
}

function call(method, path, headers, cb) {
  var fn = G.$httpClient && G.$httpClient[method];
  if (typeof fn !== 'function') { cb(null, 'метода ' + method + ' у клиента нет'); return; }
  var o = { url: CTRL + path, timeout: 3 };
  if (headers) o.headers = headers;
  var done = false;
  function once(r, e) { if (done) return; done = true; cb(r, e); }
  try {
    fn.call(G.$httpClient, o, function (e, r, body) {
      once(e ? null : { r: r, body: body }, e ? String(e) : null);
    });
  } catch (e2) { once(null, String(e2)); }
}

// ── ШАГ 1: обычный GET с посторонним Origin ──────────────────────
function stepOrigin(next) {
  call('get', '/proxies', { Authorization: AUTH, Origin: ORIGIN }, function (res, e) {
    if (e || !res) { rep.ans.origin_запрос = 'не ответил: ' + (e || 'пусто'); next(); return; }
    rep.ans.origin_запрос = 'HTTP ' + ((res.r && res.r.status) || '?');
    // Состав объекта ответа — находка сама по себе: от неё зависит, сможет ли
    // будущий сборщик разбирать что-либо, кроме тела.
    var f = [];
    try { for (var k in res.r) f.push(k); } catch (e2) {}
    rep.ans.поля_ответа = f;
    var hh = headersOf(res.r);
    if (!hh) {
      rep.ans.заголовки_видны = 'НЕТ';
      rep.ans.cors = 'проверить нельзя: скрипту не видны заголовки ответа';
      next(); return;
    }
    rep.ans.заголовки_видны = 'да, поле ' + hh['где'];
    var names = [];
    for (var n in hh.h) names.push(String(n).toLowerCase());
    rep.ans.имена_заголовков = names.slice(0, 25);
    rep.ans.cors = pickCors(hh.h);
    next();
  });
}

// ── ШАГ 2: предзапрос OPTIONS ────────────────────────────────────
// Панель, передающая секрет заголовком Authorization, обязана сначала
// получить разрешение предзапросом. Если OPTIONS не отвечает или не отдаёт
// CORS — путь «панель с заголовком» закрыт независимо от шага 1.
function stepPreflight(next) {
  if (!METHODS.options) { rep.ans.предзапрос = 'метода OPTIONS у клиента нет'; next(); return; }
  call('options', '/proxies', {
    Origin: ORIGIN,
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'authorization',
  }, function (res, e) {
    if (e || !res) { rep.ans.предзапрос = 'не ответил: ' + (e || 'пусто'); next(); return; }
    var st = (res.r && res.r.status) || '?';
    var hh = headersOf(res.r);
    rep.ans.предзапрос = 'HTTP ' + st;
    rep.ans.предзапрос_cors = hh ? pickCors(hh.h) : 'заголовки не видны';
    next();
  });
}

// ── ШАГ 3: секрет параметром адреса ──────────────────────────────
// Панели экосистемы передают его так. В отчёт идёт ТОЛЬКО код ответа.
function stepToken(next) {
  if (!SECRET) { rep.ans.токен_в_адресе = 'секрет не получен из $environment'; next(); return; }
  call('get', '/proxies?token=' + encodeURIComponent(SECRET), { Origin: ORIGIN }, function (res, e) {
    if (e || !res) { rep.ans.токен_в_адресе = 'не ответил: ' + (e || 'пусто'); next(); return; }
    var st = (res.r && res.r.status) || 0;
    rep.ans.токен_в_адресе = 'HTTP ' + st + (st === 200 ? ' — принимается' : ' — не принимается');
    next();
  });
}

// ── ШАГ 4: короткая перепись путей, нужных панели ────────────────
var PATHS = ['/proxies', '/providers/proxies', '/rules', '/providers/rules',
  '/connections', '/configs', '/version', '/memory', '/logs'];
var pathRes = {};

function walk(i, cb) {
  if (i >= PATHS.length || (Date.now() - T0) > BUDGET_MS - 2500) { cb(); return; }
  call('get', PATHS[i], { Authorization: AUTH }, function (res, e) {
    pathRes[PATHS[i]] = (e || !res) ? ('нет: ' + (e || 'пусто'))
      : ('HTTP ' + ((res.r && res.r.status) || '?') +
         ', ' + String((res.body === undefined || res.body === null) ? '' : res.body).length + ' б');
    walk(i + 1, cb);
  });
}

function stepPaths(next) { walk(0, function () { rep.ans.пути = pathRes; next(); }); }

// ── ВЕРДИКТ ──────────────────────────────────────────────────────
// РАЗБОР ПЕРЕПИСАН 31.08 ПО ПЕРВОМУ ЖЕ ЗАМЕРУ. Первая редакция решала по
// одному признаку — принимается ли секрет параметром адреса, — и на живых
// данных недооценила ответ: секрет параметром не принимается (401), но
// ПРЕДЗАПРОС вернул 200 с `Access-Control-Allow-Headers: Authorization`,
// то есть панель, шлющая секрет заголовком, разрешена. Решающий признак —
// предзапрос, а токен в адресе лишь говорит, обойдётся ли панель без него.
// Отдельно важен `Allow-Methods`: если там только GET, панель возможна
// ТОЛЬКО НА ЧТЕНИЕ — переключить узел из браузера не выйдет.
function corsCount(x) { return (x && typeof x === 'object' && x['есть']) || 0; }
function corsField(x, name) {
  var f = x && typeof x === 'object' && x['поля'];
  return (f && f[name]) ? String(f[name]) : '';
}

function verdict() {
  var a = rep.ans;
  if (a.заголовки_видны === 'НЕТ') {
    return 'НЕЯСНО: скрипту не видны заголовки ответа, про CORS сказать нечего';
  }
  var onGet = corsCount(a.cors), onPre = corsCount(a.предзапрос_cors);
  if (!onGet && !onPre) {
    return 'НЕТ: контроллер не отдаёт CORS — чужая страница до него дойдёт, ' +
      'но прочитать ответ не сможет. Браузерная панель закрыта окончательно.';
  }
  var tokLine = String(a.токен_в_адресе || '');
  var tok = tokLine.indexOf('не принимается') < 0 && tokLine.indexOf('принимается') > 0;
  var preOk = String(a.предзапрос || '').indexOf('HTTP 2') === 0;
  var hdrOk = corsField(a.предзапрос_cors, 'access-control-allow-headers')
    .toLowerCase().indexOf('authorization') >= 0;
  var methods = corsField(a.предзапрос_cors, 'access-control-allow-methods').toUpperCase();
  var writeOk = methods.indexOf('PUT') >= 0 || methods.indexOf('*') >= 0;
  var scope = writeOk ? 'чтение и управление' : 'ТОЛЬКО ЧТЕНИЕ (в предзапросе нет PUT)';
  a.область_панели = scope;

  if (tok) {
    return 'ДА: CORS есть и секрет принимается параметром адреса — панель по http ' +
      'заработает как есть, область: ' + scope;
  }
  if (preOk && hdrOk) {
    return 'ДА, С ОГОВОРКОЙ: секрет параметром адреса не принимается, но предзапрос ' +
      'разрешает заголовок Authorization — панель по http заработает, если шлёт секрет ' +
      'заголовком. Область: ' + scope;
  }
  if (preOk) {
    return 'ЧАСТИЧНО: предзапрос отвечает, но Authorization в нём не разрешён — ' +
      'панели нечем передать секрет';
  }
  return 'ЧАСТИЧНО: CORS на обычном запросе есть, предзапрос не отвечает — ' +
    'панель с заголовком Authorization до контроллера не дойдёт';
}

var FINISHED = false;
function finish() {
  if (FINISHED) return;
  FINISHED = true;
  rep.ans.ВЕРДИКТ = verdict();
  rep.ms = Date.now() - T0;
  var a = rep.ans;
  var lines = [
    a.ВЕРДИКТ,
    'заголовки ответа: ' + (a.заголовки_видны || '?'),
    'CORS: ' + JSON.stringify(a.cors || {}),
    'предзапрос: ' + JSON.stringify(a.предзапрос || '?'),
    'токен в адресе: ' + (a.токен_в_адресе || '?'),
    'область панели: ' + (a.область_панели || '?'),
    'Stash ' + (a.stash || '?') + ', ' + rep.ms + ' мс',
  ];
  console.log('[' + REV + '] ' + JSON.stringify(rep));
  try {
    $notification.post('RouteHub ' + REV, lines[0], lines.slice(1).join('\n'),
      { clipboard: JSON.stringify(rep) });
  } catch (e) {}
  var color = '#8E8E93';
  if (a.ВЕРДИКТ.indexOf('ДА') === 0) color = '#34C759';
  else if (a.ВЕРДИКТ.indexOf('ЧАСТИЧНО') === 0) color = '#FF9F0A';
  else if (a.ВЕРДИКТ.indexOf('НЕТ') === 0) color = '#FF3B30';
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'),
            icon: 'antenna.radiowaves.left.and.right', backgroundColor: color });
  } catch (e2) { try { $done(); } catch (e3) {} }
}

// Сторож. Номинал делится на 3,6 — во столько раз Stash растягивает таймеры
// по замеру ST5. Точность не нужна: он обязан сработать РАНЬШЕ лимита.
setTimeout(function () {
  if (!FINISHED) { rep.err.push('сторож: бюджет ' + BUDGET_MS + ' мс исчерпан'); finish(); }
}, Math.round(BUDGET_MS / 3.6));

stepOrigin(function () { stepPreflight(function () { stepToken(function () { stepPaths(finish); }); }); });
