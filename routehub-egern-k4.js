// routehub-egern-k4.js — диагностика Egern. K4_REV: k4-7 (2026-08-09).
// СХЕМА: шаги идут ПО ОДНОМУ ЗА ПРОГОН, курсор — в хранилище.
// ПРИЧИНА: на k4-6 прогон упал с UNHANDLED PROMISE REJECTION внутри самого
//   Egern: "n is not a function (In 'n(e,void 0,void 0)', 'n' is undefined)"
//   @ http://egern-js/ — прослойка совместимости вызвала колбек, которого
//   у неё нет. Такое падение НЕ ловится try/catch и убивает весь прогон —
//   значит, опасные формы вызова надо изолировать по прогонам.
// КУРСОР СДВИГАЕТСЯ ДО выполнения шага: упавший шаг останется со статусом
//   'НАЧАТ И НЕ ЗАВЕРШЁН', а перебор пойдёт дальше.
// Сброс перебора — env.RH_RESET = любое новое значение.
//
// УЖЕ УСТАНОВЛЕНО (k4-1..k4-5):
//   • Слой совместимости — SURGE: $environment = { system: iOS,
//     surge-build: 3010, surge-version: 5.8.3 }.
//   • $persistentStore и ctx.storage — ОДНО хранилище.
//   • $utils.geoip/ipasn/ipaso работают и ПОЛНЕЕ ctx.lookupIP.
//   • $config нет ⇒ переключения политики штатно нет (остаётся $httpAPI — шаг S2).
//   • Узел из proxies адресуем через ctx.http (204); имя из подписки — 404.
//   • Глобальный fetch идёт МИМО туннеля.
//
// В ТЕКСТЕ СКРИПТА НЕЛЬЗЯ: обратные кавычки, ${...} и ЛЮБЫЕ обратные слэши.
// ОГРАНИЧЕНИЕ: ни одна проба НЕ идёт через RH-Обход — трафик платный.

export const K4_REV = 'k4-7';

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
  const env = ctx.env || {};
  const G = globalThis;
  const U204 = env.RH_TEST_URL || 'http://cp.cloudflare.com/generate_204';
  const TRACE = 'https://www.cloudflare.com/cdn-cgi/trace';
  const GROUP = env.RH_GROUP || 'RH-Пул-Обычные';
  const NODE = env.RH_NODE || '';
  const NODE2 = env.RH_NODE2 || '';
  const STATE = 'rh_scan';

  const parseTrace = (txt) => {
    const s = String(txt || '');
    const ip = s.match(/ip=([0-9a-fA-F:.]+)/);
    const loc = s.match(/loc=([A-Z][A-Z])/);
    const colo = s.match(/colo=([A-Z][A-Z][A-Z])/);
    return { ip: ip ? ip[1] : null, loc: loc ? loc[1] : null, colo: colo ? colo[1] : null };
  };
  const cb = (fn, arg, ms) => new Promise((res) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; res(v); } };
    const timer = setTimeout(() => fin({ r: 'timeout' }), ms || 9000);
    try {
      fn(arg, function (a, b, c) {
        clearTimeout(timer);
        fin({ err: a ? String(a) : null,
              status: b ? (b.status || b.statusCode || null) : null,
              body: c ? String(c).slice(0, 400) : '' });
      });
    } catch (e) { clearTimeout(timer); fin({ r: 'throw:' + ((e && e.message) || e) }); }
  });
  const names = (o) => {
    const s = new Set();
    let cur = o;
    for (let d = 0; d < 3 && cur && cur !== Object.prototype; d++) {
      try { Object.getOwnPropertyNames(cur).forEach(n => s.add(n)); } catch (e) { }
      cur = Object.getPrototypeOf(cur);
    }
    return Array.from(s).filter(n => ['constructor','toString','apply','arguments','bind','call','caller','length','name','prototype'].indexOf(n) < 0).sort();
  };

  const steps = [
    ['S1_scan_globals', async () => {
      const list = ['$httpAPI','$surge','$trigger','$intercept','$wifi','$storage','$mock',
                    '$done','$config','$argument','$task','$prefs','$option','$input',
                    '$loon','$rocket','$axios','$app','$exit','$log','$resource',
                    '$substore','$response','$request','$notification','$utils','$network',
                    '$script','$environment','$httpClient','$persistentStore','$cronexp',
                    '$chavy','$nobyda','$eval','$msg','$openURL','$copy','$browser'];
      const out = {};
      list.forEach(n => {
        const v = G[n];
        out[n] = (v === undefined) ? '-' :
          (typeof v === 'object' || typeof v === 'function') ? names(v) : typeof v;
      });
      return out;
    }],
    ['S2_httpapi_probe', async () => {
      const a = G.$httpAPI;
      if (typeof a !== 'function') return 'нет $httpAPI (typeof ' + (typeof a) + ')';
      return await new Promise((res) => {
        let done = false;
        const fin = (v) => { if (!done) { done = true; res(v); } };
        const timer = setTimeout(() => fin('timeout'), 8000);
        try { a('GET', 'v1/policy_groups', null, (r) => { clearTimeout(timer); fin(JSON.parse(JSON.stringify(r || null))); }); }
        catch (e) { clearTimeout(timer); fin('throw:' + ((e && e.message) || e)); }
      });
    }],
    ['S3_hc_string', async () => await cb((a, c) => G.$httpClient.get(a, c), U204)],
    ['S4_hc_object', async () => await cb((a, c) => G.$httpClient.get(a, c), { url: TRACE })],
    ['S5_hc_node_sub', async () => {
      if (!NODE) return 'нет RH_NODE';
      const r = await cb((a, c) => G.$httpClient.get(a, c), { url: TRACE, node: NODE });
      return r.body ? Object.assign({ status: r.status }, parseTrace(r.body)) : r;
    }],
    ['S6_hc_node_explicit', async () => {
      if (!NODE2) return 'нет RH_NODE2';
      const r = await cb((a, c) => G.$httpClient.get(a, c), { url: TRACE, node: NODE2 });
      return r.body ? Object.assign({ status: r.status }, parseTrace(r.body)) : r;
    }],
    ['S7_hc_policy', async () => {
      const r = await cb((a, c) => G.$httpClient.get(a, c), { url: TRACE, policy: GROUP });
      return r.body ? Object.assign({ status: r.status }, parseTrace(r.body)) : r;
    }],
    ['S8_hc_request', async () => {
      if (typeof G.$httpClient.request !== 'function') return 'нет request';
      return await cb((a, c) => G.$httpClient.request(a, c), { method: 'GET', url: U204 });
    }],
    ['S9_ctx_exits', async () => {
      const one = async (policy) => {
        try {
          const r = await ctx.http.get(TRACE, { policy: policy, timeout: 9000 });
          return Object.assign({ status: r.status }, parseTrace(await r.text()));
        } catch (e) { return 'err:' + ((e && e.message) || e); }
      };
      return { explicit: NODE2 ? await one(NODE2) : '-', group: await one(GROUP), direct: await one('DIRECT') };
    }],
    ['S10_geo_compare', async () => {
      const r = await ctx.http.get(TRACE, { policy: NODE2 || GROUP, timeout: 9000 });
      const t = parseTrace(await r.text());
      const u = G.$utils;
      if (!t.ip) return t;
      return { ip: t.ip, cf_loc: t.loc, colo: t.colo,
               utils: u ? { geo: u.geoip(t.ip), asn: u.ipasn(t.ip), aso: u.ipaso(t.ip) } : '-',
               ctx_lookup: ctx.lookupIP(t.ip) };
    }],
    ['S11_ws', async () => {
      if (typeof WebSocket !== 'function') return 'нет WebSocket';
      const test = (url) => new Promise((res) => {
        let done = false;
        const fin = (v) => { if (!done) { done = true; res(v); } };
        const timer = setTimeout(() => fin('timeout'), 7000);
        try {
          const ws = new WebSocket(url);
          ws.onopen = () => { try { ws.send('rh'); } catch (e) { } };
          ws.onmessage = () => { clearTimeout(timer); try { ws.close(); } catch (e) { } fin('echo'); };
          ws.onerror = () => { clearTimeout(timer); fin('error'); };
        } catch (e) { clearTimeout(timer); fin('throw:' + ((e && e.message) || e)); }
      });
      return { postman: await test('wss://ws.postman-echo.com/raw'),
               events: await test('wss://echo.websocket.events') };
    }],
    ['S12_localstorage', async () => {
      if (typeof localStorage === 'undefined') return 'нет';
      const prev = localStorage.getItem('rh_ls');
      const n = Number(localStorage.getItem('rh_ls_n') || '0') + 1;
      localStorage.setItem('rh_ls', String(Date.now()));
      localStorage.setItem('rh_ls_n', String(n));
      return { prev_was: prev, runs: n, len: localStorage.length };
    }],
    ['S13_utils_ungzip', async () => {
      const u = G.$utils;
      if (!u || typeof u.ungzip !== 'function') return 'нет ungzip';
      const src = new TextEncoder().encode('RouteHub '.repeat(32));
      const gz = await ctx.compress.gzip(src);
      const back = u.ungzip(gz);
      return { gz_len: gz && gz.length, back_type: typeof back,
               back_len: back && (back.length || back.byteLength) || null };
    }],
    ['S14_notify', async () => {
      const n = G.$notification;
      if (!n || typeof n.post !== 'function') return 'нет $notification.post';
      n.post('RouteHub', 'перебор Surge-API', 'шаг S14');
      return 'вызвано';
    }],
    ['S15_widget_ctx', async () => ({
      widgetFamily: typeof ctx.widgetFamily, script_type: G.$script ? G.$script.type : '-',
      cron: ctx.cron || null, respond: typeof ctx.respond, abort: typeof ctx.abort
    })]
  ];

  let st = null;
  try { st = ctx.storage.getJSON(STATE); } catch (e) { }
  if (!st || st.rev !== 'k4-7' || (env.RH_RESET && st.reset !== env.RH_RESET)) {
    st = { rev: 'k4-7', reset: env.RH_RESET || '', cursor: 0, results: {} };
  }
  const total = steps.length;
  const idx = st.cursor;
  let ranNow = null;

  if (idx < total) {
    const nameOfStep = steps[idx][0];
    st.cursor = idx + 1;
    st.results[nameOfStep] = 'НАЧАТ И НЕ ЗАВЕРШЁН — шаг роняет прогон';
    try { ctx.storage.setJSON(STATE, st); } catch (e) { }
    ranNow = nameOfStep;
    try { st.results[nameOfStep] = await steps[idx][1](); }
    catch (e) { st.results[nameOfStep] = 'ошибка: ' + String((e && e.message) || e); }
    try { ctx.storage.setJSON(STATE, st); } catch (e) { }
  }

  const R = { rev: 'k4-7', step: ranNow, cursor: st.cursor, total: total,
              done: st.cursor >= total, results: st.results,
              total_ms: Date.now() - t0, ts: new Date().toISOString() };
  try {
    if (env.RH_POST_URL) {
      await ctx.http.post(env.RH_POST_URL, {
        body: R, headers: { 'Content-Type': 'application/json' }, timeout: 15000
      });
    }
  } catch (e) { }
  return { rh: 'k4-7', step: ranNow, cursor: st.cursor, total: total };
}
`;
</parameter>