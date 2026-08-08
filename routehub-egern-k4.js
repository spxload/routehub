// =============================================================
// routehub-egern-k4.js — диагностический schedule-скрипт для проверки K4.
// K4_REV: k4-2 (2026-08-08). Ревизия скрипта ведётся ОТДЕЛЬНО от версии
//   Worker'а (как PANEL_REV в боевом контуре): правка проб не требует
//   перезаливки Worker'а. Ревизия уходит в отчёт полем rev.
// Модуль импортируется в routehub-egern-worker.js статически — только так
//   Wrangler вкладывает его в бандл (вывод 21 в СТАРТ.md).
// Спецификация — ЭТАП_K_ШАГ_4.4_K4.md.
// ТОКЕН В ТЕКСТ НЕ ПОПАДАЕТ: адреса приходят через env из профиля.
// ОГРАНИЧЕНИЕ: ни одна проба НЕ идёт через RH-Обход — трафик платный.
// В ТЕКСТЕ СКРИПТА НЕЛЬЗЯ: обратные кавычки, ${...} и ЛЮБЫЕ обратные
//   слэши — текст живёт в шаблонной строке, и слэш съестся (\d → d,
//   что тихо ломает регулярки). Поэтому все классы символов — явные.
// =============================================================

export const K4_REV = 'k4-2';

// Имена узлов подписки — часть строки после '#'. Percent-encoding НЕПОСЛЕДОВАТЕЛЬНОЕ
// (вывод 25) — поэтому decodeURIComponent в try.
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

// Первые ОБЫЧНЫЕ узлы — для проб P9*. Критерий тот же, что у фильтров групп:
// слово в скобочном теге (вывод 28), не значок провайдера.
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
  const R = { rev: 'k4-2', ok: [], fail: {} };
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

  // --- A. среда и параметры
  await run('P1_script', async () => ({ name: ctx.script && ctx.script.name, cron: ctx.cron || null }));
  await run('P2_env', async () => Object.keys(env));
  await run('P3_app', async () => ({ version: ctx.app && ctx.app.version, lang: ctx.app && ctx.app.language }));
  await run('P4_device', async () => {
    const d = ctx.device || {};
    const w = d.wifi || {}, c = d.cellular || {}, v4 = d.ipv4 || {}, v6 = d.ipv6 || {};
    return { ssid: w.ssid, bssid: w.bssid, carrier: c.carrier, radio: c.radio,
             ip4: v4.address, gw: v4.gateway, iface: v4.interface, ip6: v6.address,
             dns: d.dnsServers || null };
  });

  // --- B. хранилище и его пределы
  await run('P5_storage', async () => {
    const s = ctx.storage;
    s.set('rh_p5', 'abc');
    const str = s.get('rh_p5');
    s.setJSON('rh_p5j', { a: 1 });
    const j = s.getJSON('rh_p5j');
    s.delete('rh_p5');
    const gone = s.get('rh_p5');
    const n = (Number(s.get('rh_runs')) || 0) + 1;
    s.set('rh_runs', String(n));
    return { str: str, json: j && j.a, deleted: gone === null || gone === undefined, runs: n };
  });
  await run('P29_limits', async () => {
    const s = ctx.storage, out = {};
    const sizes = [262144, 1048576];
    for (let i = 0; i < sizes.length; i++) {
      const z = sizes[i];
      try { s.set('rh_big', 'x'.repeat(z)); out[z] = (s.get('rh_big') || '').length; }
      catch (e) { out[z] = 'err:' + ((e && e.message) || e); }
    }
    try { s.delete('rh_big'); } catch (e) { }
    return out;
  });

  // --- C. политики в ctx.http
  const probe = async (url, opt) => {
    const o = Object.assign({ timeout: 8000 }, opt || {});
    const t = Date.now();
    const r = await ctx.http.get(url, o);
    return { status: r.status, ms: Date.now() - t, server: r.headers && r.headers.get ? r.headers.get('server') : null };
  };
  await run('P6_http', () => probe(U204, {}));
  await run('P7_group', () => probe(U204, { policy: GROUP }));
  await run('P8_direct', () => probe(U204, { policy: 'DIRECT' }));
  await run('P9a_node', async () => NODE ? await probe(U204, { policy: NODE }) : 'нет RH_NODE');
  await run('P9b_bogus', () => probe(U204, { policy: 'RH-НЕТ-ТАКОЙ-ПОЛИТИКИ' }));
  await run('P9c_descriptor', async () => NODE ? await probe(U204, { policyDescriptor: NODE }) : 'нет RH_NODE');
  await run('P9d_node2', async () => NODE2 ? await probe(U204, { policy: NODE2 }) : 'нет RH_NODE2');
  await run('P9e_reject', () => probe(U204, { policy: 'REJECT' }));

  // --- D. HTTPS, редиректы, гео
  await run('P12a_https', () => probe(TRACE, {}));
  await run('P12b_geo', async () => {
    const r = await ctx.http.get(TRACE, { policy: GROUP, timeout: 8000 });
    const txt = await r.text();
    const ip = txt.match(/ip=([0-9a-fA-F:.]+)/);
    const loc = txt.match(/loc=([A-Z][A-Z])/);
    const colo = txt.match(/colo=([A-Z][A-Z][A-Z])/);
    return { status: r.status, ip: ip ? ip[1] : null, loc: loc ? loc[1] : null,
             colo: colo ? colo[1] : null, geo: ip ? ctx.lookupIP(ip[1]) : null };
  });
  await run('P17_redirect', () => probe('http://www.cloudflare.com/', { redirect: 'manual' }));
  await run('P21_head', async () => {
    const t = Date.now();
    const r = await ctx.http.head(U204, { timeout: 8000 });
    return { status: r.status, ms: Date.now() - t };
  });
  await run('P11_unreach', async () => {
    const t = Date.now();
    try {
      const r = await ctx.http.get('http://192.0.2.1/generate_204', { timeout: 3000 });
      return { kind: 'ответ', status: r.status, ms: Date.now() - t };
    } catch (e) {
      return { kind: 'исключение', msg: String((e && e.message) || e), ms: Date.now() - t };
    }
  });

  // --- E. параллельность (основа будущего спидтеста)
  await run('P19_parallel', async () => {
    const t = Date.now();
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => ctx.http.get(U204, { policy: GROUP, timeout: 8000 })));
    return { n: rs.length, statuses: rs.map(r => r.status), ms: Date.now() - t };
  });

  // --- F. среда исполнения JS
  await run('P24_globals', async () => {
    const g = (n, v) => n + ':' + (typeof v);
    return [g('fetch', typeof fetch !== 'undefined' ? fetch : undefined),
            g('crypto', typeof crypto !== 'undefined' ? crypto : undefined),
            g('subtle', typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : undefined),
            g('TextEncoder', typeof TextEncoder !== 'undefined' ? TextEncoder : undefined),
            g('URL', typeof URL !== 'undefined' ? URL : undefined),
            g('Intl', typeof Intl !== 'undefined' ? Intl : undefined),
            g('setTimeout', typeof setTimeout !== 'undefined' ? setTimeout : undefined),
            g('WebAssembly', typeof WebAssembly !== 'undefined' ? WebAssembly : undefined),
            g('console', typeof console !== 'undefined' ? console : undefined),
            g('btoa', typeof btoa !== 'undefined' ? btoa : undefined)];
  });
  await run('P25_sha256', async () => {
    const data = new TextEncoder().encode('RouteHub');
    const buf = await crypto.subtle.digest('SHA-256', data);
    const b = new Uint8Array(buf);
    let hex = '';
    for (let i = 0; i < 4; i++) hex += b[i].toString(16).padStart(2, '0');
    return { head: hex, len: b.length };
  });
  await run('P26_base64', async () => ({ b: btoa('RouteHub'), back: atob(btoa('RouteHub')) }));
  await run('P27_bench', async () => {
    const t = Date.now();
    let s = 0;
    for (let i = 0; i < 1000000; i++) s += i % 7;
    return { sum: s, ms: Date.now() - t };
  });
  await run('P28_api', async () => ({
    ssh: typeof ctx.ssh, compress: typeof ctx.compress, lookupIP: typeof ctx.lookupIP,
    notify: typeof ctx.notify, storage: typeof ctx.storage, http: typeof ctx.http,
    keys: Object.keys(ctx)
  }));
  await run('P13_compress', async () => {
    const src = new TextEncoder().encode('RouteHub '.repeat(64));
    const gz = await ctx.compress.gzip(src);
    const br = await ctx.compress.brotli(src);
    const back = await ctx.compress.gunzip(gz);
    return { raw: src.length, gz: gz && gz.length, brotli: br && br.length,
             back: back && back.length, same: !!back && back.length === src.length };
  });
  await run('P22_time', async () => ({
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    local: new Date().toLocaleString('ru-RU')
  }));

  // --- G. следы перехвата (заполняет будущий http_request-скрипт)
  await run('P30_mitm', async () => ({
    hits: ctx.storage.get('rh_mitm_hits'),
    last: ctx.storage.get('rh_mitm_last')
  }));

  // --- H. тяжёлая проба — только по флагу
  if (env.RH_HEAVY === '1') {
    await run('P15_speed', async () => {
      const t = Date.now();
      const r = await ctx.http.get('https://speed.cloudflare.com/__down?bytes=1048576',
                                   { policy: NODE || GROUP, timeout: 60000 });
      const b = await r.arrayBuffer();
      const ms = Math.max(1, Date.now() - t);
      return { bytes: b.byteLength, ms: ms, mbps: Math.round(b.byteLength * 8 / ms / 100) / 10 };
    });
    await run('P20_speed_par', async () => {
      const t = Date.now();
      const rs = await Promise.all([0, 1, 2, 3].map(() =>
        ctx.http.get('https://speed.cloudflare.com/__down?bytes=262144', { policy: GROUP, timeout: 60000 })
          .then(r => r.arrayBuffer())));
      const total = rs.reduce((a, b) => a + b.byteLength, 0);
      const ms = Math.max(1, Date.now() - t);
      return { bytes: total, ms: ms, mbps: Math.round(total * 8 / ms / 100) / 10 };
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
  try {
    if (env.RH_NOTIFY === '1' && !ctx.storage.get('rh_notified2')) {
      ctx.storage.set('rh_notified2', '1');
      ctx.notify({ title: 'RouteHub ' + R.rev,
                   body: 'Прошло: ' + R.ok.length + ', отказов: ' + Object.keys(R.fail).length,
                   action: { type: 'clipboard', text: JSON.stringify(R.fail) } });
    }
  } catch (e) { }
}
`;
