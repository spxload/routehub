// routehub-egern-k4.js — диагностика Egern. K4_REV: k4-10 (2026-08-09).
// СХЕМА: шаги ПО ОДНОМУ ЗА ПРОГОН, курсор в хранилище, сдвиг ДО выполнения.
//   Упавший шаг остаётся со статусом 'НАЧАТ И НЕ ЗАВЕРШЁН'.
//   ТРЕБОВАНИЕ: интервал cron должен превышать самый долгий шаг, иначе
//   следующий прогон подхватит курсор и затрёт результат (наблюдалось на
//   k4-8 при cron '* * * * *': шаг T3 длился 10,86 с). Штатный cron — */5.
// НОВОЕ В k4-10: после КАЖДОГО шага шлётся уведомление $notification.post —
//   при ручном запуске из UI Egern иначе не видно ни прогресса, ни итога.
//   Уведомление отправляется ПОСЛЕ записи состояния: даже если оно упадёт,
//   результат шага уже сохранён.
//
// ИТОГИ k4-9 (Egern 2.20.0, k3, 2026-08-09):
//   • АДРЕСАЦИЯ УЗЛА ИЗ proxies ПОДТВЕРЖДЕНА ТРЕТЬИМ СПОСОБОМ: ifconfig.me
//     через RH-Явный-1/2/3 и DIRECT дал ЧЕТЫРЕ разных выхода —
//     111.88.96.83 / 5.129.249.122 / 85.93.10.78 / 5.227.10.120.
//   • ПРИЧИНА HTTP 400 — НЕ УЗЕЛ, А ХОСТ. Через RH-Явный-2 отвечают
//     speed.cloudflare.com и ifconfig.me (200), но cp.cloudflare.com и
//     www.cloudflare.com дают 400 — и по HTTP, и по HTTPS. Cloudflare
//     отшивает выходной IP 5.129.249.122 на части своих хостов.
//     СЛЕДСТВИЕ ЗА ПРЕДЕЛАМИ СТЕНДА: cp.cloudflare.com/generate_204 —
//     наш latency_test_url и боевой proxy-test-url; на таких узлах живой
//     и быстрый узел выглядит мёртвым. Подбор замены — шаг V3.
//   • ПОРТ 13991 ОТВЕЧАЕТ: 127.0.0.1:13991 через DIRECT дал 404 (ответ
//     живого сервера), без policy — 400 (запрос уходит в туннель).
//     Перебор путей — шаг V2.
//   • Шаг W4 (ws) НЕУБЕДИТЕЛЕН: взят тот же cp.cloudflare.com, получен тот
//     же 400 — отличить неверный разбор ws от отказа хоста нельзя.
//     Повтор на другом URL — шаг V1.
//   • Скорости 256 КБ: n1 8,3 / n2 7,4 / n3 (DE) 1,2 Мбит/с. У n2 разброс
//     между прогонами (2,8 → 7,4) ⇒ одиночный замер шумный, нужна медиана.
//
// ИТОГИ k4-8: ctx.http с policy = имя узла из proxies адресует именно этот
//   узел; поузловой спидтест реализуем; sessionStorage не переживает прогон,
//   localStorage переживает; __context.baseUrl = http://localhost:13991/js.
// ИТОГИ k4-7: $httpClient ИГНОРИРУЕТ node и policy; $httpClient.request
//   РОНЯЕТ прогон — НЕ ВЫЗЫВАТЬ; $httpAPI нет; WebSocket работает;
//   $utils.geoip для узлового IP даёт мусор — страна ТОЛЬКО из имени узла.
//
// В ТЕКСТЕ СКРИПТА НЕЛЬЗЯ: обратные кавычки, ${...} и ЛЮБЫЕ обратные слэши.
// ФАЙЛ ЗАКАНЧИВАЕТСЯ СТРОЧНЫМ КОММЕНТАРИЕМ БЕЗ ПЕРЕВОДА СТРОКИ — защита от мусора.
// ОГРАНИЧЕНИЕ ПО ТРАФИКУ: через обходной узел (RH-Явный-WS) идёт РОВНО ОДИН
//   запрос в шаге V1 — трафик обходных узлов платный.

export const K4_REV = 'k4-10';

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
  const STATE = 'rh_scan10';
  const REV = 'k4-10';
  const EX1 = 'RH-Явный-1';
  const EX2 = 'RH-Явный-2';
  const EXW = 'RH-Явный-WS';

  // Одиночный запрос через заданную политику. Пустая policy — без указания.
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

  // Уведомление: единственный способ увидеть прогресс при ручном запуске.
  const notify = (title, text) => {
    try {
      if (typeof $notification !== 'undefined' && $notification && $notification.post) {
        $notification.post(title, '', text);
      }
    } catch (e) { }
  };

  const steps = [
    // V1: ws-транспорт. РОВНО ОДИН запрос, узел обходной — трафик платный.
    // URL не из Cloudflare: на k4-9 именно хост Cloudflare давал ложный 400.
    ['V1_ws_ip', async () => ({
      note: 'один запрос, обходной узел',
      ip: await via('https://ifconfig.me/ip', EXW, 12000, 60)
    })],
    // V2: локальный сервер Egern. Через DIRECT — иначе запрос уходит в туннель.
    ['V2_local_paths', async () => {
      const paths = ['/', '/js', '/js/', '/api', '/v1', '/config', '/policies', '/status', '/version'];
      const out = {};
      for (let i = 0; i < paths.length; i++) {
        out[paths[i]] = await via('http://127.0.0.1:13991' + paths[i], 'DIRECT', 3000, 200);
      }
      return out;
    }],
    // V3: подбор тест-URL, отвечающего со ВСЕХ узлов. RH-Явный-2 — заведомо
    // проблемный для Cloudflare; RH-Явный-1 идёт контролем.
    ['V3_test_urls', async () => {
      const urls = [
        'http://cp.cloudflare.com/generate_204',
        'http://www.msftconnecttest.com/connecttest.txt',
        'http://www.gstatic.com/generate_204',
        'http://captive.apple.com/hotspot-detect.html',
        'https://ifconfig.me/ip'
      ];
      const n2 = {}, n1 = {};
      for (let i = 0; i < urls.length; i++) {
        n2[urls[i]] = await via(urls[i], EX2, 9000, 40);
        n1[urls[i]] = await via(urls[i], EX1, 9000, 40);
      }
      return { n2: n2, n1: n1 };
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
    let okText = '';
    try {
      st.results[nm] = await steps[idx][1]();
      okText = 'готово';
    } catch (e) {
      st.results[nm] = 'ошибка: ' + String((e && e.message) || e);
      okText = 'ОШИБКА';
    }
    try { ctx.storage.setJSON(STATE, st); } catch (e) { }
    const left = total - st.cursor;
    notify(REV + ': шаг ' + st.cursor + ' из ' + total,
           nm + ' — ' + okText + (left > 0 ? '. Осталось шагов: ' + left + ', запусти ещё раз' : '. ПЕРЕБОР ЗАВЕРШЁН, забирай отчёт'));
  } else {
    notify(REV + ': перебор уже завершён', 'Все ' + total + ' шагов пройдены. Отчёт на стенде.');
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