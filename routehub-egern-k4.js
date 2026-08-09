// =============================================================
// routehub-egern-k4.js — диагностический schedule-скрипт (проверка K4 и шире).
// K4_REV: k4-6 (2026-08-09) — РЕШАЮЩАЯ ПРОВЕРКА АДРЕСАЦИИ ПО ИМЕНИ УЗЛА.
//
// ИТОГИ k4-5 (Egern 2.20.0, k3, 2026-08-09):
//   • СЛОЙ СОВМЕСТИМОСТИ ЖИВОЙ И ЭТО SURGE: $environment =
//     { system: iOS, surge-build: 3010, surge-version: 5.8.3, language: ru-KZ }.
//   • $httpClient: get/post/put/patch/delete/head/options/request.
//   • $persistentStore.read/write — ХРАНИЛИЩЕ ОБЩЕЕ с ctx.storage
//     (проверено крест-накрест в обе стороны).
//   • $utils.geoip('8.8.8.8') = US, ipasn 15169, ipaso GOOGLE — ПОЛНЕЕ штатной
//     ctx.lookupIP, которая даёт PK и пустые asn/organization. Брать $utils.
//   • $network — то же, что ctx.device, в форме Surge. $script.type = 'cron'.
//   • $config ОТСУТСТВУЕТ ⇒ переключения политики из скрипта нет нигде.
//   • localStorage работает; navigator — iOS 18.7 / WebKit 605.1.15.
//   • WebSocket к echo.websocket.events — error (хост мог быть недоступен).
//   • НЕ ДОКАЗАНО: учитывается ли { node: "имя" } в $httpClient — все варианты
//     дали 204, но и вызов без параметров тоже. Различить можно только
//     по АДРЕСУ ВЫХОДА — это главная проба k4-6 (L13).
//
// В ТЕКСТЕ СКРИПТА НЕЛЬЗЯ: обратные кавычки, ${...} и ЛЮБЫЕ обратные слэши.
// ОГРАНИЧЕНИЕ: ни одна проба НЕ идёт через RH-Обход — трафик платный.
// =============================================================

export const K4_REV = 'k4-6';

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
  const R = { rev: 'k4-6', ok: [], fail: {} };
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

  // Колбечный $httpClient → промис со своим таймаутом: без него зависший
  // вызов съел бы весь прогон.
  const hc = (opts, ms) => new Promise((res) => {
    const h = G.$httpClient;
    if (!h || typeof h.get !== 'function') return res({ r: 'нет $httpClient' });
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; res({ r: 'timeout' }); } }, ms || 9000);
    try {
      h.get(opts, (err, resp, body) => {
        if (done) return;
        done = true; clearTimeout(timer);
        res({ err: err ? String(err) : null,
              status: resp ? (resp.status || resp.statusCode) : null,
              body: body ? String(body) : '' });
      });
    } catch (e) { if (!done) { done = true; clearTimeout(timer); res({ r: 'throw:' + e.message }); } }
  });
  const parseTrace = (txt) => {
    const ip = String(txt || '').match(/ip=([0-9a-fA-F:.]+)/);
    const loc = String(txt || '').match(/loc=([A-Z][A-Z])/);
    const colo = String(txt || '').match(/colo=([A-Z][A-Z][A-Z])/);
    return { ip: ip ? ip[1] : null, loc: loc ? loc[1] : null, colo: colo ? colo[1] : null };
  };

  // === L13: ГЛАВНОЕ. Различаются ли ТОЧКИ ВЫХОДА при разных параметрах.
  // Если ip у plain, by_node и by_explicit одинаковы — параметр node ИГНОРИРУЕТСЯ.
  // Если различаются — адресация по имени узла работает, и поузловой
  // спидтест возможен БЕЗ объявления узлов в proxies.
  await run('L13_exit', async () => {
    const out = {};
    const one = async (label, opts) => {
      const r = await hc(Object.assign({ url: TRACE }, opts));
      out[label] = r.body ? Object.assign({ status: r.status }, parseTrace(r.body))
                          : { status: r.status || null, err: r.err || r.r || null };
    };
    await one('plain', {});
    if (NODE) await one('node_sub', { node: NODE });
    if (NODE2) await one('node_explicit', { node: NODE2 });
    await one('policy_group', { policy: GROUP });
    await one('policy_direct', { policy: 'DIRECT' });
    // Контроль: то же через штатный ctx.http
    try {
      const r = await ctx.http.get(TRACE, { policy: NODE2 || GROUP, timeout: 9000 });
      out.ctx_explicit = Object.assign({ status: r.status }, parseTrace(await r.text()));
    } catch (e) { out.ctx_explicit = 'err:' + ((e && e.message) || e); }
    try {
      const r = await ctx.http.get(TRACE, { policy: 'DIRECT', timeout: 9000 });
      out.ctx_direct = Object.assign({ status: r.status }, parseTrace(await r.text()));
    } catch (e) { out.ctx_direct = 'err:' + ((e && e.message) || e); }
    return out;
  });

  // === L14: WebSocket — второй хост, чтобы отличить «нет поддержки» от
  // «этот сервер недоступен». От этого зависит дашборд реального времени.
  await run('L14_ws', async () => {
    if (typeof WebSocket !== 'function') return 'нет WebSocket';
    const test = (url) => new Promise((res) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; res(v); } };
      const timer = setTimeout(() => fin('timeout'), 7000);
      try {
        const ws = new WebSocket(url);
        ws.onopen = () => { try { ws.send('rh'); } catch (e) { } fin('open'); };
        ws.onmessage = () => { clearTimeout(timer); try { ws.close(); } catch (e) { } fin('echo'); };
        ws.onerror = () => { clearTimeout(timer); fin('error'); };
      } catch (e) { clearTimeout(timer); fin('throw:' + e.message); }
    });
    return {
      postman: await test('wss://ws.postman-echo.com/raw'),
      events: await test('wss://echo.websocket.events')
    };
  });

  // === L15: персистентность localStorage между прогонами
  await run('L15_ls', async () => {
    if (typeof localStorage === 'undefined') return 'нет';
    const prev = localStorage.getItem('rh_ls');
    const n = Number(localStorage.getItem('rh_ls_n') || '0') + 1;
    localStorage.setItem('rh_ls', String(Date.now()));
    localStorage.setItem('rh_ls_n', String(n));
    return { prev_was: prev, runs: n, len: localStorage.length };
  });

  // === L17: $httpClient.request — единый вход с методом
  await run('L17_request', async () => {
    const h = G.$httpClient;
    if (!h || typeof h.request !== 'function') return 'нет request';
    return await new Promise((res) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; res('timeout'); } }, 9000);
      try {
        h.request({ method: 'GET', url: U204 }, (err, resp) => {
          if (done) return;
          done = true; clearTimeout(timer);
          res({ err: err ? String(err) : null, status: resp ? (resp.status || resp.statusCode) : null });
        });
      } catch (e) { if (!done) { done = true; clearTimeout(timer); res('throw:' + e.message); } }
    });
  });

  // === L18: гео выхода через $utils (полная база) вместо ctx.lookupIP
  await run('L18_geo_exit', async () => {
    const u = G.$utils;
    const r = await ctx.http.get(TRACE, { policy: NODE2 || GROUP, timeout: 9000 });
    const t = parseTrace(await r.text());
    if (!u || !t.ip) return t;
    return { ip: t.ip, cf_loc: t.loc, colo: t.colo,
             utils_geo: u.geoip(t.ip), utils_asn: u.ipasn(t.ip), utils_aso: u.ipaso(t.ip),
             ctx_lookup: ctx.lookupIP(t.ip) };
  });

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
