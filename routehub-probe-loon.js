// =============================================================
// routehub-probe-loon.js — ЧИТАЮЩАЯ диагностика Loon. REV: L3 (2026-08-10).
//
// ИТОГИ L2 — Loon оказался БОГАЧЕ Egern:
//   • $config имеет ВОСЕМЬ методов, а не три: getConfig, getPolicy,
//     getSelectedPolicy, getSubPolicies, getSubPolicys, setPluginEnable,
//     setRunningModel, setScriptEnable, setSelectPolicy.
//     setPluginEnable и setScriptEnable — ВОЗМОЖНОСТЬ, КОТОРОЙ НЕТ В EGERN:
//     скрипт может включать и гасить плагины и другие скрипты.
//   • $persistentStore умеет remove; $utils — ungzipTest.
//   • $environment, $network, $task, $prefs ОТСУТСТВУЮТ (в Egern они есть
//     из Surge-прослойки — здесь прослойки нет).
//   • НЕДОКУМЕНТИРОВАННЫЕ глобалы: captureLog, $loon, $argument,
//     __LOONGetData__, __LOONSendData__, __LOONRequestBody__,
//     __LOONResponseBody__, __LOONBase64BinaryTool, __LNbase64ToUint8Array.
//     captureLog по названию — про журналирование (наш вывод 8: «Loon не
//     умеет логировать незагрузившиеся домены»). Ни один не описан.
//   • ПОРТ 6152 ОТВЕЧАЕТ, но по TLS: ошибка рукопожатия вместо таймаута,
//     как на остальных девяти портах. Стучаться надо по https.
//   • WebSocket ЕСТЬ (function), indexedDB есть, движок WebKit iOS 18.7,
//     часовой пояс Europe/Moscow. Дашборд реального времени возможен и
//     в боевом клиенте — ограничение вывода 7 снимается.
//     localStorage ОТСУТСТВУЕТ (в Egern был), crypto.subtle отсутствует.
//   • getConfig() вернул объект с числовыми ключами 0..39 — это МАССИВ,
//     а не структура с policy_groups. Формат разбирается шагом S3.
//
// БЕЗОПАСНОСТЬ. Скрипт ТОЛЬКО ЧИТАЕТ. Методы setSelectPolicy, setPluginEnable,
//   setScriptEnable и setRunningModel НЕ ВЫЗЫВАЮТСЯ НИГДЕ — они меняют живую
//   конфигурацию. Запись — только собственное состояние в $persistentStore
//   под ключом rh_probe_l1.
//
// ДОСТАВКА ОТЧЁТА: весь отчёт кладётся В БУФЕР ОБМЕНА через уведомление
//   (attach clipboard) — на L2 отправка по сети не сработала. Дополнительно
//   пробуется POST, если задан argument.
// =============================================================

const REV = 'L3';
const STATE = 'rh_probe_l1';
const BUDGET = 60000;

const POST_URL = (function () {
  try { if (typeof $argument !== 'undefined' && $argument) return String($argument).trim(); }
  catch (e) { }
  return '';
})();

const t0 = Date.now();

function readState() {
  try { const raw = $persistentStore.read(STATE); if (raw) return JSON.parse(raw); } catch (e) { }
  return null;
}
function writeState(o) {
  try { $persistentStore.write(JSON.stringify(o), STATE); } catch (e) { }
}

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
           'toLocaleString', 'toString', 'valueOf', 'apply', 'bind', 'call',
           'caller', 'length', 'prototype'].indexOf(n) >= 0) continue;
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
        if (err) { resolve('err:' + String(err).slice(0, 90)); return; }
        const r = { st: resp ? resp.status : null };
        if (body) r.body = String(body).slice(0, 150);
        resolve(r);
      });
    } catch (e) {
      if (!done.fired) { done.fired = true; clearTimeout(timer); resolve('исключение: ' + String((e && e.message) || e)); }
    }
  });
}

const steps = [
  // S1: недокументированные глобалы Loon. Главный шаг ревизии.
  // captureLog по названию — про журналирование запросов.
  ['S1_hidden_globals', async function () {
    const out = {};
    const names = ['captureLog', '$loon', '$argument', '$script', '$done',
                   '__LOONGetData__', '__LOONSendData__', '__LOONBase64BinaryTool',
                   '__LOONRequestBody__', '__LOONResponseBody__', '__lnUniqueId',
                   '__LNbase64ToUint8Array', '__LNuint8ArrayToBase64'];
    for (let i = 0; i < names.length; i++) {
      let v;
      try { v = eval(names[i]); } catch (e) { v = undefined; }
      if (typeof v === 'undefined') { out[names[i]] = 'отсутствует'; continue; }
      const rec = { type: typeof v };
      if (typeof v === 'function') {
        try { rec.arity = v.length; } catch (e) { }
        try { rec.src = String(v).slice(0, 200); } catch (e) { }
      } else if (typeof v === 'object' && v !== null) {
        rec.keys = describe(v, 30);
        try { rec.json = JSON.stringify(v).slice(0, 300); } catch (e) { }
      } else {
        try { rec.value = String(v).slice(0, 200); } catch (e) { }
      }
      out[names[i]] = rec;
    }
    return out;
  }],

  // S2: разбор getConfig(). На L2 вернулся объект с числовыми ключами 0..39 —
  // значит это массив. Смотрим, что в элементах.
  ['S2_getconfig_shape', async function () {
    if (typeof $config === 'undefined' || !$config.getConfig) return 'нет $config.getConfig';
    let c;
    try { c = $config.getConfig(); } catch (e) { return 'ошибка: ' + String((e && e.message) || e); }
    if (!c) return 'вернул пусто';
    const out = { type: typeof c, isArray: Array.isArray(c) };
    try { out.length = c.length; } catch (e) { }
    try {
      const first = [];
      for (let i = 0; i < 6 && i < (c.length || 0); i++) {
        const el = c[i];
        first.push(typeof el === 'object' && el !== null
          ? { keys: Object.keys(el).slice(0, 12), sample: JSON.stringify(el).slice(0, 220) }
          : String(el).slice(0, 120));
      }
      out.first_elements = first;
    } catch (e) { out.elements_error = String((e && e.message) || e); }
    try { out.top_keys = Object.keys(c).filter(function (k) { return !/^[0-9]+$/.test(k); }).slice(0, 20); } catch (e) { }
    return out;
  }],

  // S3: читающие методы $config — что именно они отдают.
  // ЗАПИСЬ НЕ ВЫЗЫВАЕТСЯ.
  ['S3_config_readers', async function () {
    const out = {};
    const call = function (name, args) {
      try {
        if (!$config[name]) return 'нет метода';
        const v = $config[name].apply($config, args || []);
        if (v === undefined) return 'undefined';
        if (typeof v === 'object' && v !== null) {
          return { type: Array.isArray(v) ? 'array' : 'object',
                   length: v.length, json: JSON.stringify(v).slice(0, 400) };
        }
        return { type: typeof v, value: String(v).slice(0, 200) };
      } catch (e) { return 'ошибка: ' + String((e && e.message) || e).slice(0, 120); }
    };
    out.getPolicy_noargs = call('getPolicy');
    out.getSelectedPolicy_noargs = call('getSelectedPolicy');
    out.getSubPolicies_noargs = call('getSubPolicies');
    out.getSubPolicys_noargs = call('getSubPolicys');
    // С именем боевой группы — только чтение выбранного члена.
    out.getSelectedPolicy_main = call('getSelectedPolicy', ['RH-Главный']);
    out.getSubPolicies_main = call('getSubPolicies', ['RH-Главный']);
    out.getPolicy_main = call('getPolicy', ['RH-Главный']);
    return out;
  }],

  // S4: порт 6152 отвечает по TLS. Стучимся по https и проверяем соседей.
  ['S4_tls_ports', async function () {
    const out = {};
    const paths = ['/', '/v1/policies', '/v1/policy_groups', '/v1/requests/recent', '/v1/log'];
    for (let i = 0; i < paths.length; i++) {
      out['https_6152' + paths[i]] = await get('https://127.0.0.1:6152' + paths[i], null, 1500);
    }
    out.https_localhost = await get('https://localhost:6152/', null, 1500);
    out.https_6153 = await get('https://127.0.0.1:6153/', null, 1500);
    return out;
  }],

  // S5: WebSocket в боевом клиенте. Если работает — дашборд реального
  // времени возможен без миграции на Egern.
  ['S5_websocket', async function () {
    if (typeof WebSocket === 'undefined') return 'нет WebSocket';
    return await new Promise(function (resolve) {
      let ws = null, settled = false;
      const finish = function (v) { if (!settled) { settled = true; try { if (ws) ws.close(); } catch (e) { } resolve(v); } };
      const timer = setTimeout(function () { finish('таймаут 8 с'); }, 8000);
      try {
        ws = new WebSocket('wss://ws.postman-echo.com/raw');
        ws.onopen = function () { try { ws.send('rh-loon-ping'); } catch (e) { } };
        ws.onmessage = function (ev) { clearTimeout(timer); finish({ echo: String(ev.data).slice(0, 40) }); };
        ws.onerror = function () { clearTimeout(timer); finish('ошибка соединения'); };
      } catch (e) { clearTimeout(timer); finish('исключение: ' + String((e && e.message) || e)); }
    });
  }],

  // S6: маршрутизация через конкретный узел. Имя берётся из аргумента
  // RH_NODE, если задан, иначе из состава боевой группы через getSubPolicies.
  ['S6_node_routing', async function () {
    const U = 'https://api.ipify.org';
    const out = { plain: await get(U, null, 6000) };
    let nodeName = null;
    try {
      if ($config.getSubPolicies) {
        const subs = $config.getSubPolicies('RH-Главный');
        if (subs && subs.length) {
          for (let i = 0; i < subs.length && !nodeName; i++) {
            const s = subs[i];
            const nm = typeof s === 'string' ? s : (s && (s.name || s.policy));
            if (nm && nm.indexOf('Обход') < 0 && nm !== 'DIRECT' && nm !== 'REJECT') nodeName = nm;
          }
        }
      }
    } catch (e) { out.pick_error = String((e && e.message) || e).slice(0, 100); }
    out.node_tried = nodeName;
    if (nodeName) {
      out.via_node = await get(U, { node: nodeName }, 8000);
      out.via_policy = await get(U, { policy: nodeName }, 8000);
    }
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
  const body = JSON.stringify(R);

  // Главный путь доставки — буфер обмена: на L2 отправка по сети не прошла.
  try {
    $notification.post('Loon-проба ' + REV + ': прогон ' + st.runs,
                       'Отчёт скопирован — вставь в чат',
                       'Готово ' + done + ' из ' + steps.length +
                       (left ? '. Осталось ' + left + ' — запусти ещё раз' : '. ЗАВЕРШЕНО') +
                       '. Байт: ' + body.length,
                       { 'clipboard': body });
  } catch (e) {
    try { $notification.post('Loon-проба ' + REV, '', 'Готово ' + done + ' из ' + steps.length); } catch (e2) { }
  }

  if (POST_URL) {
    try {
      $httpClient.post({ url: POST_URL, headers: { 'Content-Type': 'application/json' },
                         body: body }, function () { $done({}); });
      return;
    } catch (e) { }
  }
  $done({});
})();

// ХВОСТОВОЙ СТРАЖ — строка без перевода в конце файла; мусор после неё —