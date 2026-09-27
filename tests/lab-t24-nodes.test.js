// Стенд опыта ST24: GET /lab/t24-nodes?g=l|n|p|t (src/clients/stash-lab24.js).
//
// ЗАЧЕМ. ST23 показал: скачивание поставщика с ИЗМЕНЁННЫМ содержимым само
// запускает проверку узлов. ST24 меряет, замечает ли группа смерть узла БЕЗ
// этого — значит, выдача поставщика обязана быть байт в байт одной и той же
// в любое время. Адрес стоит в публичном override Lab без токена: только
// узлы direct с проверкой по /lab/t24-pulse стенда, без обхода, D1 и env,
// кроме CLIENT; журнал — только метка, группа и время.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { T, worker, req } from './harness.js';

const L = T.STASH_LAB24;
const MS = 1_800_000_000_000;       // начало окна 3 000 000 (чётное)
const W = 600000;
const STAND = 'https://routehub-stash.proton4iker.workers.dev';
const BASE = 'https://w.invalid';

function strictEnv(client) {
  return new Proxy({ CLIENT: client }, { get(t, k) {
    if (k === 'CLIENT') return t.CLIENT;
    if (typeof k === 'symbol' || k === 'then') return undefined;
    throw new Error('стенд ST24 обратился к env.' + String(k));
  } });
}
async function captured(fn) {
  const real = console.log, out = [];
  console.log = (...a) => { out.push(a.map(String).join(' ')); };
  try { return { r: await fn(), out }; } finally { console.log = real; }
}
const labLines = (out) => out.filter((s) => s.indexOf('"lab"') >= 0);

test('узлы группы: два direct RH-Т24-<G>A / <G>B, проверка — только /lab/t24-pulse стенда своей меткой, тайм-аут 5', () => {
  assert.deepEqual(L.T24_GROUPS, ['l', 'n', 'p', 't']);
  const all = [];
  for (const g of L.T24_GROUPS) {
    const G = g.toUpperCase();
    assert.deepEqual(L.t24Nodes(g), [
      { name: 'RH-Т24-' + G + 'A', type: 'direct', 'benchmark-url': STAND + '/lab/t24-pulse?t=t24' + g + 'a', 'benchmark-timeout': 5 },
      { name: 'RH-Т24-' + G + 'B', type: 'direct', 'benchmark-url': STAND + '/lab/t24-pulse?t=t24' + g + 'b', 'benchmark-timeout': 5 },
    ]);
    for (const n of L.t24Nodes(g)) {
      assert.ok(n.name.indexOf('Обход') < 0);
      assert.ok(L.T24_TAGS.indexOf(n['benchmark-url'].split('?t=')[1]) >= 0, 'метки узла нет в белом списке пульса');
      all.push(n.name);
    }
  }
  assert.equal(new Set(all).size, 8, 'имена узлов повторяются между группами');
  assert.equal(L.T24_STAND, STAND);
});

test('тело поставщика — чистая функция g: байт в байт одно и то же в любое время и в любом окне', async () => {
  for (const g of L.T24_GROUPS) {
    const u = new URL(BASE + '/lab/t24-nodes?g=' + g);
    const texts = [];
    for (const ms of [MS, MS + 1, MS + W - 1, MS + W, MS + W + 123456, MS + 7 * W + 5, 0, 2_000_000_000_000]) {
      texts.push(await L.handleT24Nodes(u, { CLIENT: 'stash' }, ms, () => {}).text());
    }
    assert.equal(new Set(texts).size, 1, 'выдача ' + g + ' зависит от времени');
    assert.equal(texts[0], L.renderT24(g));
    assert.ok(!/\d{6,}/.test(texts[0]), 'в выдаче число, похожее на окно или время');
  }
  const bodies = L.T24_GROUPS.map((g) => L.renderT24(g));
  assert.equal(new Set(bodies).size, 4, 'у групп одинаковая выдача');
});

test('живой маршрут: стенд без токена — 200, YAML, no-store; env кроме CLIENT не трогает; Loon, чужая g, POST — 404', async () => {
  for (const g of L.T24_GROUPS) {
    const r = await worker.fetch(req(BASE + '/lab/t24-nodes?g=' + g), strictEnv('stash'));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/yaml/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(await r.text(), L.renderT24(g));
  }
  for (const env of [strictEnv(undefined), strictEnv('loon')]) {
    const { r, out } = await captured(() => worker.fetch(req(BASE + '/lab/t24-nodes?g=l'), env));
    assert.equal(r.status, 404);
    assert.equal(labLines(out).length, 0, 'Loon пишет в журнал опыта');
  }
  for (const q of ['', '?g=', '?g=L', '?g=x', '?g=ll', '?g=l%0A', '?x=l']) {
    const { r, out } = await captured(() => worker.fetch(req(BASE + '/lab/t24-nodes' + q), strictEnv('stash')));
    assert.equal(r.status, 404, q);
    assert.equal(labLines(out).length, 0, 'чужая g в журнале: ' + q);
  }
  assert.equal((await worker.fetch(req(BASE + '/lab/t24-nodes?g=l', { method: 'POST' }), strictEnv('stash'))).status, 404);
});

test('строка журнала скачивания: lab, g, ts — и больше ничего; IP, UA и Cookie не попадают', async () => {
  const log = [];
  L.handleT24Nodes(new URL(BASE + '/lab/t24-nodes?g=p'), { CLIENT: 'stash' }, MS + 7, (s) => log.push(s));
  assert.equal(log.length, 1);
  assert.deepEqual(JSON.parse(log[0]), { lab: 't24-nodes', g: 'p', ts: new Date(MS + 7).toISOString() });
  const headers = { 'User-Agent': 'Stash/3.4.1 SECRET-UA', 'CF-Connecting-IP': '203.0.113.77', Cookie: 'k=SECRET' };
  const { out } = await captured(() => worker.fetch(req(BASE + '/lab/t24-nodes?g=t', { headers }), strictEnv('stash')));
  const lines = labLines(out);
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ['g', 'lab', 'ts']);
  for (const s of out) assert.ok(!/203\.0\.113|SECRET|Stash\/3/.test(s), 'в журнал попали данные запроса: ' + s);
});

// Касание T идёт по правилу override Lab на отдельный хост (ревью ST24) — маршрута
// касания у стенда нет: 404 без строки журнала.
test('маршрута /lab/t24-touch нет: 404 без строки журнала', async () => {
  assert.equal(L.T24_TOUCH_PATH, undefined);
  assert.equal(L.handleT24Touch, undefined);
  const { r, out } = await captured(() => worker.fetch(req(BASE + '/lab/t24-touch'), strictEnv('stash')));
  assert.equal(r.status, 404);
  assert.equal(labLines(out).length, 0);
});

const PY = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
test('выдача каждой группы разбирается PyYAML: ключ proxies, тайм-аут — число', { skip: PY.status !== 0 && 'нет python3 + PyYAML' }, () => {
  for (const g of L.T24_GROUPS) {
    const r = spawnSync('python3', ['-c', 'import sys, json, yaml\nprint(json.dumps(yaml.safe_load(sys.stdin.read()), ensure_ascii=False))'],
      { input: L.renderT24(g), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(d), ['proxies']);
    assert.deepEqual(d.proxies, L.t24Nodes(g));
  }
});
