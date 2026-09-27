// Эндпоинт опыта ST23: GET /lab/t23-nodes (src/clients/stash-lab.js).
//
// ЗАЧЕМ. Адрес стоит в публичном override Lab без токена: выдача — только
// узлы direct с проверкой по /lab/pulse стенда и один муляж TEST-NET, без
// обхода, D1 и подписки. Порядок обязан меняться по окну 10 мин (на этом
// стоит весь опыт), а строка журнала — нести только окно, порядок и сеть
// источника (asn / название), без IP, заголовков и User-Agent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { T, worker, req } from './harness.js';

const L = T.STASH_LAB;
const W = 600000;
const MS = 1_800_000_000_000;       // начало окна 3 000 000 (чётное)
const URL0 = 'https://w.invalid/lab/t23-nodes';
const STAND = 'https://routehub-stash.proton4iker.workers.dev';

function strictEnv(client) {
  return new Proxy({ CLIENT: client }, { get(t, k) {
    if (k === 'CLIENT') return t.CLIENT;
    if (typeof k === 'symbol' || k === 'then') return undefined;
    throw new Error('эндпоинт ST23 обратился к env.' + String(k));
  } });
}
async function captured(fn) {
  const real = console.log, out = [];
  console.log = (...a) => { out.push(a.map(String).join(' ')); };
  try { return { r: await fn(), out }; } finally { console.log = real; }
}
// Request с полем cf, как в рантайме Cloudflare.
function cfReq(url, headers, cf) {
  const r = req(url, { headers });
  Object.defineProperty(r, 'cf', { value: cf });
  return r;
}
const names = (ms) => L.t23Nodes(ms).map((n) => n.name);

test('порядок по окну 10 мин: чётное — A, B, C; нечётное — Муляж, C, B, A; смена ровно на границе', () => {
  assert.equal(L.T23_WINDOW_MS, W);
  assert.equal(L.t23Window(MS), 3000000);
  assert.deepEqual(names(MS), ['RH-Т23-A', 'RH-Т23-B', 'RH-Т23-C']);
  assert.deepEqual(names(MS + W - 1), names(MS));
  assert.deepEqual(names(MS + W), ['RH-Т23-Муляж', 'RH-Т23-C', 'RH-Т23-B', 'RH-Т23-A']);
  assert.deepEqual(names(MS - 1), names(MS + W), 'окно до MS — нечётное');
  assert.deepEqual(names(MS + 2 * W), names(MS));
});

test('узлы: A/B/C — direct с проверкой только по /lab/pulse стенда; муляж — socks5 TEST-NET, порт 1; обхода нет', () => {
  for (const ms of [MS, MS + W]) {
    for (const n of L.t23Nodes(ms)) {
      assert.ok(n.name.indexOf('Обход') < 0 && n.name.indexOf(L.T23_PREFIX) === 0);
      assert.match(n['benchmark-url'], /^https:\/\/routehub-stash\.proton4iker\.workers\.dev\/lab\/pulse\?t=t23[abcd]$/);
      assert.equal(n['benchmark-timeout'], 5);
      if (n.name === L.T23_DEAD) {
        assert.deepEqual(Object.keys(n).sort(), ['benchmark-timeout', 'benchmark-url', 'name', 'port', 'server', 'type']);
        assert.equal(n.type, 'socks5');
        assert.match(n.server, /^192\.0\.2\.\d{1,3}$/);
        assert.equal(n.port, 1);
        assert.equal(n['benchmark-url'], STAND + '/lab/pulse?t=t23d');
      } else {
        assert.deepEqual(Object.keys(n).sort(), ['benchmark-timeout', 'benchmark-url', 'name', 'type'], 'лишние поля у direct');
        assert.equal(n.type, 'direct');
        assert.equal(n['benchmark-url'], STAND + '/lab/pulse?t=t23' + n.name.slice(-1).toLowerCase());
      }
    }
  }
  assert.equal(L.T23_STAND, STAND);
});

test('живой маршрут: стенд без токена — 200, YAML, no-store; env кроме CLIENT не трогает; POST и Loon — 404', async () => {
  const r = await worker.fetch(req(URL0), strictEnv('stash'));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/yaml/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const t = await r.text();
  assert.match(t, /^# RouteHub — узлы ST23/);
  assert.equal(t.indexOf('/t/'), -1);
  for (const env of [strictEnv(undefined), strictEnv('loon')]) {
    const { r: r2, out } = await captured(() => worker.fetch(req(URL0), env));
    assert.equal(r2.status, 404);
    assert.equal(out.filter((s) => s.indexOf('"lab"') >= 0).length, 0, 'Loon пишет в журнал опыта');
  }
  assert.equal((await worker.fetch(req(URL0, { method: 'POST' }), strictEnv('stash'))).status, 404);
});

test('детерминизм: одно окно — байт в байт одна выдача, соседнее — другая', async () => {
  const a = await L.handleT23Nodes({ CLIENT: 'stash' }, MS + 5, () => {}).text();
  const b = await L.handleT23Nodes({ CLIENT: 'stash' }, MS + W - 5, () => {}).text();
  const c = await L.handleT23Nodes({ CLIENT: 'stash' }, MS + W, () => {}).text();
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a, L.renderT23(MS));
});

test('строка журнала: lab, ts, окно, порядок, asn, org — и больше ничего', () => {
  const log = [];
  L.handleT23Nodes({ CLIENT: 'stash' }, MS + W + 7, (s) => log.push(s), { asn: 64500, asOrganization: 'Example Telecom' });
  assert.equal(log.length, 1);
  assert.deepEqual(JSON.parse(log[0]), { lab: 't23-nodes', ts: new Date(MS + W + 7).toISOString(), окно: 3000001,
    порядок: 'Муляж,C,B,A', asn: 64500, org: 'Example Telecom' });
  const log2 = [];
  L.handleT23Nodes({ CLIENT: 'stash' }, MS, (s) => log2.push(s));
  assert.deepEqual(JSON.parse(log2[0]), { lab: 't23-nodes', ts: new Date(MS).toISOString(), окно: 3000000,
    порядок: 'A,B,C', asn: null, org: null });
});

test('asn и org санитизируются: только целое ASN, название без переводов строк и разметки, до 64 знаков', () => {
  assert.equal(L.cfAsn({ asn: 12389 }), 12389);
  for (const v of [undefined, null, '12389', 0, -1, 1.5, 2 ** 32, NaN]) assert.equal(L.cfAsn({ asn: v }), null, String(v));
  assert.equal(L.cfAsn(undefined), null);
  assert.equal(L.cfOrg({ asOrganization: 'ПАО «МТС»' }), 'ПАО МТС');
  assert.equal(L.cfOrg({ asOrganization: 'Hetzner Online GmbH' }), 'Hetzner Online GmbH');
  assert.equal(L.cfOrg({ asOrganization: 'Evil\n{"lab":"pulse"}<script>' }), 'Evil lab pulse script');
  assert.equal(L.cfOrg({ asOrganization: 'x'.repeat(100) }).length, 64);
  for (const v of [undefined, 42, '', '\n\t', '"{}"']) assert.equal(L.cfOrg({ asOrganization: v }), null, JSON.stringify(v));
  assert.equal(L.cfOrg(null), null);
});

test('живой маршрут с IP, UA, Cookie в заголовках и в cf: в журнал попадают только asn и org', async () => {
  const headers = { 'User-Agent': 'Stash/3.4.1 SECRET-UA', 'CF-Connecting-IP': '203.0.113.77', 'X-Forwarded-For': '203.0.113.77',
    'X-Real-IP': '203.0.113.77', Cookie: 'k=SECRET' };
  const cf = { asn: 64500, asOrganization: 'Example Telecom', country: 'RU', city: 'SECRET-CITY', latitude: 'SECRET-LAT',
    clientTcpRtt: 42, colo: 'ARN' };
  const { r, out } = await captured(() => worker.fetch(cfReq(URL0, headers, cf), strictEnv('stash')));
  assert.equal(r.status, 200);
  const lines = out.filter((s) => s.indexOf('"lab"') >= 0);
  assert.equal(lines.length, 1, JSON.stringify(out));
  const rec = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(rec).sort(), ['asn', 'lab', 'org', 'ts', 'окно', 'порядок']);
  assert.equal(rec.asn, 64500);
  assert.equal(rec.org, 'Example Telecom');
  for (const s of out) assert.ok(!/203\.0\.113|SECRET|Stash\/3|ARN|"RU"/.test(s), 'в журнал попали данные запроса: ' + s);
});

const PY = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
test('выдача разбирается PyYAML в обоих окнах: ключ proxies, порт и тайм-аут — числа', { skip: PY.status !== 0 && 'нет python3 + PyYAML' }, () => {
  for (const ms of [MS, MS + W]) {
    const r = spawnSync('python3', ['-c', 'import sys, json, yaml\nprint(json.dumps(yaml.safe_load(sys.stdin.read()), ensure_ascii=False))'],
      { input: L.renderT23(ms), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(d), ['proxies']);
    assert.deepEqual(d.proxies, L.t23Nodes(ms));
  }
});
