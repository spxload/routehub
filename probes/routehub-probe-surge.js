/*
 * RouteHub — ПРОБА ВОЗМОЖНОСТЕЙ SURGE. Ревизия SG1.
 * ===========================================================================
 * ЗАЧЕМ. У Дианы семь дней бесплатного Surge. Задача — за это время выяснить
 * не «что написано в документации», а ЧТО РЕАЛЬНО ЕСТЬ в среде, и что из
 * этого переносимо в Stash или в Loon. Проект уже обжёгся на обратном:
 * половина находок по Stash (`$environment['controller-url']`,
 * `$httpClient.globalProxy`, порт 13991 у Egern) в документации отсутствует,
 * а отсутствие `/version` у контроллера Stash однажды приняли за «контроллера
 * нет» и потеряли ревизию.
 *
 * ПРИНЦИП (вывод 54 проекта). Перебор ПО СПИСКУ ОЖИДАЕМЫХ ИМЁН негоден:
 * он находит только то, что мы и так знали. Отсутствие доказывает лишь
 * СПЛОШНАЯ ОПИСЬ. Поэтому проба сначала выгружает всё, что есть, и лишь
 * потом сверяет со списком известного.
 *
 * ЧТО ДЕЛАЕТ — ТОЛЬКО ЧТЕНИЕ:
 *   1. Сплошная опись глобальных имён и их прототипа.
 *   2. Разбор КАЖДОГО `$`-объекта: свои свойства, тип каждого члена,
 *      значения коротких строк и чисел (секреты маскируются).
 *   3. Полный дамп `$environment` и `$network` — там у клиентов обычно
 *      лежит недокументированное.
 *   4. Замер движка: число глобальных имён, миллион итераций, наличие
 *      WebSocket, crypto.subtle, fetch, TextEncoder. Колонки те же, что в
 *      таблице сравнения клиентов в `docs/ЭТАП_K_STASH.md`, — чтобы Surge
 *      встал в неё четвёртой колонкой без пересчёта.
 *   5. Карта локального HTTP API: GET по кандидатам путей на 127.0.0.1.
 *      Только GET. Ни одного метода, который что-то меняет.
 *   6. Перечень «пишущих» возможностей: НАЛИЧИЕ фиксируется, вызов — нет.
 *
 * ЧЕГО НЕ ДЕЛАЕТ (правила проекта, нарушать нельзя):
 *   • не гоняет трафик через обходные узлы — платный трафик;
 *   • не пишет в боевую маршрутизацию: никаких setSelectGroupPolicy,
 *     смены режима, перезагрузки профиля, правок конфига;
 *   • не включает MITM и не трогает захват трафика;
 *   • не отправляет наружу ключ API и вообще ничего, похожего на секрет.
 *
 * ЗАПУСК (с телефона, без компьютера):
 *   Surge → Скрипты (Scripting) → выбрать RH-SG1 → «Выполнить» (Run),
 *   вывод смотреть тут же. Либо как панель на главном экране Surge —
 *   см. `probes/RouteHub-Surge.sgmodule`.
 *
 * АРГУМЕНТ (необязательный, вида `ключ=значение`, через `&`):
 *   full=1           выгрузить ВСЕ глобальные имена, а не только сводку
 *   apikey=<ключ>    ключ HTTP API Surge, если он включён в профиле строкой
 *                    http-api = <ключ>@0.0.0.0:6171
 *   port=<номер>     проверить дополнительный порт помимо кандидатов
 *   post=1           отправить отчёт на приёмник стенда (по умолчанию нет)
 *
 * ЗАЧЕМ ключ. Без него API отвечает 401 — и это тоже результат: он
 * доказывает, что API слушает. С ключом видно карту путей целиком.
 * Ключ НИКУДА не отправляется и в отчёт не попадает.
 */

var REV = 'SG1';
var BUDGET_MS = 25000;
var URL204 = 'http://connectivitycheck.gstatic.com/generate_204';
var INGEST = 'https://routehub-egern.proton4iker.workers.dev/ingest/rh-drop-2026?src=surge-' + REV;

var G = (typeof globalThis !== 'undefined') ? globalThis : this;
var T0 = Date.now();
var rep = { rev: REV, ts: new Date().toISOString(), steps: {}, errors: [] };

function left() { return BUDGET_MS - (Date.now() - T0); }

function safe(name, fn) {
  var t = Date.now();
  try { rep.steps[name] = fn(); }
  catch (e) { rep.errors.push(name + ': ' + String((e && e.message) || e)); }
  rep.steps['_ms_' + name] = Date.now() - t;
}

// Аргумент разбираем сами: у разных типов скриптов Surge он приходит
// то строкой, то объектом.
function parseArg() {
  var raw = (typeof $argument === 'undefined') ? '' : $argument;
  if (raw && typeof raw === 'object') return raw;
  var out = {}, s = String(raw || '');
  var parts = s.split('&');
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].split('=');
    if (kv[0]) out[kv[0].trim()] = kv.slice(1).join('=').trim();
  }
  return out;
}
var ARG = parseArg();
var FULL = String(ARG.full || '') === '1';
var APIKEY = String(ARG.apikey || '');
var DO_POST = String(ARG.post || '') === '1';

// Маскировка: всё, что похоже на ключ, токен или пароль, наружу не идёт.
var SECRET_RE = /(key|token|secret|password|passwd|auth|cookie|credential|uuid|hwid)/i;
function mask(name, v) {
  if (typeof v !== 'string') return v;
  if (SECRET_RE.test(String(name))) return '<скрыто, длина ' + v.length + '>';
  if (v.length > 200) return v.slice(0, 200) + '…<обрезано, всего ' + v.length + '>';
  return v;
}

// ── ШАГ 1. Сплошная опись глобальных имён ───────────────────────────────────
safe('globals', function () {
  var names = Object.getOwnPropertyNames(G).sort();
  var proto = [];
  try {
    var p = Object.getPrototypeOf(G);
    if (p) proto = Object.getOwnPropertyNames(p).sort();
  } catch (e) {}
  var dollars = [];
  for (var i = 0; i < names.length; i++) if (names[i].charAt(0) === '$') dollars.push(names[i]);
  var o = { count: names.length, proto_count: proto.length, dollar_names: dollars };
  if (FULL) { o.names = names; o.proto = proto; }
  return o;
});

// ── ШАГ 2. Разбор каждого `$`-объекта ───────────────────────────────────────
// Именно здесь у Stash нашлись controller-url и globalProxy, которых нет в
// документации. Смотрим не «есть ли ожидаемое», а «что вообще внутри».
safe('dollar_objects', function () {
  var out = {};
  var names = Object.getOwnPropertyNames(G);
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    if (n.charAt(0) !== '$') continue;
    var v;
    try { v = G[n]; } catch (e) { out[n] = { error: String(e) }; continue; }
    var t = typeof v;
    if (t !== 'object' && t !== 'function') { out[n] = { type: t, value: mask(n, v) }; continue; }
    var members = {};
    try {
      var mn = Object.getOwnPropertyNames(v).sort();
      for (var j = 0; j < mn.length; j++) {
        var m = mn[j], mv;
        try { mv = v[m]; } catch (e2) { members[m] = 'error'; continue; }
        var mt = typeof mv;
        members[m] = (mt === 'string' || mt === 'number' || mt === 'boolean')
          ? (mt + ': ' + JSON.stringify(mask(m, mv))) : mt;
      }
    } catch (e3) { members._error = String(e3); }
    // Прототип отдельным списком: часть методов живёт там, а не на объекте.
    var pm = [];
    try {
      var pp = Object.getPrototypeOf(v);
      if (pp && pp !== Object.prototype && pp !== Function.prototype) pm = Object.getOwnPropertyNames(pp).sort();
    } catch (e4) {}
    out[n] = { type: t, members: members, proto_members: pm };
  }
  return out;
});

// ── ШАГ 3. Среда и сеть целиком ─────────────────────────────────────────────
safe('environment', function () {
  if (typeof $environment === 'undefined') return 'нет $environment';
  var o = {};
  for (var k in $environment) { try { o[k] = mask(k, $environment[k]); } catch (e) { o[k] = 'error'; } }
  try {
    var own = Object.getOwnPropertyNames($environment);
    for (var i = 0; i < own.length; i++) if (!(own[i] in o)) o[own[i]] = mask(own[i], $environment[own[i]]);
  } catch (e2) {}
  return o;
});

safe('network', function () {
  if (typeof $network === 'undefined') return 'нет $network';
  var o = {};
  try { o = JSON.parse(JSON.stringify($network)); } catch (e) {
    for (var k in $network) { try { o[k] = $network[k]; } catch (e2) {} }
  }
  // IP-адреса не секрет, но SSID и провайдера оставляем — они нужны для
  // разбора контекста, как в пробе L10.
  return o;
});

// ── ШАГ 4. Замер движка — колонки как в таблице сравнения клиентов ─────────
safe('engine', function () {
  var t = Date.now(), acc = 0;
  for (var i = 0; i < 1000000; i++) acc += i % 7;
  var loopMs = Date.now() - t;
  function ty(n) { try { return typeof G[n]; } catch (e) { return 'error'; } }
  return {
    globals: (rep.steps.globals && rep.steps.globals.count) || null,
    million_iterations_ms: loopMs,
    acc_check: acc,
    WebSocket: ty('WebSocket'),
    fetch: ty('fetch'),
    crypto: ty('crypto'),
    'crypto.subtle': (typeof G.crypto === 'object' && G.crypto) ? typeof G.crypto.subtle : 'нет',
    TextEncoder: ty('TextEncoder'),
    localStorage: ty('localStorage'),
    setTimeout: ty('setTimeout'),
    Promise: ty('Promise'),
    async_support: (function () { try { new Function('return (async()=>1)'); return 'есть'; } catch (e) { return 'нет'; } })(),
  };
});

// ── ШАГ 5. Сверка со списком известного — ПОСЛЕ описи, а не вместо ────────
safe('known_check', function () {
  var KNOWN = ['$httpClient', '$persistentStore', '$notification', '$done', '$argument',
    '$environment', '$script', '$network', '$utils', '$surge', '$configuration',
    '$profile', '$request', '$response', '$practice', '$intent', '$task', '$config',
    '$stash', '$loon', '$axios', '$prefs'];
  var o = {};
  for (var i = 0; i < KNOWN.length; i++) {
    try { o[KNOWN[i]] = typeof G[KNOWN[i]]; } catch (e) { o[KNOWN[i]] = 'error'; }
  }
  return o;
});

// ── ШАГ 6. Пишущие возможности: только НАЛИЧИЕ, без вызова ────────────────
// Ни одна из этих функций не вызывается. Проект держит правило: пробы и
// диагностика никогда не пишут в боевую маршрутизацию.
safe('write_capabilities_present_not_called', function () {
  var CAND = [
    ['$surge', ['setSelectGroupPolicy', 'selectGroupDetails', 'setOutboundMode',
      'reloadProfile', 'setHttpAPI', 'setModuleState', 'setSwitchState', 'toggle']],
    ['$configuration', ['sendMessage', 'getItem', 'setItem']],
    ['$persistentStore', ['write', 'read']],
    ['$utils', ['geoip', 'ipasn', 'ipaso', 'ungzip', 'gzip']],
    ['$httpClient', ['get', 'post', 'put', 'delete', 'head', 'options', 'patch']],
  ];
  var out = {};
  for (var i = 0; i < CAND.length; i++) {
    var host = CAND[i][0], keys = CAND[i][1], obj = null;
    try { obj = G[host]; } catch (e) {}
    if (!obj) { out[host] = 'нет объекта'; continue; }
    var m = {};
    for (var j = 0; j < keys.length; j++) {
      try { m[keys[j]] = typeof obj[keys[j]]; } catch (e2) { m[keys[j]] = 'error'; }
    }
    out[host] = m;
  }
  return out;
});

// ── ШАГ 7. Карта локального HTTP API. ТОЛЬКО GET ──────────────────────────
// Порт 6171 — из документации Surge (http-api = <ключ>@0.0.0.0:6171).
// Остальные кандидаты — на случай, если он переопределён.
var PORTS = [6171, 6152, 8080];
if (ARG.port && !isNaN(+ARG.port)) PORTS.unshift(+ARG.port);

var PATHS = [
  '/v1/outbound', '/v1/outbound/global',
  '/v1/policies', '/v1/policies/detail', '/v1/policy_groups', '/v1/policy_groups/select',
  '/v1/requests/recent', '/v1/requests/active',
  '/v1/traffic', '/v1/dns', '/v1/dns/flush',
  '/v1/profiles/current', '/v1/profiles/items',
  '/v1/modules', '/v1/scripting', '/v1/rules', '/v1/devices',
  '/v1/features/mitm', '/v1/features/capture', '/v1/features/rewrite',
  '/v1/features/scripting', '/v1/features/system_proxy', '/v1/features/enhanced_mode',
  '/v1/events', '/v1/test/dns_delay', '/v1/stop',
  '/v1', '/', '/version', '/status'
];

function httpGet(url, headers, timeoutMs, cb) {
  if (typeof $httpClient === 'undefined' || !$httpClient.get) { cb({ err: 'нет $httpClient' }); return; }
  var done = false;
  var timer = setTimeout(function () { if (!done) { done = true; cb({ err: 'timeout' }); } }, timeoutMs);
  try {
    $httpClient.get({ url: url, headers: headers || {}, timeout: Math.round(timeoutMs / 1000) },
      function (err, resp, body) {
        if (done) return;
        done = true; clearTimeout(timer);
        if (err) { cb({ err: String(err) }); return; }
        cb({ status: (resp && resp.status) || null, len: body ? String(body).length : 0,
             head: body ? String(body).slice(0, 160) : '' });
      });
  } catch (e) {
    if (!done) { done = true; clearTimeout(timer); cb({ err: String(e) }); }
  }
}

// Сначала находим живой порт, потом обходим пути только на нём.
function findPort(idx, cb) {
  if (idx >= PORTS.length || left() < 6000) { cb(null, {}); return; }
  var p = PORTS[idx];
  httpGet('http://127.0.0.1:' + p + '/v1/outbound', APIKEY ? { 'X-Key': APIKEY } : {}, 2500, function (r) {
    rep.steps['port_' + p] = r;
    // 401 — это ТОЖЕ ответ: значит слушает, просто ключ не подошёл или не дан.
    if (r && (r.status || (r.err && String(r.err).indexOf('timeout') < 0 && r.status))) { cb(p, r); return; }
    if (r && r.status) { cb(p, r); return; }
    findPort(idx + 1, cb);
  });
}

function walk(port, i, acc, cb) {
  if (i >= PATHS.length || left() < 4000) { cb(acc, i); return; }
  httpGet('http://127.0.0.1:' + port + PATHS[i], APIKEY ? { 'X-Key': APIKEY } : {}, 1800, function (r) {
    acc[PATHS[i]] = r.status ? (r.status + ' · ' + r.len + ' Б') : ('— ' + (r.err || 'нет ответа'));
    walk(port, i + 1, acc, cb);
  });
}

// ── ШАГ 8. Живость сети без обходных узлов ────────────────────────────────
function checkNet(cb) {
  httpGet(URL204, {}, 4000, function (r) { rep.steps.net204 = r; cb(); });
}

// ── Вывод ─────────────────────────────────────────────────────────────────
function summary() {
  var g = rep.steps.globals || {}, e = rep.steps.engine || {};
  var lines = [];
  lines.push('глобальных имён: ' + (g.count || '?'));
  lines.push('$-объекты: ' + ((g.dollar_names || []).join(' ') || 'нет'));
  lines.push('движок: 1 млн итераций ' + (e.million_iterations_ms != null ? e.million_iterations_ms + ' мс' : '?') +
    ', WebSocket ' + (e.WebSocket || '?') + ', crypto.subtle ' + (e['crypto.subtle'] || '?'));
  if (rep.steps.api_port) lines.push('HTTP API: порт ' + rep.steps.api_port +
    ', путей отвечает ' + (rep.steps.api_alive || 0) + ' из ' + PATHS.length);
  else lines.push('HTTP API: не отозвался ни один кандидат (порты ' + PORTS.join(', ') + ')');
  if (rep.errors.length) lines.push('ошибок шагов: ' + rep.errors.length);
  return lines;
}

function finish() {
  rep.total_ms = Date.now() - T0;
  var lines = summary();
  var json = JSON.stringify(rep);
  console.log('[' + REV + '] ' + json);

  try {
    if (typeof $notification !== 'undefined' && $notification.post) {
      $notification.post('RouteHub ' + REV + ' — опись Surge', lines[0], lines.slice(1).join('\n'));
    }
  } catch (e) {}

  function done() {
    // Панель Surge, если скрипт запущен как panel: заголовок плюс сводка.
    try { $done({ title: 'RouteHub ' + REV, content: lines.join('\n'), icon: 'wand.and.stars' }); }
    catch (e) { try { $done(); } catch (e2) {} }
  }

  if (!DO_POST) { done(); return; }
  try {
    $httpClient.post({ url: INGEST, headers: { 'Content-Type': 'application/json' }, body: json, timeout: 8 },
      function () { done(); });
  } catch (e) { done(); }
}

// ── Прогон ────────────────────────────────────────────────────────────────
checkNet(function () {
  findPort(0, function (port, first) {
    if (!port) { finish(); return; }
    rep.steps.api_port = port;
    rep.steps.api_first = first;
    walk(port, 0, {}, function (map, reached) {
      rep.steps.api_map = map;
      rep.steps.api_reached = reached + ' из ' + PATHS.length;
      var alive = 0;
      for (var k in map) if (/^\d/.test(map[k])) alive++;
      rep.steps.api_alive = alive;
      finish();
    });
  });
});
