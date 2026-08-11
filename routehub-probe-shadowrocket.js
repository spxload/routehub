// =============================================================
// routehub-probe-shadowrocket.js — ЧИТАЮЩАЯ диагностика Shadowrocket. REV: SR3.
//
// ИЗМЕНЕНИЕ ПРОТИВ SR2: отчёт ОТПРАВЛЯЕТСЯ НА СТЕНД сам — в Shadowrocket
//   не сработали ни буфер обмена из уведомления, ни поиск журнала скрипта.
//   Приёмник: /ingest/<ключ>?src=sr у Worker'а стенда. Токена устройства он
//   НЕ требует (скрипт лежит в публичном репозитории, токен туда класть
//   нельзя), доступа к подписке не даёт — только запись и чтение отчётов.
//   Печать в консоль кусками оставлена запасным путём.
//
// ЗАЧЕМ. Третий клиент для сравнения. Момент удачный: whitelist РКН ВКЛЮЧЁН.
//
// ЧТО УЖЕ ИЗМЕРЕНО НА ДРУГИХ КЛИЕНТАХ (для сопоставления):
//   • Egern: управление политиками из скрипта невозможно (сплошная опись
//     959 имён); есть ctx.ssh, prev_hop, правила по SSID, smart, виджеты.
//     Обновление профиля событийное, не по таймеру — проверено наблюдением.
//   • Loon 3.5.0: $config умеет getPolicy, getSelectedPolicy, setSelectPolicy,
//     setPluginEnable, setScriptEnable, setRunningModel; getConfig отдаёт
//     JSON-строку с картой policy_select; WebSocket не соединяется; порт
//     6152 закрыт; хранилище 1 МБ на ключ; движок 12 мс на миллион итераций.
//   • ПОД WHITELIST (Loon, замерено): обычные узлы РАБОТАЮТ — российский
//     89-99 мс и 6,4 Мбит/с, немецкий 96-99 мс и 5,5 Мбит/с; обходной
//     388-505 мс и 1,5 Мбит/с. Напрямую живы только ya.ru и gosuslugi.ru:
//     yandex.ru, vk.com, dzen.ru, avito.ru — таймаут.
//
// БЕЗОПАСНОСТЬ: ТОЛЬКО ЧТЕНИЕ, ничего не переключает.
//
// КАК ЗАПУСТИТЬ: Shadowrocket → конфиг, раздел [Script]:
//   rh-probe = type=cron,script-path=<ссылка>,cronexp=0 0 * * *,enable=true
//   и запустить вручную кнопкой у скрипта; либо поставить cronexp на
//   ближайшую минуту. Отчёт уйдёт на стенд сам, копировать ничего не нужно.
// =============================================================

const REV = 'SR3';
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
        if (body) { r.len = String(body).length; r.body = String(body).slice(0, 40); }
        resolve(r);
      });
    } catch (e) {
      if (!done.fired) { done.fired = true; clearTimeout(timer); resolve('исключение'); }
    }
  });
}

const results = {};

(async function () {
  // 1. Сплошная опись globalThis.
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
    results.S1 = { total: all.length, glob: interesting.join(','), kw: kw.join(',') };
  } catch (e) { results.S1 = 'ошибка'; }

  // 2. Описи объектов.
  try {
    const o = {};
    const names = ['$rocket', '$config', '$httpClient', '$persistentStore', '$utils',
                   '$notification', '$environment', '$script', '$network', '$task',
                   '$prefs', '$done', '$argument', '$httpAPI', '$surge', '$loon'];
    for (let i = 0; i < names.length; i++) {
      let v;
      try { v = eval(names[i]); } catch (e) { v = undefined; }
      if (typeof v === 'undefined') { o[names[i]] = '-'; continue; }
      if (typeof v === 'object' && v !== null) o[names[i]] = describe(v, 40);
      else if (typeof v === 'function') o[names[i]] = 'fn/' + v.length;
      else o[names[i]] = String(v).slice(0, 100);
    }
    results.S2 = o;
  } catch (e) { results.S2 = 'ошибка'; }

  // 3. Среда и движок.
  try {
    const has = function (n) { try { return typeof eval(n); } catch (e) { return 'нет'; } };
    const env = { ws: has('WebSocket'), ls: has('localStorage'), idb: has('indexedDB'),
                  fetch: has('fetch'), crypto: has('crypto'), wasm: has('WebAssembly'),
                  xhr: has('XMLHttpRequest'), doc: has('document') };
    try { env.subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? 'есть' : 'нет'; } catch (e) { }
    try { env.ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? String(navigator.userAgent).slice(0, 60) : null; } catch (e) { }
    try { env.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { }
    const t = Date.now();
    let acc = 0;
    for (let i = 0; i < 1000000; i++) acc += i % 7;
    env.mln_ms = Date.now() - t;
    results.S3 = env;
  } catch (e) { results.S3 = 'ошибка'; }

  // 4. Хранилище.
  try {
    const TMP = 'rh_probe_sr_tmp';
    const out = {};
    const sizes = [1024, 262144, 1048576];
    for (let i = 0; i < sizes.length; i++) {
      const data = new Array(sizes[i] + 1).join('x');
      const w = store_write(data, TMP);
      const back = store_read(TMP);
      out[sizes[i]] = { w: w, back: back ? back.length : 0 };
    }
    try { out.remove = $persistentStore.remove ? $persistentStore.remove(TMP) : 'нет метода'; }
    catch (e) { out.remove = 'ошибка'; }
    results.S4 = out;
  } catch (e) { results.S4 = 'ошибка'; }

  // 5. Поведение под whitelist: маяки напрямую, по правилам и российские.
  try {
    const M = [['gstatic', 'http://connectivitycheck.gstatic.com/generate_204'],
               ['cloudflare', 'http://cp.cloudflare.com/generate_204'],
               ['apple', 'http://captive.apple.com/hotspot-detect.html']];
    const R = [['ya', 'https://ya.ru'], ['gosuslugi', 'https://www.gosuslugi.ru']];
    const out = { direct: {}, rules: {}, ru: {} };
    for (let i = 0; i < M.length; i++) {
      out.direct[M[i][0]] = await get(M[i][1], { node: 'DIRECT' }, 4000);
      out.rules[M[i][0]] = await get(M[i][1], null, 4000);
    }
    for (let i = 0; i < R.length; i++) out.ru[R[i][0]] = await get(R[i][1], { node: 'DIRECT' }, 4000);
    results.S5 = out;
  } catch (e) { results.S5 = 'ошибка'; }

  // 6. Локальные порты.
  try {
    const ports = [9090, 6152, 1080, 8080, 7890, 8888];
    const out = {};
    for (let i = 0; i < ports.length; i++) {
      out[ports[i]] = await get('http://127.0.0.1:' + ports[i] + '/', { node: 'DIRECT' }, 1200);
    }
    results.S6 = out;
  } catch (e) { results.S6 = 'ошибка'; }

  const R = { rev: REV, client: 'shadowrocket', mode: 'WHITELIST',
              results: results, total_ms: Date.now() - t0, ts: new Date().toISOString() };
  const body = JSON.stringify(R);
  store_write(body, STATE);

  // ГЛАВНАЯ ДОСТАВКА — отправка на открытый приёмник стенда. Токена
  // устройства он не требует, к подписке доступа не даёт.
  const INGEST = 'https://routehub-egern.proton4iker.workers.dev/ingest/rh-drop-2026?src=sr';
  await new Promise(function (resolve) {
    try {
      $httpClient.post({ url: INGEST, headers: { 'Content-Type': 'application/json' }, body: body },
        function (err, resp) {
          try {
            $notification.post('Shadowrocket ' + REV,
                               err ? 'Отправка не удалась' : 'Отчёт отправлен на стенд',
                               err ? String(err).slice(0, 100) : ('Байт: ' + body.length + '. Статус: ' + (resp ? resp.status : '?')));
          } catch (e) { }
          resolve();
        });
    } catch (e) { resolve(); }
  });

  // ЗАПАСНАЯ ДОСТАВКА — печать в консоль кусками, если отправка не пройдёт.
  const CH = 800;
  const parts = Math.ceil(body.length / CH);
  console.log('===== RouteHub ' + REV + ' НАЧАЛО ОТЧЁТА, кусков: ' + parts + ', байт: ' + body.length + ' =====');
  for (let i = 0; i < parts; i++) {
    console.log('[RH ' + (i + 1) + '/' + parts + '] ' + body.slice(i * CH, (i + 1) * CH));
  }
  console.log('===== RouteHub ' + REV + ' КОНЕЦ ОТЧЁТА =====');

  $done({});
})();

// ХВОСТОВОЙ СТРАЖ — строка без перевода в конце файла; мусор после неё —