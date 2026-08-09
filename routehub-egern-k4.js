// routehub-egern-k4.js — диагностика Egern. K4_REV: k4-8 (2026-08-09).
// СХЕМА: шаги ПО ОДНОМУ ЗА ПРОГОН, курсор в хранилище, сдвиг ДО выполнения.
//   Упавший шаг остаётся со статусом 'НАЧАТ И НЕ ЗАВЕРШЁН'.
//
// ИТОГИ k4-7 (Egern 2.20.0, k3, 2026-08-09):
//   • $httpClient ИГНОРИРУЕТ и node, и policy: все варианты дали один выход
//     111.88.96.83, тот же, что у обычных правил. Совместимость поверхностная.
//   • $httpClient.request РОНЯЕТ прогон (шаг S8 не завершён) — НЕ ВЫЗЫВАТЬ.
//   • $httpAPI нет ⇒ управления политиками из скрипта нет никаким путём.
//   • WebSocket РАБОТАЕТ (ws.postman-echo.com — echo) ⇒ реальное время возможно.
//   • localStorage персистентен; $utils.ungzip работает; $notification.post работает.
//   • $utils.geoip для узлового IP дал PK/null — та же дыра, что у ctx.lookupIP.
//     Страна — ТОЛЬКО из имени узла (вывод 4 в СТАРТ.md).
//   • В globalThis есть НЕОПИСАННЫЕ Egern, __context, _tickTimers, а также window,
//     document, location, sessionStorage, indexedDB, EventSource, Worker — шаг T1.
//
// ГЛАВНЫЙ ОТКРЫТЫЙ ВОПРОС (шаг T2): адресуем ли узел через ctx.http.
//   В k4-7 явный узел и группа дали ОДИН IP — но группа могла выбрать именно его.
//   Различает только сравнение ТРЁХ РАЗНЫХ явных узлов между собой.
//   Имена детерминированы (RH-Явный-1..3), правка Worker'а не нужна.
//
// В ТЕКСТЕ СКРИПТА НЕЛЬЗЯ: обратные кавычки, ${...} и ЛЮБЫЕ обратные слэши.
// ФАЙЛ ЗАКАНЧИВАЕТСЯ СТРОЧНЫМ КОММЕНТАРИЕМ БЕЗ ПЕРЕВОДА СТРОКИ — защита от мусора.
// ОГРАНИЧЕНИЕ: ни одна проба НЕ идёт через RH-Обход — трафик платный.

export const K4_REV = 'k4-8';

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
  const TRACE = 'https://www.cloudflare.com/cdn-cgi/trace';
  const GROUP = env.RH_GROUP || 'RH-Пул-Обычные';
  const STATE = 'rh_scan8';

  const parseTrace = (txt) => {
    const s = String(txt || '');
    const ip = s.match(/ip=([0-9a-fA-F:.]+)/);
    const loc = s.match(/loc=([A-Z][A-Z])/);
    return { ip: ip ? ip[1] : null, loc: loc ? loc[1] : null };
  };
  const exitVia = async (policy) => {
    try {
      const r = await ctx.http.get(TRACE, { policy: policy, timeout: 9000 });
      return Object.assign({ st: r.status }, parseTrace(await r.text()));
    } catch (e) { return 'err:' + ((e && e.message) || e); }
  };
  const names = (o) => {
    const s = new Set();
    let cur = o;
    for (let d = 0; d < 3 && cur && cur !== Object.prototype; d++) {
      try { Object.getOwnPropertyNames(cur).forEach(n => s.add(n)); } catch (e) { }
      cur = Object.getPrototypeOf(cur);
    }
    return Array.from(s).filter(n => ['constructor','toString','apply','arguments','bind','call','caller','length','name','prototype'].indexOf(n) < 0).sort();
  };
  const safeVal = (v, depth) => {
    const t = typeof v;
    if (v === null || t === 'undefined') return String(v);
    if (t === 'string' || t === 'number' || t === 'boolean') return v;
    if (t === 'function') return 'function';
    if (depth <= 0) return '[object]';
    const out = {};
    names(v).slice(0, 40).forEach(k => {
      try { out[k] = safeVal(v[k], depth - 1); } catch (e) { out[k] = 'err'; }
    });
    return out;
  };

  const steps = [
    // T1: неописанные объекты самого Egern
    ['T1_egern_obj', async () => ({
      Egern_type: typeof G.Egern,
      Egern: typeof G.Egern !== 'undefined' ? safeVal(G.Egern, 2) : '-',
      __context_type: typeof G.__context,
      __context: typeof G.__context !== 'undefined' ? safeVal(G.__context, 2) : '-',
      tickTimers: typeof G._tickTimers
    })],
    // T2: ГЛАВНОЕ — разные ли выходы у трёх ЯВНЫХ узлов
    ['T2_explicit_diff', async () => ({
      n1: await exitVia('RH-Явный-1'),
      n2: await exitVia('RH-Явный-2'),
      n3: await exitVia('RH-Явный-3'),
      group: await exitVia(GROUP),
      direct: await exitVia('DIRECT')
    })],
    // T3: повтор того же через паузу — устойчиво ли распределение
    ['T3_explicit_repeat', async () => {
      await new Promise(r => setTimeout(r, 1500));
      return { n1: await exitVia('RH-Явный-1'), n2: await exitVia('RH-Явный-2') };
    }],
    // T4: среда WebKit — что реально живое
    ['T4_dom', async () => {
      const out = {};
      try { out.location = typeof location !== 'undefined' ? String(location.href).slice(0, 120) : '-'; } catch (e) { out.location = 'err'; }
      try { out.document = typeof document !== 'undefined' ? (document.title === undefined ? 'no title' : String(document.title)) : '-'; } catch (e) { out.document = 'err'; }
      try { out.origin = typeof origin !== 'undefined' ? String(origin) : '-'; } catch (e) { out.origin = 'err'; }
      out.session = typeof sessionStorage;
      out.idb = typeof indexedDB;
      out.worker = typeof Worker;
      out.eventsource = typeof EventSource;
      out.rtc = typeof RTCPeerConnection;
      out.opendb = typeof openDatabase;
      return out;
    }],
    // T5: sessionStorage — переживает ли прогоны (в отличие от localStorage)
    ['T5_session', async () => {
      if (typeof sessionStorage === 'undefined') return 'нет';
      const prev = sessionStorage.getItem('rh_ss');
      sessionStorage.setItem('rh_ss', String(Date.now()));
      return { prev_was: prev, len: sessionStorage.length };
    }],
    // T6: два параллельных замера через РАЗНЫЕ узлы — прообраз спидтеста.
    // По 256 КБ на узел, только обычные узлы.
    ['T6_speed_pair', async () => {
      const one = async (policy) => {
        const t = Date.now();
        try {
          const r = await ctx.http.get('https://speed.cloudflare.com/__down?bytes=262144',
                                       { policy: policy, timeout: 30000 });
          const b = await r.arrayBuffer();
          const ms = Math.max(1, Date.now() - t);
          return { bytes: b.byteLength, ms: ms, mbps: Math.round(b.byteLength * 8 / ms / 100) / 10 };
        } catch (e) { return 'err:' + ((e && e.message) || e); }
      };
      return { n1: await one('RH-Явный-1'), n2: await one('RH-Явный-2') };
    }],
    // T7: следы перехвата (заполнит будущий http_request-скрипт)
    ['T7_mitm', async () => ({
      hits: ctx.storage.get('rh_mitm_hits'), last: ctx.storage.get('rh_mitm_last')
    })]
  ];

  let st = null;
  try { st = ctx.storage.getJSON(STATE); } catch (e) { }
  if (!st || st.rev !== 'k4-8' || (env.RH_RESET && st.reset !== env.RH_RESET)) {
    st = { rev: 'k4-8', reset: env.RH_RESET || '', cursor: 0, results: {} };
  }
  const total = steps.length;
  const idx = st.cursor;
  let ranNow = null;

  if (idx < total) {
    const nm = steps[idx][0];
    st.cursor = idx + 1;
    st.results[nm] = 'НАЧАТ И НЕ ЗАВЕРШЁН — шаг роняет прогон';
    try { ctx.storage.setJSON(STATE, st); } catch (e) { }
    ranNow = nm;
    try { st.results[nm] = await steps[idx][1](); }
    catch (e) { st.results[nm] = 'ошибка: ' + String((e && e.message) || e); }
    try { ctx.storage.setJSON(STATE, st); } catch (e) { }
  }

  const R = { rev: 'k4-8', step: ranNow, cursor: st.cursor, total: total,
              done: st.cursor >= total, results: st.results,
              total_ms: Date.now() - t0, ts: new Date().toISOString() };
  try {
    if (env.RH_POST_URL) {
      await ctx.http.post(env.RH_POST_URL, {
        body: R, headers: { 'Content-Type': 'application/json' }, timeout: 15000
      });
    }
  } catch (e) { }
  return { rh: 'k4-8', step: ranNow, cursor: st.cursor, total: total };
}
`;

// ХВОСТОВОЙ СТРАЖ — строка без перевода в конце файла; мусор после неё — 