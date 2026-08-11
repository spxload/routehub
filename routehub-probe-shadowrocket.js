// =============================================================
// routehub-probe-shadowrocket.js — ЧИТАЮЩАЯ диагностика Shadowrocket. REV: SR1.
//
// ЗАЧЕМ. Третий клиент, который стоит у Дианы и иногда используется.
//   По Egern пройдено пятнадцать ревизий, по Loon шесть; здесь снимается
//   базовая картина тем же способом, чтобы три клиента можно было сравнить.
//   Особая ценность момента: whitelist РКН ВКЛЮЧЁН, значит сразу видно,
//   как Shadowrocket ведёт себя под блокировкой.
//
// ЧТО УЖЕ ЗНАЕМ ПРО ДРУГИЕ КЛИЕНТЫ (для сравнения):
//   • Egern: управление политиками из скрипта НЕВОЗМОЖНО (доказано сплошной
//     описью 959 имён); зато есть ctx.ssh, цепочки prev_hop, правила по SSID,
//     группа smart с рейтингом, виджеты.
//   • Loon 3.5.0: $config умеет getPolicy, getSelectedPolicy, setSelectPolicy,
//     setPluginEnable, setScriptEnable, setRunningModel; getConfig отдаёт
//     JSON-строку с картой policy_select; WebSocket НЕ соединяется;
//     локальный порт 6152 закрыт; хранилище 1 МБ на ключ.
//
// БЕЗОПАСНОСТЬ: ТОЛЬКО ЧТЕНИЕ. Ничего не переключает и не меняет.
//   Запись — только собственное состояние под ключом rh_probe_sr.
//
// КАК ЗАПУСТИТЬ (Диана):
//   Shadowrocket → «Конфигурация» → раздел [Script] активного конфига,
//   строка вида:
//     rh-probe = type=cron,script-path=<ссылка>,cronexp=0 0 * * *,enable=true
//   и запустить вручную кнопкой у скрипта. Либо через «Скрипты» → «Выполнить».
//   Если в этой версии нет ручного запуска — поставить cronexp на ближайшую
//   минуту и дождаться срабатывания.
//
// ДОСТАВКА: отчёт кладётся в буфер обмена через уведомление (как в Loon).
//   Если буфер не поддерживается — краткая сводка придёт в тексте пуша,
//   полный отчёт останется в хранилище под ключом rh_probe_sr.
// =============================================================

const REV = 'SR1';
const STATE = 'rh_probe_sr';
const t0 = Date.now();

function store_read(k) { try { return $persistentStore.read(k); } catch (e) { return null; } }
function store_write(v, k) { try { return $persistentStore.write(v, k); } catch (e) { return 'ошибка'; } }

function describe(obj, limit) {
  const out = {};
  let seen = 0;
  try {
    let cur = obj;
    const names = [];
    for (let d = 0; d < 3 && cur; d++) {
      try { Object.getOwnPropertyNames(cur).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); }); }
      catch (e) { }
      cur = Object.getPrototypeOf(cur);
    }
    names.sort();
    for (let i = 0; i < names.length && seen < (limit || 50); i++) {
      const n = names[i];
      if (n === 'constructor' || n.indexOf('__') === 0) continue;
      if (['hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
           'toString', 'valueOf', 'apply', 'bind', 'call', 'caller', 'length',
           'prototype', 'arguments', 'name'].indexOf(n) >= 0) continue;
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
    const started = Date.now();
    const timer = setTimeout(function () {
      if (!done.fired) { done.fired = true; resolve('таймаут'); }
    }, ms || 4000);
    try {
      const req = Object.assign({ url: url }, opt || {});
      $httpClient.get(req, function (err, resp, body) {
        if (done.fired) return;
        done.fired = true;
        clearTimeout(timer);
        if (err) { resolve('err:' + String(err).slice(0, 60)); return; }
        const r = { st: resp ? resp.status : null, ms: Date.now() - started };
        if (body) { r.len = String(body).length; r.body = String(body).slice(0, 50); }
        resolve(r);
      });
    } catch (e) {
      if (!done.fired) { done.fired = true; clearTimeout(timer); resolve('исключение'); }
    }
  });
}

const results = {};

(async function () {
  // 1. СПЛОШНАЯ опись globalThis — так в Egern стало ясно, что скрытого нет,
  // а в Loon нашлись captureLog и вся служебная машинерия.
  try {
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
      return l.indexOf('rocket') >= 0 || l.indexOf('policy') >= 0 || l.indexOf('proxy') >= 0 ||
             l.indexOf('config') >= 0 || l.indexOf('surge') >= 0 || l.indexOf('log') >= 0 ||
             l.indexOf('shadow') >= 0;
    });
    results.S1_scan = { total: all.length, interesting: interesting.join(','), by_keyword: kw.join(',') };
  } catch (e) { results.S1_scan = 'ошибка: ' + String((e && e.message) || e); }

  // 2. Описи известных объектов. В Shadowrocket ожидается surge-совместимый
  // набор; интересно, есть ли $config и что он умеет.
  try {
    const o = {};
    const names = ['$rocket', '$config', '$httpClient', '$persistentStore', '$utils',
                   '$notification', '$environment', '$script', '$network', '$task',
                   '$prefs', '$done', '$argument', '$httpAPI', '$surge', '$loon'];
    for (let i = 0; i < names.length; i++) {
      let v;
      try { v = eval(names[i]); } catch (e) { v = undefined; }
      if (typeof v === 'undefined') { o[names[i]] = 'отсутствует'; continue; }
      if (typeof v === 'object' && v !== null) o[names[i]] = describe(v, 40);
      else if (typeof v === 'function') o[names[i]] = 'function/' + v.length;
      else o[names[i]] = { type: typeof v, value: String(v).slice(0, 120) };
    }
    results.S2_objects = o;
  } catch (e) { results.S2_objects = 'ошибка: ' + String((e && e.message) || e); }

  // 3. Среда исполнения: движок, хранилища, WebSocket, криптография.
  try {
    const has = function (n) { try { return typeof eval(n); } catch (e) { return 'нет'; } };
    const env = {
      websocket: has('WebSocket'), localStorage: has('localStorage'),
      indexedDB: has('indexedDB'), fetch: has('fetch'), crypto: has('crypto'),
      wasm: has('WebAssembly'), xhr: has('XMLHttpRequest'), document: has('document')
    };
    try { env.subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? 'есть' : 'ОТСУТСТВУЕТ'; } catch (e) { }
    try { env.ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? String(navigator.userAgent).slice(0, 70) : null; } catch (e) { }
    try { env.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { }
    const t = Date.now();
    let acc = 0;
    for (let i = 0; i < 1000000; i++) acc += i % 7;
    env.million_iterations_ms = Date.now() - t;
    results.S3_env = env;
  } catch (e) { results.S3_env = 'ошибка: ' + String((e && e.message) || e); }

  // 4. Хранилище: лимиты и удаление.
  try {
    const TMP = 'rh_probe_sr_tmp';
    const out = {};
    const sizes = [1024, 262144, 1048576];
    for (let i = 0; i < sizes.length; i++) {
      const data = new Array(sizes[i] + 1).join('x');
      const w = store_write(data, TMP);
      const back = store_read(TMP);
      out[sizes[i]] = { write: w, read_back: back ? back.length : 0 };
    }
    try { out.remove = $persistentStore.remove ? $persistentStore.remove(TMP) : 'нет метода remove'; }
    catch (e) { out.remove = 'ошибка'; }
    results.S4_storage = out;
  } catch (e) { results.S4_storage = 'ошибка: ' + String((e && e.message) || e); }

  // 5. ПОД WHITELIST: маяки напрямую и через прокси. Прямой выход задаётся
  // явно — в Loon выяснилось, что без параметра запрос идёт по правилам.
  try {
    const M = [
      ['gstatic_cc', 'http://connectivitycheck.gstatic.com/generate_204'],
      ['cloudflare', 'http://cp.cloudflare.com/generate_204'],
      ['apple', 'http://captive.apple.com/hotspot-detect.html']
    ];
    const R = [['ya', 'https://ya.ru'], ['gosuslugi', 'https://www.gosuslugi.ru']];
    const out = { foreign_direct: {}, russian_direct: {}, foreign_default: {} };
    for (let i = 0; i < M.length; i++) {
      out.foreign_direct[M[i][0]] = await get(M[i][1], { node: 'DIRECT' }, 4000);
      out.foreign_default[M[i][0]] = await get(M[i][1], null, 4000);
    }
    for (let i = 0; i < R.length; i++) {
      out.russian_direct[R[i][0]] = await get(R[i][1], { node: 'DIRECT' }, 4000);
    }
    results.S5_whitelist = out;
  } catch (e) { results.S5_whitelist = 'ошибка: ' + String((e && e.message) || e); }

  // 6. Локальные порты — у Shadowrocket может быть свой управляющий интерфейс.
  try {
    const ports = [9090, 6152, 1080, 8080, 7890, 8888];
    const out = {};
    for (let i = 0; i < ports.length; i++) {
      out[ports[i]] = await get('http://127.0.0.1:' + ports[i] + '/', { node: 'DIRECT' }, 1200);
    }
    results.S6_ports = out;
  } catch (e) { results.S6_ports = 'ошибка: ' + String((e && e.message) || e); }

  const R = { rev: REV, client: 'shadowrocket', mode: 'WHITELIST',
              results: results, total_ms: Date.now() - t0, ts: new Date().toISOString() };
  const body = JSON.stringify(R);
  store_write(body, STATE);

  try {
    $notification.post('Shadowrocket-проба ' + REV,
                       'Отчёт скопирован — вставь в чат',
                       'Байт: ' + body.length + '. Шагов: ' + Object.keys(results).length,
                       { 'clipboard': body });
  } catch (e) {
    try {
      $notification.post('Shadowrocket-проба ' + REV, '',
                         'Готово. Байт: ' + body.length + '. Отчёт в хранилище, ключ ' + STATE);
    } catch (e2) { }
  }
  $done({});
})();

// ХВОСТОВОЙ СТРАЖ — строка без перевода в конце файла; мусор после неё —