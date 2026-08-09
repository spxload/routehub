// =============================================================
// routehub-egern-k4.js — диагностический schedule-скрипт (проверка K4 и шире).
// K4_REV: k4-4 (2026-08-08) = k4-3 (интроспекция) + пробы по ЯВНО ОБЪЯВЛЕННЫМ
//   узлам (proxies, worker e0.4.0). Ревизия ведётся отдельно от версии
//   Worker'а: правка проб не требует его перезаливки; rev уходит в отчёт.
//
// ИТОГИ ПОЛЕЙ (Egern 2.20.0, k3, 2026-08-08):
//   • k4-1/k4-2: schedule работает без MITM; ctx.http принимает в policy имена
//     ГРУПП и DIRECT; имя узла из подписки, несуществующее имя и REJECT —
//     404 от самого Egern. policyDescriptor с именем узла — ошибка 400.
//   • crypto.subtle ОТСУТСТВУЕТ; fetch, WebAssembly, Intl, setTimeout — есть.
//   • storage держит 1 МБ в значении; 5 параллельных запросов — 109 мс.
//   • ctx.lookupIP расходится с Cloudflare и даёт пустые asn/organization.
//
// В ТЕКСТЕ СКРИПТА НЕЛЬЗЯ: обратные кавычки, ${...} и ЛЮБЫЕ обратные
//   слэши — текст живёт в шаблонной строке, слэш съедается и ТИХО ломает
//   регулярки (\d → d). Проверяется прогоном перед коммитом.
// ОГРАНИЧЕНИЕ: ни одна проба НЕ идёт через RH-Обход — трафик платный.
// =============================================================

export const K4_REV = 'k4-4';

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
  const R = { rev: 'k4-4', ok: [], fail: {} };
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
  const GROUP2 = env.RH_GROUP2 || '';
  const names = (o) => {
    const s = new Set();
    let cur = o;
    for (let d = 0; d < 3 && cur && cur !== Object.prototype; d++) {
      try { Object.getOwnPropertyNames(cur).forEach(n => s.add(n)); } catch (e) { }
      cur = Object.getPrototypeOf(cur);
    }
    return Array.from(s).filter(n => n !== 'constructor').sort();
  };
  const probe = async (url, opt) => {
    const o = Object.assign({ timeout: 8000 }, opt || {});
    const t = Date.now();
    const r = await ctx.http.get(url, o);
    return { status: r.status, ms: Date.now() - t, server: r.headers && r.headers.get ? r.headers.get('server') : null };
  };

  await run('P1_script', async () => ({ name: ctx.script && ctx.script.name, cron: ctx.cron || null }));
  await run('P4_device', async () => {
    const d = ctx.device || {};
    const w = d.wifi || {}, c = d.cellular || {};
    return { ssid: w.ssid, bssid: w.bssid, carrier: c.carrier, radio: c.radio };
  });

  // --- ГЛАВНОЕ В k4-4: адресуем ли УЗЕЛ, ОБЪЯВЛЕННЫЙ В proxies
  await run('P9f_explicit', async () => NODE2 ? await probe(U204, { policy: NODE2 }) : 'нет RH_NODE2');
  await run('P9g_expl_desc', async () => NODE2 ? await probe(U204, { policyDescriptor: NODE2 }) : 'нет RH_NODE2');
  await run('P9h_expl_geo', async () => {
    if (!NODE2) return 'нет RH_NODE2';
    const r = await ctx.http.get(TRACE, { policy: NODE2, timeout: 8000 });
    const txt = await r.text();
    const ip = txt.match(/ip=([0-9a-fA-F:.]+)/);
    const loc = txt.match(/loc=([A-Z][A-Z])/);
    return { status: r.status, ip: ip ? ip[1] : null, loc: loc ? loc[1] : null,
             geo: ip ? ctx.lookupIP(ip[1]) : null };
  });
  await run('P9a_node', async () => NODE ? await probe(U204, { policy: NODE }) : 'нет RH_NODE');
  await run('P36_groups', async () => {
    const out = {};
    const list = ['RH-Пул-Обычные', 'RH-Проба-Обычная', 'RH-RU', 'RH-Главный', 'RH-Проба-DIRECT', 'DIRECT'];
    if (GROUP2) list.push(GROUP2);
    for (let i = 0; i < list.length; i++) {
      try { const r = await probe(U204, { policy: list[i] }); out[list[i]] = r.status + '/' + r.ms + 'мс'; }
      catch (e) { out[list[i]] = 'err:' + ((e && e.message) || e); }
    }
    return out;
  });

  // --- ИНТРОСПЕКЦИЯ: что есть на самом деле, а не в документации
  await run('P31_global', async () => names(globalThis));
  await run('P32_ctx_deep', async () => {
    const out = {};
    Object.keys(ctx).forEach(k => {
      const v = ctx[k];
      out[k] = (v && (typeof v === 'object' || typeof v === 'function')) ? names(v) : typeof v;
    });
    return out;
  });
  await run('P33_crypto', async () => ({
    keys: typeof crypto !== 'undefined' ? names(crypto) : null,
    getRandomValues: typeof crypto !== 'undefined' ? typeof crypto.getRandomValues : null,
    randomUUID: typeof crypto !== 'undefined' ? typeof crypto.randomUUID : null
  }));
  await run('P40_web', async () => {
    const t = (n) => n + ':' + (typeof globalThis[n]);
    return ['Response', 'Request', 'Headers', 'Blob', 'FormData', 'AbortController',
            'ReadableStream', 'structuredClone', 'performance', 'navigator', 'WebSocket',
            'XMLHttpRequest', 'localStorage', 'process', 'require', 'Deno', 'Bun',
            'TextDecoder', 'queueMicrotask', 'setInterval'].map(t);
  });

  // --- ГЛОБАЛЬНЫЙ fetch и гео через группу
  await run('P34_fetch', async () => {
    if (typeof fetch !== 'function') return 'нет fetch';
    const t = Date.now();
    const r = await fetch(TRACE);
    const txt = await r.text();
    const ip = txt.match(/ip=([0-9a-fA-F:.]+)/);
    const loc = txt.match(/loc=([A-Z][A-Z])/);
    return { status: r.status, ms: Date.now() - t, ip: ip ? ip[1] : null, loc: loc ? loc[1] : null };
  });
  await run('P12b_geo', async () => {
    const r = await ctx.http.get(TRACE, { policy: GROUP, timeout: 8000 });
    const txt = await r.text();
    const ip = txt.match(/ip=([0-9a-fA-F:.]+)/);
    const loc = txt.match(/loc=([A-Z][A-Z])/);
    const colo = txt.match(/colo=([A-Z][A-Z][A-Z])/);
    return { ip: ip ? ip[1] : null, loc: loc ? loc[1] : null, colo: colo ? colo[1] : null };
  });

  // --- ЛОКАЛЬНЫЙ API Egern на устройстве
  await run('P35_local', async () => {
    const ports = [9090, 8080, 6152, 6170, 7890, 1082, 8888];
    const out = {};
    for (let i = 0; i < ports.length; i++) {
      const u = 'http://127.0.0.1:' + ports[i] + '/';
      try { const r = await ctx.http.get(u, { timeout: 700, policy: 'DIRECT' }); out[ports[i]] = r.status; }
      catch (e) { out[ports[i]] = 'x'; }
    }
    return out;
  });

  await run('P38_wasm', async () => {
    if (typeof WebAssembly !== 'object') return 'нет';
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    return { validate: WebAssembly.validate(bytes), compile: typeof WebAssembly.compile,
             instantiate: typeof WebAssembly.instantiate };
  });
  await run('P39_timer', async () => {
    const t = Date.now();
    await new Promise(res => setTimeout(res, 1200));
    return { slept_ms: Date.now() - t };
  });
  await run('P19_parallel', async () => {
    const t = Date.now();
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => ctx.http.get(U204, { policy: GROUP, timeout: 8000 })));
    return { n: rs.length, ms: Date.now() - t };
  });
  await run('P30_mitm', async () => ({
    hits: ctx.storage.get('rh_mitm_hits'), last: ctx.storage.get('rh_mitm_last')
  }));

  // --- тяжёлые замеры — только по флагу. Если P9f прошёл, меряем ЧЕРЕЗ УЗЕЛ:
  // это и есть будущий поузловой спидтест.
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
    await run('P20_speed_par', async () => {
      const t = Date.now();
      const rs = await Promise.all([0, 1, 2, 3].map(() =>
        ctx.http.get('https://speed.cloudflare.com/__down?bytes=262144', { policy: target, timeout: 60000 })
          .then(r => r.arrayBuffer())));
      const total = rs.reduce((a, b) => a + b.byteLength, 0);
      const ms = Math.max(1, Date.now() - t);
      return { via: target, bytes: total, ms: ms, mbps: Math.round(total * 8 / ms / 100) / 10 };
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
  // Возвращаемое значение schedule-скрипта документацией не описано —
  // смотрим глазами на экране скриптов, показывается ли где-нибудь.
  return { rh: R.rev, ok: R.ok.length, fail: Object.keys(R.fail).length, ts: R.ts };
}
`;
