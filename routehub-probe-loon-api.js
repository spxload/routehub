// RouteHub — ПРОБА УПРАВЛЯЮЩЕГО API В LOON. Ревизия L7.
// НАЗНАЧЕНИЕ: закрыть пробел методики. В Egern мы искали локальный сервер
// (16 путей Surge + 7 Clash + соседние порты) — всё 404. В Stash такой сервер
// НАШЁЛСЯ и дал полное управление. В LOON такой поиск НИКОГДА НЕ ВЕЛСЯ.
// Если у Loon есть свой контроллер — миграция теряет смысл.
//
// ТОЛЬКО ЧТЕНИЕ: ни одного записывающего запроса, ни одного вызова
// setSelectPolicy / setPluginEnable / setScriptEnable / setRunningModel.
// Боевая маршрутизация не затрагивается.
//
// ТИП СКРИПТА: generic — запуск вручную из интерфейса Loon.
// УСТАНОВКА: в [Script] главного конфига или вручную в разделе
// «Скрипты»: generic script-path=<ссылка на этот файл>, tag=RH-L7, timeout=120
// ОТЧЁТ: буфер обмена через $notification с clipboard (вывод 57) + консоль.
//
// ВАЖНО (вывод 55): в Loon `$httpClient` БЕЗ параметра `node` идёт ПО ПРАВИЛАМ
// конфига. Для локальных адресов задаём `node: 'DIRECT'` явно, иначе
// запрос к 127.0.0.1 уйдёт в туннель и результат будет ложным.

var REV = 'L7';
var G = (typeof globalThis !== 'undefined') ? globalThis : this;
var T0 = Date.now();
var FIN = false;
var rep = { rev: REV, ts: new Date().toISOString(), steps: {}, probe: [], errors: [] };

// Порты: Clash/Stash (9090), Surge (6152, 6170), типовые прокси-порты,
// диапазон Egern (13992) — на случай общего происхождения прослоек.
var PORTS = [9090, 6152, 6170, 7890, 8080, 8888, 9091, 1080, 13992];
var PATHS = ['/', '/version', '/proxies', '/configs', '/policies', '/v1/policies', '/v1/policy_groups', '/v1/requests/recent'];

function has(n) { try { return typeof G[n]; } catch (e) { return 'error'; } }
function safe(name, fn) {
  var t = Date.now();
  try { rep.steps[name] = fn(); }
  catch (e) { rep.errors.push(name + ': ' + String((e && e.message) || e)); }
  rep.steps['_ms_' + name] = Date.now() - t;
}

// ШАГ 1. ЧЛЕНЫ $environment — именно здесь в Stash лежали адрес и токен.
// Значения длиной более 40 символов обрезаются: вдруг там ключ.
safe('environment', function () {
  var t = has('$environment');
  if (t === 'undefined') return { available: false };
  var r = { available: true, keys: [], values: {} };
  try { r.keys = Object.getOwnPropertyNames(G.$environment).sort(); } catch (e) {}
  for (var i = 0; i < r.keys.length; i++) {
    var k = r.keys[i];
    try {
      var v = G.$environment[k];
      var s = (v === null || v === undefined) ? String(v) : String(v);
      r.values[k] = (s.length > 40) ? (s.slice(0, 12) + '\u2026[\u0434\u043b\u0438\u043d\u0430 ' + s.length + ']') : s;
    } catch (e) { r.values[k] = 'error'; }
  }
  return r;
});

// ШАГ 2. Поиск по всей описи глобалов имён, пахнущих API и ключами.
safe('globals', function () {
  var names = [];
  try { names = Object.getOwnPropertyNames(G).sort(); } catch (e) {}
  var pat = /api|token|secret|key|controller|port|url|socket|dash|panel/i;
  var hits = [];
  for (var i = 0; i < names.length; i++) if (pat.test(names[i])) hits.push(names[i]);
  var dollar = [];
  for (var j = 0; j < names.length; j++) if (names[j].charAt(0) === '$') dollar.push(names[j]);
  return { count: names.length, dollar: dollar, suspicious: hits };
});

// ШАГ 3. Опись членов $config и $utils — нет ли чего сверх восьми методов.
safe('members', function () {
  var want = ['$config', '$utils', '$persistentStore', '$httpClient', '$notification', '$script', '$network'];
  var r = {};
  for (var i = 0; i < want.length; i++) {
    var n = want[i], t = has(n);
    if (t !== 'object' && t !== 'function') { r[n] = t; continue; }
    try {
      var o = G[n], m = Object.getOwnPropertyNames(o);
      try {
        var pp = Object.getPrototypeOf(o);
        if (pp && pp !== Object.prototype) m = m.concat(Object.getOwnPropertyNames(pp));
      } catch (e) {}
      r[n] = m.sort();
    } catch (e) { r[n] = 'error'; }
  }
  return r;
});

// ШАГ 4. getConfig() — нет ли в выдаче полей про порт, API или ключ.
safe('getConfig', function () {
  if (has('$config') === 'undefined') return { available: false };
  var raw = null;
  try { raw = G.$config.getConfig(); } catch (e) { return { error: String(e) }; }
  var o = null;
  try { o = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (e) {}
  if (!o) return { type: typeof raw, len: raw ? String(raw).length : 0 };
  var keys = Object.keys(o).sort();
  var pat = /api|token|secret|key|controller|port|url|socket/i;
  var hits = [];
  for (var i = 0; i < keys.length; i++) if (pat.test(keys[i])) hits.push(keys[i] + '=' + String(o[keys[i]]).slice(0, 40));
  return { keys: keys, suspicious: hits, ssid: o.ssid, running_model: o.running_model };
});

// --- Перебор локальных адресов -------------------------------------
function call(url, cb) {
  var t = Date.now(), fired = false;
  function once(o) { if (!fired) { fired = true; cb(o); } }
  setTimeout(function () { once({ url: url, status: null, error: '\u0442\u0430\u0439\u043c\u0430\u0443\u0442', ms: Date.now() - t }); }, 2500);
  try {
    // node:'DIRECT' обязателен — иначе запрос уйдёт по правилам в туннель.
    G.$httpClient.get({ url: url, node: 'DIRECT', timeout: 2 }, function (err, resp, data) {
      once({
        url: url, ms: Date.now() - t,
        status: resp ? (resp.status || resp.statusCode) : null,
        error: err ? String(err).slice(0, 80) : null,
        len: data ? String(data).length : 0,
        head: data ? String(data).slice(0, 200) : ''
      });
    });
  } catch (e) {
    once({ url: url, status: null, error: 'throw: ' + String(e), ms: Date.now() - t });
  }
}

// ШАГ 5. Сначала корень каждого порта: жив ли там вообще сервер.
// Только для откликнувшихся портов перебираются пути — экономия бюджета.
var pi = 0, alive = [];
function scanPorts() {
  if (pi >= PORTS.length || Date.now() - T0 > 45000) { scanPaths(); return; }
  var p = PORTS[pi++];
  call('http://127.0.0.1:' + p + '/', function (r) {
    r.port = p;
    rep.probe.push(r);
    if (r.status !== null) alive.push(p);
    scanPorts();
  });
}

var ai = 0, qi = 0;
function scanPaths() {
  if (!alive.length) { finish('\u043d\u0438 \u043e\u0434\u0438\u043d \u043f\u043e\u0440\u0442 \u043d\u0435 \u043e\u0442\u0432\u0435\u0442\u0438\u043b'); return; }
  if (ai >= alive.length || Date.now() - T0 > 90000) { finish('\u043f\u0435\u0440\u0435\u0431\u043e\u0440 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043d'); return; }
  if (qi >= PATHS.length) { qi = 0; ai++; scanPaths(); return; }
  var p = alive[ai], q = PATHS[qi++];
  if (q === '/') { scanPaths(); return; }
  call('http://127.0.0.1:' + p + q, function (r) {
    r.port = p;
    rep.probe.push(r);
    scanPaths();
  });
}

function finish(note) {
  if (FIN) return;
  FIN = true;
  rep.total_ms = Date.now() - T0;
  rep.note = note || '';
  var hits = [];
  for (var i = 0; i < rep.probe.length; i++) if (rep.probe[i].status !== null) hits.push(rep.probe[i]);
  rep.hits = hits;
  var body = JSON.stringify(rep);
  try { console.log('[RH-' + REV + '] ' + body); } catch (e) {}
  var line = '\u043f\u043e\u0440\u0442\u043e\u0432 ' + PORTS.length + ' \u00b7 \u043e\u0442\u043a\u043b\u0438\u043a\u043d\u0443\u043b\u043e\u0441\u044c ' + hits.length;
  try {
    G.$notification.post('RouteHub ' + REV, line, '\u043e\u0442\u0447\u0451\u0442 \u0432 \u0431\u0443\u0444\u0435\u0440\u0435 \u043e\u0431\u043c\u0435\u043d\u0430', { 'clipboard': body });
  } catch (e) {
    try { G.$notification.post('RouteHub ' + REV, line, '\u0441\u043c. \u043a\u043e\u043d\u0441\u043e\u043b\u044c'); } catch (e2) {}
  }
  try { G.$done({}); } catch (e) {}
}

setTimeout(function () { finish('\u0438\u0441\u0447\u0435\u0440\u043f\u0430\u043d \u0431\u044e\u0434\u0436\u0435\u0442'); }, 100000);

if (has('$httpClient') === 'undefined') { rep.errors.push('\u043d\u0435\u0442 $httpClient'); finish('\u043d\u0435\u0442 $httpClient'); }
else scanPorts();
// конец файла
