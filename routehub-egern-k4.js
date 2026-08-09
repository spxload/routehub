// routehub-egern-k4.js — диагностика Egern. K4_REV: k4-9 (2026-08-09).
// СХЕМА: шаги ПО ОДНОМУ ЗА ПРОГОН, курсор в хранилище, сдвиг ДО выполнения.
//   Упавший шаг остаётся со статусом 'НАЧАТ И НЕ ЗАВЕРШЁН'.
//   ТРЕБОВАНИЕ: интервал cron должен превышать самый долгий шаг, иначе
//   следующий прогон подхватит курсор и затрёт результат (наблюдалось на
//   k4-8 при cron '* * * * *': шаг T3 длился 10,86 с). Штатный cron — */5.
//
// ИТОГИ k4-8 (Egern 2.20.0, k3, 2026-08-09) — ГЛАВНЫЙ ВОПРОС ЗАКРЫТ:
//   • ctx.http с policy = имя узла из proxies АДРЕСУЕТ ИМЕННО ЭТОТ УЗЕЛ:
//     RH-Явный-1 → 111.88.96.83 (RU), RH-Явный-3 → 85.93.10.78 (DE),
//     группа → 111.88.96.82, DIRECT → 5.227.10.120. Повтор (T3) устойчив.
//   • Поузловой спидтест реализуем: 256 КБ дали 9,5 и 2,8 Мбит/с (T6).
//   • RH-Явный-2 стабильно отдаёт HTTP 400 на www.cloudflare.com/cdn-cgi/trace,
//     НО тот же узел успешно качает с speed.cloudflare.com ⇒ отказ привязан
//     к паре «узел + хост». Причина — шаг W1 этой ревизии.
//   • __context.baseUrl = http://localhost:13991/js ⇒ у Egern есть ЛОКАЛЬНЫЙ
//     HTTP-сервер. Ранее перебирались 9090/8080/6152/6170/7890/1082/8888 —
//     этот порт не проверялся. Шаг W3. От него зависит вывод 44 (нет
//     управления политиками из скрипта).
//   • sessionStorage НЕ переживает прогон (T5), localStorage переживает.
//
// ИТОГИ k4-7: $httpClient ИГНОРИРУЕТ node и policy; $httpClient.request
//   РОНЯЕТ прогон — НЕ ВЫЗЫВАТЬ; $httpAPI нет; WebSocket работает;
//   $utils.geoip для узлового IP даёт мусор — страна ТОЛЬКО из имени узла.
//
// В ТЕКСТЕ СКРИПТА НЕЛЬЗЯ: обратные кавычки, ${...} и ЛЮБЫЕ обратные слэши.
// ФАЙЛ ЗАКАНЧИВАЕТСЯ СТРОЧНЫМ КОММЕНТАРИЕМ БЕЗ ПЕРЕВОДА СТРОКИ — защита от мусора.
// ОГРАНИЧЕНИЕ ПО ТРАФИКУ: через обходной узел (RH-Явный-WS) идёт РОВНО ОДИН
//   запрос generate_204 в шаге W4 — трафик обходных узлов платный.

export const K4_REV = 'k4-9';

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
  const STATE = 'rh_scan9';
  const REV = 'k4-9';
  const EX1 = 'RH-Явный-1';
  const EX2 = 'RH-Явный-2';
  const EX3 = 'RH-Явный-3';
  const EXW = 'RH-Явный-WS';

  // Один запрос через заданную политику. Тело обрезается: в отчёт идёт
  // только признак, а не содержимое страницы.
  const via = async (url, policy, ms, cut) => {
    try {
      const opt = { timeout: ms || 9000 };
      if (policy) opt.policy = policy;
      const r = await ctx.http.get(url, opt);
      let body = '';
      try { body = String(await r.text() || '').slice(0, cut || 80); } catch (e) { body = 'нечитаемо'; }
      return { st: r.status, body: body };
    } catch (e) { return 'err:' + ((e && e.message) || e); }
  };

  const steps = [
    // W1: ГЛАВНОЕ — от чего зависит отказ RH-Явный-2: от узла или от хоста.
    ['W1_n2_urls', async () => ({
      plain_204: await via('http://cp.cloudflare.com/generate_204', EX2),
      https_204: await via('https://cp.cloudflare.com/generate_204', EX2),
      trace: await via('https://www.cloudflare.com/cdn-cgi/trace', EX2),
      speed_1k: await via('https://speed.cloudflare.com/__down?bytes=1024', EX2, 15000, 20),
      control_n1_trace: await via('https://www.cloudflare.com/cdn-cgi/trace', EX1)
    })],
    // W2: выходной IP трёх узлов через НЕ-Cloudflare источник —
    // третий независимый способ подтвердить поузловую адресацию.
    ['W2_ip_alt', async () => ({
      n1: await via('https://ifconfig.me/ip', EX1, 9000, 60),
      n2: await via('https://ifconfig.me/ip', EX2, 9000, 60),
      n3: await via('https://ifconfig.me/ip', EX3, 9000, 60),
      direct: await via('https://ifconfig.me/ip', 'DIRECT', 9000, 60)
    })],
    // W3: локальный HTTP-сервер Egern (порт из __context.baseUrl).
    // Шаг вынесен отдельно: обращение к локальному адресу может уронить прогон.
    ['W3_local_13991', async () => ({
      root: await via('http://127.0.0.1:13991/', '', 3000, 200),
      js: await via('http://127.0.0.1:13991/js', '', 3000, 200),
      root_direct: await via('http://127.0.0.1:13991/', 'DIRECT', 3000, 200),
      by_name: await via('http://localhost:13991/', '', 3000, 200)
    })],
    // W4: разбор ws-транспорта. РОВНО ОДИН запрос — узел обходной, трафик платный.
    ['W4_ws_once', async () => ({
      note: 'один запрос, обходной узел',
      r: await via('http://cp.cloudflare.com/generate_204', EXW, 9000, 20)
    })],
    // W5: замер 256 КБ через три обычных узла подряд — устойчивость привязки
    // и прообраз персонального спидтеста.
    ['W5_speed3', async () => {
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
      return { n1: await one(EX1), n2: await one(EX2), n3: await one(EX3) };
    }]
  ];

  let st = null;
  try { st = ctx.storage.getJSON(STATE); } catch (e) { }
  if (!st || st.rev !== REV || (env.RH_RESET && st.reset !== env.RH_RESET)) {
    st = { rev: REV, reset: env.RH_RESET || '', cursor: 0, results: {} };
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

  const R = { rev: REV, step: ranNow, cursor: st.cursor, total: total,
              done: st.cursor >= total, results: st.results,
              total_ms: Date.now() - t0, ts: new Date().toISOString() };
  // После завершения перебора отчёт шлётся ОДИН раз: холостые прогоны
  // ели квоту Worker'ов (наблюдалось на k4-8).
  try {
    if (env.RH_POST_URL && (ranNow || !st.posted_done)) {
      await ctx.http.post(env.RH_POST_URL, {
        body: R, headers: { 'Content-Type': 'application/json' }, timeout: 15000
      });
      if (!ranNow) { st.posted_done = true; try { ctx.storage.setJSON(STATE, st); } catch (e) { } }
    }
  } catch (e) { }
  return { rh: REV, step: ranNow, cursor: st.cursor, total: total };
}
`;

// ХВОСТОВОЙ СТРАЖ — строка без перевода в конце файла; мусор после неё —