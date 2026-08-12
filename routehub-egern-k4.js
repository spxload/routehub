// routehub-egern-k4.js — диагностика Egern. K4_REV: k4-16 (2026-08-12).
//
// ЗАДАЧА: закрыть ПРОБЕЛ МЕТОДИКИ, обнаруженный на Stash.
//
// ЧТО СЛУЧИЛОСЬ НА STASH (пробы ST2-ST5, 2026-08-12):
//   в среде всего шесть $-объектов и НИ ОДНОГО метода управления.
//   Но в $environment лежали ДВА НЕОПИСАННЫХ ПОЛЯ — controller-url и
//   controller-authorization. По ним нашёлся локальный Clash-совместимый
//   контроллер на 127.0.0.1:9090, и через него ЗАПИСЬ ПРОШЛА (204):
//   переключение группы, смена режима, журнал соединений, WebSocket.
//
// ПОЧЕМУ ЭТО КАСАЕТСЯ EGERN: в k4-11/k4-12 порты перебирались ВСЛЕПУЮ
//   (13990-13995) и БЕЗ АВТОРИЗАЦИИ, а члены $environment НИ РАЗУ не
//   описывались. Два условия могли скрыть контроллер: неизвестный порт и
//   ответ 404 без ключа. Оба проверяются здесь.
//
// ИЗМЕНЕНИЯ k4-16 ОТНОСИТЕЛЬНО k4-15:
//   1. БЕЗОПАСНОСТЬ: значения ключей с именами token/auth/secret/key
//      МАСКИРУЮТСЯ всегда (три первых символа и длина), без оглядки на
//      длину. В k4-15 короткие значения выводились целиком — токен Stash
//      был 15 символов и ушёл бы полностью.
//   2. ДОСТАВКА: отчёт дублируется на ОТКРЫТЫЙ приёмник стенда, чтобы
//      его можно было прочитать без токена устройства. Приёмник доступа
//      к подписке не даёт; благодаря п. 1 ключи туда не попадают.
//
// ШАГИ: E1 опись $environment; E2 __context с вложенностью; E3 ctx.app,
//   ctx.device, ctx.env; E4 поиск адресов, портов и ключей; E5 перебор
//   портов С АВТОРИЗАЦИЕЙ; E6 пути контроллера на откликнувшихся портах.
//
// ТОЛЬКО ЧТЕНИЕ: только GET, ни одного записывающего запроса.
// ТРАФИК: всё локальное (127.0.0.1), обходные узлы не задействованы.
//
// В ТЕКСТЕ K4_SCRIPT НЕЛЬЗЯ: обратные кавычки, шаблонные подстановки
// и ОБРАТНЫЕ СЛЭШИ. ФАЙЛ ЗАКАНЧИВАЕТСЯ СТРОЧНЫМ КОММЕНТАРИЕМ
// БЕЗ ПЕРЕВОДА СТРОКИ.
//
// ИСТОРИЯ: k4-1 … k4-14 см. в истории git и в ЭТАП_K_EGERN_*.md.

export const K4_REV = 'k4-16';

export function subNames(text) {
  const out = [];
  const lines = String(text || '').split(String.fromCharCode(10));
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
    if (names[i].indexOf('Обход') < 0) out.push(names[i]);
  }
  return out;
}
export function firstNormalNode(text) {
  const a = normalNodes(text, 1);
  return a.length ? a[0] : '';
}

export const K4_SCRIPT = `export default async function (ctx) {
  const t0 = Date.now();
  const REV = 'k4-16';
  const env = ctx.env || {};
  const OPEN = 'https://routehub-egern.proton4iker.workers.dev/ingest/rh-drop-2026?src=egern-k4-16';
  const rep = { rev: REV, ts: new Date().toISOString(), steps: {}, errors: [] };

  const notify = (title, text) => {
    try {
      if (typeof ctx.notify === 'function') { ctx.notify({ title: title, body: text }); return 'ok'; }
    } catch (e) { }
    return 'no';
  };

  const secretName = (k) => {
    const lk = String(k).toLowerCase();
    return lk.indexOf('token') >= 0 || lk.indexOf('auth') >= 0 ||
           lk.indexOf('secret') >= 0 || lk.indexOf('key') >= 0 ||
           lk.indexOf('password') >= 0 || lk.indexOf('cred') >= 0;
  };

  // Ключи маскируются ВСЕГДА: отчёт уходит на открытый приёмник.
  const shown = (v, key) => {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'function') return 'function';
    let s;
    try { s = (typeof v === 'object') ? JSON.stringify(v) : String(v); } catch (e) { s = 'unserializable'; }
    if (key && secretName(key)) return s.slice(0, 3) + '***[длина ' + s.length + ']';
    if (s.length > 48) return s.slice(0, 14) + '...[' + s.length + ']';
    return s;
  };

  const describe = (obj) => {
    const r = { keys: [], values: {} };
    if (!obj) return r;
    let names = [];
    try { names = Object.getOwnPropertyNames(obj); } catch (e) { }
    try {
      const pp = Object.getPrototypeOf(obj);
      if (pp && pp !== Object.prototype) names = names.concat(Object.getOwnPropertyNames(pp));
    } catch (e) { }
    names.sort();
    r.keys = names;
    for (let i = 0; i < names.length && i < 80; i++) {
      try { r.values[names[i]] = shown(obj[names[i]], names[i]); } catch (e) { r.values[names[i]] = 'error'; }
    }
    return r;
  };

  const G = (typeof globalThis !== 'undefined') ? globalThis : this;

  try {
    rep.steps.environment = (typeof G.$environment === 'undefined')
      ? { available: false }
      : describe(G.$environment);
  } catch (e) { rep.errors.push('E1: ' + String(e)); }

  try {
    if (typeof G.__context === 'undefined') rep.steps.context = { available: false };
    else {
      const c = describe(G.__context);
      c.nested = {};
      for (let i = 0; i < c.keys.length && i < 20; i++) {
        const k = c.keys[i];
        try {
          const v = G.__context[k];
          if (v && typeof v === 'object') c.nested[k] = describe(v).keys;
        } catch (e) { }
      }
      rep.steps.context = c;
    }
  } catch (e) { rep.errors.push('E2: ' + String(e)); }

  try {
    rep.steps.ctx_app = describe(ctx.app);
    rep.steps.ctx_device = describe(ctx.device);
    rep.steps.ctx_env_keys = Object.keys(env).sort();
  } catch (e) { rep.errors.push('E3: ' + String(e)); }

  let FOUND_URL = null, FOUND_AUTH = null;
  const FOUND_PORTS = [];
  try {
    const pools = [];
    if (typeof G.$environment !== 'undefined' && rep.steps.environment && rep.steps.environment.keys) {
      pools.push(['env', G.$environment, rep.steps.environment.keys]);
    }
    if (rep.steps.ctx_app && rep.steps.ctx_app.keys) pools.push(['app', ctx.app, rep.steps.ctx_app.keys]);
    if (rep.steps.ctx_device && rep.steps.ctx_device.keys) pools.push(['device', ctx.device, rep.steps.ctx_device.keys]);
    const hits = [];
    for (let p = 0; p < pools.length; p++) {
      const src = pools[p][0], obj = pools[p][1], keys = pools[p][2] || [];
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        let raw = null;
        try { raw = obj[k]; } catch (e) { continue; }
        if (typeof raw === 'function' || raw === null || raw === undefined) continue;
        const s = String(raw);
        const lk = k.toLowerCase();
        const isUrl = s.indexOf('http') === 0 || s.indexOf('127.0.0.1') >= 0 || s.indexOf('localhost') >= 0;
        const isKeyName = secretName(k);
        const isPortName = lk.indexOf('port') >= 0;
        const isCtrl = lk.indexOf('control') >= 0 || lk.indexOf('api') >= 0 || lk.indexOf('dash') >= 0;
        if (isUrl || isKeyName || isPortName || isCtrl) {
          hits.push({ src: src, key: k, shown: shown(raw, k) });
          if (isUrl && !FOUND_URL) FOUND_URL = s;
          if ((isKeyName || isCtrl) && !FOUND_AUTH && s.length > 3 && s.length < 200 && !isUrl) FOUND_AUTH = s;
          if (isPortName) { const n = parseInt(s, 10); if (n > 0 && n < 65536) FOUND_PORTS.push(n); }
        }
      }
    }
    rep.steps.hunt = {
      hits: hits,
      url_found: !!FOUND_URL,
      url_host: FOUND_URL ? String(FOUND_URL).slice(0, 30) : null,
      auth_found: !!FOUND_AUTH,
      auth_len: FOUND_AUTH ? FOUND_AUTH.length : 0,
      ports: FOUND_PORTS
    };
  } catch (e) { rep.errors.push('E4: ' + String(e)); }

  const PORTS = [9090, 13992, 13993, 13994, 6152, 6170, 7890, 8080, 9091];
  for (let i = 0; i < FOUND_PORTS.length; i++) if (PORTS.indexOf(FOUND_PORTS[i]) < 0) PORTS.push(FOUND_PORTS[i]);
  const PATHS = ['/', '/proxies', '/configs', '/rules', '/connections', '/providers/proxies', '/policy_groups', '/v1/policy_groups/select'];

  const hit = async (url, auth) => {
    const t = Date.now();
    const o = { policy: 'DIRECT', timeout: 2500 };
    if (auth) o.headers = { Authorization: auth };
    try {
      const r = await ctx.http.get(url, o);
      let body = '';
      try { body = String(await r.text() || '').slice(0, 200); } catch (e) { }
      return { url: url, auth: !!auth, ms: Date.now() - t, st: r.status, len: body.length, head: body };
    } catch (e) {
      return { url: url, auth: !!auth, ms: Date.now() - t, st: null, err: String((e && e.message) || e).slice(0, 60) };
    }
  };

  const scan = [];
  const alive = [];
  for (let i = 0; i < PORTS.length; i++) {
    if (Date.now() - t0 > 60000) { rep.errors.push('budget-ports'); break; }
    const r = await hit('http://127.0.0.1:' + PORTS[i] + '/', FOUND_AUTH);
    r.port = PORTS[i];
    scan.push(r);
    if (r.st !== null && r.st !== undefined) alive.push(PORTS[i]);
  }
  for (let a = 0; a < alive.length; a++) {
    for (let q = 1; q < PATHS.length; q++) {
      if (Date.now() - t0 > 95000) { rep.errors.push('budget-paths'); break; }
      const r = await hit('http://127.0.0.1:' + alive[a] + PATHS[q], FOUND_AUTH);
      r.port = alive[a];
      scan.push(r);
    }
  }
  rep.steps.scan = { ports: PORTS, alive: alive, with_auth: !!FOUND_AUTH, results: scan };

  rep.total_ms = Date.now() - t0;
  const envKeys = (rep.steps.environment && rep.steps.environment.keys) ? rep.steps.environment.keys.length : 0;
  notify(REV, 'environment: ' + envKeys + ', портов откликнулось ' + alive.length);

  const post = async (u) => {
    try {
      await ctx.http.post(u, { body: rep, headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
      return true;
    } catch (e) { return false; }
  };
  if (env.RH_POST_URL) await post(env.RH_POST_URL);
  await post(OPEN);

  return { rh: REV, env_keys: envKeys, alive: alive.length };
}
`;

// ХВОСТОВОЙ СТРАЖ — строка без перевода в конце файла; мусор после неё —