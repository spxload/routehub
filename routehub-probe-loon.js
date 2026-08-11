// =============================================================
// routehub-probe-loon.js — ЧИТАЮЩАЯ диагностика Loon. REV: L4 (2026-08-11).
//
// ИТОГИ L3:
//   • captureLog — НЕ журнал трафика, а обёртка console.log (виден исходник).
//     Вывод 8 остаётся: Loon не умеет логировать незагрузившиеся домены.
//   • $loon = "iPhone14,7 26.5.2 3.5.0(975)" ⇒ Loon 3.5.0, iOS 26.5.2.
//     ВО ВСЕХ НАШИХ ДОКУМЕНТАХ ЗНАЧИТСЯ 3.3.9 — часть выводов устарела.
//     navigator.userAgent врёт (отдаёт 18.7) — версию брать из $loon.
//   • getConfig() возвращает СТРОКУ JSON (1105 символов, начинается с {"mitm),
//     а не объект. Разбирается шагом S1.
//   • getPolicy('RH-Главный') и getSelectedPolicy('RH-Главный') → "RH-АВТО":
//     ЧТЕНИЕ ТЕКУЩЕГО ВЫБОРА РАБОТАЕТ, аргумент — имя группы.
//     getSubPolicies вернул undefined — разбирается шагом S2.
//   • WebSocket: класс есть, соединение с эхо-сервером — ТАЙМАУТ 8 с
//     (в Egern отвечало сразу) ⇒ дашборд реального времени НЕ подтверждён.
//   • $argument ОТСУТСТВУЕТ в generic-скрипте — параметр не передаётся,
//     поэтому отправка отчёта по сети невозможна. Доставка — буфер обмена.
//   • Порт 6152: ошибка сокета и по http, и по https; API нет.
//
// ЧТО ЗАКРЫВАЕТ L4 — проверки, сделанные по Egern, но не по Loon:
//   замеры скорости через узел с медианой; тест-адреса; маяки; лимиты и
//   стойкость хранилища; точность геобаз; скорость движка и параллельность;
//   сжатие; методы записи на локальный порт; URL-схема клиента.
//
// БЕЗОПАСНОСТЬ. ТОЛЬКО ЧТЕНИЕ. setSelectPolicy, setPluginEnable,
//   setScriptEnable, setRunningModel НЕ ВЫЗЫВАЮТСЯ. Запись — только своё
//   состояние под ключом rh_probe_l1 и временный ключ rh_probe_tmp, который
//   тут же удаляется.
// ДОСТАВКА: отчёт кладётся в буфер обмена через уведомление.
// =============================================================

const REV = 'L4';
const STATE = 'rh_probe_l1';
const BUDGET = 70000;
const t0 = Date.now();

function readState() {
  try { const raw = $persistentStore.read(STATE); if (raw) return JSON.parse(raw); } catch (e) { }
  return null;
}
function writeState(o) {
  try { $persistentStore.write(JSON.stringify(o), STATE); } catch (e) { }
}

function get(url, opt, ms) {
  return new Promise(function (resolve) {
    const done = { fired: false };
    const timer = setTimeout(function () {
      if (!done.fired) { done.fired = true; resolve('таймаут'); }
    }, ms || 5000);
    const started = Date.now();
    try {
      const req = Object.assign({ url: url }, opt || {});
      $httpClient.get(req, function (err, resp, body) {
        if (done.fired) return;
        done.fired = true;
        clearTimeout(timer);
        const ms2 = Date.now() - started;
        if (err) { resolve('err:' + String(err).slice(0, 70)); return; }
        const r = { st: resp ? resp.status : null, ms: ms2 };
        if (body) { r.len = String(body).length; r.body = String(body).slice(0, 60); }
        resolve(r);
      });
    } catch (e) {
      if (!done.fired) { done.fired = true; clearTimeout(timer); resolve('исключение'); }
    }
  });
}

function median(a) {
  const s = a.filter(function (v) { return v !== null; }).sort(function (x, y) { return x - y; });
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

// Имя обычного узла из конфига — нужно для замеров через узел.
function pickNode() {
  try {
    const raw = $config.getConfig();
    const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const buckets = [c.proxies, c.proxy, c.nodes, c.policy_groups, c.policies];
    for (let b = 0; b < buckets.length; b++) {
      const arr = buckets[b];
      if (!arr || !arr.length) continue;
      for (let i = 0; i < arr.length; i++) {
        const it = arr[i];
        const nm = typeof it === 'string' ? it : (it && (it.name || it.tag));
        if (nm && nm.indexOf('Обход') < 0 && nm.indexOf('RH-') !== 0 &&
            nm !== 'DIRECT' && nm !== 'REJECT') return nm;
      }
    }
  } catch (e) { }
  return null;
}

const URLS = [
  ['gstatic_cc', 'http://connectivitycheck.gstatic.com/generate_204'],
  ['vivo', 'http://wifi.vivo.com.cn/generate_204'],
  ['google_c3', 'http://clients3.google.com/generate_204'],
  ['cloudflare', 'http://cp.cloudflare.com/generate_204'],
  ['apple', 'http://captive.apple.com/hotspot-detect.html'],
  ['msft', 'http://www.msftconnecttest.com/connecttest.txt'],
  ['ya_https', 'https://ya.ru'],
  ['gosuslugi', 'https://www.gosuslugi.ru']
];

const steps = [
  // S1: разбор getConfig() как JSON-строки. На L3 стало ясно, что это строка.
  ['S1_config_parsed', async function () {
    let raw;
    try { raw = $config.getConfig(); } catch (e) { return 'ошибка: ' + String((e && e.message) || e); }
    const out = { type: typeof raw, length: raw ? String(raw).length : 0 };
    let c = null;
    try { c = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (e) { out.parse_error = String((e && e.message) || e); out.head = String(raw).slice(0, 300); return out; }
    out.keys = Object.keys(c);
    const sizes = {};
    for (const k in c) {
      const v = c[k];
      sizes[k] = Array.isArray(v) ? ('массив ' + v.length) : typeof v;
    }
    out.shape = sizes;
    out.sample = JSON.stringify(c).slice(0, 700);
    return out;
  }],

  // S2: подбор аргументов для getSubPolicies — на L3 вернул undefined.
  ['S2_subpolicies', async function () {
    const out = {};
    const call = function (m, args) {
      try {
        if (!$config[m]) return 'нет метода';
        const v = $config[m].apply($config, args || []);
        if (v === undefined) return 'undefined';
        if (v === null) return 'null';
        if (typeof v === 'object') return JSON.stringify(v).slice(0, 400);
        return String(v).slice(0, 300);
      } catch (e) { return 'ошибка: ' + String((e && e.message) || e).slice(0, 100); }
    };
    const groups = ['RH-Главный', 'RH-АВТО', 'RH-АВТО-W', 'RH-RU', 'RH-AI', 'RH-Обход'];
    for (let i = 0; i < groups.length; i++) {
      out['getSubPolicies(' + groups[i] + ')'] = call('getSubPolicies', [groups[i]]);
      out['getSelectedPolicy(' + groups[i] + ')'] = call('getSelectedPolicy', [groups[i]]);
    }
    out['getSubPolicys(RH-Главный)'] = call('getSubPolicys', ['RH-Главный']);
    out['getSubPolicies(RH-Главный,0)'] = call('getSubPolicies', ['RH-Главный', 0]);
    return out;
  }],

  // S3: тест-адреса через прямой выход и через узел — сравнение с эталоном,
  // снятым на Egern (k4-13). Три повтора, медиана.
  ['S3_test_urls', async function () {
    const node = pickNode();
    const out = { node_used: node };
    const sweep = async function (opt) {
      const res = {};
      for (let i = 0; i < URLS.length; i++) {
        const times = [];
        let st = null, len = null, note = null;
        for (let k = 0; k < 3; k++) {
          const r = await get(URLS[i][1], opt, 3000);
          if (r && r.st) { times.push(r.ms); st = r.st; if (len === null) len = r.len || 0; }
          else { note = String(r).slice(0, 40); times.push(null); break; }
        }
        const ok = times.filter(function (v) { return v !== null; }).length;
        res[URLS[i][0]] = note ? { ok: ok + '/3', err: note } : { ok: ok + '/3', st: st, ms: median(times), len: len };
      }
      return res;
    };
    out.direct = await sweep(null);
    if (node) out.via_node = await sweep({ node: node });
    return out;
  }],

  // S4: скорость через узел. В Egern speed.cloudflare.com занижал вдесятеро,
  // поэтому берутся два источника; первый замер отбрасывается.
  ['S4_speed', async function () {
    const node = pickNode();
    const out = { node_used: node };
    const src = [
      ['cloudflare', 'https://speed.cloudflare.com/__down?bytes=131072'],
      ['ovh', 'https://proof.ovh.net/files/1Mb.dat']
    ];
    for (let i = 0; i < src.length; i++) {
      const runs = [];
      for (let k = 0; k < 3; k++) {
        const r = await get(src[i][1], node ? { node: node } : null, 20000);
        if (r && r.st && r.len) runs.push(Math.round(r.len * 8 / Math.max(1, r.ms) / 100) / 10);
        else { runs.push(null); break; }
      }
      out[src[i][0]] = { runs: runs, median_no_first: median(runs.slice(1)) };
    }
    return out;
  }],

  // S5: хранилище — лимиты, remove, живучесть между прогонами.
  ['S5_storage', async function () {
    const out = {};
    const TMP = 'rh_probe_tmp';
    const sizes = [1024, 32768, 262144, 1048576];
    for (let i = 0; i < sizes.length; i++) {
      const data = new Array(sizes[i] + 1).join('x');
      let okw = false;
      try { okw = $persistentStore.write(data, TMP); } catch (e) { okw = 'ошибка'; }
      let back = 0;
      try { const r = $persistentStore.read(TMP); back = r ? r.length : 0; } catch (e) { }
      out[sizes[i]] = { write: okw, read_back: back, ok: back === sizes[i] };
    }
    try { out.remove = $persistentStore.remove(TMP); } catch (e) { out.remove = 'ошибка: ' + String((e && e.message) || e); }
    try { out.after_remove = $persistentStore.read(TMP); } catch (e) { out.after_remove = 'ошибка'; }
    return out;
  }],

  // S6: геобазы против фактов и скорость движка.
  ['S6_utils_and_engine', async function () {
    const out = {};
    try { out.geoip_8888 = $utils.geoip('8.8.8.8'); } catch (e) { out.geoip_8888 = 'ошибка'; }
    try { out.ipasn_8888 = $utils.ipasn('8.8.8.8'); } catch (e) { }
    try { out.ipaso_8888 = $utils.ipaso('8.8.8.8'); } catch (e) { }
    const ip = await get('https://api.ipify.org', null, 6000);
    if (ip && ip.body) {
      const addr = String(ip.body).trim();
      out.own_ip = addr;
      try { out.geoip_own = $utils.geoip(addr); } catch (e) { out.geoip_own = 'ошибка'; }
      try { out.ipaso_own = $utils.ipaso(addr); } catch (e) { }
    }
    const t = Date.now();
    let acc = 0;
    for (let i = 0; i < 1000000; i++) acc += i % 7;
    out.million_iterations_ms = Date.now() - t;
    const t2 = Date.now();
    await Promise.all([get(URLS[0][1], null, 4000), get(URLS[1][1], null, 4000),
                       get(URLS[2][1], null, 4000), get(URLS[3][1], null, 4000),
                       get(URLS[5][1], null, 4000)]);
    out.five_parallel_ms = Date.now() - t2;
    return out;
  }],

  // S7: запись на локальный порт и пути Clash — в Egern всё дало 404.
  ['S7_local_write', async function () {
    const out = {};
    const post = function (url) {
      return new Promise(function (resolve) {
        const done = { fired: false };
        const timer = setTimeout(function () { if (!done.fired) { done.fired = true; resolve('таймаут'); } }, 1500);
        try {
          $httpClient.post({ url: url, body: '{}' }, function (err, resp) {
            if (done.fired) return;
            done.fired = true; clearTimeout(timer);
            resolve(err ? ('err:' + String(err).slice(0, 60)) : { st: resp ? resp.status : null });
          });
        } catch (e) { if (!done.fired) { done.fired = true; clearTimeout(timer); resolve('исключение'); } }
      });
    };
    out.post_6152 = await post('http://127.0.0.1:6152/');
    out.post_6152_select = await post('http://127.0.0.1:6152/v1/policy_groups/select');
    const clash = ['/proxies', '/connections', '/configs', '/traffic'];
    for (let i = 0; i < clash.length; i++) {
      out['get_6152' + clash[i]] = await get('http://127.0.0.1:6152' + clash[i], null, 1200);
    }
    return out;
  }],

  // S8: сжатие и URL-схема клиента.
  ['S8_misc', async function () {
    const out = {};
    try { out.ungzip = typeof $utils.ungzip; } catch (e) { }
    try { out.ungzipTest = String($utils.ungzipTest()).slice(0, 120); } catch (e) { out.ungzipTest = 'ошибка: ' + String((e && e.message) || e).slice(0, 80); }
    try { out.script_info = JSON.stringify($script).slice(0, 200); } catch (e) { }
    try { out.loon_version = $loon; } catch (e) { }
    try { out.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { }
    try {
      out.notify_with_url = 'отправлено';
      $notification.post('RouteHub: проверка перехода', 'Нажми, если хочешь проверить URL-схему',
                         'Откроет loon://', { 'openUrl': 'loon://' });
    } catch (e) { out.notify_with_url = 'ошибка: ' + String((e && e.message) || e).slice(0, 80); }
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
  $done({});
})();

// ХВОСТОВОЙ СТРАЖ — строка без перевода в конце файла; мусор после неё —