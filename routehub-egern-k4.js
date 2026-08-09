// routehub-egern-k4.js — диагностика Egern. K4_REV: k4-11 (2026-08-09).
//
// СХЕМА ИЗМЕНЕНА (по просьбе Дианы): все шаги идут ЗА ОДИН ПРОГОН подряд.
//   Каждый шаг обёрнут в try/catch — обычная ошибка пишется в отчёт, перебор
//   продолжается. Но падение ВНУТРИ прослойки Egern try/catch НЕ ловится и
//   убивает прогон целиком, поэтому дополнительно ведётся защита:
//     • перед шагом его имя пишется в state.inflight и сохраняется;
//     • после шага inflight очищается;
//     • если новый прогон видит непустой inflight — значит прошлый прогон
//       умер на этом шаге: он заносится в state.dead, в отчёт попадает
//       'РОНЯЕТ ПРОГОН', и дальше он ВСЕГДА пропускается.
//   Итог: смертельный шаг стоит одного лишнего запуска, а не одного запуска
//   на каждый шаг, как было в k4-8..k4-10.
//
// ЧТО ИЩЕМ В ЭТОЙ РЕВИЗИИ — обходные пути для того, что «не работает»:
//   X0 — СПЛОШНАЯ опись globalThis / Egern / __context / ctx. Прежние ревизии
//        перебирали глобалы ПО СПИСКУ ИЗВЕСТНЫХ ИМЁН (сорок штук) — так
//        неизвестное имя найти невозможно. Здесь описываются все.
//   X1 — policyDescriptor. Неизвестная политика даёт 404, а policyDescriptor
//        дал 400 ⇒ параметр РАСПОЗНАН, не понравилось значение. В Surge policy
//        descriptor — описание политики строкой целиком. Если так же здесь,
//        можно адресовать ЛЮБОЙ узел, не объявляя его в proxies.
//   X2 — пути Surge HTTP API на локальном сервере 13991, с заголовком X-Key
//        и без него (Surge без X-Key отказывает всему). Среди путей —
//        /v1/policy_groups/select (переключение политики) и
//        /v1/requests/recent (журнал трафика, наш K9).
//   X3 — пути Clash/mihomo на 13991 и соседние порты 13990, 13992..13995.
//        13991 нашли случайно из __context.baseUrl — управляющий может быть рядом.
//
// ИТОГИ ПРЕДЫДУЩИХ РЕВИЗИЙ (кратко):
//   k4-10: ws-транспорт разобран верно (wss); локальный сервер отдаёт только
//     /js и /js/, остальные наивные пути 404; годная замена тест-URL —
//     www.gstatic.com/generate_204 (cp.cloudflare.com отшивает часть выходных IP).
//   k4-9: поузловая адресация подтверждена третьим способом (четыре разных
//     выходных IP); выходные адреса узлов ПЛАВАЮТ.
//   k4-8: ctx.http с policy = имя узла из proxies адресует именно этот узел;
//     поузловой спидтест реализуем; sessionStorage не переживает прогон.
//   k4-7: $httpClient ИГНОРИРУЕТ node и policy; $httpClient.request РОНЯЕТ
//     прогон — НЕ ВЫЗЫВАТЬ; $httpAPI и $config отсутствуют; WebSocket работает.
//
// В ТЕКСТЕ СКРИПТА НЕЛЬЗЯ: обратные кавычки, ${...} и ЛЮБЫЕ обратные слэши.
// ФАЙЛ ЗАКАНЧИВАЕТСЯ СТРОЧНЫМ КОММЕНТАРИЕМ БЕЗ ПЕРЕВОДА СТРОКИ — защита от мусора.
// ТРАФИК: обходные узлы в этой ревизии НЕ задействованы вовсе.

export const K4_REV = 'k4-11';

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
  const STATE = 'rh_scan11';
  const REV = 'k4-11';
  const EX1 = 'RH-Явный-1';
  const GRP = env.RH_GROUP || 'RH-Пул-Обычные';

  const via = async (url, opt) => {
    try {
      const o = opt || {};
      if (!o.timeout) o.timeout = 8000;
      const r = await ctx.http.get(url, o);
      let body = '';
      try { body = String(await r.text() || '').slice(0, o.cut || 120); } catch (e) { body = 'нечитаемо'; }
      return { st: r.status, body: body };
    } catch (e) { return 'err:' + ((e && e.message) || e); }
  };

  const notify = (title, text) => {
    try {
      if (typeof ctx.notify === 'function') { ctx.notify({ title: title, body: text }); return; }
      if (typeof $notification !== 'undefined' && $notification && $notification.post) {
        $notification.post(title, '', text);
      }
    } catch (e) { }
  };

  // Опись имён объекта вместе с прототипом, с типами значений.
  const describe = (obj, limit) => {
    const out = {};
    let seen = 0;
    try {
      let cur = obj;
      const names = [];
      for (let depth = 0; depth < 3 && cur; depth++) {
        try { Object.getOwnPropertyNames(cur).forEach(n => { if (names.indexOf(n) < 0) names.push(n); }); }
        catch (e) { }
        cur = Object.getPrototypeOf(cur);
      }
      names.sort();
      for (let i = 0; i < names.length && seen < (limit || 200); i++) {
        const n = names[i];
        if (n === 'constructor') continue;
        let t = 'нет';
        try { t = typeof obj[n]; } catch (e) { t = 'недоступно'; }
        if (t === 'undefined') continue;
        out[n] = t;
        seen++;
      }
    } catch (e) { out.__error = String((e && e.message) || e); }
    return out;
  };

  const steps = [
    // X0: сплошная опись. Прежние ревизии искали ПО СПИСКУ — так неизвестное
    // имя не найти. Отсеиваем стандартные конструкторы (Заглавная + длина > 3)
    // и обработчики событий (on*), остальное показываем целиком.
    ['X0_scan_full', async () => {
      const all = [];
      try { Object.getOwnPropertyNames(globalThis).forEach(n => all.push(n)); } catch (e) { }
      const interesting = [];
      for (let i = 0; i < all.length; i++) {
        const n = all[i];
        const c = n.charAt(0);
        const isUpper = (c >= 'A' && c <= 'Z');
        if (isUpper && n.length > 3) continue;
        if (n.indexOf('on') === 0 && n.length > 4) continue;
        interesting.push(n);
      }
      const lower = all.filter(n => n.toLowerCase().indexOf('gern') >= 0 ||
                                    n.toLowerCase().indexOf('surge') >= 0 ||
                                    n.toLowerCase().indexOf('policy') >= 0 ||
                                    n.toLowerCase().indexOf('proxy') >= 0 ||
                                    n.toLowerCase().indexOf('config') >= 0);
      return {
        total: all.length,
        interesting: interesting.join(','),
        by_keyword: lower.join(','),
        ctx_keys: describe(ctx, 80),
        egern_keys: (typeof Egern !== 'undefined') ? describe(Egern, 60) : 'нет Egern',
        context_keys: (typeof __context !== 'undefined') ? describe(__context, 60) : 'нет __context'
      };
    }],

    // X1: policyDescriptor. 400 против 404 у неизвестной политики означает,
    // что параметр разбирается. Перебираем шесть форм записи.
    ['X1_policy_descriptor', async () => {
      const U = 'http://www.gstatic.com/generate_204';
      const one = async (label, d) => {
        try {
          const r = await ctx.http.get(U, { policyDescriptor: d, timeout: 8000 });
          return { st: r.status };
        } catch (e) { return 'err:' + ((e && e.message) || e); }
      };
      return {
        as_group: await one('группа', GRP),
        as_direct: await one('DIRECT', 'DIRECT'),
        as_explicit: await one('явный узел', EX1),
        as_surge_line: await one('строка Surge', 'select, ' + GRP),
        as_yaml: await one('YAML', 'select:' + String.fromCharCode(10) + '  name: X' + String.fromCharCode(10) + '  policies: [' + GRP + ']'),
        as_json: await one('JSON', JSON.stringify({ select: { name: 'X', policies: [GRP] } }))
      };
    }],

    // X2: пути Surge HTTP API на локальном сервере. Surge требует X-Key,
    // поэтому каждый путь пробуется дважды. Локальные запросы обязательно
    // через DIRECT — иначе уходят в туннель и дают 400.
    ['X2_surge_api', async () => {
      const paths = ['/v1/policies', '/v1/policy_groups', '/v1/policy_groups/select',
                     '/v1/requests/recent', '/v1/requests/active', '/v1/profiles',
                     '/v1/profiles/current', '/v1/scripting', '/v1/modules',
                     '/v1/rules', '/v1/traffic', '/v1/events', '/v1/dns',
                     '/v1/outbound', '/v1/devices', '/v1/features/mitm'];
      const out = {};
      for (let i = 0; i < paths.length; i++) {
        const u = 'http://127.0.0.1:13991' + paths[i];
        const plain = await via(u, { policy: 'DIRECT', timeout: 1000, cut: 100 });
        const st = (plain && plain.st) ? plain.st : null;
        // Со вторым запросом возимся только там, где путь не 404.
        if (st && st !== 404) {
          const keyed = await via(u, { policy: 'DIRECT', timeout: 1000, cut: 100,
                                       headers: { 'X-Key': env.RH_APIKEY || 'egern' } });
          out[paths[i]] = { plain: plain, with_key: keyed };
        } else {
          out[paths[i]] = plain;
        }
      }
      return out;
    }],

    // X3: пути Clash/mihomo и соседние порты. 13991 найден случайно —
    // управляющий порт может стоять рядом.
    ['X3_clash_and_ports', async () => {
      const clash = ['/proxies', '/configs', '/connections', '/traffic', '/logs', '/rules', '/version'];
      const out = { clash_on_13991: {}, neighbour_ports: {} };
      for (let i = 0; i < clash.length; i++) {
        out.clash_on_13991[clash[i]] = await via('http://127.0.0.1:13991' + clash[i],
                                                 { policy: 'DIRECT', timeout: 1000, cut: 100 });
      }
      const ports = [13990, 13992, 13993, 13994, 13995];
      for (let i = 0; i < ports.length; i++) {
        out.neighbour_ports[ports[i]] = await via('http://127.0.0.1:' + ports[i] + '/',
                                                  { policy: 'DIRECT', timeout: 1000, cut: 100 });
      }
      return out;
    }]
  ];

  // ---- состояние: dead — шаги, убившие прогон; они пропускаются навсегда ----
  let st = null;
  try { st = ctx.storage.getJSON(STATE); } catch (e) { }
  if (!st || st.rev !== REV || (env.RH_RESET && st.reset !== env.RH_RESET)) {
    st = { rev: REV, reset: env.RH_RESET || '', dead: {}, results: {}, runs: 0 };
  }
  if (!st.dead) st.dead = {};
  if (!st.results) st.results = {};

  // Прошлый прогон умер на этом шаге — заносим в чёрный список.
  if (st.inflight) {
    st.dead[st.inflight] = true;
    st.results[st.inflight] = 'РОНЯЕТ ПРОГОН — падение внутри прослойки Egern, try/catch не ловит; шаг исключён';
    st.inflight = null;
    try { ctx.storage.setJSON(STATE, st); } catch (e) { }
  }

  st.runs = (st.runs || 0) + 1;
  let okCount = 0, errCount = 0, skipCount = 0;

  for (let i = 0; i < steps.length; i++) {
    const nm = steps[i][0];
    if (st.dead[nm]) { skipCount++; continue; }
    st.inflight = nm;
    try { ctx.storage.setJSON(STATE, st); } catch (e) { }
    try {
      st.results[nm] = await steps[i][1]();
      okCount++;
    } catch (e) {
      st.results[nm] = 'ошибка: ' + String((e && e.message) || e);
      errCount++;
    }
    st.inflight = null;
    try { ctx.storage.setJSON(STATE, st); } catch (e) { }
  }

  const deadNames = Object.keys(st.dead);
  const R = { rev: REV, run: st.runs, total: steps.length,
              ok: okCount, errors: errCount, skipped: deadNames,
              results: st.results, total_ms: Date.now() - t0,
              ts: new Date().toISOString() };

  notify(REV + ': прогон ' + st.runs + ' завершён',
         'Шагов пройдено ' + okCount + ' из ' + steps.length +
         (errCount ? ', с ошибкой ' + errCount : '') +
         (deadNames.length ? ', исключено ' + deadNames.length + ' (роняли прогон)' : '') +
         '. Отчёт отправлен.');

  try {
    if (env.RH_POST_URL) {
      await ctx.http.post(env.RH_POST_URL, {
        body: R, headers: { 'Content-Type': 'application/json' }, timeout: 15000
      });
    }
  } catch (e) { }
  return { rh: REV, run: st.runs, ok: okCount, errors: errCount, skipped: deadNames.length };
}
`;

// ХВОСТОВОЙ СТРАЖ — строка без перевода в конце файла; мусор после неё —