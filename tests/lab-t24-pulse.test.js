// Стенд опыта ST24: GET / HEAD /lab/t24-pulse?t=<метка>
// (src/clients/stash-lab24.js).
//
// ЗАЧЕМ. Узлы *A «умирают» со стороны стенда: в нечётное окно по 10 мин их
// адрес проверки отвечает через 25 с (ядро рвёт на 5-й). Ошибка здесь
// ломает весь опыт тихо: быстрый ответ на HEAD (ядро проверяет узел HEAD)
// сделал бы узел вечно живым; строка журнала после паузы пропадала бы при
// обрыве соединения; окно наоборот или задержка на чужой метке — неверные
// выводы. Паузу подменяем таймером и 25 с не ждём.

import test from 'node:test';
import assert from 'node:assert/strict';
import { T, worker, req } from './harness.js';

const L = T.STASH_LAB24;
const MS = 1_800_000_000_000;       // окно 3 000 000 — чётное (все живы)
const W = 600000;
const ODD = MS + W;                  // окно 3 000 001 — нечётное (*a мертвы)
const BASE = 'https://w.invalid/lab/t24-pulse';
const DYING = ['t24la', 't24na', 't24pa', 't24ta'];
const ALIVE = ['t24lb', 't24nb', 't24pb', 't24tb', 't24p-hc', 't24ctl'];

function strictEnv(client) {
  return new Proxy({ CLIENT: client }, { get(t, k) {
    if (k === 'CLIENT') return t.CLIENT;
    if (typeof k === 'symbol' || k === 'then') return undefined;
    throw new Error('пульс ST24 обратился к env.' + String(k));
  } });
}

// Подмена таймера: пауза стенда (любой setTimeout ≥ 1 с) не ждёт, а
// записывается — с числом строк журнала на момент её начала. Короткие
// таймеры (раннер тестов) идут настоящим путём.
async function withTimer(fn) {
  const real = globalThis.setTimeout, pauses = [], log = [];
  const realLog = console.log;
  console.log = (...a) => { log.push(a.map(String).join(' ')); };
  globalThis.setTimeout = (cb, ms, ...rest) => {
    if (ms >= 1000) { pauses.push({ ms, строк: log.length }); return real(cb, 0, ...rest); }
    return real(cb, ms, ...rest);
  };
  try { const r = await fn(log); return { r, pauses, log }; } finally { globalThis.setTimeout = real; console.log = realLog; }
}
const lab = (log) => log.filter((s) => s.indexOf('"lab"') >= 0).map((s) => JSON.parse(s));

test('окно смерти: *a мертвы ровно в нечётные окна по 10 мин, граница — floor(ms / 600000); прочие метки живы всегда', () => {
  assert.equal(L.T24_WINDOW_MS, W);
  assert.equal(L.t24Window(MS), 3000000);
  for (const t of DYING) {
    assert.equal(L.t24Dead(t, MS), false, t);
    assert.equal(L.t24Dead(t, ODD - 1), false, 'последняя мс чётного окна: ' + t);
    assert.equal(L.t24Dead(t, ODD), true, 'первая мс нечётного окна: ' + t);
    assert.equal(L.t24Dead(t, ODD + W - 1), true);
    assert.equal(L.t24Dead(t, ODD + W), false);
    assert.equal(L.t24Dead(t, MS - 1), true, 'окно до MS — нечётное');
  }
  for (const t of ALIVE) for (const ms of [MS, ODD, ODD + W - 1, MS - 1]) assert.equal(L.t24Dead(t, ms), false, t + ' ' + ms);
  assert.deepEqual(L.T24_TAGS.slice().sort(), DYING.concat(ALIVE).sort());
});

test('мёртвый узел: строка журнала ДО паузы 25 с, затем 204 no-store; живой — 204 без паузы', async () => {
  assert.equal(L.T24_DEAD_DELAY_MS, 25000);
  for (const t of DYING) {
    const { r, pauses, log } = await withTimer(() => L.handleT24Pulse(new URL(BASE + '?t=' + t), { CLIENT: 'stash' }, ODD + 5));
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(pauses, [{ ms: 25000, строк: 1 }], 'пауза не 25 с или журнал после паузы: ' + t);
    assert.deepEqual(lab(log), [{ lab: 't24-pulse', t, окно: 3000001, мёртв: true, ts: new Date(ODD + 5).toISOString() }]);
  }
  for (const [t, ms] of DYING.map((x) => [x, MS + 5]).concat(ALIVE.map((x) => [x, ODD + 5]))) {
    const { r, pauses, log } = await withTimer(() => L.handleT24Pulse(new URL(BASE + '?t=' + t), { CLIENT: 'stash' }, ms));
    assert.equal(r.status, 204);
    assert.deepEqual(pauses, [], 'пауза у живого: ' + t);
    assert.deepEqual(lab(log), [{ lab: 't24-pulse', t, окно: L.t24Window(ms), мёртв: false, ts: new Date(ms).toISOString() }]);
  }
});

test('пауза настоящая: без подмены таймера ответ мёртвого не приходит раньше срока', async () => {
  const real = globalThis.setTimeout;
  let asked = null;
  globalThis.setTimeout = (cb, ms, ...rest) => { if (ms >= 1000) { asked = ms; return real(() => {}, 0); } return real(cb, ms, ...rest); };
  const realLog = console.log;
  console.log = () => {};
  let settled = false;
  try {
    L.handleT24Pulse(new URL(BASE + '?t=t24la'), { CLIENT: 'stash' }, ODD).then(() => { settled = true; });
    await new Promise((r) => real(r, 30));
  } finally { globalThis.setTimeout = real; console.log = realLog; }
  assert.equal(asked, 25000);
  assert.equal(settled, false, 'ответ мёртвого пришёл, не дождавшись паузы');
});

test('чужая метка — 404 сразу, без паузы и без строки журнала; Loon — 404', async () => {
  for (const q of ['', '?t=', '?t=t24lc', '?t=T24LA', '?t=t24la%0A', '?t=t23a', '?t=u30', '?t=t24p-hcx', '?x=t24la']) {
    const { r, pauses, log } = await withTimer(() => L.handleT24Pulse(new URL(BASE + q), { CLIENT: 'stash' }, ODD));
    assert.equal(r.status, 404, q);
    assert.deepEqual(pauses, [], 'пауза на чужой метке: ' + q);
    assert.deepEqual(lab(log), [], 'чужая метка в журнале: ' + q);
  }
  for (const env of [strictEnv(undefined), strictEnv('loon')]) {
    const { r, pauses, log } = await withTimer(() => worker.fetch(req(BASE + '?t=t24la'), env));
    assert.equal(r.status, 404);
    assert.deepEqual(pauses, []);
    assert.deepEqual(lab(log), []);
  }
});

test('живой маршрут: HEAD = GET — мёртвый ждёт паузу и по HEAD; env кроме CLIENT не трогает; POST — 404', async () => {
  // Время маршрута — Date.now(): подменяем его на нечётное окно.
  const realNow = Date.now;
  Date.now = () => ODD + 1000;
  try {
    for (const method of ['GET', 'HEAD']) {
      const d = await withTimer(() => worker.fetch(req(BASE + '?t=t24na', { method }), strictEnv('stash')));
      assert.equal(d.r.status, 204, method);
      assert.equal(d.r.headers.get('cache-control'), 'no-store');
      assert.deepEqual(d.pauses, [{ ms: 25000, строк: 1 }], 'мёртвый по ' + method + ' без паузы');
      assert.equal(lab(d.log)[0].мёртв, true);
      const a = await withTimer(() => worker.fetch(req(BASE + '?t=t24nb', { method }), strictEnv('stash')));
      assert.equal(a.r.status, 204);
      assert.deepEqual(a.pauses, []);
      const bad = await withTimer(() => worker.fetch(req(BASE + '?t=zzz', { method }), strictEnv('stash')));
      assert.equal(bad.r.status, 404, 'чужая метка по ' + method);
    }
    Date.now = () => MS + 1000;
    const e = await withTimer(() => worker.fetch(req(BASE + '?t=t24na', { method: 'HEAD' }), strictEnv('stash')));
    assert.equal(e.r.status, 204);
    assert.deepEqual(e.pauses, [], 'чётное окно — без паузы');
  } finally { Date.now = realNow; }
  assert.equal((await worker.fetch(req(BASE + '?t=t24lb', { method: 'POST' }), strictEnv('stash'))).status, 404);
});

test('строка журнала пульса — только lab, t, окно, мёртв, ts; IP, UA, Cookie не попадают', async () => {
  const headers = { 'User-Agent': 'Stash/3.4.1 SECRET-UA', 'CF-Connecting-IP': '203.0.113.77', Cookie: 'k=SECRET' };
  const { log } = await withTimer(() => worker.fetch(req(BASE + '?t=t24ctl', { headers }), strictEnv('stash')));
  const lines = lab(log);
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['lab', 't', 'ts', 'мёртв', 'окно']);
  for (const s of log) assert.ok(!/203\.0\.113|SECRET|Stash\/3/.test(s), 'в журнал попали данные запроса: ' + s);
});
