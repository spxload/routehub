// RouteHub — ПРОБА ВОЗМОЖНОСТЕЙ STASH. Ревизия ST1.
// НАЗНАЧЕНИЕ: сплошная опись среды Stash и проверка сетевых возможностей.
// ТОЛЬКО ЧТЕНИЕ: скрипт не меняет ни политику, ни правила, ни узлы. Единственная
// запись — временный ключ RH_probe_tmp в хранилище, он же удаляется в конце шага.
// СХЕМА ПРОГОНА (вывод 56): все шаги за один запуск; ошибка шага пишется в отчёт,
// перебор продолжается; общий бюджет времени, недоделанное — следующим запуском.
// ДОСТАВКА ОТЧЁТА: POST на открытый приёмник стенда (токена устройства не требует
// и доступа к подписке не даёт). Если POST не прошёл — печать в консоль Stash.
// ЗАПУСК: секция cron профиля Stash, см. ЭТАП_K_STASH.md.

var REV = 'ST1';
var INGEST = 'https://routehub-egern.proton4iker.workers.dev/ingest/rh-drop-2026?src=stash-' + REV;
var URL204 = 'http://connectivitycheck.gstatic.com/generate_204';
var URLIP = 'https://api.ipify.org?format=json';
var BUDGET_MS = 25000;

var G = (typeof globalThis !== 'undefined') ? globalThis : this;
var T0 = Date.now();
var rep = { rev: REV, ts: new Date().toISOString(), steps: {}, errors: [] };

function safe(name, fn) {
  var t = Date.now();
  try {
    rep.steps[name] = fn();
  } catch (e) {
    rep.errors.push(name + ': ' + String((e && e.message) || e));
  }
  rep.steps['_ms_' + name] = Date.now() - t;
}

function has(n) {
  try { return typeof G[n]; } catch (e) { return 'error'; }
}

// --- ШАГ 1. Сплошная опись глобальных имён -------------------------------
// Вывод 54: перебор ПО СПИСКУ ИМЁН негоден. Отсутствие доказывает только
// полная опись, поэтому имена выгружаются целиком, а не выборочно.
safe('globals', function () {
  var names = Object.getOwnPropertyNames(G).sort();
  var proto = [];
  try {
    var p = Object.getPrototypeOf(G);
    if (p) proto = Object.getOwnPropertyNames(p).sort();
  } catch (e) {}
  return { count: names.length, names: names, proto_count: proto.length, proto: proto };
});

// --- ШАГ 2. Наличие ожидаемых интерфейсов --------------------------------
var KNOWN = ['$httpClient', '$persistentStore', '$notification', '$done', '$argument',
  '$environment', '$script', '$config', '$stash', '$task', '$utils', '$network',
  '$request', '$response', '$intent', 'console', 'fetch', 'WebSocket', 'crypto',
  'localStorage', 'sessionStorage', 'setTimeout', 'setInterval', 'TextEncoder',
  'TextDecoder', 'Response', 'Request', 'XMLHttpRequest', 'atob', 'btoa'];

safe('api', function () {
  var o = {};
  for (var i = 0; i < KNOWN.length; i++) o[KNOWN[i]] = has(KNOWN[i]);
  try { o['crypto.subtle'] = (G.crypto && typeof G.crypto.subtle) || 'undefined'; } catch (e) {}
  return o;
});

// --- ШАГ 3. Опись членов найденных объектов ------------------------------
// Ищем то, чего в документации нет: управление политикой, чтение выбора групп,
// перечисление ключей хранилища. В Egern таких методов не нашлось ни одного.
safe('members', function () {
  var out = {};
  for (var i = 0; i < KNOWN.length; i++) {
    var n = KNOWN[i], v;
    try { v = G[n]; } catch (e) { continue; }
    if (!v || (typeof v !== 'object' && typeof v !== 'function')) continue;
    var own = [], pro = [];
    try { own = Object.getOwnPropertyNames(v); } catch (e) {}
    try {
      var p = Object.getPrototypeOf(v);
      if (p && p !== Object.prototype && p !== Function.prototype) pro = Object.getOwnPropertyNames(p);
    } catch (e) {}
    if (own.length || pro.length) out[n] = { own: own, proto: pro };
  }
  return out;
});

// --- ШАГ 4. Аргумент планового задания -----------------------------------
// В Loon у generic-скрипта $argument отсутствует (вывод 57). Здесь проверяем,
// доходит ли argument из секции cron профиля Stash.
safe('argument', function () {
  var t = has('$argument');
  var raw = (t === 'undefined') ? null : G.$argument;
  var parsed = null;
  if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch (e) {} }
  else if (raw && typeof raw === 'object') parsed = raw;
  return { type: t, raw: (typeof raw === 'string' ? raw : null), parsed: parsed };
});

// --- ШАГ 5. Хранилище ----------------------------------------------------
safe('store', function () {
  if (has('$persistentStore') === 'undefined') return { available: false };
  var key = 'RH_probe_tmp', val = 'rh-' + Date.now();
  var r = { available: true };
  try { r.write = G.$persistentStore.write(val, key); } catch (e) { r.write_err = String(e); }
  try { r.read_match = (G.$persistentStore.read(key) === val); } catch (e) { r.read_err = String(e); }
  try { r.remove = (typeof G.$persistentStore.remove === 'function'); } catch (e) {}
  // Уборка: пишем null — по журналу изменений Stash это штатный способ очистки.
  try { G.$persistentStore.write(null, key); } catch (e) {}
  return r;
});

// --- ШАГ 6. Производительность (сопоставимо с Egern 7 мс / Loon 12 / SR 40) ---
safe('perf', function () {
  var t = Date.now(), s = 0;
  for (var i = 0; i < 1000000; i++) s += i;
  return { million_iterations_ms: Date.now() - t, checksum: s };
});

// --- ШАГ 7. WebSocket: только конструктор, без ожидания соединения --------
// В Egern соединение открывается, в Loon класс есть, но не соединяется.
safe('websocket_ctor', function () {
  if (has('WebSocket') === 'undefined') return { available: false };
  try {
    var ws = new G.WebSocket('wss://echo.websocket.events');
    var st = ws.readyState;
    try { ws.close(); } catch (e) {}
    return { available: true, constructed: true, readyState: st };
  } catch (e) {
    return { available: true, constructed: false, error: String(e && e.message || e) };
  }
});

// --- СЕТЕВЫЕ ШАГИ: строго последовательно, каждый со своим бюджетом -------
function req(opts, cb) {
  if (has('$httpClient') === 'undefined') { cb({ error: 'no $httpClient' }); return; }
  var t = Date.now(), fired = false;
  function once(o) { if (!fired) { fired = true; cb(o); } }
  try {
    G.$httpClient.get(opts, function (err, resp, data) {
      once({
        ms: Date.now() - t,
        error: err ? String(err) : null,
        status: resp ? (resp.status || resp.statusCode) : null,
        body_len: data ? String(data).length : 0,
        body_head: data ? String(data).slice(0, 120) : ''
      });
    });
  } catch (e) {
    once({ error: 'throw: ' + String(e && e.message || e), ms: Date.now() - t });
  }
}

function finish() {
  rep.total_ms = Date.now() - T0;
  var body = JSON.stringify(rep);
  rep_sent(body);
}

function rep_sent(body) {
  var done = false;
  function end(note) {
    if (done) return;
    done = true;
    try { console.log('[RH-' + REV + '] ' + note); } catch (e) {}
    try { console.log(body); } catch (e) {}
    try { if (has('$done') !== 'undefined') G.$done({}); } catch (e) {}
  }
  if (has('$httpClient') === 'undefined') { end('отчёт только в консоль: нет $httpClient'); return; }
  try {
    G.$httpClient.post({ url: INGEST, headers: { 'Content-Type': 'application/json' }, body: body, timeout: 10 },
      function (err, resp) {
        end(err ? ('POST не прошёл: ' + String(err)) : ('POST ok: ' + (resp && (resp.status || resp.statusCode))));
      });
  } catch (e) {
    end('POST throw: ' + String(e && e.message || e));
  }
  setTimeout(function () { end('POST без ответа в срок'); }, 12000);
}

// Шаг 8: прямой запрос. Шаг 9: тот же адрес через конкретный узел.
// Имя узла берётся из argument (ключ node) — иначе шаг помечается пропущенным.
function stepDirect() {
  req({ url: URL204, timeout: 8 }, function (r) {
    rep.steps.net_direct = r;
    stepIP();
  });
}

function stepIP() {
  req({ url: URLIP, timeout: 8 }, function (r) {
    rep.steps.net_ip = r;
    stepNode();
  });
}

function stepNode() {
  var a = rep.steps.argument && rep.steps.argument.parsed;
  var node = a && a.node;
  if (!node) { rep.steps.net_node = { skipped: 'в argument нет ключа node' }; finish(); return; }
  // Документация Stash: имя прокси передаётся URL-кодированным в X-Stash-Selected-Proxy.
  req({ url: URLIP, timeout: 10, headers: { 'X-Stash-Selected-Proxy': encodeURIComponent(node) } },
    function (r) {
      r.node = node;
      rep.steps.net_node = r;
      finish();
    });
}

// Общий предохранитель: отчёт уходит даже если сетевая цепочка зависла.
setTimeout(function () {
  if (!rep.total_ms) { rep.errors.push('исчерпан бюджет ' + BUDGET_MS + ' мс'); finish(); }
}, BUDGET_MS);

stepDirect();
// конец файла — хвостовой страж (вывод 49)