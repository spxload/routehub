// Общий подставной контроллер Stash для тестов проб (идея 3.1).
//
// ЗАЧЕМ. Модели контроллера в тестах ST18–ST20 писались заново под каждую
// пробу: свой $httpClient, свои часы, свой vm-песочник, свой settle. Здесь —
// одна модель с поведением, установленным пробами на устройстве (Stash 3.4.1,
// CHANGELOG ST18–ST20); расхождения моделей прежних тестов — опциями.
//
// ПО УМОЛЧАНИЮ (как на устройстве):
// - адрес с не-ASCII символами (кириллица без encodeURIComponent) — 400;
// - неизвестная группа — 404 {"message":"Resource not found"};
// - PUT несуществующего члена — 400 «Selector update error: proxy not exist»,
//   выбор не сбит (ST18);
// - PUT в Fallback и URLTest закрепляет: `now` → цель (ST18, ST19); поля
//   `fixed` в ответе нет (ST18) — включается опцией fixedField;
// - PUT в LoadBalance — 400 «must be one of Selector / URLTest / Fallback»;
// - DELETE /proxies/{группа} — 405, закрепление не снимает (ST18);
// - timeout запроса пишется в журнал КАК ЕСТЬ: у Stash он в секундах, и тест
//   пробы обязан ловить миллисекунды (ловушка проекта);
// - PUT узла со словом «Обход» в имени — 400 и запись в w.bypass: модели не
//   выбирают обходные узлы (правило 1), тест пробы проверяет w.bypass пустым.
//
// Часы подставные: каждый ответ сдвигает w.clock.t на w.step мс (30).

import assert from 'node:assert/strict';
import vm from 'node:vm';

export const T0 = 1_800_000_000_000;
export const SECRET = 'Bearer ОЧЕНЬ-СЕКРЕТНО';
export const BYPASS_WORD = 'Обход';
export const MSG = {
  noGroup: '{"message":"Resource not found"}',
  notExist: '{"message":"Selector update error: proxy not exist"}',
  selectorOnly: '{"message":"must be one of Selector / URLTest / Fallback"}',
  bypass: '{"message":"fake-stash: обходной узел в тесте"}',
};
const BUILTIN = { DIRECT: 'Direct', REJECT: 'Reject' };

function dec(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

// Опции createStash (всё необязательно; поля w можно менять и после создания):
//   groups      — { имя: { type, now, all, fixed? } }, type: Selector | Fallback |
//                 URLTest | LoadBalance | прочее (узел, GET/PUT — как группа без all);
//   step        — сдвиг часов на ответ, мс; hang — не отвечать вовсе;
//   eof         — столько первых запросов получают EOF; eofStep — тратит ли
//                 такой EOF время ответа (по умолчанию да, как обрыв по тайм-ауту);
//   eofWhen(method, путь, w)   — EOF по предикату (всегда тратит время);
//   fail(method, путь, w, o)   — true → 500 'oops', число → этот код,
//                 { status, body } — как задано; путь раскодирован, с ?запросом;
//   late(call, w), lateMs      — первый подошедший запрос ответит через lateMs
//                 настоящих мс (250), индекс — w.lateIdx;
//   onRequest(call, w)         — перед разбором (модель ядра: проверки по часам);
//   route(method, путь, o, reply, w) — свои маршруты; true/не undefined — обработан;
//   nowOf(имя, grp, w)         — вычисляемый `now` (модели закрепления);
//   entry(имя, grp, w)         — тело GET /proxies/{имя};
//   fallback    — 'pin' (закрепляет, по умолчанию) | 'reject' (400) |
//                 'ignore' (204, ничего) | 'pinOnly' (204, только fixed);
//   urltest     — 'pin' (по умолчанию) | 'reject';
//   del         — '405' (Stash) | 'unfix' (mihomo: Fallback 204 и снятие,
//                 прочие 404) | '404';
//   fixedField  — отдавать поле fixed в GET;
//   builtins    — DIRECT/REJECT известны контроллеру (по умолчанию да);
//   putReject(имя, want, w)    — true/строка-тело → 400 до прочих проверок;
//   onUnknown(имя, want, w)    — побочный эффект PUT несуществующего члена;
//   noMove(имя, w)             — 204 без смены выбора;
//   msg         — замена текстов MSG;
//   connections — массив для GET /connections.
export function createStash(o = {}) {
  const g = o.groups || {};
  const msg = { ...MSG, ...(o.msg || {}) };
  const w = {
    g, T0, clock: { t: T0 }, calls: [], store: {}, notes: [], bypass: [], wrote: {}, puts: {},
    step: o.step || 30, hang: !!o.hang, eofLeft: o.eof || 0, eofWhen: o.eofWhen || null,
    fail: o.fail || null, late: o.late || null, lateIdx: -1,
  };
  const known = (n) => g[n] || (o.builtins !== false && BUILTIN[n] ? { type: BUILTIN[n] } : null);
  w.nowOf = (n) => {
    const x = g[n];
    if (o.nowOf) return o.nowOf(n, x, w);
    if (x.now !== undefined) return x.now;
    return (x.all || []).find((m) => m.indexOf(BYPASS_WORD) < 0);
  };
  function entry(n) {
    const x = known(n);
    if (o.entry && g[n]) return o.entry(n, x, w);
    const e = { name: n, type: x.type };
    if (x.all) { e.now = w.nowOf(n); e.all = x.all; }
    if (o.fixedField && 'fixed' in x) e.fixed = x.fixed;
    return e;
  }
  w.entry = entry;

  w.handle = (method, opt, cb) => {
    const url = String(opt.url || '');
    const p = url.replace(/^[a-z]+:\/\/[^/]*/i, '');
    const m = p.match(/^\/proxies\/([^/?]+)(\/delay)?/);
    const call = { method, url, p, name: m ? dec(m[1]) : null, auth: opt.headers && opt.headers.Authorization,
      body: opt.body || null, timeout: opt.timeout, t: w.clock.t, end: null };
    w.calls.push(call);
    if (w.hang) return;
    let delay = 1;
    if (w.late && !w.lateUsed && w.late(call, w)) { w.lateUsed = true; w.lateIdx = w.calls.length - 1; delay = o.lateMs || 250; }
    const reply = (st, body) => setTimeout(() => {
      w.clock.t += w.step; call.end = w.clock.t; cb(null, { status: st, headers: {} }, body);
    }, delay);
    const eof = (spend) => setTimeout(() => {
      if (spend) w.clock.t += w.step;
      call.end = w.clock.t; cb('Get "' + url + '": EOF', null, null);
    }, delay);
    if (o.onRequest) o.onRequest(call, w);
    const dp = dec(p);
    if (w.eofLeft > 0) { w.eofLeft--; return eof(o.eofStep !== false); }
    if (w.eofWhen && w.eofWhen(method, dp, w)) return eof(true);
    if (/[^\x00-\x7F]/.test(url)) return reply(400, '{"message":"bad path"}');
    const f = w.fail && w.fail(method, dp, w, opt);
    if (f) {
      if (f === true) return reply(500, 'oops');
      if (typeof f === 'number') return reply(f, '{"message":"error"}');
      return reply(f.status, f.body);
    }
    if (o.route) { const r = o.route(method, p, opt, reply, w); if (r !== undefined && r !== false) return; }
    if (m) return proxy(method, call.name, !!m[2], opt, reply);
    if (p === '/' && method === 'get') return reply(200, '{"hello":"stash"}');
    if (p === '/proxies' && method === 'get') {
      const px = {};
      for (const n of Object.keys(g)) px[n] = entry(n);
      return reply(200, JSON.stringify({ proxies: px }));
    }
    if (p === '/connections' && method === 'get') return reply(200, JSON.stringify({ connections: o.connections || [] }));
    return reply(404, '404 page not found');
  };

  function proxy(method, name, delay, opt, reply) {
    const x = known(name);
    if (!x) return reply(404, msg.noGroup);
    if (delay) return reply(200, '{"delay":42}');
    if (method === 'get') return reply(200, JSON.stringify(entry(name)));
    if (method !== 'put' && method !== 'delete') return reply(405, 'Method Not Allowed');
    w.wrote[name] = 1;
    if (method === 'put') w.puts[name] = (w.puts[name] || 0) + 1;
    if (method === 'delete') {
      const mode = o.del || '405';
      if (mode === '405') return reply(405, 'Method Not Allowed');
      if (mode === '404' || x.type !== 'Fallback') return reply(404, '404 page not found');
      x.fixed = ''; x.fixedAt = null; x.now = x.all[0];
      return reply(204, '');
    }
    let want;
    try { want = JSON.parse(opt.body).name; } catch (e) { return reply(400, '{"message":"bad body"}'); }
    if (typeof want === 'string' && want.indexOf(BYPASS_WORD) >= 0) {
      w.bypass.push({ group: name, want });
      return reply(400, msg.bypass);
    }
    const rej = o.putReject && o.putReject(name, want, w);
    if (rej) return reply(400, typeof rej === 'string' ? rej : msg.selectorOnly);
    if (!x.all || x.all.indexOf(want) < 0) {
      if (o.onUnknown) o.onUnknown(name, want, w);
      return reply(400, msg.notExist);
    }
    if (o.noMove && o.noMove(name, w)) return reply(204, '');
    const pin = () => { x.now = want; x.fixed = want; x.fixedAt = w.clock.t; };
    if (x.type === 'Fallback') {
      const mode = o.fallback || 'pin';
      if (mode === 'reject') return reply(400, msg.selectorOnly);
      if (mode === 'pin') pin();
      if (mode === 'pinOnly') { x.fixed = want; x.fixedAt = w.clock.t; }
      return reply(204, '');
    }
    if (x.type === 'URLTest') {
      if (o.urltest === 'reject') return reply(400, msg.selectorOnly);
      pin();
      return reply(204, '');
    }
    if (x.type === 'LoadBalance') return reply(400, msg.selectorOnly);
    x.now = want;
    return reply(204, '');
  }

  w.writes = () => w.calls.filter((c) => c.method !== 'get');
  return w;
}

const FORBID = {
  post: 'проба не должна слать POST',
  patch: 'проба не должна менять настройки',
  delete: 'проба не должна удалять',
};

// Песочник vm для скрипта пробы. Опции:
//   env      — замена/дополнение $environment; extra — прочие глобалы ($request, $script);
//   forbid   — методы $httpClient, бросающие исключение (по умолчанию post, patch);
//   timer(ms) — настоящая задержка setTimeout (по умолчанию ms/1000, не меньше 1);
//   stretch  — растяжение таймеров в фоне Stash (ST14: в 3–4 раза), до timer;
//   storeWrite — замена $persistentStore.write; noteTag — поля в запись w.notes.
// Возвращает state: done, doneCalls, note { t, s, b, o, clip }, log, logs, sb.
export function sandbox(w, code, file, opts = {}) {
  const state = { done: null, doneCalls: 0, note: null, log: null, logs: [] };
  const RealDate = Date;
  function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(w.clock.t); }
  FakeDate.now = () => w.clock.t;
  FakeDate.UTC = RealDate.UTC; FakeDate.parse = RealDate.parse;
  const timer = opts.timer || ((ms) => Math.max(1, Math.round((ms || 0) / 1000)));
  const stretch = opts.stretch || 1;
  const forbid = opts.forbid || ['post', 'patch'];
  const http = {};
  for (const mt of ['get', 'put', 'delete', 'post', 'patch']) {
    http[mt] = forbid.includes(mt) ? () => { throw new Error(FORBID[mt]); } : (o, cb) => w.handle(mt, o, cb);
  }
  const sb = Object.assign({
    console: { log: (s) => { state.log = String(s); state.logs.push(state.log); } },
    JSON, Math, Date: FakeDate, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, isFinite, encodeURIComponent, decodeURIComponent,
    setTimeout: (fn, ms) => setTimeout(fn, timer((ms || 0) * stretch)),
    clearTimeout,
    $environment: Object.assign({ 'controller-url': 'http://127.0.0.1:9090', 'controller-authorization': SECRET,
      'stash-version': '3.4.1' }, opts.env || {}),
    $notification: { post: (t, s, b, o) => {
      state.note = { t, s, b, o: o || null, clip: (o && o.clipboard) || null };
      w.notes.push({ at: w.clock.t, t, s, b, ...(opts.noteTag || {}) });
    } },
    $persistentStore: { read: (k) => (k in w.store ? w.store[k] : null),
      write: opts.storeWrite || ((v, k) => { w.store[k] = v; return true; }) },
    $httpClient: http,
    $done: (v) => { state.doneCalls++; state.done = v || {}; },
  }, opts.extra || {});
  sb.globalThis = sb;
  state.sb = sb;
  vm.runInContext(code, vm.createContext(sb), { filename: file });
  return state;
}

// Ждёт $done, затем ещё grace мс: второй $done, если он есть, успеет прийти.
export async function settle(state, ms = 5000, grace = 150) {
  const until = Date.now() + ms;
  while (!state.done && Date.now() < until) await new Promise((r) => setTimeout(r, 2));
  assert.ok(state.done, 'проба не дошла до $done');
  await new Promise((r) => setTimeout(r, grace));
  assert.equal(state.doneCalls, 1, 'ровно один $done на любой ветви');
  return state;
}
