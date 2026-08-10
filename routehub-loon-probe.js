/*
 * routehub-loon-probe.js — ЧИТАЮЩАЯ диагностика Loon. Ревизия L1 (2026-08-10).
 *
 * ЗАЧЕМ. Для Egern мы прошли пятнадцать ревизий и выяснили, что сплошная опись
 * globalThis находит то, чего не найти перебором по списку известных имён.
 * В Loon такой описи НЕ ДЕЛАЛОСЬ НИ РАЗУ — искали только то, что знали по
 * документации. Loon у нас боевой, и цена находки здесь выше, чем на стенде.
 *
 * ОСОБО ИНТЕРЕСНО:
 *   • есть ли в Loon то, чего нет в Egern: crypto.subtle (у нас нет HMAC на
 *     устройстве), WebSocket (реальное время в панели), локальный HTTP API;
 *   • можно ли получить журнал соединений — вывод 8 гласит «Loon НЕ умеет
 *     логировать незагрузившиеся домены», но это никогда не проверялось
 *     сплошным поиском по API;
 *   • что на самом деле отдаёт $config.getConfig() — полный состав полей.
 *
 * БЕЗОПАСНОСТЬ. Скрипт ТОЛЬКО ЧИТАЕТ. Он не вызывает setSelectPolicy, не
 * трогает узлы, группы, правила и хранилище (кроме одного своего ключа).
 * Боевой конфиг не изменяется. Запуск — вручную, тип generic.
 *
 * КУДА СЛАТЬ ОТЧЁТ. URL берётся из $argument, чтобы токен стенда НЕ ПОПАЛ В
 * ПУБЛИЧНЫЙ РЕПОЗИТОРИЙ. Строка скрипта в Loon добавляется вручную:
 *   generic script-path=https://raw.githubusercontent.com/spxload/routehub/egern/routehub-loon-probe.js,
 *     tag=RH-Проба-Loon, argument=https://routehub-egern.proton4iker.workers.dev/t/<ТОКЕН>/probe?key=k3
 * Без argument отчёт останется в $persistentStore под ключом rh_loon_probe и
 * покажется в уведомлении сокращённо.
 *
 * СХЕМА ПРОГОНА — как в k4-11..k4-14: все шаги за один запуск, ошибка шага
 * пишется в отчёт и не мешает остальным; шаг, уронивший прогон, при следующем
 * запуске заносится в чёрный список и пропускается навсегда.
 */

var REV = 'L1';
var STATE = 'rh_loon_probe';
var POST_URL = (typeof $argument !== 'undefined' && $argument) ? String($argument) : '';

function readState() {
  try {
    var raw = $persistentStore.read(STATE);
    if (raw) return JSON.parse(raw);
  } catch (e) { }
  return null;
}
function writeState(st) {
  try { $persistentStore.write(JSON.stringify(st), STATE); } catch (e) { }
}

// Опись имён объекта вместе с прототипами, с типами значений.
function describe(obj, limit) {
  var out = {}, seen = 0;
  try {
    var cur = obj, names = [];
    for (var d = 0; d < 3 && cur; d++) {
      try {
        Object.getOwnPropertyNames(cur).forEach(function (n) {
          if (names.indexOf(n) < 0) names.push(n);
        });
      } catch (e) { }
      cur = Object.getPrototypeOf(cur);
    }
    names.sort();
    var skip = ['constructor', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
                'toLocaleString', 'toString', 'valueOf', '__defineGetter__',
                '__defineSetter__', '__lookupGetter__', '__lookupSetter__', '__proto__'];
    for (var i = 0; i < names.length && seen < (limit || 60); i++) {
      var n = names[i];
      if (skip.indexOf(n) >= 0) continue;
      var t = 'нет';
      try { t = typeof obj[n]; } catch (e) { t = 'недоступно'; }
      if (t === 'undefined') continue;
      out[n] = t;
      seen++;
    }
  } catch (e) { out.error = String(e && e.message || e); }
  return out;
}

function has(name) {
  try { return typeof eval(name); } catch (e) { return 'нет'; }
}

// Один запрос через $httpClient. node передаётся, чтобы проверить адресацию:
// в Egern этот параметр молча игнорировался, в Loon по документации работает.
function getVia(url, node, cb) {
  var opt = { url: url, timeout: 5000 };
  if (node) opt.node = node;
  var t = Date.now();
  try {
    $httpClient.get(opt, function (err, resp, body) {
      if (err) { cb({ err: String(err).slice(0, 80) }); return; }
      cb({ st: resp ? resp.status : null, ms: Date.now() - t,
           body: String(body || '').slice(0, 80) });
    });
  } catch (e) { cb({ crash: String(e && e.message || e).slice(0, 80) }); }
}

// ---------------------------------------------------------------- шаги
var steps = [];

// L1: СПЛОШНАЯ опись глобального объекта. Главный шаг ревизии.
steps.push(['L1_scan_full', function (done) {
  var res = {};
  try {
    var g = (typeof globalThis !== 'undefined') ? globalThis : this;
    var all = [];
    try { Object.getOwnPropertyNames(g).forEach(function (n) { all.push(n); }); } catch (e) { }
    res.total = all.length;
    var interesting = [];
    for (var i = 0; i < all.length; i++) {
      var n = all[i], c = n.charAt(0);
      if (c >= 'A' && c <= 'Z' && n.length > 3) continue;
      if (n.indexOf('on') === 0 && n.length > 4) continue;
      interesting.push(n);
    }
    res.interesting = interesting.join(',');
    res.by_keyword = all.filter(function (n) {
      var l = n.toLowerCase();
      return l.indexOf('loon') >= 0 || l.indexOf('policy') >= 0 || l.indexOf('proxy') >= 0 ||
             l.indexOf('config') >= 0 || l.indexOf('conn') >= 0 || l.indexOf('log') >= 0 ||
             l.indexOf('traffic') >= 0;
    }).join(',');
  } catch (e) { res.error = String(e && e.message || e); }
  done(res);
}]);

// L2: что на самом деле отдаёт $config и какие у него методы.
steps.push(['L2_config', function (done) {
  var res = { config_type: has('$config') };
  try {
    if (typeof $config !== 'undefined' && $config) {
      res.methods = describe($config, 40);
      if (typeof $config.getConfig === 'function') {
        var c = $config.getConfig();
        res.top_keys = c ? Object.keys(c).join(',') : 'пусто';
        if (c) {
          res.ssid = c.ssid || null;
          res.running_model = c.running_model;
          // Группы: только имена и текущий выбор. Ничего не переключаем.
          try {
            var pol = c.policy_groups || c.policygroups || c.groups || null;
            if (pol) {
              res.groups_type = Array.isArray(pol) ? 'массив' : typeof pol;
              res.groups_sample = JSON.stringify(pol).slice(0, 500);
            } else {
              res.groups = 'поля групп нет среди ' + res.top_keys;
            }
          } catch (e) { res.groups_err = String(e && e.message || e); }
        }
      }
    }
  } catch (e) { res.error = String(e && e.message || e); }
  done(res);
}]);

// L3: браузерная среда. В Egern полный WebKit, но БЕЗ crypto.subtle.
// Если в Loon subtle есть — на устройстве можно считать HMAC.
steps.push(['L3_webkit', function (done) {
  var res = {};
  var names = ['window', 'document', 'location', 'navigator', 'WebSocket', 'XMLHttpRequest',
               'fetch', 'localStorage', 'sessionStorage', 'indexedDB', 'crypto',
               'WebAssembly', 'Worker', 'EventSource', 'Blob', 'TextEncoder',
               'structuredClone', 'performance', 'setTimeout', 'Intl'];
  for (var i = 0; i < names.length; i++) res[names[i]] = has(names[i]);
  try {
    res.crypto_keys = (typeof crypto !== 'undefined') ? describe(crypto, 12) : 'нет';
    res.crypto_subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? 'ЕСТЬ' : 'нет';
  } catch (e) { res.crypto_err = String(e && e.message || e); }
  try { res.ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? String(navigator.userAgent).slice(0, 90) : 'нет'; } catch (e) { }
  done(res);
}]);

// L4: описи остальных известных объектов — вдруг есть методы сверх документации.
steps.push(['L4_objects', function (done) {
  var res = {};
  var objs = ['$httpClient', '$persistentStore', '$utils', '$notification', '$environment',
              '$script', '$config', '$network', '$httpAPI', '$surge', '$task', '$prefs'];
  for (var i = 0; i < objs.length; i++) {
    var t = has(objs[i]);
    if (t === 'object' || t === 'function') {
      try { res[objs[i]] = describe(eval(objs[i]), 25); } catch (e) { res[objs[i]] = 'ошибка описи'; }
    } else {
      res[objs[i]] = t;
    }
  }
  try { res.environment_value = (typeof $environment !== 'undefined') ? JSON.stringify($environment).slice(0, 200) : 'нет'; } catch (e) { }
  done(res);
}]);

// L5: адресация через конкретный узел. В Egern $httpClient молча игнорировал
// node; в Loon по документации должен учитывать. Проверяем по выходному IP.
// Имена узлов берутся из аргумента через точку с запятой, если заданы:
//   argument=<URL>;<узел1>;<узел2>
steps.push(['L5_node_routing', function (done) {
  var res = {};
  var parts = (typeof $argument !== 'undefined' && $argument) ? String($argument).split(';') : [];
  var n1 = parts[1] || '', n2 = parts[2] || '';
  var url = 'https://api.ipify.org';
  getVia(url, '', function (direct) {
    res.no_node = direct;
    if (!n1) { res.note = 'имена узлов не переданы в argument'; done(res); return; }
    getVia(url, n1, function (a) {
      res[n1] = a;
      if (!n2) { done(res); return; }
      getVia(url, n2, function (b) { res[n2] = b; done(res); });
    });
  });
}]);

// L6: локальный HTTP API. В Egern его нет вовсе; в Loon не проверялось.
steps.push(['L6_local_ports', function (done) {
  var ports = [9090, 6152, 6170, 7890, 1082, 8888, 13991];
  var paths = ['/', '/v1/policies', '/version'];
  var res = {}, idx = 0;
  var jobs = [];
  for (var p = 0; p < ports.length; p++)
    for (var q = 0; q < paths.length; q++)
      jobs.push(['http://127.0.0.1:' + ports[p] + paths[q], ports[p] + paths[q]]);
  function next() {
    if (idx >= jobs.length) { done(res); return; }
    var job = jobs[idx++];
    getVia(job[0], '', function (r) {
      // Отказ соединения не пишем — интересны только ответившие.
      if (r && (r.st || r.crash)) res[job[1]] = r;
      next();
    });
  }
  next();
}]);

// ---------------------------------------------------------------- прогон
var st = readState();
if (!st || st.rev !== REV) st = { rev: REV, dead: {}, results: {}, runs: 0 };
if (!st.dead) st.dead = {};
if (!st.results) st.results = {};

if (st.inflight) {
  st.dead[st.inflight] = true;
  st.results[st.inflight] = 'РОНЯЕТ ПРОГОН — шаг исключён';
  st.inflight = null;
  writeState(st);
}
st.runs = (st.runs || 0) + 1;

var i = 0;
function runNext() {
  if (i >= steps.length) { finish(); return; }
  var nm = steps[i][0], fn = steps[i][1];
  i++;
  if (st.dead[nm] || st.results[nm] !== undefined) { runNext(); return; }
  st.inflight = nm;
  writeState(st);
  var finished = false;
  var guard = setTimeout(function () {
    if (finished) return;
    finished = true;
    st.results[nm] = 'таймаут шага';
    st.inflight = null;
    writeState(st);
    runNext();
  }, 25000);
  try {
    fn(function (result) {
      if (finished) return;
      finished = true;
      clearTimeout(guard);
      st.results[nm] = result;
      st.inflight = null;
      writeState(st);
      runNext();
    });
  } catch (e) {
    if (finished) return;
    finished = true;
    clearTimeout(guard);
    st.results[nm] = 'ошибка: ' + String(e && e.message || e);
    st.inflight = null;
    writeState(st);
    runNext();
  }
}

function finish() {
  var report = { rev: REV, run: st.runs, client: 'loon',
                 done: Object.keys(st.results).length, total: steps.length,
                 dead: Object.keys(st.dead), results: st.results,
                 ts: new Date().toISOString() };
  var short = 'Шагов ' + report.done + ' из ' + steps.length +
              (report.dead.length ? ', исключено ' + report.dead.length : '');
  try { $notification.post('RouteHub-проба Loon ' + REV, short, POST_URL ? 'Отчёт отправлен на стенд' : 'Отчёт в хранилище'); } catch (e) { }
  if (!POST_URL) { $done({}); return; }
  var url = POST_URL.split(';')[0];
  try {
    $httpClient.post({ url: url, headers: { 'Content-Type': 'application/json' },
                       body: JSON.stringify(report), timeout: 15000 },
      function () { $done({}); });
  } catch (e) { $done({}); }
}

runNext();

// ХВОСТОВОЙ СТРАЖ — строка без перевода в конце файла; мусор после неё —