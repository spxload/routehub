// Журнал опытов лаборатории: GET /lab/pulse и строка журнала /lab/t22-nodes
// (src/clients/stash-lab.js), журнал Worker'а стенда (wrangler.toml).
//
// ЗАЧЕМ. В фоне контроллер Stash отдаёт EOF окнами по 30+ мин (ST21) — проба
// не видит, проверяет ли ядро узлы и скачивает ли поставщика, пока
// приложение закрыто. Это видно по журналу Worker'а: каждый запрос ядра к
// /lab/pulse (адрес проверки узла-«пульса») и к /lab/t22-nodes — строка с
// меткой и временем. Адрес публичный (override Lab), поэтому в строку не
// должно попасть ничего, кроме метки и времени: ни IP, ни заголовков, ни UA.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { T, worker, req } from './harness.js';

const L = T.STASH_LAB;
const ROOT = path.resolve(import.meta.dirname, '..');
const MS = 1_800_000_000_000;
const BASE = 'https://w.invalid' + '/lab/pulse';

function strictEnv(client) {
  return new Proxy({ CLIENT: client }, { get(t, k) {
    if (k === 'CLIENT') return t.CLIENT;
    if (typeof k === 'symbol' || k === 'then') return undefined;
    throw new Error('журнал опыта обратился к env.' + String(k));
  } });
}
// Перехват console.log на время вызова: всё, что обработчик пишет в журнал.
async function captured(fn) {
  const real = console.log, out = [];
  console.log = (...a) => { out.push(a.map(String).join(' ')); };
  try { return { r: await fn(), out }; } finally { console.log = real; }
}

test('пульс: 204 без тела, no-store; одна строка журнала — только lab, метка и время', async () => {
  assert.equal(L.PULSE_PATH, '/lab/pulse');
  const log = [];
  const r = L.handlePulse(new URL(BASE + '?t=u60'), { CLIENT: 'stash' }, MS, (s) => log.push(s));
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(await r.text(), '');
  assert.equal(log.length, 1);
  assert.deepEqual(JSON.parse(log[0]), { lab: 'pulse', t: 'u60', ts: new Date(MS).toISOString() });
});

test('пульс: метка — только [a-z0-9-]{1,16}, иначе «bad» (в журнал не попадает чужой текст)', () => {
  const tag = (q) => L.pulseTag(new URL(BASE + q));
  assert.equal(tag('?t=u60'), 'u60');
  assert.equal(tag('?t=a-b-9'), 'a-b-9');
  assert.equal(tag('?t=' + 'a'.repeat(16)), 'a'.repeat(16));
  for (const q of ['', '?t=', '?t=' + 'a'.repeat(17), '?t=U60', '?t=u60%0Aforged', '?t=%D0%BF', '?t=a%20b', '?x=u60']) {
    assert.equal(tag(q), 'bad', q);
  }
});

test('живой маршрут пульса: стенд — 204, строка журнала без IP, заголовков и UA; env кроме CLIENT не трогает', async () => {
  const secret = { 'User-Agent': 'Stash/3.4.1 SECRET-UA', 'CF-Connecting-IP': '203.0.113.77', 'X-Forwarded-For': '203.0.113.77', Cookie: 'k=SECRET' };
  const { r, out } = await captured(() => worker.fetch(req(BASE + '?t=u60', { headers: secret }), strictEnv('stash')));
  assert.equal(r.status, 204);
  const lines = out.filter((s) => s.indexOf('"lab"') >= 0);
  assert.equal(lines.length, 1, 'ровно одна строка журнала: ' + JSON.stringify(out));
  const rec = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(rec).sort(), ['lab', 't', 'ts']);
  assert.equal(rec.t, 'u60');
  for (const s of out) assert.ok(!/203\.0\.113|SECRET|Stash\/3/.test(s), 'в журнал попали данные запроса: ' + s);
});

test('живой маршрут пульса принимает HEAD (так проверяют узел ядра Clash-семейства): 204 и одна строка журнала', async () => {
  const { r, out } = await captured(() => worker.fetch(req(BASE + '?t=u60', { method: 'HEAD' }), strictEnv('stash')));
  assert.equal(r.status, 204);
  const lines = out.filter((s) => s.indexOf('"lab"') >= 0);
  assert.equal(lines.length, 1, 'HEAD без строки журнала — пустой журнал прочтут как «в фоне не проверяет»');
  assert.equal(JSON.parse(lines[0]).t, 'u60');
});

test('поставщик муляжей: одна строка журнала — lab, время и окно; тоже без данных запроса', async () => {
  const log = [];
  const r = L.handleT22Nodes({ CLIENT: 'stash' }, MS + 5, (s) => log.push(s));
  assert.equal(r.status, 200);
  assert.equal(log.length, 1);
  assert.deepEqual(JSON.parse(log[0]), { lab: 't22-nodes', ts: new Date(MS + 5).toISOString(), окно: L.t22Window(MS) });
  const { out } = await captured(() => worker.fetch(req('https://w.invalid/lab/t22-nodes', { headers: { 'CF-Connecting-IP': '203.0.113.77' } }), strictEnv('stash')));
  const lines = out.filter((s) => s.indexOf('"lab"') >= 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ['lab', 'ts', 'окно']);
  for (const s of out) assert.ok(s.indexOf('203.0.113') < 0);
});

test('боевой Loon (CLIENT не задан или чужой) пульса не знает — 404 и ни строки в журнал', async () => {
  for (const env of [strictEnv(undefined), strictEnv('loon')]) {
    const { r, out } = await captured(() => worker.fetch(req(BASE + '?t=u60'), env));
    assert.equal(r.status, 404);
    assert.equal(out.filter((s) => s.indexOf('"lab"') >= 0).length, 0);
  }
  assert.equal((await worker.fetch(req(BASE + '?t=u60', { method: 'POST' }), strictEnv('stash'))).status, 404, 'только GET и HEAD');
});

test('wrangler.toml: журнал включён только у стенда, служебные invocation-записи выключены', () => {
  const w = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
  const blocks = w.split(/\n(?=\[)/);
  const block = (h) => blocks.find((b) => b.split('\n')[0].trim() === h) || '';
  const obs = block('[env.stash.observability]');
  assert.match(obs, /\nenabled = true\n/);
  assert.match(obs, /\nhead_sampling_rate = 1\n/);
  assert.match(block('[env.stash.observability.logs]'), /\ninvocation_logs = false\n/);
  const heads = blocks.map((b) => b.split('\n')[0].trim()).filter((h) => /observability/.test(h));
  assert.deepEqual(heads, ['[env.stash.observability]', '[env.stash.observability.logs]'], 'журнал боевого Worker\'а не трогать');
});
