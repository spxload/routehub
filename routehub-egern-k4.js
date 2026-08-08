// =============================================================
// routehub-egern-k4.js — диагностический schedule-скрипт для проверки K4.
// Модуль импортируется в routehub-egern-worker.js статически — только так
// Wrangler вкладывает его в бандл (вывод 21 в СТАРТ.md).
// Спецификация проб P1–P15 — ЭТАП_K_ШАГ_4.4_K4.md.
// Текст скрипта отдаёт сам стенд по /t/<token>/script/k4.js?key=kN,
// а не raw.githubusercontent.com: под whitelist raw недоступен, а свой origin
// и так единая точка отказа — вторую заводить незачем.
// ТОКЕН В ТЕКСТ СКРИПТА НЕ ПОПАДАЕТ: адрес приёма отчёта передаётся
// через env.RH_POST_URL при генерации профиля.
// ОГРАНИЧЕНИЕ: ни одна проба НЕ идёт через RH-Обход — трафик платный.
// =============================================================

// Имена узлов подписки — часть строки после '#'. Кодирование percent-encoded
// НЕПОСЛЕДОВАТЕЛЬНО (вывод 25) — поэтому decodeURIComponent в try.
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

// Первый ОБЫЧНЫЙ узел — для пробы P9 (запрос через конкретный узел).
// Критерий тот же, что у фильтров групп: слово в скобочном теге (вывод 28).
export function firstNormalNode(text) {
  const names = subNames(text);
  for (let i = 0; i < names.length; i++) {
    if (!/Обход/.test(names[i])) return names[i];
  }
  return '';
}

// Текст скрипта для Egern. Форма обязательная: export default async function (ctx).
// Внутри НЕЛЬЗЯ использовать обратные кавычки и ${...}: текст живёт
// в шаблонной строке Worker'а. По той же причине в регулярках нет \n.
export const K4_SCRIPT = `export default async function (ctx) {
  const t0 = Date.now();
  const R = { ok: [], fail: {} };
  const run = async (k, fn) => {
    try { R[k] = await fn(); R.ok.push(k); }
    catch (e) { R.fail[k] = String((e && e.message) || e); }
  };
  const env = ctx.env || {};
  const U204 = env.RH_TEST_URL || 'http://cp.cloudflare.com/generate_204';
  const GROUP = env.RH_GROUP || 'RH-Пул-Обычные';

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
    let big;
    try { s.set('rh_big', 'x'.repeat(32768)); big = (s.get('rh_big') || '').length; s.delete('rh_big'); }
    catch (e) { big = 'err:' + ((e && e.message) || e); }
    return { str: str, json: j && j.a, deleted: gone === null || gone === undefined, runs: n, big32k: big };
  });

  const probe = async (policy) => {
    const o = { timeout: 8000 };
    if (policy) o.policy = policy;
    const t = Date.now();
    const r = await ctx.http.get(U204, o);
    return { status: r.status, ms: Date.now() - t };
  };
  await run('P6_http', () => probe(null));
  await run('P7_group', () => probe(GROUP));
  await run('P8_direct', () => probe('DIRECT'));
  await run('P9_node', async () => env.RH_NODE ? await probe(env.RH_NODE) : 'нет env.RH_NODE');
  await run('P11_unreach', async () => {
    const t = Date.now();
    try {
      const r = await ctx.http.get('http://192.0.2.1/generate_204', { timeout: 3000 });
      return { kind: 'ответ', status: r.status, ms: Date.now() - t };
    } catch (e) {
      return { kind: 'исключение', msg: String((e && e.message) || e), ms: Date.now() - t };
    }
  });
  await run('P12_geo', async () => {
    const out = { ip8888: ctx.lookupIP('8.8.8.8') };
    const r = await ctx.http.get('https://cp.cloudflare.com/cdn-cgi/trace', { policy: GROUP, timeout: 8000 });
    const txt = await r.text();
    const m = txt.match(/ip=([0-9a-fA-F:.]+)/);
    out.exit_ip = m ? m[1] : null;
    out.exit_geo = m ? ctx.lookupIP(m[1]) : null;
    return out;
  });
  await run('P13_compress', async () => {
    const src = new TextEncoder().encode('RouteHub '.repeat(64));
    const gz = await ctx.compress.gzip(src);
    const back = await ctx.compress.gunzip(gz);
    return { raw: src.length, gz: gz && gz.length, back: back && back.length, same: !!back && back.length === src.length };
  });
  if (env.RH_HEAVY === '1') {
    await run('P15_speed', async () => {
      const t = Date.now();
      const r = await ctx.http.get('https://speed.cloudflare.com/__down?bytes=1048576', { policy: env.RH_NODE || GROUP, timeout: 60000 });
      const b = await r.arrayBuffer();
      const ms = Math.max(1, Date.now() - t);
      return { bytes: b.byteLength, ms: ms, mbps: Math.round(b.byteLength * 8 / ms / 100) / 10 };
    });
  }

  R.total_ms = Date.now() - t0;
  R.ts = new Date().toISOString();
  await run('P10_post', async () => {
    if (!env.RH_POST_URL) return 'нет env.RH_POST_URL';
    const r = await ctx.http.post(env.RH_POST_URL, {
      body: R, headers: { 'Content-Type': 'application/json' }, timeout: 15000
    });
    return { status: r.status };
  });
  try { ctx.storage.setJSON('rh_last', R); } catch (e) { }
  try {
    if (!ctx.storage.get('rh_notified')) {
      ctx.storage.set('rh_notified', '1');
      ctx.notify({ title: 'RouteHub K4', body: 'Прошло: ' + R.ok.length + ', отказов: ' + Object.keys(R.fail).length });
    }
  } catch (e) { }
}
`;
