// Поведение пробы ST20 (почему сбрасывается закрепление fallback/url-test) в
// песочнице с подставным контроллером.
//
// ЗАЧЕМ. ST20 обязана РАЗЛИЧАТЬ причины сброса. Подставной контроллер
// моделирует ядро с проверками здоровья по interval каждой группы (часы
// ядра — от его старта) и умеет исходы, между которыми проба должна выбрать:
//   'survive'  — закрепление держится; больной закреплённый член fallback
//                обходит, выздоровел — возвращается к нему;
//   'eternal'  — закрепление вечное, даже на больном члене;
//   'onefail'  — одна неудачная проверка закреплённого члена стирает
//                закрепление навсегда (mihomo findAliveProxy);
//   'interval' — каждая проверка здоровья снимает закрепление;
// и события: перезапуск ядра (счётчики байт и history сбрасываются,
// контроллер молчит окном), смена сети (RH-AI), пересборка групп, соединение
// через группу, окна недоступности контроллера. Если вердикт пробы не
// различает модели здесь, на устройстве он тоже соврёт.
//
// ЧАСЫ ПОДСТАВНЫЕ: прогоны cron раз в 1 и раз в 5 минут — в песочнице миг.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = 'probes/routehub-probe-stash20.js';
const OV_FILE = 'plugins/RouteHub-Stash-ST20.stoverride';
const CODE = fs.readFileSync(path.join(ROOT, FILE), 'utf8');

const SECRET = 'Bearer ОЧЕНЬ-СЕКРЕТНО';
const PRIVATE_HOST = 'очень-личный-сайт.example';
const NODE = 'Узел-Обход-DE-личный';
const P = 'RH-Т20-';
const D1 = P + 'Прямо1', D2 = P + 'Прямо2', DUMMY = P + 'Муляж', CLOCKD = P + 'Муляж2';
const F30 = P + 'F30', F3600 = P + 'F3600', U30 = P + 'U30', CONN = P + 'Связь';
const W = P + 'W', W0 = P + 'W0', MANUAL = P + 'Ручной', CANARY = P + 'Метка', CLOCK = P + 'Часы';
const WRITABLE = [F30, F3600, U30, CONN, W, W0, MANUAL, CANARY];
const T_START = 1_800_000_000_000;
const MIN = 60000;

// ── ПОДСТАВНОЙ КОНТРОЛЛЕР ────────────────────────────────────────────────
function world(o = {}) {
  const w = { clock: { t: T_START }, calls: [], store: {}, notes: [], step: o.step || 30, hang: !!o.hang,
    eofLeft: o.eof || 0, fail: o.fail || null, down: o.down || [], model: o.model || 'survive',
    connReset: !!o.connReset, putReject: o.putReject || null };
  const core = { start: T_START - (o.coreAgo === undefined ? 10 * MIN : o.coreAgo) };
  const sel = (all) => ({ type: 'Selector', all, now: all[0] });
  const auto = (type, interval, all) => ({ type, interval, all, pin: null, last: -Infinity, alive: {} });
  const g = {
    [D1]: sel(['DIRECT']), [D2]: sel(['DIRECT']), [MANUAL]: sel(['DIRECT', DUMMY]), [CANARY]: sel([D1, D2]),
    [F30]: auto('Fallback', 30, [D1, D2]), [F3600]: auto('Fallback', 3600, [D1, D2]),
    [U30]: auto('URLTest', 30, [D1, D2]), [CONN]: auto('Fallback', 3600, [D1, D2]),
    [W]: auto('Fallback', o.wInterval || 30, [D1, MANUAL]), [W0]: auto('Fallback', o.wInterval || 30, [D1, D2]),
    [CLOCK]: auto('Fallback', 86400, [CLOCKD]),
    'RH-AI': sel(['RH-AI-W', 'RH-AI-C']),
    [DUMMY]: { type: 'Socks5' }, [CLOCKD]: { type: 'Socks5' }, [NODE]: { type: 'Vless' },
  };
  if (o.noGroups) for (const k of Object.keys(g)) if (k.startsWith(P)) delete g[k];
  const autos = () => Object.values(g).filter((x) => x.interval);
  const events = (o.events || []).map((e) => ({ ...e, done: false })).sort((a, b) => a.at - b.at);

  function aliveNow(n) {
    if (n === 'DIRECT') return true;
    const x = g[n];
    if (!x || !x.type || x.type === 'Socks5') return false;
    if (x.type === 'Selector') return aliveNow(x.now);
    return x.all.some(aliveNow);
  }
  function check(x) {
    for (const m of x.all) x.alive[m] = aliveNow(m);
    if (w.model === 'interval') x.pin = null;
    if (w.model === 'onefail' && x.pin && !x.alive[x.pin]) x.pin = null;
  }
  function checksUpTo(t) {
    for (const x of autos()) {
      const iv = x.interval * 1000;
      let k = x.last < core.start ? 0 : Math.floor((x.last - core.start) / iv) + 1;
      for (;;) { const at = core.start + k * iv; if (at > t) break; check(x); x.last = at; k++; }
    }
  }
  function clearPins() { for (const x of autos()) x.pin = null; }
  function apply(e) {
    if (e.kind === 'restart') {
      core.start = e.at;
      for (const x of autos()) { x.pin = null; x.last = -Infinity; x.alive = {}; }
      if (o.selReset) for (const x of Object.values(g)) if (x.type === 'Selector') x.now = x.all[0];
    }
    if (e.kind === 'rebuild') {
      clearPins();
      for (const x of Object.values(g)) if (x.type === 'Selector') x.now = x.all[0];
    }
    if (e.kind === 'net') { g['RH-AI'].now = e.to; if (o.netReset) clearPins(); }
  }
  function advance(t) {
    for (const e of events) if (!e.done && e.at <= t) { checksUpTo(e.at); apply(e); e.done = true; }
    checksUpTo(t);
  }
  function nowOf(n) {
    const x = g[n];
    if (x.type === 'Selector') return x.now;
    // 'ttl' — закрепление снимается по времени от записи, независимо от проверок.
    const ttl = o.ttlOf ? o.ttlOf(n, w) : o.ttl;
    if (ttl && x.pin && w.clock.t - x.pinAt >= ttl) x.pin = null;
    const first = x.all.find((m) => x.alive[m]) || x.all[0];
    if (w.model === 'eternal') return x.pin || first;
    return x.pin && x.alive[x.pin] ? x.pin : first;
  }
  const hist = () => (o.noHist ? [] : [{ time: new Date(core.start).toISOString(), delay: 0 }]);
  function entry(n) {
    const x = g[n];
    const e = { name: n, type: x.type, history: n === CLOCKD ? hist() : [] };
    if (x.all) { e.all = x.all; e.now = nowOf(n); }
    return e;
  }
  w.g = g; w.nowOf = (n) => { advance(w.clock.t); return nowOf(n); }; w.core = core;

  w.handle = (method, opt, cb) => {
    const url = String(opt.url || '');
    const p = url.replace(/^http:\/\/127\.0\.0\.1:9090/, '');
    w.calls.push({ method, p, auth: opt.headers && opt.headers.Authorization, body: opt.body || null,
      timeout: opt.timeout, t: w.clock.t });
    if (w.hang) return;
    advance(w.clock.t);
    const reply = (st, body) => setTimeout(() => { w.clock.t += w.step; cb(null, { status: st, headers: {} }, body); }, 1);
    const eof = () => setTimeout(() => { w.clock.t += w.step; cb('Get "' + url + '": EOF', null, null); }, 1);
    if (w.eofLeft > 0) { w.eofLeft--; return eof(); }
    if (w.down.some(([a, b]) => w.clock.t >= a && w.clock.t < b)) return eof();
    if (/[^\x00-\x7F]/.test(url)) return reply(400, 'bad path');
    if (w.fail && w.fail(method, decodeURIComponent(p), w)) return reply(500, 'oops');
    if (p === '/') return reply(200, '{"hello":"stash"}');
    if (p === '/proxies' && method === 'get') {
      const px = {};
      for (const n of Object.keys(g)) {
        px[n] = entry(n);
        if (o.hideNow && o.hideNow(n, w)) delete px[n].now;   // группа есть, `now` не отдан
      }
      return reply(200, JSON.stringify({ proxies: px }));
    }
    if (p === '/connections') {
      const s = Math.floor((w.clock.t - core.start) / 1000);
      const body = { connections: [{ id: '1', chains: [NODE], metadata: { host: PRIVATE_HOST } }] };
      if (!o.noTotals) { body.uploadTotal = s * 7; body.downloadTotal = s * 13; }
      return reply(200, JSON.stringify(body));
    }
    const m = p.match(/^\/proxies\/([^/?]+)(\/delay)?/);
    if (m) {
      const name = decodeURIComponent(m[1]);
      const x = g[name];
      if (!x) return reply(404, '{"message":"Resource not found"}');
      if (m[2]) { if (w.connReset && 'pin' in x) x.pin = null; return reply(200, '{"delay":42}'); }
      if (method === 'get') return reply(200, JSON.stringify(entry(name)));
      if (method === 'put') {
        if (w.putReject && w.putReject(name)) return reply(400, '{"message":"must be one of Selector / Fallback"}');
        const want = JSON.parse(opt.body).name;
        if (!x.all || x.all.indexOf(want) < 0) return reply(400, '{"message":"Selector update error: proxy not exist"}');
        if ('pin' in x) { x.pin = want; x.pinAt = w.clock.t; } else x.now = want;
        return reply(204, '');
      }
      return reply(405, 'Method Not Allowed');
    }
    return reply(404, '404 page not found');
  };
  return w;
}

function sandboxFor(w, { tile = false, storeWrite = null } = {}) {
  const state = { done: null, doneCalls: 0, note: null, log: null };
  const RealDate = Date;
  function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(w.clock.t); }
  FakeDate.now = () => w.clock.t;
  const sb = {
    console: { log: (s) => { state.log = String(s); } },
    JSON, Math, Date: FakeDate, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, isFinite, encodeURIComponent, decodeURIComponent,
    // Сторож (75 с) — 400 мс настоящего времени, остальное — 1 мс.
    setTimeout: (fn, ms) => setTimeout(fn, ms >= 60000 ? 400 : 1),
    clearTimeout,
    $script: { name: 'rh-st20', type: tile ? 'tile' : 'cron' },
    $environment: { 'controller-url': 'http://127.0.0.1:9090', 'controller-authorization': SECRET, 'stash-version': '3.4.1' },
    $notification: { post: (t, s, b, opts) => { state.note = { t, s, b, o: opts || null }; w.notes.push({ at: w.clock.t, s, tile }); } },
    $persistentStore: { read: (k) => (k in w.store ? w.store[k] : null),
      write: storeWrite || ((v, k) => { w.store[k] = v; return true; }) },
    $httpClient: {
      get: (opt, cb) => w.handle('get', opt, cb),
      put: (opt, cb) => w.handle('put', opt, cb),
      post: () => { throw new Error('проба не должна слать POST'); },
      patch: () => { throw new Error('проба не должна менять настройки'); },
      delete: () => { throw new Error('проба не должна удалять'); },
    },
    $done: (v) => { state.doneCalls++; state.done = v || {}; },
  };
  sb.globalThis = sb;
  state.sb = sb;
  vm.runInContext(CODE, vm.createContext(sb), { filename: FILE });
  return state;
}

async function settle(state, ms = 5000) {
  const until = Date.now() + ms;
  while (!state.done && Date.now() < until) await new Promise((r) => setTimeout(r, 2));
  assert.ok(state.done, 'проба не дошла до $done');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(state.doneCalls, 1, 'ровно один $done на любой ветви');
  return state;
}

async function runOnce(w, opts = {}) {
  const st = await settle(sandboxFor(w, opts));
  const rep = JSON.parse(st.log.replace(/^\[ST20\] /, ''));
  return { st, rep };
}

// Ручная точка по инструкции: два нажатия плитки с разницей 10 с.
async function tap(w) {
  const first = await runOnce(w, { tile: true });
  w.clock.t += 10000;
  const second = await runOnce(w, { tile: true });
  return { first, ...second };
}

// Прогоны cron по границам расписания: start + k·every (прогон, вышедший за
// границу, следующий не сдвигает — как у настоящего cron).
async function chain(w, { every = MIN, minutes = 60, tiles = [] } = {}) {
  const start = w.clock.t, reps = [];
  for (let k = 0; k * every <= minutes * MIN; k++) {
    const at = start + k * every;
    if (w.clock.t < at) w.clock.t = at;
    reps.push(await runOnce(w));
    for (const tm of tiles) if (tm > k * every && tm <= (k + 1) * every && tm <= minutes * MIN) {
      if (w.clock.t < start + tm) w.clock.t = start + tm;
      const t = await tap(w);
      reps.push(t.first, t);
    }
  }
  return reps;
}

const writes = (w) => w.calls.filter((c) => c.method !== 'get');
const last = (reps) => reps[reps.length - 1].rep.ans;
const state = (w) => JSON.parse(w.store.RH_ST20);

// ── МОДЕЛИ: КАЖДАЯ ДАЁТ СВОЙ ВЕРДИКТ, ПРИ ЛЮБОЙ ЧАСТОТЕ ПРОГОНОВ ─────────
const CADENCES = [[MIN, 60, 'раз в минуту'], [5 * MIN, 90, 'раз в 5 минут']];
const MODELS = {
  survive: { интервал: /^ОПРОВЕРГНУТА/, провал: /^ОПРОВЕРГНУТА: закрепление переживает провал/ },
  eternal: { интервал: /^ОПРОВЕРГНУТА/, провал: /^ПРОВАЛ НЕ СНИМАЕТ/ },
  onefail: { интервал: /^ОПРОВЕРГНУТА/, провал: /^ПОДТВЕРЖДЕНА: один провал/ },
  interval: { интервал: /^ПОДТВЕРЖДЕНА/, провал: /^ВЫВОД НЕВОЗМОЖЕН/ },
};

for (const [every, minutes, label] of CADENCES) {
  for (const [model, want] of Object.entries(MODELS)) {
    test(`модель «${model}», прогоны ${label}: интервал и провал названы верно`, async () => {
      const w = world({ model });
      const reps = await chain(w, { every, minutes });
      const A = last(reps);
      assert.match(A.вердикты.интервал, want.интервал, A.вердикты.интервал);
      assert.match(A.вердикты.провал, want.провал, A.вердикты.провал);
      assert.equal(A.W.раунды.length, 2, 'два раунда опыта с провалом');
      assert.match(A.ВЕРДИКТ, /автоматическая часть готова/, A.ВЕРДИКТ);
      // Ручной вернули с муляжа в любой модели.
      assert.equal(w.g[MANUAL].now, 'DIRECT');
      if (model !== 'interval') {
        assert.match(A.вердикты.соединение, /^НЕ СБРАСЫВАЕТ/, A.вердикты.соединение);
        assert.equal(A.группы.F3600.сбросов, 0);
        assert.ok(A.группы.F30.держал_мин >= 20, 'F30 держал ' + A.группы.F30.держал_мин);
      }
    });
  }
}

test('вердикты четырёх моделей попарно различимы и не зависят от частоты прогонов', async () => {
  const sig = {};
  for (const [every, minutes] of CADENCES) {
    for (const model of Object.keys(MODELS)) {
      const A = last(await chain(world({ model }), { every, minutes }));
      const s = A.вердикты.интервал.split(':')[0] + ' / ' + A.вердикты.провал.split(':')[0];
      if (sig[model]) assert.equal(s, sig[model], model + ': вердикт зависит от частоты');
      sig[model] = s;
    }
  }
  assert.equal(new Set(Object.values(sig)).size, 4, JSON.stringify(sig));
});

test('модель «interval»: F3600 сбрасывается раз в час, F30 — каждый прогон; вывод по частоте, а не по факту сброса', async () => {
  const w = world({ model: 'interval' });
  const A = last(await chain(w, { every: 5 * MIN, minutes: 90 }));
  assert.ok(A.группы.F3600.без_меток >= 1, 'часовая проверка F3600 не сработала в модели');
  assert.ok(A.группы.F30.без_меток >= 10);
  assert.match(A.вердикты.интервал, /^ПОДТВЕРЖДЕНА/);
});

// ── СОБЫТИЯ: ПЕРЕЗАПУСК, СЕТЬ, ПЕРЕСБОРКА, СОЕДИНЕНИЕ, ОКНА ──────────────
for (const [every, minutes, label] of CADENCES) {
  test(`перезапуск ядра (счётчики и history сброшены, контроллер молчит), ${label}`, async () => {
    const at = T_START + 40 * MIN;
    const w = world({ events: [{ at, kind: 'restart' }], down: [[at - 3 * MIN, at + 7 * MIN]] });
    const A = last(await chain(w, { every, minutes }));
    const ev = A.события.filter((e) => e.гр === 'F3600');
    assert.equal(ev.length, 1, JSON.stringify(A.события));
    assert.equal(ev[0].кандидат, 'перезапуск');
    assert.ok(ev[0].метки.includes('окно'));
    assert.match(A.вердикты.перезапуск, /^СБРАСЫВАЕТ \(F3600: 1 из 1 окон.*одиночный опыт; метки перезапуска: итоги есть, часы есть/, A.вердикты.перезапуск);
    assert.match(A.вердикты.интервал, /^ОПРОВЕРГНУТА/, 'сброс перезапуском принят за интервал');
    // После сброса закрепление восстановлено; W0 после опыта не отслеживается.
    assert.equal(w.nowOf(F3600), D2);
    assert.ok(!A.события.some((e) => e.гр === 'W0'), 'W0 после опыта дал события');
    assert.equal(w.nowOf(F30), D2);
  });
}

test('перезапуск без счётчиков, но с history: метка «часы» всё равно называет перезапуск', async () => {
  const at = T_START + 30 * MIN;
  const w = world({ events: [{ at, kind: 'restart' }], noTotals: true });
  const A = last(await chain(w, { every: MIN, minutes: 45 }));
  const ev = A.события.find((e) => e.гр === 'F3600');
  assert.equal(ev.кандидат, 'перезапуск');
  assert.ok(A.метки.some((m) => m.вид === 'перезапуск' && m.по === 'часы'));
  assert.match(A.вердикты.перезапуск, /итоги НЕТ, часы есть/);
});

test('перезапуск без счётчиков и без history: не «перезапуск», а «окно недоступности»; метки названы отсутствующими', async () => {
  const at = T_START + 30 * MIN;
  const w = world({ events: [{ at, kind: 'restart' }], down: [[at - 2 * MIN, at + 3 * MIN]], noTotals: true, noHist: true });
  const A = last(await chain(w, { every: MIN, minutes: 45 }));
  const ev = A.события.find((e) => e.гр === 'F3600');
  assert.equal(ev.кандидат, 'окно недоступности');
  assert.match(A.вердикты.перезапуск, /^не наблюдалось; метки перезапуска: итоги НЕТ, часы НЕТ/);
  assert.match(A.вердикты.окна, /^СБРАСЫВАЕТ/);
});

test('контроллер недоступен окнами, закрепление живо: ни одного сброса, «окна — не сбрасывает»', async () => {
  const w = world({ down: [[T_START + 10 * MIN, T_START + 14 * MIN], [T_START + 30 * MIN, T_START + 33 * MIN]] });
  const reps = await chain(w, { every: MIN, minutes: 50 });
  const A = last(reps);
  assert.ok(reps.some((r) => /КОНТРОЛЛЕР НЕ ОТВЕТИЛ/.test(r.rep.ans.ВЕРДИКТ)), 'окна не сработали в модели');
  assert.equal(A.события.length, 0, JSON.stringify(A.события));
  assert.match(A.вердикты.окна, /^НЕ СБРАСЫВАЕТ \(F3600: 0 из 2 окон/, A.вердикты.окна);
  assert.equal(A.метки.filter((m) => m.вид === 'окно').length, 2);
});

test('окна недоступности при прогонах раз в 5 минут — те же выводы', async () => {
  const w = world({ down: [[T_START + 9 * MIN, T_START + 11 * MIN], [T_START + 29 * MIN, T_START + 31 * MIN]] });
  const A = last(await chain(w, { every: 5 * MIN, minutes: 90 }));
  assert.equal(A.события.length, 0);
  assert.match(A.вердикты.окна, /^НЕ СБРАСЫВАЕТ \(F3600: 0 из 2 окон/, A.вердикты.окна);
  assert.match(A.вердикты.интервал, /^ОПРОВЕРГНУТА/);
});

for (const netReset of [true, false]) {
  test(`смена сети ${netReset ? 'сбрасывает' : 'не сбрасывает'} закрепление — проба говорит то же`, async () => {
    const w = world({ netReset, events: [{ at: T_START + 20 * MIN + 5000, kind: 'net', to: 'RH-AI-C' },
      { at: T_START + 35 * MIN + 5000, kind: 'net', to: 'RH-AI-W' }] });
    const A = last(await chain(w, { every: MIN, minutes: 50 }));
    if (netReset) {
      assert.match(A.вердикты.сеть, /^СБРАСЫВАЕТ \(F3600: 2 из 2 окон/, A.вердикты.сеть);
      assert.ok(A.события.every((e) => e.кандидат === 'сеть'), JSON.stringify(A.события));
    } else {
      assert.match(A.вердикты.сеть, /^НЕ СБРАСЫВАЕТ \(F3600: 0 из 2 окон/, A.вердикты.сеть);
      assert.equal(A.события.length, 0);
    }
    assert.match(A.вердикты.интервал, /^ОПРОВЕРГНУТА/);
  });
}

test('пересборка групп: канарейка select откатилась без падения счётчиков — «пересборка?»', async () => {
  const w = world({ events: [{ at: T_START + 30 * MIN + 5000, kind: 'rebuild' }] });
  const A = last(await chain(w, { every: MIN, minutes: 45 }));
  const ev = A.события.find((e) => e.гр === 'F3600');
  assert.equal(ev.кандидат, 'пересборка?');
  assert.match(A.вердикты.пересборка, /^СБРАСЫВАЕТ/);
  assert.equal(w.g[CANARY].now, D2, 'канарейку не выставили заново');
});

test('соединение через группу снимает закрепление — «соединение: СБРАСЫВАЕТ», F3600 при этом держится', async () => {
  const w = world({ connReset: true });
  const A = last(await chain(w, { every: MIN, minutes: 30 }));
  assert.match(A.вердикты.соединение, /^СБРАСЫВАЕТ/, A.вердикты.соединение);
  assert.equal(A.группы.F3600.сбросов, 0);
  assert.ok(A.события.every((e) => e.гр === 'Связь' && e.кандидат === 'соединение'));
  // Замер задержки — только через Связь.
  for (const c of w.calls.filter((x) => /\/delay/.test(x.p))) {
    assert.equal(decodeURIComponent(c.p.split('?')[0]), '/proxies/' + CONN + '/delay');
  }
});

// ── ПЛИТКА И УВЕДОМЛЕНИЯ ─────────────────────────────────────────────────
test('плитка: ручная точка с метками окна; уведомление с выгрузкой — только на втором нажатии', async () => {
  const at = T_START + 20 * MIN + 5000;
  const w = world({ netReset: true, events: [{ at, kind: 'net', to: 'RH-AI-C' }] });
  await chain(w, { every: MIN, minutes: 20 });
  w.clock.t = at + 10000;
  const { first, st, rep } = await tap(w);
  assert.equal(rep.ans.тип, 'плитка');
  // Первое нажатие — обычный прогон: уведомить может лишь о событиях (здесь
  // сбросы сменой сети), но не о ручной точке.
  assert.ok(!first.st.note || !/ручная точка №\d+ подтверждена/.test(first.st.note.b), 'первое нажатие подтвердило точку');
  assert.match(first.st.done.content, /нажмите плитку ещё раз/);
  assert.ok(st.note, 'подтверждённая точка без уведомления');
  assert.match(st.note.b, /ручная точка №1 подтверждена/);
  assert.equal(JSON.parse(st.note.o.clipboard).ans.ручные.length, 1, 'второе нажатие завело новую точку');
  const m = rep.ans.ручные[0];
  assert.equal(m.подтв, true);
  assert.deepEqual(m.метки, ['сеть']);
  assert.ok(m.сброшены.includes('F3600'));
  assert.match(rep.ans.вердикты.ручные, /^№1 [\d:]+ UTC: метки \[сеть\], сброшены \[/);
  assert.equal(m.сеть, 'RH-AI-C');
});

test('одиночный запуск плитки без событий (автообновление) не уведомляет; через минуту — новая неподтверждённая точка', async () => {
  const w = world();
  await runOnce(w);
  w.clock.t += MIN;
  await runOnce(w);
  w.clock.t += 20000;
  const one = await runOnce(w, { tile: true });
  assert.equal(one.st.note, null, 'автообновление плитки уведомило');
  w.clock.t += 70000;
  const two = await runOnce(w, { tile: true });
  assert.equal(two.st.note, null);
  assert.deepEqual(two.rep.ans.ручные.map((m) => m.подтв), [false, false]);
  assert.match(two.rep.ans.вердикты.ручные, /не подтверждена — возможно автозапуск плитки/);
});

test('плитка после перезапуска VPN: метка перезапуска и сброшенные группы — калибровка', async () => {
  const at = T_START + 20 * MIN + 20000;
  const w = world({ events: [{ at, kind: 'restart' }], down: [[at - 10000, at + 15000]] });
  await chain(w, { every: MIN, minutes: 20 });
  w.clock.t = at + 25000;
  const { rep } = await tap(w);
  const m = rep.ans.ручные[0];
  assert.ok(m.метки.includes('перезапуск'), JSON.stringify(m));
  assert.ok(m.сброшены.includes('F3600') && m.сброшены.includes('F30'), JSON.stringify(m));
});

test('cron уведомляет только о вехах и новых парах «группа — причина»', async () => {
  const quiet = world({ model: 'survive' });
  await chain(quiet, { every: MIN, minutes: 60 });
  const qs = quiet.notes.map((n) => n.s);
  assert.ok(qs.length <= 2, 'лишние уведомления: ' + qs.join(' | '));
  assert.ok(qs.some((s) => /автоматическая часть готова/.test(s)));
  const noisy = world({ model: 'interval' });
  await chain(noisy, { every: MIN, minutes: 60 });
  assert.ok(noisy.notes.length <= 6, 'шумно: ' + noisy.notes.length + ' уведомлений за 60 прогонов');
  for (let i = 1; i < noisy.notes.length; i++) {
    assert.ok(noisy.notes[i].at - noisy.notes[i - 1].at >= 60000, 'два уведомления в одном прогоне');
  }
});

// ── ГРАНИЦЫ ЗАПИСИ, СЕКРЕТ, ПРИВАТНОСТЬ ───────────────────────────────────
test('пишет только PUT и только в RH-Т20-* из белого списка; RH-AI и узлы не трогаются; timeout в секундах', async () => {
  const w = world({ model: 'onefail', connReset: true, events: [{ at: T_START + 20 * MIN, kind: 'rebuild' }] });
  await chain(w, { every: MIN, minutes: 40, tiles: [25 * MIN + 1000] });
  assert.ok(writes(w).length > 10);
  for (const c of writes(w)) {
    assert.equal(c.method, 'put');
    const name = decodeURIComponent(c.p.replace(/^\/proxies\//, ''));
    assert.ok(WRITABLE.includes(name), 'запись вне белого списка: ' + name);
  }
  for (const c of w.calls) {
    assert.ok(!/[^\x00-\x7F]/.test(c.p), 'незакодированный адрес: ' + c.p);
    assert.ok(decodeURIComponent(c.p).indexOf(NODE) < 0, 'запрос к узлу: ' + c.p);
    assert.ok(!/RH-AI/.test(decodeURIComponent(c.p)), 'отдельный запрос к RH-AI: ' + c.p);
    assert.equal(c.auth, SECRET);
    assert.equal(c.timeout, 5, 'timeout не в секундах: ' + c.timeout);
  }
});

test('в выгрузке, уведомлении и хранилище нет секрета, хостов соединений и имён узлов', async () => {
  const w = world();
  const reps = await chain(w, { every: MIN, minutes: 5, tiles: [3 * MIN + 1000] });
  const tileRun = reps.find((r) => r.rep.ans.тип === 'плитка' && r.st.note);
  const dump = JSON.stringify(reps.map((r) => r.rep)) + JSON.stringify(tileRun.st.note) + JSON.stringify(w.store);
  assert.ok(dump.indexOf('ОЧЕНЬ-СЕКРЕТНО') < 0, 'секрет в выгрузке');
  assert.ok(dump.indexOf(PRIVATE_HOST) < 0, 'хост соединения в выгрузке');
  assert.ok(dump.indexOf(NODE) < 0, 'имя узла в выгрузке');
});

// ── ОТКАЗЫ И ГРАНИЦЫ ──────────────────────────────────────────────────────
test('override не применился — ни одной записи; cron напоминает не чаще раза в 6 часов', async () => {
  const w = world({ noGroups: true });
  const reps = await chain(w, { every: MIN, minutes: 5 });
  assert.equal(writes(w).length, 0);
  assert.match(last(reps).ВЕРДИКТ, /override не применился/);
  assert.equal(w.notes.length, 1);
  assert.equal(w.store.RH_ST20, undefined);
});

test('EOF на прогреве: один повтор спасает прогон', async () => {
  const w = world({ eof: 1 });
  const { rep } = await runOnce(w);
  assert.equal(rep.ans.прогрев.код, 200);
  assert.equal(rep.ans.прогрев.повтор, true);
  assert.equal(rep.ans.фаза, 'работа');
});

test('EOF дважды: ничего не записано, состояние не создано, отказ учтён и станет меткой «окно»', async () => {
  const w = world();
  await runOnce(w);
  const before = w.store.RH_ST20;
  w.clock.t += MIN; w.eofLeft = 2;
  const { rep, st } = await runOnce(w);
  assert.match(rep.ans.ВЕРДИКТ, /КОНТРОЛЛЕР НЕ ОТВЕТИЛ/);
  assert.equal(st.note, null, 'cron уведомил об отказе контроллера');
  assert.equal(w.store.RH_ST20, before, 'состояние изменено без чтения');
  assert.equal(JSON.parse(w.store.RH_ST20_fail).n, 1);
  const n = writes(w).length;
  w.clock.t += MIN;
  const r3 = await runOnce(w);
  assert.ok(r3.rep.ans.метки.some((m) => m.вид === 'окно' && m.прогонов === 1));
  assert.ok(writes(w).length >= n);
});

test('первый прогон с отказом: без состояния ничего не пишется', async () => {
  const w = world({ eof: 2 });
  const { rep } = await runOnce(w);
  assert.equal(writes(w).length, 0);
  assert.match(rep.ans.ВЕРДИКТ, /КОНТРОЛЛЕР НЕ ОТВЕТИЛ/);
  assert.equal(w.store.RH_ST20, undefined);
});

test('контроллер молчит — сторож, один $done, записей нет, замок снят', async () => {
  const w = world({ hang: true });
  const { rep } = await runOnce(w);
  assert.ok(rep.err.some((e) => e.indexOf('сторож') === 0));
  assert.equal(writes(w).length, 0);
  assert.equal(w.store.RH_ST20, undefined);
  assert.equal(w.store.RH_ST20_lock, '');
  assert.equal(JSON.parse(w.store.RH_ST20_fail).n, 1);
});

test('сторож позже худшего честного пути (дефект ST14)', () => {
  const num = (k) => Number(CODE.match(new RegExp('var ' + k + ' = (\\d+)'))[1]);
  assert.ok(num('GUARD_MS') > num('BUDGET_MS') + num('CTRL_SEC') * 1000);
});

test('медленный контроллер: прогон укладывается в бюджет, закрепления доделываются следующими прогонами', async () => {
  const w = world({ step: 2500 });
  const t0 = w.clock.t;
  const { rep } = await runOnce(w);
  assert.ok(w.clock.t - t0 <= 45000, 'прогон вышел за бюджет: ' + (w.clock.t - t0));
  assert.ok(rep.err.some((e) => /бюджет/.test(e)));
  const n = Object.values(rep.ans.группы).filter((g) => g.стат === 'держит').length;
  assert.ok(n < 6, 'все закрепления за один медленный прогон — бюджет не проверяется');
  w.step = 30;
  for (let i = 0; i < 2; i++) { w.clock.t += MIN; await runOnce(w); }
  const A = state(w);
  for (const g of [F30, F3600, U30, CONN, CANARY]) assert.equal(A.гр[g].стат, 'держит', g);
});

test('повтор чтения после обрыва не выходит за бюджет', async () => {
  // 7 с на ответ; прогрев проходит, дальше каждое чтение обрывается.
  const w = world({ step: 7000, down: [[T_START + 1, Infinity]] });
  const t0 = w.clock.t;
  await runOnce(w);
  assert.ok(w.clock.t - t0 <= 45000, 'прогон вышел за бюджет: ' + (w.clock.t - t0));
  assert.equal(writes(w).length, 0);
});

test('неудачное чтение /proxies посреди наблюдения — не сброс и не подтверждение', async () => {
  let k = 0;
  const w = world({ fail: (m, p) => m === 'get' && p === '/proxies' && (++k % 3 === 0) });
  const A = last(await chain(w, { every: MIN, minutes: 40 }));
  assert.equal(A.события.length, 0, JSON.stringify(A.события));
  assert.match(A.вердикты.интервал, /^ОПРОВЕРГНУТА/);
});

test('чтение после записи не удалось — «ждём», решает следующее удачное чтение; сбросом не считается', async () => {
  let armed = true;
  const w = world({ fail: (m, p) => {
    if (armed && m === 'get' && p === '/proxies/' + F3600) { armed = false; return true; }
    return false;
  } });
  await runOnce(w);
  assert.equal(state(w).гр[F3600].стат, 'ждём');
  w.clock.t += MIN;
  await runOnce(w);
  const s = state(w);
  assert.equal(s.гр[F3600].стат, 'держит');
  assert.equal(s.гр[F3600].сбросов, 0);
});

test('url-test не принимает PUT — не больше пяти попыток, вердикт называет код', async () => {
  const w = world({ putReject: (n) => n === U30 });
  const A = last(await chain(w, { every: MIN, minutes: 15 }));
  const puts = writes(w).filter((c) => decodeURIComponent(c.p) === '/proxies/' + U30).length;
  assert.equal(puts, 5);
  assert.match(A.вердикты.url_test, /^PUT не принят: 400/);
});

test('возврат Ручного с муляжа не прошёл — повтор в следующем прогоне, раунд не засчитан раньше времени', async () => {
  let failOnce = true;
  const w = world({ model: 'survive', fail: (m, p, ww) => {
    if (m === 'put' && p === '/proxies/' + MANUAL && ww.g[MANUAL].now === DUMMY && failOnce) { failOnce = false; return true; }
    return false;
  } });
  const A = last(await chain(w, { every: MIN, minutes: 40 }));
  assert.equal(w.g[MANUAL].now, 'DIRECT');
  assert.match(A.вердикты.провал, /^ОПРОВЕРГНУТА/, A.вердикты.провал);
});

test('W больше не на Ручном перед провалом — Ручной не ломается, раунд «снято до провала»', async () => {
  const w = world({ model: 'interval' });
  await chain(w, { every: MIN, minutes: 20 });
  assert.ok(!writes(w).some((c) => decodeURIComponent(c.p) === '/proxies/' + MANUAL && JSON.parse(c.body).name === DUMMY),
    'Ручной ставили на муляж, хотя закрепление W уже снято');
});

test('замок: второй прогон при живом замке ничего не делает; плитка говорит «занято»; старый замок не мешает', async () => {
  const w = world();
  w.store.RH_ST20_lock = String(w.clock.t - 200000);   // зависший прогон 200 с назад (сторож растянут)
  const { rep } = await runOnce(w, { tile: true });
  assert.equal(w.calls.length, 0);
  assert.match(rep.ans.ВЕРДИКТ, /ЗАНЯТО/);
  assert.equal(w.store.RH_ST20_lock, String(w.clock.t - 200000), 'чужой замок снят');
  w.clock.t += 120000;                                  // замку 320 с — дольше timeout cron
  const r2 = await runOnce(w);
  assert.ok(w.calls.length > 0);
  assert.equal(r2.rep.ans.фаза, 'работа');
});

test('сутки прошли — «итог», только чтение; новый цикл не начинается, пока override стоит', async () => {
  // Перезапуск сразу после суток сбрасывает закрепления: в «итог» их не восстанавливают.
  const w = world({ events: [{ at: T_START + 24 * 3600000 + 30000, kind: 'restart' }] });
  await chain(w, { every: 5 * MIN, minutes: 60 });
  const t0 = state(w).t0;
  w.clock.t = T_START + 24 * 3600000 + MIN;
  const n = writes(w).length;
  const r = await runOnce(w);
  assert.equal(r.rep.ans.фаза, 'итог');
  assert.match(r.rep.ans.ВЕРДИКТ, /выключите override/);
  for (let i = 0; i < 3; i++) { w.clock.t += 20 * 3600000; await runOnce(w); }
  assert.equal(writes(w).length, n, 'проба писала после «итог»');
  assert.ok(!w.calls.some((c) => c.t > T_START + 24 * 3600000 && /\/delay/.test(c.p)), 'соединение через группу в «итог»');
  assert.ok(state(w).гр[F3600].сбросов >= 1, 'в модели перезапуск не сбросил закрепление');
  assert.equal(state(w).t0, t0, 'начат новый цикл');
});

test('двое суток без удачных прогонов — новый цикл', async () => {
  const w = world();
  await chain(w, { every: MIN, minutes: 3 });
  const t0 = state(w).t0;
  w.clock.t += 49 * 3600000;
  await runOnce(w);
  assert.ok(state(w).t0 > t0);
});

test('замер через группу не принят — соединение «НЕ ПРОВЕРЕНО», автоматическая часть всё равно завершается', async () => {
  const w = world({ fail: (m, p) => /\/delay$/.test(p.split('?')[0]) });
  const A = last(await chain(w, { every: 5 * MIN, minutes: 60 }));
  assert.match(A.вердикты.соединение, /^НЕ ПРОВЕРЕНО: замер через группу не принят \(500\)/, A.вердикты.соединение);
  assert.match(A.ВЕРДИКТ, /автоматическая часть готова/);
});

test('W не принимает закрепление — «провал: НЕ ПРОВЕРЕНО», Ручной не трогается, часть завершается', async () => {
  const w = world({ putReject: (n) => n === W });
  const A = last(await chain(w, { every: MIN, minutes: 40 }));
  assert.match(A.вердикты.провал, /^НЕ ПРОВЕРЕНО: W не принимает закрепление \(400\)/, A.вердикты.провал);
  assert.ok(!writes(w).some((c) => decodeURIComponent(c.p) === '/proxies/' + MANUAL && JSON.parse(c.body).name === DUMMY));
  assert.match(A.ВЕРДИКТ, /автоматическая часть готова/);
});

test('fallback не принимает закрепление — «интервал: НЕ ПРОВЕРЕНО», а не «опровергнута»', async () => {
  const w = world({ putReject: (n) => n === F30 || n === F3600 });
  const A = last(await chain(w, { every: MIN, minutes: 30 }));
  assert.match(A.вердикты.интервал, /^НЕ ПРОВЕРЕНО/, A.вердикты.интервал);
});

test('закрепление принято кодом, но выбор не тот — не «держит», после пяти раз «отказ»', async () => {
  const w = world();
  const orig = w.handle;
  w.handle = (m, o, cb) => (m === 'put' && decodeURIComponent(o.url).endsWith(F30)
    ? (w.calls.push({ method: m, p: o.url.replace('http://127.0.0.1:9090', ''), auth: o.headers.Authorization, timeout: o.timeout, body: o.body }),
      setTimeout(() => { w.clock.t += 30; cb(null, { status: 204 }, ''); }, 1))
    : orig(m, o, cb));
  const A = last(await chain(w, { every: MIN, minutes: 30 }));
  assert.equal(A.группы.F30.стат, 'отказ');
  assert.equal(A.группы.F30.не_встало, 5);
  assert.equal(A.группы.F30.сбросов, 0, 'незакрепившееся принято за сброс');
  assert.match(A.вердикты.интервал, /^НЕ ПРОВЕРЕНО/);
});

test('хранилище не сохраняет — cron молчит, а не зовёт каждую минуту', async () => {
  const w = world();
  const storeWrite = (v, k) => { if (k === 'RH_ST20') return false; w.store[k] = v; return true; };
  for (let i = 0; i < 5; i++) {
    const { rep } = await runOnce(w, { storeWrite });
    assert.match(rep.err.join(';'), /состояние не сохранено/);
    w.clock.t += MIN;
  }
  assert.equal(w.notes.length, 0);
});

test('пропуск прогонов без отказов (туннель выключали) — метка «пропуск», сброс назван окном недоступности', async () => {
  const w = world({ noTotals: true, noHist: true, events: [{ at: T_START + 25 * MIN, kind: 'restart' }] });
  await chain(w, { every: MIN, minutes: 15 });
  w.clock.t = T_START + 30 * MIN;
  const { rep } = await runOnce(w);
  assert.ok(rep.ans.метки.some((m) => m.вид === 'пропуск'));
  const ev = rep.ans.события.find((e) => e.гр === 'F3600');
  assert.equal(ev.кандидат, 'окно недоступности');
  assert.ok(ev.метки.includes('пропуск'));
});

for (const [every, minutes, label] of CADENCES) {
  test(`опыт с провалом по времени (${label}): болезнь не раньше 150 с после закрепления W, возврат — не раньше 150 с болезни`, async () => {
    const w = world({ model: 'survive' });
    await chain(w, { every, minutes });
    const puts = writes(w).map((c) => ({ g: decodeURIComponent(c.p.replace(/^\/proxies\//, '')), n: JSON.parse(c.body).name, t: c.t }));
    const pinW = puts.filter((x) => x.g === W && x.n === MANUAL);
    const sick = puts.filter((x) => x.g === MANUAL && x.n === DUMMY);
    const cure = puts.filter((x) => x.g === MANUAL && x.n === 'DIRECT');
    assert.equal(sick.length, 2); assert.equal(cure.length, 2); assert.equal(pinW.length, 2);
    for (let i = 0; i < 2; i++) {
      assert.ok(sick[i].t - pinW[i].t >= 150000, 'болезнь через ' + (sick[i].t - pinW[i].t) + ' мс');
      assert.ok(cure[i].t - sick[i].t >= 150000, 'возврат через ' + (cure[i].t - sick[i].t) + ' мс');
    }
  });
}

test('плитка оставляет метку «ручная» в журнале меток', async () => {
  const w = world();
  await runOnce(w);
  w.clock.t += 20000;
  const { rep } = await tap(w);
  assert.equal(rep.ans.метки.filter((m) => m.вид === 'ручная').length, 1, 'второе нажатие завело вторую метку');
  assert.ok(rep.ans.метки.some((m) => m.вид === 'ручная' && m.n === 1));
});

// ── ПОПРАВКИ ПО МУТАЦИЯМ ─────────────────────────────────────────────────
test('модель «ttl» (закрепление живёт 10 мин от записи): сбросы без меток у F30 и F3600 — «НЕ ИНТЕРВАЛ»', async () => {
  const w = world({ ttl: 10 * MIN });
  const A = last(await chain(w, { every: MIN, minutes: 60 }));
  assert.match(A.вердикты.интервал, /^НЕ ИНТЕРВАЛ/, A.вердикты.интервал);
});

test('мало наблюдений — «мало данных», а не «опровергнута»', async () => {
  const w = world();
  const A = last(await chain(w, { every: MIN, minutes: 10 }));
  assert.match(A.вердикты.интервал, /^мало данных/, A.вердикты.интервал);
  assert.doesNotMatch(A.ВЕРДИКТ, /готова/);
});

test('перезапуск и смена сети в одном окне — кандидат «перезапуск», а не «сеть»', async () => {
  const at = T_START + 20 * MIN + 5000;
  const w = world({ events: [{ at, kind: 'net', to: 'RH-AI-C' }, { at: at + 1000, kind: 'restart' }] });
  const A = last(await chain(w, { every: MIN, minutes: 25 }));
  const ev = A.события.find((e) => e.гр === 'F3600');
  assert.deepEqual([ev.кандидат, ev.метки.includes('сеть')], ['перезапуск', true]);
});

test('перезапуск без history, но со счётчиками — метка «итоги»', async () => {
  const w = world({ noHist: true, events: [{ at: T_START + 20 * MIN + 5000, kind: 'restart' }] });
  const A = last(await chain(w, { every: MIN, minutes: 25 }));
  assert.equal(A.события.find((e) => e.гр === 'F3600').кандидат, 'перезапуск');
  assert.ok(A.метки.some((m) => m.вид === 'перезапуск' && m.по === 'итоги'));
  assert.match(A.вердикты.перезапуск, /итоги есть, часы НЕТ/);
});

test('`now` группы не отдан в снимке — не сброс и не подтверждение', async () => {
  const w = world({ hideNow: (n, ww) => n === F3600 && Math.floor((ww.clock.t - T_START) / MIN) % 4 === 2 });
  const A = last(await chain(w, { every: MIN, minutes: 30 }));
  assert.equal(A.группы.F3600.сбросов, 0);
  assert.ok(A.снимки.some((h) => h.now.F3600 === null), 'в модели `now` не пропадал');
});

test('`now` W не отдан — Ручной на муляж не ставится; «готова» только по сроку 1,5 ч', async () => {
  const w = world({ hideNow: (n) => n === W });
  const reps = await chain(w, { every: MIN, minutes: 95 });
  const at40 = reps.find((r) => r.rep.ans.мин >= 40).rep.ans;
  assert.ok(!writes(w).some((c) => decodeURIComponent(c.p) === '/proxies/' + MANUAL && JSON.parse(c.body).name === DUMMY));
  assert.match(at40.вердикты.провал, /^идёт/, at40.вердикты.провал);
  assert.doesNotMatch(at40.ВЕРДИКТ, /готова/);
  assert.match(last(reps).ВЕРДИКТ, /автоматическая часть готова \(по сроку 1,5 ч/);
});

test('W возвращается не сразу (ядро проверяет реже) — «вернулся», а не «не вернулся» по первому чтению', async () => {
  const w = world({ model: 'survive', wInterval: 150 });
  const A = last(await chain(w, { every: MIN, minutes: 60 }));
  assert.match(A.вердикты.провал, /^ОПРОВЕРГНУТА/, A.вердикты.провал + ' ' + JSON.stringify(A.W.раунды));
  assert.ok(A.W.раунды.some((r) => r.через_с > 60), 'в модели возврат не запаздывал: ' + JSON.stringify(A.W.раунды));
});

test('чтение после записи не удалось, а закрепление не встало — не сброс', async () => {
  let armed = 2;
  const w = world({ fail: (m, p) => armed === 1 && m === 'get' && p === '/proxies/' + F3600 && (armed = 0, true) });
  const orig = w.handle;
  w.handle = (m, o, cb) => {
    if (armed === 2 && m === 'put' && decodeURIComponent(o.url).endsWith(F3600)) {
      armed = 1;                                   // 204 без закрепления, чтение после — сбой
      w.calls.push({ method: m, p: o.url.replace('http://127.0.0.1:9090', ''), auth: o.headers.Authorization, timeout: o.timeout, body: o.body });
      return setTimeout(() => { w.clock.t += 30; cb(null, { status: 204 }, ''); }, 1);
    }
    return orig(m, o, cb);
  };
  await runOnce(w);
  assert.equal(state(w).гр[F3600].стат, 'ждём');
  w.clock.t += MIN;
  await runOnce(w);
  w.clock.t += MIN;
  await runOnce(w);
  const s = state(w);
  assert.equal(s.гр[F3600].сбросов, 0, 'незакрепившееся принято за сброс');
  assert.equal(s.гр[F3600].стат, 'держит', 'не закреплено заново');
});

test('первый удачный прогон cron уведомляет о запуске', async () => {
  const w = world();
  const { st } = await runOnce(w);
  assert.ok(st.note, 'нет уведомления о запуске');
  assert.match(st.note.b, /^повод: запуск/);
  w.clock.t += MIN;
  const r2 = await runOnce(w);
  assert.equal(r2.st.note, null, 'второй прогон без событий уведомил');
});

// ── ПОПРАВКИ ТЕСТИРОВЩИКА И РЕВЬЮ 25.09 ─────────────────────────────────
test('Н1: закрепление истекает само (ttl 5 мин), провал ничего не снимает — «НЕ РАЗЛИЧИТЬ», а не «ПОДТВЕРЖДЕНА»', async () => {
  const w = world({ ttl: 5 * MIN, model: 'survive' });
  const A = last(await chain(w, { every: MIN, minutes: 120 }));
  assert.match(A.вердикты.закрепление, /^держалось подряд до [\d.]+ мин \(F3600\)/, 'сбросы при пережитых окнах названы «меньше периода»');
  assert.match(A.вердикты.провал, /^НЕ РАЗЛИЧИТЬ: закрепление снимается и без провала — контроль W0 сброшен через \d+ с/, A.вердикты.провал);
  assert.match(A.вердикты.интервал, /^НЕ ИНТЕРВАЛ/, A.вердикты.интервал);
  assert.ok(A.W.раунды.every((r) => r.итог !== 'не вернулся' || r.контроль !== 'чист'));
});

test('Н1: контроль W0 держит — «один провал» подтверждается и при прогонах раз в 5 минут', async () => {
  const w = world({ model: 'onefail' });
  const A = last(await chain(w, { every: 5 * MIN, minutes: 60 }));
  assert.ok(A.W.раунды.every((r) => r.контроль === 'чист'), JSON.stringify(A.W.раунды));
  assert.match(A.вердикты.провал, /^ПОДТВЕРЖДЕНА: .*контроль W0 держит/);
});

test('Н1: W0 закрепляется в том же прогоне, что и W, и перед ним', async () => {
  const w = world({ model: 'survive' });
  await chain(w, { every: MIN, minutes: 20 });
  const puts = writes(w).map((c) => decodeURIComponent(c.p.replace(/^\/proxies\//, '')));
  const pinsW = writes(w).filter((c) => decodeURIComponent(c.p) === '/proxies/' + W);
  const pinsW0 = writes(w).filter((c) => decodeURIComponent(c.p) === '/proxies/' + W0);
  assert.equal(pinsW.length, pinsW0.length);
  pinsW.forEach((c, i) => assert.ok(c.t - pinsW0[i].t >= 0 && c.t - pinsW0[i].t < 5000, 'W0 не в том же прогоне'));
  assert.ok(puts.indexOf(W0) < puts.indexOf(W));
});

test('Н1: `now` контроля W0 не отдан — «не вернулся» не засчитывается', async () => {
  const w = world({ model: 'onefail', hideNow: (n) => n === W0 });
  const A = last(await chain(w, { every: MIN, minutes: 40 }));
  assert.match(A.вердикты.провал, /^НЕ РАЗЛИЧИТЬ: .*контроль W0 не прочитан/, A.вердикты.провал);
});

test('Н1: контроль каждого раунда свой — сброс W0 в первом раунде не пачкает второй', async () => {
  // Первые 12 мин закрепление живёт 5 мин, дальше — вечно.
  const w = world({ model: 'onefail', ttlOf: (n, ww) => (ww.clock.t < T_START + 12 * MIN ? 5 * MIN : 0) });
  const A = last(await chain(w, { every: MIN, minutes: 40 }));
  assert.match(A.W.раунды[0].контроль, /^сброшен через/, JSON.stringify(A.W.раунды));
  assert.equal(A.W.раунды[1].контроль, 'чист', JSON.stringify(A.W.раунды));
  assert.match(A.вердикты.провал, /^ПОДТВЕРЖДЕНА: .*ещё 1 «не вернулся» при сброшенном контроле W0 — одиночный опыт/, A.вердикты.провал);
});

test('Н1: W0 не принимает закрепление — W не закрепляется вовсе, «НЕ ПРОВЕРЕНО: W0»', async () => {
  const w = world({ putReject: (n) => n === W0 });
  const A = last(await chain(w, { every: MIN, minutes: 30 }));
  assert.equal(writes(w).filter((c) => decodeURIComponent(c.p) === '/proxies/' + W).length, 0, 'W закреплён без контроля');
  assert.match(A.вердикты.провал, /^НЕ ПРОВЕРЕНО: W0 не принимает закрепление \(400\)/, A.вердикты.провал);
});

test('Р3: возврат Ручного с муляжа всё время отказывает — «болезнь» в состоянии не растёт без предела', async () => {
  const w = world({ fail: (m, p, ww) => m === 'put' && p === '/proxies/' + MANUAL && ww.g[MANUAL].now === DUMMY });
  await chain(w, { every: MIN, minutes: 40 });
  const s = state(w);
  assert.equal(s.W.фаза, 'болеет');
  assert.ok(s.W.болезнь.length <= 20, 'болезнь: ' + s.W.болезнь.length);
});

test('Н2: закрепление живёт меньше периода cron — отдельный вывод, «готово» по сроку, соединение «НЕ ПРОВЕРЕНО»', async () => {
  const w = world({ ttl: 30000 });
  const A = last(await chain(w, { every: MIN, minutes: 100 }));
  assert.match(A.вердикты.закрепление, /^МЕНЬШЕ ПЕРИОДА ЧТЕНИЙ/, A.вердикты.закрепление);
  assert.match(A.вердикты.соединение, /^НЕ ПРОВЕРЕНО: Связь не держит закрепление/, A.вердикты.соединение);
  const ready = w.notes.find((n) => /автоматическая часть готова/.test(n.s));
  assert.ok(ready, 'сигнала «готово» нет');
  assert.ok(ready.at - T_START <= 91 * MIN, 'готово позже 1,5 ч: ' + (ready.at - T_START) / MIN);
});

test('Н2: Связь не принимает PUT — соединение «НЕ ПРОВЕРЕНО», готовность приходит', async () => {
  const w = world({ putReject: (n) => n === CONN });
  const A = last(await chain(w, { every: MIN, minutes: 45 }));
  assert.match(A.вердикты.соединение, /^НЕ ПРОВЕРЕНО: Связь не принимает закрепление \(400\)/);
  assert.match(A.ВЕРДИКТ, /автоматическая часть готова/);
  assert.doesNotMatch(A.ВЕРДИКТ, /по сроку/);
});

test('Н2: сроком закрывается только несделанное — при обычной модели «по сроку» не пишется', async () => {
  const w = world();
  const A = last(await chain(w, { every: 5 * MIN, minutes: 100 }));
  const life = A.вердикты.закрепление.match(/^держалось подряд до ([\d.]+) мин \(F3600\)/);
  assert.ok(life && Number(life[1]) >= 60, A.вердикты.закрепление);
  assert.doesNotMatch(A.ВЕРДИКТ, /по сроку/);
});

test('Н3: перезапуск VPN без счётчиков и history на ручной точке — «ручная точка», интервал не портится', async () => {
  const at = T_START + 30 * MIN + 20000;
  const w = world({ noTotals: true, noHist: true, events: [{ at, kind: 'restart' }] });
  await chain(w, { every: MIN, minutes: 30 });
  w.clock.t = at + 15000;
  const { rep } = await tap(w);
  const A = rep.ans;
  const ev = A.события.filter((e) => e.гр === 'F3600');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].кандидат, 'ручная точка');
  assert.equal(A.группы.F30.без_меток, 0, 'сброс на ручной точке засчитан как «без меток»');
  assert.match(A.вердикты.интервал, /^ОПРОВЕРГНУТА/, A.вердикты.интервал);
});

test('Н4: write() отказывает вне белого списка; RH-AI и узлов в WRITABLE нет', async () => {
  const w = world();
  const { st } = await runOnce(w);
  const n = writes(w).length;
  const got = await new Promise((res) => st.sb.write('RH-AI', 'RH-AI-C', res));
  const got2 = await new Promise((res) => st.sb.write(NODE, 'DIRECT', res));
  assert.equal(writes(w).length, n, 'запись ушла в контроллер');
  assert.equal(got.error, 'отказ пробы'); assert.equal(got2.error, 'отказ пробы');
  assert.deepEqual(Object.keys(st.sb.WRITABLE).sort(), [...WRITABLE].sort());
});

test('Н4: F30 сбрасывается чаще F3600 меньше чем вчетверо — не «ПОДТВЕРЖДЕНА»', async () => {
  // ttl 5 и 12 мин: частоты отличаются примерно в 2,3 раза — так бывает при
  // сбросе по времени, а не при проверке здоровья (там разница в 100 раз).
  const w = world({ ttlOf: (n) => (n === F30 ? 5 * MIN : n === F3600 ? 12 * MIN : 0) });
  const A = last(await chain(w, { every: MIN, minutes: 90 }));
  const f = A.группы.F30, g = A.группы.F3600;
  const ratio = (f.без_меток / f.наблюдал_мин) / (g.без_меток / g.наблюдал_мин);
  assert.ok(ratio > 2 && ratio < 4, 'модель вне диапазона: ' + ratio);
  assert.match(A.вердикты.интервал, /^НЕ ИНТЕРВАЛ/, A.вердикты.интервал);
});

test('Н4: F30 сбрасывается, а F3600 наблюдался меньше 20 мин — «мало данных», а не «ПОДТВЕРЖДЕНА»', async () => {
  const w = world({ model: 'interval' });
  const A = last(await chain(w, { every: MIN, minutes: 12 }));
  assert.ok(A.группы.F30.без_меток >= 2);
  assert.equal(A.группы.F3600.без_меток, 0);
  assert.match(A.вердикты.интервал, /^мало данных/, A.вердикты.интервал);
});

test('Р2: состояние RH_ST20 за сутки с лишним в шумной модели — меньше 16 КБ UTF-8', async () => {
  const w = world({ model: 'interval', down: [[T_START + 3 * 3600000, T_START + 3 * 3600000 + 20 * MIN]] });
  await chain(w, { every: 5 * MIN, minutes: 26 * 60, tiles: [2 * 3600000 + 1000, 5 * 3600000 + 1000] });
  const bytes = Buffer.byteLength(w.store.RH_ST20, 'utf8');
  assert.ok(bytes < 16000, 'RH_ST20 = ' + bytes + ' байт');
  const w2 = world({ model: 'interval' });
  await chain(w2, { every: MIN, minutes: 150 });
  const b2 = Buffer.byteLength(w2.store.RH_ST20, 'utf8');
  assert.ok(b2 < 16000, 'RH_ST20 = ' + b2 + ' байт (поминутно)');
});

test('Р3: сутки истекли в фазе «болеет» — Ручной возвращён, раунд закрыт, болезнь не копится', async () => {
  const w = world({ model: 'survive' });
  await chain(w, { every: MIN, minutes: 4 });
  assert.equal(state(w).W.фаза, 'болеет', 'модель не дошла до болезни');
  w.clock.t = T_START + 24 * 3600000 + MIN;
  const { rep } = await runOnce(w);
  assert.equal(w.g[MANUAL].now, 'DIRECT');
  assert.equal(rep.ans.W.фаза, 'готово');
  assert.equal(rep.ans.W.раунды[rep.ans.W.раунды.length - 1].итог, 'прервано сутками');
  const n = writes(w).length;
  for (let i = 0; i < 30; i++) { w.clock.t += MIN; await runOnce(w); }
  assert.equal(writes(w).length, n);
  assert.ok(state(w).W.болезнь.length <= 20);
});

test('Р4: замок перехвачен посреди прогона — состояние не сохраняется, чужой замок не снимается', async () => {
  const w = world();
  await runOnce(w);
  const before = w.store.RH_ST20;
  w.clock.t += MIN;
  w.fail = (m, p, ww) => { if (p === '/proxies') ww.store.RH_ST20_lock = 'чужой'; return false; };
  const { rep } = await runOnce(w);
  assert.equal(w.store.RH_ST20_lock, 'чужой', 'чужой замок снят');
  assert.equal(w.store.RH_ST20, before, 'устаревшее состояние записано поверх');
  assert.ok(rep.err.some((e) => /замок перехвачен/.test(e)));
});

// ── ВТОРОЙ КРУГ РЕВЬЮ И ТЕСТИРОВЩИКА 25.09 ───────────────────────────────
test('«меньше периода чтений» — не раньше трёх окон подряд: после двух «мало данных»', async () => {
  const w = world({ ttl: 30000 });
  const reps = await chain(w, { every: MIN, minutes: 3 });
  const life = reps.map((r) => r.rep.ans.вердикты.закрепление);
  assert.match(life[2], /^мало данных/, life.join(' | '));
  assert.match(life[3], /^МЕНЬШЕ ПЕРИОДА ЧТЕНИЙ: F3600 сброшен во всех 3 окнах/, life.join(' | '));
});

test('ЗАНЯТО от живого прогона: «через 10–20 с нажмите плитку ДВАЖДЫ»', async () => {
  const w = world();
  w.store.RH_ST20_lock = String(w.clock.t - 5000);
  const { rep, st } = await runOnce(w, { tile: true });
  assert.match(rep.ans.ВЕРДИКТ, /ЗАНЯТО.*через 10–20 с нажмите плитку ДВАЖДЫ/);
  assert.equal(st.note, null);
});

test('ЗАНЯТО от убитого прогона (перезапуск VPN): ждать до истечения замка и нажать ДВАЖДЫ', async () => {
  const w = world();
  w.store.RH_ST20_lock = String(w.clock.t - 100000);
  const { rep } = await runOnce(w, { tile: true });
  assert.match(rep.ans.ВЕРДИКТ, /ЗАНЯТО.*через 215 с нажмите плитку ДВАЖДЫ/, rep.ans.ВЕРДИКТ);
  // Совет выполним: через столько секунд замок свободен, пара нажатий проходит.
  w.clock.t += 215000;
  const { rep: r2 } = await tap(w);
  assert.equal(r2.ans.ручные.length, 1);
  assert.equal(r2.ans.ручные[0].подтв, true);
});

test('неподтверждённый запуск плитки — не причина: сбросы в его окне «без меток» и названы в выводе об interval', async () => {
  const at = T_START + 30 * MIN + 20000;
  const w = world({ noTotals: true, noHist: true, events: [{ at, kind: 'restart' }] });
  await chain(w, { every: MIN, minutes: 30 });
  w.clock.t = at + 15000;
  const { rep } = await runOnce(w, { tile: true });           // одно нажатие — возможно автообновление
  const ev = rep.ans.события.find((e) => e.гр === 'F3600');
  assert.equal(ev.кандидат, 'без меток');
  assert.ok(ev.метки.includes('ручная?'));
  assert.equal(rep.ans.группы.F3600.без_меток, 1);
  assert.match(rep.ans.вердикты.интервал, /из них в окнах неподтверждённого запуска плитки: 2\)/, rep.ans.вердикты.интервал);
  // Через 10 с второе нажатие — окна переходят в «ручная точка».
  w.clock.t += 10000;
  const { rep: r2 } = await runOnce(w, { tile: true });
  assert.equal(r2.ans.события.find((e) => e.гр === 'F3600').кандидат, 'ручная точка');
  assert.equal(r2.ans.группы.F3600.без_меток, 0);
  assert.equal(r2.ans.группы.F3600.окна['без меток'][0], 0);
  assert.deepEqual(r2.ans.группы.F3600.окна['ручная точка'], [1, 0]);
  assert.doesNotMatch(r2.ans.вердикты.интервал, /неподтверждённого/);
});

test('группа не прочитана при первом нажатии — её окно после подтверждения тоже «ручная точка»', async () => {
  const at = T_START + 30 * MIN + 20000, tap1 = at + 15000;
  const w = world({ noTotals: true, noHist: true, events: [{ at, kind: 'restart' }],
    hideNow: (n, ww) => n === F3600 && ww.clock.t >= tap1 && ww.clock.t < tap1 + 5000 });
  await chain(w, { every: MIN, minutes: 30 });
  w.clock.t = tap1;
  const { rep } = await tap(w);
  const ev = rep.ans.события.find((e) => e.гр === 'F3600');
  assert.ok(ev, 'сброс F3600 не замечен');
  assert.equal(ev.кандидат, 'ручная точка', JSON.stringify(ev));
  assert.equal(rep.ans.группы.F3600.без_меток, 0);
});

// ── OVERRIDE ─────────────────────────────────────────────────────────────
test('override: муляжи на TEST-NET, группы без узлов, без правил и MITM, lazy: false, cron раз в минуту, плитка', () => {
  const ov = fs.readFileSync(path.join(ROOT, OV_FILE), 'utf8');
  const body = ov.replace(/^#.*$/gm, '');
  assert.match(body, /server: 192\.0\.2\.1\n/);
  assert.match(body, /server: 192\.0\.2\.2\n/);
  const servers = [...body.matchAll(/server: (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(servers, ['192.0.2.1', '192.0.2.2']);
  const members = [...body.matchAll(/^ {6}- (.+)$/gm)].map((m) => m[1].trim());
  for (const m of members) assert.ok(m === 'DIRECT' || m.startsWith(P), 'посторонний член группы: ' + m);
  assert.ok(!/^rules:/m.test(body), 'override добавляет правила');
  assert.ok(!/mitm/i.test(body), 'override включает MITM');
  for (const [n, iv] of [[F30, 30], [F3600, 3600], [U30, 30], [CONN, 3600], [W, 30], [W0, 30], [CLOCK, 86400]]) {
    const blk = body.slice(body.indexOf('- name: ' + n + '\n'));
    const one = blk.slice(0, blk.indexOf('\n  - name:', 5) > 0 ? blk.indexOf('\n  - name:', 5) : undefined);
    assert.match(one, new RegExp('interval: ' + iv + '\\n'), n);
    assert.match(one, /lazy: false\n/, n + ' без lazy: false');
  }
  for (const n of [D1, D2, MANUAL, CANARY, DUMMY, CLOCKD]) assert.ok(body.indexOf('- name: ' + n + '\n') > 0, 'нет ' + n);
  assert.match(body, /cron: '\* \* \* \* \*'/);
  assert.match(body, /tiles:\n {2}- name: rh-st20\n/);
  assert.match(body, /url: https:\/\/raw\.githubusercontent\.com\/spxload\/routehub\/stash-client\/probes\/routehub-probe-stash20\.js\n/);
  // Имена групп в override и в пробе совпадают.
  for (const n of [D1, D2, DUMMY, CLOCKD, F30, F3600, U30, CONN, W, W0, MANUAL, CANARY, CLOCK]) {
    assert.ok(CODE.indexOf("P + '" + n.slice(P.length) + "'") > 0, 'проба не знает ' + n);
  }
});
