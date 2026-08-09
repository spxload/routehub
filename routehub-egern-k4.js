// =============================================================
// routehub-egern-k4.js — диагностический schedule-скрипт (проверка K4 и шире).
// K4_REV: k4-5 (2026-08-09) — НЕДОКУМЕНТИРОВАННЫЙ СЛОЙ СОВМЕСТИМОСТИ.
//   Ревизия ведётся отдельно от версии Worker'а; rev уходит в отчёт.
//
// ИТОГИ k4-4 (Egern 2.20.0, k3, 2026-08-09) — основание для этой ревизии:
//   • УЗЕЛ ИЗ proxies АДРЕСУЕМ: policy "RH-Явный-1" → 204, выход 111.88.96.83.
//     Имя узла из подписки → 404. policyDescriptor → 400. ⇒ поузловой спидтест
//     возможен только через явное объявление узлов.
//   • В globalThis есть НЕОПИСАННЫЙ слой Loon/Surge/QuanX: $httpClient,
//     $persistentStore, $notification, $utils, $network, $script, $environment,
//     $done, $cronexp. ЭТО И ПРОВЕРЯЕТ k4-5.
//   • Окружение — полный WebKit: WebSocket, XMLHttpRequest, localStorage,
//     indexedDB, ReadableStream, Blob, structuredClone, performance, navigator.
//   • ГЛОБАЛЬНЫЙ fetch ИДЁТ МИМО ТУННЕЛЯ (выход 5.227.10.120 против
//     111.88.96.83 у ctx.http) — политикам не подчиняется.
//   • crypto: только getRandomValues (ни subtle, ни randomUUID).
//   • Локального API Egern нет ни на одном из семи пробованных портов.
//   • ctx.storage: get/set/getJSON/setJSON/delete — перечисления ключей нет.
//
// ЗАЧЕМ ЭТО ВАЖНО: в Loon $httpClient.get({node:"имя"}) адресует УЗЕЛ по имени,
//   а $config.setSelectPolicy переключает группу. Если слой совместимости живой,
//   это обход двух главных ограничений штатного API.
//
// В ТЕКСТЕ СКРИПТА НЕЛЬЗЯ: обратные кавычки, ${...} и ЛЮБЫЕ обратные
//   слэши (шаблонная строка съедает слэш и тихо ломает регулярки).
// ОГРАНИЧЕНИЕ: ни одна проба НЕ идёт через RH-Обход — трафик платный.
// =============================================================

export const K4_REV = 'k4-5';

export function subNames(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const p = lines[i].indexOf('#');
    if (p < 0) continue;
    let n = lines[i].slice(p + 1).trim();
    try { n = decodeURIComponent(n); } catch (e) { }
    if (n) out.push(n);
  }
  return out;
}
export function normalNodes(text, limit) {
  const out = [];
  const names = subNames(text);
  for (let i = 0; i < names.length && out.length < (limit || 4); i++) {
    if (!/Обход/.test(names[i])) out.push(names[i]);
  }
  return out;
}
export function firstNormalNode(text) {
  const a = normalNodes(text, 1);
  return a.length ? a[0] : '';
}

export const K4_SCRIPT = `export default async function (ctx) {
  const t0 = Date.now();
  const R = { rev: 'k4-5', ok: [], fail: {} };
  const run = async (k, fn) => {
    try { R[k] = await fn(); R.ok.push(k); }
    catch (e) { R.fail[k] = String((e && e.message) || e); }
  };
  const env = ctx.env || {};
  const U204 = env.RH_TEST_URL || 'http://cp.cloudflare.com/generate_204';
  const TRACE = 'https://www.cloudflare.com/cdn-cgi/trace';
  const GROUP = env.RH_GROUP || 'RH-Пул-Обычные';
  const NODE = env.RH_NODE || '';
  const NODE2 = env.RH_NODE2 || '';
  const G = globalThis;
  const names = (o) => {
    const s = new Set();
    let cur = o;
    for (let d = 0; d < 3 && cur && cur !== Object.prototype; d++) {
      try { Object.getOwnPropertyNames(cur).forEach(n => s.add(n)); } catch (e) { }
      cur = Object.getPrototypeOf(cur);
    }
    return Array.from(s).filter(n => n !== 'constructor' && n !== 'toString' &&
      n !== 'apply' && n !== 'arguments' && n !== 'bind' && n !== 'call' &&
      n !== 'caller' && n !== 'length' && n !== 'name' && n !== 'prototype').sort();
  };

  // === СЛОЙ СОВМЕСТИМОСТИ — что это такое и что умеет
  await run('L1_surface', async () => {
    const list = ['$httpClient', '$persistentStore', '$notification', '$utils',
                  '$network', '$script', '$environment', '$done', '$cronexp',
                  '$config', '$argument', '$task', '$prefs', '$option', '$input',
                  '$surge', '$loon', '$rocket', '$axios', '$app'];
    const out = {};
    list.forEach(n => {
      const v = G[n];
      out[n] = (v === undefined) ? 'undefined'
             : (typeof v === 'object' || typeof v === 'function') ? names(v) : typeof v;
    });
    return out;
  });
  await run('L2_env_val', async () => {
    const e = G.$environment;
    return e ? (typeof e === 'object' ? JSON.parse(JSON.stringify(e)) : String(e)) : 'undefined';
  });
  await run('L3_network', async () => {
    const n = G.$network;
    return n ? (typeof n === 'object' ? JSON.parse(JSON.stringify(n)) : String(n)) : 'undefined';
  });
  await run('L4_script_obj', async () => {
    const s = G.$script;
    return s ? (typeof s === 'object' ? JSON.parse(JSON.stringify(s)) : String(s)) : 'undefined';
  });
  await run('L5_utils', async () => {
    const u = G.$utils;
    if (!u) return 'undefined';
    const out = { methods: names(u) };
    try { out.geoip = u.geoip ? u.geoip('8.8.8.8') : 'no method'; } catch (e) { out.geoip = 'err'; }
    try { out.ipasn = u.ipasn ? u.ipasn('8.8.8.8') : 'no method'; } catch (e) { out.ipasn = 'err'; }
    try { out.ipaso = u.ipaso ? u.ipaso('8.8.8.8') : 'no method'; } catch (e) { out.ipaso = 'err'; }
    return out;
  });
  await run('L6_store', async () => {
    const p = G.$persistentStore;
    if (!p) return 'undefined';
    const out = { methods: names(p) };
    try { out.write = p.write ? p.write('rh-compat', 'rh_probe_compat') : 'no method'; } catch (e) { out.write = 'err:' + e.message; }
    try { out.read = p.read ? p.read('rh_probe_compat') : 'no method'; } catch (e) { out.read = 'err:' + e.message; }
    // Общее ли хранилище с ctx.storage?
    try { ctx.storage.set('rh_probe_ctxside', 'from-ctx'); } catch (e) { }
    try { out.cross_read = p.read ? p.read('rh_probe_ctxside') : null; } catch (e) { out.cross_read = 'err'; }
    try { out.ctx_sees_compat = ctx.storage.get('rh_probe_compat'); } catch (e) { out.ctx_sees_compat = 'err'; }
    return out;
  });
  // ГЛАВНАЯ ПРОБА СЛОЯ: адресация УЗЛА по имени, как в Loon.
  await run('L7_httpclient', async () => {
    const h = G.$httpClient;
    if (!h || typeof h.get !== 'function') return 'undefined';
    const call = (opts) => new Promise((res) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; res({ r: 'timeout' }); } }, 9000);
      try {
        h.get(opts, (err, resp, body) => {
          if (done) return;
          done = true; clearTimeout(timer);
          res({ err: err ? String(err) : null,
                status: resp ? (resp.status || resp.statusCode) : null,
                len: body ? String(body).length : 0 });
        });
      } catch (e) { if (!done) { done = true; clearTimeout(timer); res({ r: 'throw:' + e.message }); } }
    });
    const out = {};
    out.plain = await call({ url: U204 });
    out.by_node = NODE ? await call({ url: U204, node: NODE }) : 'нет RH_NODE';
    out.by_explicit = NODE2 ? await call({ url: U204, node: NODE2 }) : 'нет RH_NODE2';
    out.by_policy = await call({ url: U204, policy: GROUP });
    // Куда выходит по умолчанию — в туннель или мимо, как fetch?
    const tr = await call({ url: TRACE });
    out.trace_len = tr.len || 0;
    return out;
  });
  await run('L8_notify', async () => {
    const n = G.$notification;
    return n ? names(n) : 'undefined';
  });
  await run('L9_config', async () => {
    const c = G.$config;
    if (!c) return 'undefined';
    const out = { methods: names(c) };
    try { out.getConfig = typeof c.getConfig === 'function' ? JSON.parse(JSON.stringify(c.getConfig())) : 'no method'; }
    catch (e) { out.getConfig = 'err:' + e.message; }
    return out;
  });

  // === ОКРУЖЕНИЕ WEBKIT — что из этого реально работает
  await run('L10_localstorage', async () => {
    if (typeof localStorage === 'undefined') return 'нет';
    const prev = localStorage.getItem('rh_ls');
    localStorage.setItem('rh_ls', String(Date.now()));
    return { prev: prev, now: localStorage.getItem('rh_ls'), len: localStorage.length };
  });
  await run('L11_ws', async () => {
    if (typeof WebSocket !== 'function') return 'нет';
    return await new Promise((res) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; res(v); } };
      const timer = setTimeout(() => fin({ r: 'timeout' }), 8000);
      try {
        const ws = new WebSocket('wss://echo.websocket.events');
        ws.onopen = () => { try { ws.send('rh'); } catch (e) { } };
        ws.onmessage = (ev) => { clearTimeout(timer); try { ws.close(); } catch (e) { } fin({ r: 'ok', got: String(ev.data).slice(0, 40) }); };
        ws.onerror = () => { clearTimeout(timer); fin({ r: 'error' }); };
      } catch (e) { clearTimeout(timer); fin({ r: 'throw:' + e.message }); }
    });
  });
  await run('L12_navigator', async () => ({
    ua: typeof navigator !== 'undefined' ? String(navigator.userAgent || '').slice(0, 120) : 'нет',
    perf: typeof performance !== 'undefined' ? typeof performance.now : 'нет',
    idb: typeof indexedDB
  }));

  // === ШТАТНОЕ: контрольные точки
  const probe = async (url, opt) => {
    const o = Object.assign({ timeout: 8000 }, opt || {});
    const t = Date.now();
    const r = await ctx.http.get(url, o);
    return { status: r.status, ms: Date.now() - t };
  };
  await run('P9f_explicit', async () => NODE2 ? await probe(U204, { policy: NODE2 }) : 'нет RH_NODE2');
  await run('P30_mitm', async () => ({
    hits: ctx.storage.get('rh_mitm_hits'), last: ctx.storage.get('rh_mitm_last')
  }));

  if (env.RH_HEAVY === '1') {
    const target = NODE2 || GROUP;
    await run('P15_speed', async () => {
      const t = Date.now();
      const r = await ctx.http.get('https://speed.cloudflare.com/__down?bytes=1048576',
                                   { policy: target, timeout: 60000 });
      const b = await r.arrayBuffer();
      const ms = Math.max(1, Date.now() - t);
      return { via: target, bytes: b.byteLength, ms: ms, mbps: Math.round(b.byteLength * 8 / ms / 100) / 10 };
    });
  }

  R.total_ms = Date.now() - t0;
  R.ts = new Date().toISOString();
  await run('P10_post', async () => {
    if (!env.RH_POST_URL) return 'нет RH_POST_URL';
    const r = await ctx.http.post(env.RH_POST_URL, {
      body: R, headers: { 'Content-Type': 'application/json' }, timeout: 15000
    });
    return { status: r.status };
  });
  try { ctx.storage.setJSON('rh_last', R); } catch (e) { }
  return { rh: R.rev, ok: R.ok.length, fail: Object.keys(R.fail).length, ts: R.ts };
}
`;
