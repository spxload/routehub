// routehub-egern-k4.js — диагностика Egern. K4_REV: k4-14 (2026-08-10).
//
// ЗАДАЧА: подобрать МАЯКИ для детектора whitelist РКН и выяснить причину
//   ошибок 400 на ровном месте. Снимается эталон в нормальном режиме — под
//   блокировкой сравнивать будет уже не с чем.
//
// ЛОГИКА ДЕТЕКТОРА (план, раздел F): под whitelist ИНОСТРАННЫЕ адреса
//   перестают отвечать НАПРЯМУЮ, а российские продолжают. Значит маяки —
//   иностранные, опрашиваемые через DIRECT; российские нужны контролем,
//   чтобы отличить whitelist от банального отсутствия интернета.
//   Решение принимается по большинству: молчат 4 из 5 — считаем whitelist.
//
// ИТОГИ k4-13 (2026-08-09/10, эталон снят до блокировок):
//   • ГОДНЫЕ ТЕСТ-АДРЕСА (3/3, код 204, пустое тело, через все четыре выхода):
//     connectivitycheck.gstatic.com (57/64/98/74 мс) — РОВНЕЕ ВСЕХ, выбран;
//     wifi.vivo.com.cn, clients3.google.com, www.gstatic.com, cp.cloudflare.com.
//   • ОТСЕЯНЫ: edge-http.microsoft.com — 502 напрямую и с DE-узла;
//     qualcomm.cn — 403 через RU-узел; firefox и gnome — вдвое медленнее.
//   • ya.ru, mail.ru, icanhazip дали 400 ЧЕРЕЗ ВСЕ ВЫХОДЫ, включая прямой.
//     Это не блокировка, а неспособность клиента обработать ответ — вероятно
//     редирект с http на https. Причина выясняется шагом M3.
//   • gosuslugi.ru: 200 напрямую, СБОЙ через любой прокси. Подтверждает
//     вывод 3 (РФ-whitelist домены обязаны идти жёстким DIRECT).
//   • ИСТОЧНИКИ ВЫХОДНОГО IP: ipify, ipinfo, icanhazip и Cloudflare согласны
//     (111.88.96.82), а ifconfig.me дал 139.100.196.194 — НЕНАДЁЖЕН, не брать.
//   • ИСТОЧНИК ДЛЯ СПИДТЕСТА: speed.cloudflare.com ЗАНИЖАЕТ ВДЕСЯТЕРО
//     (2,1 Мбит/с против 22,7 у proof.ovh.net на том же узле в тот же момент).
//     ⇒ ВСЕ прежние замеры скорости (k4-8, k4-9, k4-12) НЕДОСТОВЕРНЫ.
//     Для спидтеста брать proof.ovh.net и отбрасывать первый замер (8,1 → 22,7).
//     ash-speed.hetzner.com — сбой 400.
//
// СХЕМА: все шаги за один прогон, бюджет 100 с; недоделанное выполняется
//   следующим запуском, готовое не повторяется; шаг, убивший прогон, заносится
//   в чёрный список и пропускается навсегда.
//
// В ТЕКСТЕ СКРИПТА НЕЛЬЗЯ: обратные кавычки, ${...} и ЛЮБЫЕ обратные слэши.
// ФАЙЛ ЗАКАНЧИВАЕТСЯ СТРОЧНЫМ КОММЕНТАРИЕМ БЕЗ ПЕРЕВОДА СТРОКИ.
// ТРАФИК: обходные узлы не задействованы; тела ответов не скачиваются целиком.

export const K4_REV = 'k4-14';

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
  const BUDGET = 100000;
  const env = ctx.env || {};
  const STATE = 'rh_scan14';
  const REV = 'k4-14';

  // Кандидаты в МАЯКИ: иностранные, отвечающие быстро и без тела.
  // Под whitelist должны замолчать все разом — это и есть признак.
  const FOREIGN = [
    ['gstatic_cc', 'http://connectivitycheck.gstatic.com/generate_204'],
    ['vivo', 'http://wifi.vivo.com.cn/generate_204'],
    ['google_c3', 'http://clients3.google.com/generate_204'],
    ['cloudflare', 'http://cp.cloudflare.com/generate_204'],
    ['apple', 'http://captive.apple.com/hotspot-detect.html'],
    ['msft', 'http://www.msftconnecttest.com/connecttest.txt'],
    ['firefox', 'http://detectportal.firefox.com/success.txt'],
    ['cf_trace', 'https://1.1.1.1/cdn-cgi/trace'],
    ['ipify', 'https://api.ipify.org'],
    ['ipinfo', 'https://ipinfo.io/ip'],
    ['example', 'http://example.com'],
    ['github', 'https://github.com'],
    ['wikipedia', 'https://www.wikipedia.org'],
    ['duckduckgo', 'https://duckduckgo.com']
  ];

  // Российские: контроль живости интернета. Под whitelist продолжают работать.
  const RUSSIAN = [
    ['ya_https', 'https://ya.ru'],
    ['yandex_https', 'https://yandex.ru'],
    ['mailru_https', 'https://mail.ru'],
    ['vk', 'https://vk.com'],
    ['dzen', 'https://dzen.ru'],
    ['gosuslugi', 'https://www.gosuslugi.ru'],
    ['cbr', 'https://www.cbr.ru'],
    ['nalog', 'https://www.nalog.gov.ru'],
    ['mos', 'https://www.mos.ru'],
    ['ozon', 'https://www.ozon.ru'],
    ['wb', 'https://www.wildberries.ru'],
    ['rutube', 'https://rutube.ru']
  ];

  const notify = (title, text) => {
    try {
      if (typeof ctx.notify === 'function') { ctx.notify({ title: title, body: text }); return 'ok'; }
      if (typeof $notification !== 'undefined' && $notification && $notification.post) {
        $notification.post(title, '', text); return 'surge';
      }
    } catch (e) { }
    return 'нет';
  };

  const median = (arr) => {
    const a = arr.filter(v => v !== null).sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : null;
  };

  const measure = async (url, policy, tries) => {
    const times = [];
    let status = null, note = null, len = null;
    const n = tries || 3;
    for (let k = 0; k < n; k++) {
      const t = Date.now();
      try {
        const o = { timeout: 3000 };
        if (policy) o.policy = policy;
        const r = await ctx.http.get(url, o);
        times.push(Date.now() - t);
        status = r.status;
        if (len === null) { try { len = String(await r.text() || '').length; } catch (e) { len = -1; } }
      } catch (e) {
        note = String((e && e.message) || e).slice(0, 50);
        times.push(null);
        break;
      }
    }
    const ok = times.filter(v => v !== null).length;
    const res = { ok: ok + '/' + n, ms: median(times) };
    if (status !== null) res.st = status;
    if (len !== null) res.len = len;
    if (note) res.err = note;
    return res;
  };

  const sweep = async (list, policy, tries) => {
    const out = {};
    for (let i = 0; i < list.length; i++) out[list[i][0]] = await measure(list[i][1], policy, tries);
    return out;
  };

  const steps = [
    // M1: кандидаты в маяки, прямой выход. Главный шаг ревизии.
    ['M1_foreign_direct', async () => await sweep(FOREIGN, 'DIRECT')],
    // M2: российские, прямой выход — контроль живости интернета.
    ['M2_russian_direct', async () => await sweep(RUSSIAN, 'DIRECT', 2)],
    // M3: причина ошибок 400. Проверяются режимы редиректа и схема https.
    ['M3_redirect_cause', async () => {
      const cases = [
        ['ya_http_default', 'http://ya.ru', {}],
        ['ya_http_follow', 'http://ya.ru', { redirect: 'follow' }],
        ['ya_http_manual', 'http://ya.ru', { redirect: 'manual' }],
        ['ya_https', 'https://ya.ru', {}],
        ['mailru_http_manual', 'http://mail.ru', { redirect: 'manual' }],
        ['icanhaz_http_manual', 'http://ipv4.icanhazip.com', { redirect: 'manual' }],
        ['icanhaz_https', 'https://ipv4.icanhazip.com', {}]
      ];
      const out = {};
      for (let i = 0; i < cases.length; i++) {
        const o = Object.assign({ policy: 'DIRECT', timeout: 4000 }, cases[i][2]);
        try {
          const r = await ctx.http.get(cases[i][1], o);
          let loc = null;
          try { loc = r.headers && r.headers.get ? r.headers.get('location') : null; } catch (e) { }
          const res = { st: r.status };
          if (loc) res.location = String(loc).slice(0, 60);
          out[cases[i][0]] = res;
        } catch (e) { out[cases[i][0]] = 'err:' + String((e && e.message) || e).slice(0, 60); }
      }
      return out;
    }],
    // M4: те же маяки через российский узел — пригодятся, если понадобится
    // отличать «нет интернета» от «нет прокси».
    ['M4_foreign_via_node', async () => await sweep(FOREIGN, 'RH-Явный-1', 2)]
  ];

  let st = null;
  try { st = ctx.storage.getJSON(STATE); } catch (e) { }
  if (!st || st.rev !== REV || (env.RH_RESET && st.reset !== env.RH_RESET)) {
    st = { rev: REV, reset: env.RH_RESET || '', dead: {}, results: {}, runs: 0 };
  }
  if (!st.dead) st.dead = {};
  if (!st.results) st.results = {};

  if (st.inflight) {
    st.dead[st.inflight] = true;
    st.results[st.inflight] = 'РОНЯЕТ ПРОГОН — падение внутри прослойки Egern, try/catch не ловит; шаг исключён';
    st.inflight = null;
    try { ctx.storage.setJSON(STATE, st); } catch (e) { }
  }

  st.runs = (st.runs || 0) + 1;
  let did = 0, errCount = 0, left = 0;

  for (let i = 0; i < steps.length; i++) {
    const nm = steps[i][0];
    if (st.dead[nm]) continue;
    if (st.results[nm] !== undefined) continue;
    if (Date.now() - t0 > BUDGET) { left++; continue; }
    st.inflight = nm;
    try { ctx.storage.setJSON(STATE, st); } catch (e) { }
    try { st.results[nm] = await steps[i][1](); did++; }
    catch (e) { st.results[nm] = 'ошибка: ' + String((e && e.message) || e); errCount++; }
    st.inflight = null;
    try { ctx.storage.setJSON(STATE, st); } catch (e) { }
  }

  const done = Object.keys(st.results).length;
  const R = { rev: REV, run: st.runs, total: steps.length, done: done,
              did_now: did, errors: errCount, left: left,
              dead: Object.keys(st.dead), results: st.results,
              total_ms: Date.now() - t0, ts: new Date().toISOString() };

  notify(REV + ': прогон ' + st.runs,
         'Готово ' + done + ' из ' + steps.length +
         (left ? '. Не хватило времени на ' + left + ' — запусти ещё раз' : '. ПЕРЕБОР ЗАВЕРШЁН'));

  try {
    if (env.RH_POST_URL) {
      await ctx.http.post(env.RH_POST_URL, {
        body: R, headers: { 'Content-Type': 'application/json' }, timeout: 15000
      });
    }
  } catch (e) { }
  return { rh: REV, run: st.runs, done: done, left: left };
}
`;

// ХВОСТОВОЙ СТРАЖ — строка без перевода в конце файла; мусор после неё —