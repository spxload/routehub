// Стенд опыта ST25: POST /lab/t24-report — живой отчёт пробы
// (src/clients/stash-lab24.js, handleT24Report).
//
// ЗАЧЕМ. Строка `{"lab":"report",…}` идёт в хвост Worker'а, сессия читает её
// во время опыта. Без токена, поэтому стенд обязан: отвечать только на стенде
// Stash; не пускать в журнал тело больше 2 КБ (413 без строки) и ключи вне
// белого списка; не писать IP и заголовки; отвечать stop:true при секрете
// LAB_STOP и при стране источника не RU (запрос дошёл через обход —
// страховка правила 1 после факта; страны нет — тоже stop, отсутствие данных
// не читается как «всё хорошо»).

import test from 'node:test';
import assert from 'node:assert/strict';
import { T, worker, req } from './harness.js';

const L = T.STASH_LAB24;
const URL_ = 'https://w.invalid' + L.T24_REPORT_PATH;
const MS = 1_800_000_000_000;
const RU = { country: 'RU' };
const GOOD = { rev: 'ST25', seq: 7, r: '08:09:30 w3000000 9.5м cron L:A N:B P:A T:A К:Пульс aA:01?? кас:204', tr: ['N ушёл 0.5м (≥0) фон #7'] };

function strictEnv(o) {
  return new Proxy({ ...o }, { get(t, k) {
    if (k === 'CLIENT' || k === 'LAB_STOP') return t[k];
    if (typeof k === 'symbol' || k === 'then') return undefined;
    throw new Error('отчёт ST25 обратился к env.' + String(k));
  } });
}
const post = (body, headers) => req(URL_, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: headers || {} });
async function call(body, { env = { CLIENT: 'stash' }, cf = RU, headers } = {}) {
  const log = [];
  const r = await L.handleT24Report(post(body, headers), strictEnv(env), cf, MS, (s) => log.push(s));
  const text = await r.text();
  return { status: r.status, j: text ? JSON.parse(text) : null, log: log.map((s) => JSON.parse(s)), raw: log, r };
}

test('обычный отчёт: 200 {ok:1, stop:false}; одна строка журнала lab=report с ts и ключами тела', async () => {
  const c = await call(GOOD);
  assert.equal(c.status, 200);
  assert.deepEqual(c.j, { ok: 1, stop: false });
  assert.equal(c.r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(c.log, [{ lab: 'report', ts: new Date(MS).toISOString(), ...GOOD }]);
});

test('белый список: чужие ключи не попадают, строки обрезаны и без управляющих символов, tr ≤ 8, числа целые', async () => {
  const c = await call({ ...GOOD, ip: '203.0.113.7', ua: 'Stash/3.4.1', token: 'SECRET', seq: 7.9, r: 'a\nb\u0000c' + 'x'.repeat(400),
    tr: Array.from({ length: 12 }, (_, i) => 't' + i + 'y'.repeat(100)).concat([5]), стоп: 'данных достаточно', ит: 'L — x', пр: 3, lab: 'pulse', ts: 'x' });
  assert.equal(c.status, 200);
  const e = c.log[0];
  assert.deepEqual(Object.keys(e).sort(), ['lab', 'r', 'rev', 'seq', 'tr', 'ts', 'ит', 'пр', 'стоп'].sort());
  assert.equal(e.lab, 'report', 'lab подменён телом');
  assert.equal(e.ts, new Date(MS).toISOString(), 'ts подменён телом');
  assert.equal(e.seq, 7);
  assert.equal(e.r, 'a b c' + 'x'.repeat(215));
  assert.equal(e.tr.length, 8);
  assert.ok(e.tr.every((x) => typeof x === 'string' && x.length <= 80));
  assert.ok(!/203\.0\.113|SECRET|Stash\/3/.test(c.raw[0]));
  for (const bad of [[], 'null', '"строка"', '{}', { ip: '1.2.3.4' }, 'не json', { seq: 'x', r: 5 }]) {
    const b = await call(bad);
    assert.equal(b.status, 400, JSON.stringify(bad));
    assert.deepEqual(b.log, [], 'в журнале: ' + JSON.stringify(bad));
  }
});

test('тело больше 2 КБ — 413 без строки журнала (по Content-Length и по байтам тела); ровно 2 КБ — принято', async () => {
  const big = { ...GOOD, r: 'я'.repeat(1100) };             // 2200+ байт при 1100 символах
  const c = await call(big);
  assert.equal(c.status, 413);
  assert.deepEqual(c.log, []);
  const h = await call(GOOD, { headers: { 'Content-Length': '5000' } });
  assert.equal(h.status, 413, 'Content-Length больше предела принят');
  assert.deepEqual(h.log, []);
  const base = JSON.stringify({ ...GOOD, r: '' });
  const edge = JSON.stringify({ ...GOOD, r: 'x'.repeat(L.T24_REPORT_MAX - Buffer.byteLength(base)) });
  assert.equal(Buffer.byteLength(edge), L.T24_REPORT_MAX);
  assert.equal((await call(edge)).status, 200);
  assert.equal((await call(edge + ' ')).status, 413);
});

test('stop: секрет LAB_STOP непустой → stop:true и «флаг: стоп»; пустой или пробелы — работать', async () => {
  const c = await call(GOOD, { env: { CLIENT: 'stash', LAB_STOP: '1' } });
  assert.deepEqual(c.j, { ok: 1, stop: true });
  assert.equal(c.log[0].флаг, 'стоп');
  for (const v of [undefined, '', '  ']) {
    const d = await call(GOOD, { env: { CLIENT: 'stash', LAB_STOP: v } });
    assert.deepEqual(d.j, { ok: 1, stop: false }, JSON.stringify(v));
    assert.equal(d.log[0].флаг, undefined);
  }
});

test('страна источника не RU → «обход: да» и stop:true; страны нет → «нет данных» и stop:true; RU — без поля обход', async () => {
  for (const cf of [{ country: 'DE' }, { country: 'NL' }, { country: 'T1' }]) {
    const c = await call(GOOD, { cf });
    assert.deepEqual(c.j, { ok: 1, stop: true }, cf.country);
    assert.equal(c.log[0].обход, 'да');
    assert.ok(c.raw[0].indexOf(cf.country) < 0 || cf.country === 'T1', 'страна в журнале');
  }
  for (const cf of [null, {}, { country: '' }, { country: 5 }]) {
    const c = await call(GOOD, { cf });
    assert.deepEqual(c.j, { ok: 1, stop: true }, JSON.stringify(cf));
    assert.equal(c.log[0].обход, 'нет данных');
  }
  assert.equal((await call(GOOD)).log[0].обход, undefined);
});

test('маршрут Worker\'а: только POST и только стенд Stash; Loon и прочие методы — 404 без журнала', async () => {
  const realLog = console.log, log = [];
  console.log = (...a) => { log.push(a.map(String).join(' ')); };
  try {
    const ok = await worker.fetch(post(GOOD, { 'CF-Connecting-IP': '203.0.113.9' }), strictEnv({ CLIENT: 'stash' }));
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: 1, stop: true }, 'без req.cf страна неизвестна — stop');
    assert.equal(log.filter((s) => s.indexOf('"lab":"report"') >= 0).length, 1);
    assert.ok(log.every((s) => s.indexOf('203.0.113.9') < 0), 'IP в журнале');
    log.length = 0;
    for (const env of [strictEnv({}), strictEnv({ CLIENT: 'loon' })]) {
      assert.equal((await worker.fetch(post(GOOD), env)).status, 404);
    }
    for (const method of ['GET', 'HEAD', 'PUT']) {
      assert.equal((await worker.fetch(req(URL_, { method }), strictEnv({ CLIENT: 'stash' }))).status, 404, method);
    }
    assert.deepEqual(log.filter((s) => s.indexOf('"lab"') >= 0), []);
  } finally { console.log = realLog; }
});
