// routehub-egern-k4.js — диагностика Egern. K4_REV: k4-12 (2026-08-09).
//
// СХЕМА (введена в k4-11, оправдала себя): все шаги за ОДИН прогон подряд.
//   Обычная ошибка шага пишется в отчёт, перебор продолжается. Падение внутри
//   прослойки Egern try/catch не ловит и убивает прогон — на этот случай имя
//   выполняемого шага лежит в state.inflight; следующий прогон видит его,
//   заносит шаг в state.dead, пишет 'РОНЯЕТ ПРОГОН' и навсегда пропускает.
//   Смертельный шаг стоит ОДНОГО лишнего запуска, а не запуска на каждый шаг.
//   Поэтому в ревизию складывается сразу весь остаток проверок.
//
// ИТОГИ k4-11 (2026-08-09) — две ветки поиска закрыты, одна открылась:
//   • СПЛОШНАЯ опись globalThis: 959 имён, нестандартных ровно девять —
//     $httpClient, $persistentStore, $utils, $network, $script, $notification,
//     $environment, $done, $cronexp (плюс __context и _tickTimers). Поиск по
//     словам policy/proxy/config/surge/egern дал только сам Egern и штатный
//     JS-Proxy. Опись ctx совпала с документацией дословно.
//     ⇒ УПРАВЛЕНИЕ ПОЛИТИКАМИ ИЗ СКРИПТА НЕВОЗМОЖНО — доказано, а не
//     «по имеющимся сведениям». Ветка закрыта.
//   • policyDescriptor: все шесть форматов дали 400. Гипотеза «400 против 404
//     значит параметр распознан» ОПРОВЕРГНУТА: 400 приходит и на локальный
//     запрос без DIRECT, и на узел с неудобным для Cloudflare выходом ⇒ это
//     универсальная ошибка «не смог выполнить». Ветка закрыта.
//   • Пути Surge HTTP API (16 штук) и Clash (7 штук) на 13991 — все 404.
//   • НАХОДКА: соседние порты. 13990 и 13995 — ошибка соединения, а
//     13992, 13993, 13994 ОТВЕЧАЮТ 404, то есть слушают. Нигде не описаны.
//     Их разбор — шаг Y1 этой ревизии.
//
// ЧТО ПРОВЕРЯЕТ k4-12 (весь оставшийся запас гипотез разом):
//   Y1 — 14 путей на портах 13991..13994 + заголовки ответа (по Server и
//        WWW-Authenticate видно, что за сервер и нужен ли ключ).
//   Y2 — методы POST/PUT/DELETE: вдруг чтение закрыто, а запись открыта.
//   Y3 — Egern.arguments, единственное неописанное поле объекта Egern.
//   Y4 — ctx.ssh.connect к заведомо мёртвому адресу: жив ли механизм и как падает.
//   Y5 — по три замера 256 КБ на каждый явный узел: медиана вместо шумного
//        одиночного замера (на k4-8/k4-9 один узел дал 2,8 и 7,4 Мбит/с).
//   Y6 — ctx.notify с действием по тапу на egern:/policy_groups/new с именем
//        СУЩЕСТВУЮЩЕЙ группы: перезаписывает схема группу или создаёт дубль.
//        Тап делает Диана; результат виден в приложении, не в отчёте.
//   Y7 — опись ctx.ssh / ctx.http / ctx.storage / ctx.compress / ctx.device
//        по прототипам: нет ли методов сверх документации.
//
// В ТЕКСТЕ СКРИПТА НЕЛЬЗЯ: обратные кавычки, ${...} и ЛЮБЫЕ обратные слэши.
// ФАЙЛ ЗАКАНЧИВАЕТСЯ СТРОЧНЫМ КОММЕНТАРИЕМ БЕЗ ПЕРЕВОДА СТРОКИ — защита от мусора.
// ТРАФИК: обходные узлы не задействованы; обычных уходит ~2,3 МБ на шаг Y5.

export const K4_REV = 'k4-12';

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
  const STATE = 'rh_scan12';
  const REV = 'k4-12';
  const EX = ['RH-Явный-1', 'RH-Явный-2', 'RH-Явный-3'];
  const GRP = env.RH_GROUP || 'RH-Пул-Обычные';

  const notify = (title, text, action) => {
    try {
      if (typeof ctx.notify === 'function') {
        const o = { title: title, body: text };
        if (action) o.action = action;
        ctx.notify(o);
        return 'ctx.notify';
      }
      if (typeof $notification !== 'undefined' && $notification && $notification.post) {
        $notification.post(title, '', text);
        return 'surge';
      }
      return 'нет уведомлений';
    } catch (e) { return 'ошибка: ' + ((e && e.message) || e); }
  };

  // Локальная проба с чтением заголовков ответа: Server и WWW-Authenticate
  // показывают, что за сервер отвечает и требует ли ключа.
  const local = async (url, method) => {
    try {
      const o = { policy: 'DIRECT', timeout: 700 };
      const fn = method === 'POST' ? ctx.http.post
               : method === 'PUT' ? ctx.http.put
               : method === 'DELETE' ? ctx.http.delete
               : ctx.http.get;
      if (method === 'POST' || method === 'PUT') o.body = '{}';
      const r = await fn.call(ctx.http, url, o);
      const h = {};
      try {
        ['server', 'www-authenticate', 'content-type', 'allow'].forEach(k => {
          const v = r.headers && r.headers.get ? r.headers.get(k) : null;
          if (v) h[k] = String(v).slice(0, 60);
        });
      } catch (e) { }
      let body = '';
      try { body = String(await r.text() || '').slice(0, 120); } catch (e) { }
      const res = { st: r.status };
      if (body) res.body = body;
      if (Object.keys(h).length) res.head = h;
      return res;
    } catch (e) { return 'err:' + ((e && e.message) || e); }
  };

  const describe = (obj, limit) => {
    const out = {};
    let seen = 0;
    try {
      let cur = obj;
      const names = [];
      for (let d = 0; d < 3 && cur; d++) {
        try { Object.getOwnPropertyNames(cur).forEach(n => { if (names.indexOf(n) < 0) names.push(n); }); }
        catch (e) { }
        cur = Object.getPrototypeOf(cur);
      }
      names.sort();
      for (let i = 0; i < names.length && seen < (limit || 60); i++) {
        const n = names[i];
        if (n === 'constructor' || n.indexOf('__') === 0) continue;
        if (['hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
             'toLocaleString', 'toString', 'valueOf'].indexOf(n) >= 0) continue;
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
    // Y1: три отвечающих порта, найденных на k4-11, плюс известный 13991.
    ['Y1_ports_paths', async () => {
      const ports = [13991, 13992, 13993, 13994];
      const paths = ['/', '/v1', '/api', '/js', '/status', '/version', '/health',
                     '/ws', '/events', '/log', '/policies', '/proxies',
                     '/connections', '/dashboard'];
      const out = {};
      for (let p = 0; p < ports.length; p++) {
        const port = ports[p];
        const bucket = {};
        for (let i = 0; i < paths.length; i++) {
          const r = await local('http://127.0.0.1:' + port + paths[i]);
          // 404 без тела и заголовков сжимаем до числа, чтобы отчёт не распух.
          if (r && r.st === 404 && !r.body && !r.head) bucket[paths[i]] = 404;
          else bucket[paths[i]] = r;
        }
        out[port] = bucket;
      }
      return out;
    }],

    // Y2: вдруг чтение закрыто, а запись открыта.
    ['Y2_methods', async () => ({
      post_13991: await local('http://127.0.0.1:13991/', 'POST'),
      put_13991: await local('http://127.0.0.1:13991/', 'PUT'),
      delete_13991: await local('http://127.0.0.1:13991/', 'DELETE'),
      post_13992: await local('http://127.0.0.1:13992/', 'POST'),
      post_13992_v1: await local('http://127.0.0.1:13992/v1', 'POST')
    })],

    // Y3: единственное неописанное поле объекта Egern.
    ['Y3_egern_arguments', async () => {
      const out = {};
      try {
        if (typeof Egern === 'undefined') return 'нет Egern';
        out.type = typeof Egern.arguments;
        try { out.json = JSON.stringify(Egern.arguments).slice(0, 400); }
        catch (e) { out.json = 'не сериализуется: ' + ((e && e.message) || e); }
        out.keys = Egern.arguments ? describe(Egern.arguments, 40) : 'пусто';
      } catch (e) { out.error = String((e && e.message) || e); }
      return out;
    }],

    // Y4: жив ли SSH-механизм. Адрес заведомо мёртвый — интересен вид отказа.
    ['Y4_ssh_alive', async () => {
      const out = { ssh_type: typeof ctx.ssh };
      if (!ctx.ssh || typeof ctx.ssh.connect !== 'function') { out.connect = 'нет метода'; return out; }
      try {
        const s = await ctx.ssh.connect({ host: '192.0.2.1', port: 22,
                                          username: 'nobody', password: 'x', timeout: 3000 });
        out.connected = typeof s;
        try { await s.close(); } catch (e) { }
      } catch (e) { out.error = String((e && e.message) || e).slice(0, 200); }
      return out;
    }],

    // Y5: медиана вместо одиночного замера — на прошлых ревизиях один и тот же
    // узел дал 2,8 и 7,4 Мбит/с.
    ['Y5_speed_median', async () => {
      const one = async (policy) => {
        const t = Date.now();
        try {
          const r = await ctx.http.get('https://speed.cloudflare.com/__down?bytes=262144',
                                       { policy: policy, timeout: 30000 });
          const b = await r.arrayBuffer();
          const ms = Math.max(1, Date.now() - t);
          return Math.round(b.byteLength * 8 / ms / 100) / 10;
        } catch (e) { return null; }
      };
      const out = {};
      for (let i = 0; i < EX.length; i++) {
        const runs = [];
        for (let k = 0; k < 3; k++) runs.push(await one(EX[i]));
        const good = runs.filter(v => v !== null).sort((a, b) => a - b);
        out[EX[i]] = { runs: runs, median: good.length ? good[Math.floor(good.length / 2)] : null };
      }
      return out;
    }],

    // Y6: перезапишет ли URL-схема существующую группу или создаст дубль.
    // Ссылка уходит в уведомление, тап делает Диана; итог виден в приложении.
    ['Y6_urlscheme_notify', async () => {
      const url = 'egern:/policy_groups/new?name=' + encodeURIComponent(GRP) +
                  '&type=select&policy=' + encodeURIComponent(EX[0]);
      const r = notify('k4-12: проверка URL-схемы',
                       'Нажми это уведомление. Проверяем, перезапишет ли схема группу ' +
                       GRP + ' или создаст вторую с тем же именем. После нажатия посмотри список групп.',
                       { type: 'openUrl', url: url });
      return { url: url, notify: r };
    }],

    // Y7: нет ли у объектов ctx методов сверх документации.
    ['Y7_ctx_objects', async () => ({
      ssh: describe(ctx.ssh, 30),
      http: describe(ctx.http, 30),
      storage: describe(ctx.storage, 30),
      compress: describe(ctx.compress, 30),
      device: describe(ctx.device, 30),
      app: describe(ctx.app, 30),
      script: describe(ctx.script, 30)
    })]
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
  let okCount = 0, errCount = 0;

  for (let i = 0; i < steps.length; i++) {
    const nm = steps[i][0];
    if (st.dead[nm]) continue;
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
         'Пройдено ' + okCount + ' из ' + steps.length +
         (errCount ? ', с ошибкой ' + errCount : '') +
         (deadNames.length ? ', исключено ' + deadNames.length : '') + '. Отчёт отправлен.');

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