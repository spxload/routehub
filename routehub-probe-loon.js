// =============================================================
// routehub-probe-loon.js — ЧИТАЮЩАЯ диагностика Loon. REV: L2 (2026-08-10).
//
// ЗАЧЕМ. По Egern пройдено пятнадцать ревизий, и сплошная опись globalThis
//   показала то, чего не найти перебором по списку известных имён. По Loon
//   такой описи НЕ ДЕЛАЛОСЬ НИ РАЗУ — искали только то, что знали из
//   документации. Проверяем, нет ли в боевом клиенте механизмов, мимо которых
//   мы прошли: журнала запросов (вывод 8 гласит «Loon не умеет логировать»),
//   локального управляющего порта, недокументированных методов $config.
//
// БЕЗОПАСНОСТЬ. Скрипт ТОЛЬКО ЧИТАЕТ: НЕ вызывает $config.setSelectPolicy,
//   НЕ меняет группы, НЕ пишет ничего, кроме собственного состояния в
//   $persistentStore под ключом rh_probe_l1. Боевая маршрутизация не
//   затрагивается. Запуск вручную, generic-скриптом.
//
// АДРЕС ДЛЯ ОТЧЁТА берётся из argument строки [Script] — чтобы токен стенда
//   не попадал в публичный репозиторий. Без него скрипт тоже работает: итог
//   приходит пушем, полный отчёт остаётся в $persistentStore.
//
// СХЕМА ПРОГОНА (перенесена из Egern-ревизий): все шаги за один запуск;
//   ошибка шага пишется в отчёт и перебор идёт дальше; шаг, уронивший прогон,
//   при следующем запуске заносится в чёрный список и пропускается навсегда;
//   бюджет 60 с — недоделанное выполнится следующим запуском.
// =============================================================

const REV = 'L2';
const STATE = 'rh_probe_l1';
const BUDGET = 60000;

// Адрес /probe стендового Worker'а передаётся через argument строки [Script].
const POST_URL = (function () {
  try { if (typeof $argument !== 'undefined' && $argument) return String($argument).trim(); }
  catch (e) { }
  return '';
})();

const t0 = Date.now();

function notify(title, text) {
  try { if (typeof $notification !== 'undefined' && $notification.post) $notification.post(title, '', text); }
  catch (e) { }
}
function readState() {
  try { const raw = $persistentStore.read(STATE); if (raw) return JSON.parse(raw); } catch (e) { }
  return null;
}
function writeState(o) {
  try { $persistentStore.write(JSON.stringify(o), STATE); } catch (e) { }
}

// Опись объекта вместе с прототипами: имена и типы значений.
function describe(obj, limit) {
  const out = {};
  let seen = 0;
  try {
    let cur = obj;
    const names = [];
    for (let d = 0; d < 3 && cur; d++) {
      try {
        Object.getOwnPropertyNames(cur).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
      } catch (e) { }
      cur = Object.getPrototypeOf(cur);
    }
    names.sort();
    for (let i = 0; i < names.length && seen < (limit || 60); i++) {
      const n = names[i];
      if (n === 'constructor' || n.indexOf('__') === 0) continue;
      if (['hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
           'toLocaleString', 'toString', 'valueOf'].indexOf(n) >= 0) continue;
      let t = 'нет';
      try { t = typeof obj[n]; } catch (e) { t = 'недоступно'; }
      if (t === 'undefined') continue;
      out[n] = t;
      seen++;
    }
  } catch (e) { out.error = String((e && e.message) || e); }
  return out;
}

function get(url, opt, ms) {
  return new Promise(function (resolve) {
    const done = { fired: false };
    const timer = setTimeout(function () {
      if (!done.fired) { done.fired = true; resolve('таймаут'); }
    }, ms || 5000);
    try {
      const req = Object.assign({ url: url }, opt || {});
      $httpClient.get(req, function (err, resp, body) {
        if (done.fired) return;
        done.fired = true;
        clearTimeout(timer);
        if (err) { resolve('err:' + String(err).slice(0, 80)); return; }
        const r = { st: resp ? resp.status : null };
        if (body) r.body = String(body).slice(0, 120);
        resolve(r);
      });
    } catch (e) {
      if (!done.fired) { done.fired = true; clearTimeout(timer); resolve('исключение: ' + String((e && e.message) || e)); }
    }
  });
}

const steps = [
  // S1: СПЛОШНАЯ опись globalThis. Главный шаг — по Loon впервые.
  ['S1_scan_full', async function () {
    const all = [];
    try { Object.getOwnPropertyNames(globalThis).forEach(function (n) { all.push(n); }); } catch (e) { }
    const interesting = [];
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      const c = n.charAt(0);
      if (c >= 'A' && c <= 'Z' && n.length > 3) continue;
      if (n.indexOf('on') === 0 && n.length > 4) continue;
      interesting.push(n);
    }
    const kw = all.filter(function (n) {
      const l = n.toLowerCase();
      return l.indexOf('loon') >= 0 || l.indexOf('policy') >= 0 || l.indexOf('proxy') >= 0 ||
             l.indexOf('config') >= 0 || l.indexOf('surge') >= 0 || l.indexOf('log') >= 0;
    });
    return { total: all.length, interesting: interesting.join(','), by_keyword: kw.join(',') };
  }],

  // S2: описи известных объектов по прототипам — методы сверх документации.
  ['S2_objects', async function () {
    const o = {};
    const names = ['$config', '$httpClient', '$persistentStore', '$utils', '$notification',
                   '$environment', '$script', '$network', '$task', '$prefs', '$done'];
    for (let i = 0; i < names.length; i++) {
      let v = null;
      try { v = eval(names[i]); } catch (e) { v = null; }
      o[names[i]] = (v === null || typeof v === 'undefined') ? 'отсутствует' : describe(v, 40);
    }
    return o;
  }],

  // S3: что отдаёт $config.getConfig(). ТОЛЬКО ЧТЕНИЕ, секреты не выводятся.
  ['S3_getconfig', async function () {
    if (typeof $config === 'undefined' || !$config.getConfig) return 'нет $config.getConfig';
    let c = null;
    try { c = $config.getConfig(); } catch (e) { return 'ошибка: ' + String((e && e.message) || e); }
    if (!c) return 'вернул пусто';
    const out = { keys: Object.keys(c).slice(0, 40) };
    try { out.ssid = c.ssid || null; } catch (e) { }
    try { out.running_model = c.running_model; } catch (e) { }
    try {
      if (c.policy_groups) {
        out.groups_count = c.policy_groups.length;
        out.groups = c.policy_groups.slice(0, 12).map(function (g) {
          return { name: g.name, type: g.type, select: g.select || g.selected || null,
                   members: g.policies ? g.policies.length : null };
        });
      }
    } catch (e) { out.groups_error = String((e && e.message) || e); }
    return out;
  }],

  // S4: локальные порты — есть ли управляющий интерфейс, как HTTP API у Surge.
  ['S4_local_ports', async function () {
    const ports = [6152, 6170, 9090, 8080, 1080, 7890, 8888, 13991, 6153, 9091];
    const out = {};
    for (let i = 0; i < ports.length; i++) {
      out[ports[i]] = await get('http://127.0.0.1:' + ports[i] + '/', null, 1500);
    }
    return out;
  }],

  // S5: пути Surge HTTP API вслепую на самом вероятном порту.
  // /v1/requests/recent — это журнал запросов, наша давняя боль.
  ['S5_api_paths', async function () {
    const paths = ['/v1/policies', '/v1/policy_groups', '/v1/policy_groups/select',
                   '/v1/requests/recent', '/v1/traffic', '/v1/events', '/v1/log',
                   '/v1/profiles/current', '/api/v1/log', '/logs'];
    const out = {};
    for (let i = 0; i < paths.length; i++) {
      out[paths[i]] = await get('http://127.0.0.1:6152' + paths[i], null, 1200);
    }
    return out;
  }],

  // S6: среда исполнения. В Egern оказался полный WebKit с рабочим WebSocket —
  // если здесь так же, дашборд реального времени возможен и без миграции.
  ['S6_environment', async function () {
    const has = function (n) { try { return typeof eval(n); } catch (e) { return 'нет'; } };
    const out = {
      websocket: has('WebSocket'), localStorage: has('localStorage'),
      indexedDB: has('indexedDB'), fetch: has('fetch'), crypto: has('crypto'),
      wasm: has('WebAssembly'), worker: has('Worker'), xhr: has('XMLHttpRequest'),
      document: has('document'), navigator: has('navigator')
    };
    try { out.subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? 'есть' : 'ОТСУТСТВУЕТ'; } catch (e) { }
    try { out.ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? String(navigator.userAgent).slice(0, 80) : null; } catch (e) { }
    try { out.env = JSON.stringify($environment).slice(0, 200); } catch (e) { }
    try { out.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { }
    return out;
  }],

  // S7: маршрутизация через конкретный узел, сравнение с прямым выходом.
  ['S7_node_routing', async function () {
    const U = 'https://api.ipify.org';
    const out = { plain: await get(U, null, 6000) };
    try {
      if (typeof $config !== 'undefined' && $config.getConfig) {
        const c = $config.getConfig();
        let nodeName = null;
        if (c && c.policy_groups) {
          for (let i = 0; i < c.policy_groups.length && !nodeName; i++) {
            const g = c.policy_groups[i];
            if (g && g.policies && g.policies.length) {
              for (let k = 0; k < g.policies.length; k++) {
                const p = g.policies[k];
                const nm = typeof p === 'string' ? p : (p && p.name);
                if (nm && nm.indexOf('Обход') < 0 && nm !== 'DIRECT' && nm !== 'REJECT') { nodeName = nm; break; }
              }
            }
          }
        }
        out.node_tried = nodeName;
        if (nodeName) out.via_node = await get(U, { node: nodeName }, 8000);
      }
    } catch (e) { out.error = String((e && e.message) || e); }
    return out;
  }]
];

(async function () {
  let st = readState();
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
  let did = 0, errs = 0, left = 0;

  for (let i = 0; i < steps.length; i++) {
    const nm = steps[i][0];
    if (st.dead[nm]) continue;
    if (st.results[nm] !== undefined) continue;
    if (Date.now() - t0 > BUDGET) { left++; continue; }
    st.inflight = nm;
    writeState(st);
    try { st.results[nm] = await steps[i][1](); did++; }
    catch (e) { st.results[nm] = 'ошибка: ' + String((e && e.message) || e); errs++; }
    st.inflight = null;
    writeState(st);
  }

  const done = Object.keys(st.results).length;
  const R = { rev: REV, client: 'loon', run: st.runs, total: steps.length,
              done: done, errors: errs, left: left, dead: Object.keys(st.dead),
              results: st.results, total_ms: Date.now() - t0,
              ts: new Date().toISOString() };

  notify('Loon-проба ' + REV + ': прогон ' + st.runs,
         'Готово ' + done + ' из ' + steps.length +
         (left ? '. Не хватило времени на ' + left + ' — запусти ещё раз'
               : '. ПЕРЕБОР ЗАВЕРШЁН') +
         (POST_URL ? '' : '. Адрес отчёта не задан — данные только в хранилище'));

  if (POST_URL) {
    try {
      $httpClient.post({ url: POST_URL, headers: { 'Content-Type': 'application/json' },
                         body: JSON.stringify(R) }, function () { $done({}); });
      return;
    } catch (e) { }
  }
  $done({});
})();

// ХВОСТОВОЙ СТРАЖ — строка без перевода в конце файла; мусор после неё —