// Эндпоинт муляжей ST22: GET /lab/t22-nodes (src/clients/stash-lab.js).
//
// ЗАЧЕМ. Адрес стоит в публичном override Lab без токена — значит выдача
// обязана быть муляжами и только муляжами: TEST-NET, порт 1, без обхода, без
// данных D1 и подписки. И она обязана различать то, ради чего сделана:
// метка меняется по 10-минутному окну, порядок — обратный фильтру override.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { T, worker, req } from './harness.js';

const L = T.STASH_LAB;
const W = 600000;
const MS = 1_800_000_000_000;       // начало окна 3 000 000
const URL0 = 'https://w.invalid/lab/t22-nodes';

// env, любое обращение к которому, кроме CLIENT, — провал: D1 не трогать.
function strictEnv(client) {
  return new Proxy({ CLIENT: client }, { get(t, k) {
    if (k === 'CLIENT') return t.CLIENT;
    if (typeof k === 'symbol' || k === 'then') return undefined;
    throw new Error('эндпоинт муляжей обратился к env.' + String(k));
  } });
}
const names = (ms) => L.t22Nodes(ms).map((n) => n.name);

test('состав: метка окна, затем слоты 3, 2, 1 — обратно фильтру override; только socks5 TEST-NET, порт 1', () => {
  assert.deepEqual(names(MS), ['RH-Т22-Метка-3000000', 'RH-Т22-3', 'RH-Т22-2', 'RH-Т22-1']);
  assert.deepEqual(L.T22_SLOTS, ['RH-Т22-1', 'RH-Т22-2', 'RH-Т22-3']);
  for (const n of L.t22Nodes(MS)) {
    assert.equal(n.type, 'socks5');
    assert.match(n.server, /^192\.0\.2\.\d{1,3}$/, 'не TEST-NET: ' + n.server);
    assert.equal(n.port, 1);
    assert.deepEqual(Object.keys(n).sort(), ['name', 'port', 'server', 'type'], 'лишние поля (пароль, uuid)');
    assert.ok(n.name.indexOf('Обход') < 0 && n.name.indexOf(L.T22_PREFIX) === 0);
  }
  assert.equal(new Set(L.t22Nodes(MS).map((n) => n.server)).size, 4, 'адреса муляжей различны');
});

test('метка меняется ровно на границе 10-минутного окна; слоты — нет', () => {
  assert.equal(L.T22_WINDOW_MS, W);
  assert.equal(names(MS + W - 1)[0], 'RH-Т22-Метка-3000000');
  assert.equal(names(MS + W)[0], 'RH-Т22-Метка-3000001');
  assert.equal(names(MS - 1)[0], 'RH-Т22-Метка-2999999');
  assert.deepEqual(names(MS).slice(1), names(MS + 7 * W).slice(1));
  assert.equal(L.t22Window(MS + 2.5 * W), 3000002);
});

test('живой маршрут: стенд Stash без токена и ключа — 200, YAML, no-store; D1 и прочий env не трогает', async () => {
  const r = await worker.fetch(req(URL0), strictEnv('stash'));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/yaml/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const t = await r.text();
  assert.match(t, /^# RouteHub — муляжи ST22/);
  assert.match(t, /\nproxies:\n {2}- name: 'RH-Т22-Метка-\d+'\n/);
  assert.equal(t.indexOf('/t/'), -1);
  const at = (s) => t.indexOf("'" + s + "'");
  assert.ok(at('RH-Т22-3') < at('RH-Т22-2') && at('RH-Т22-2') < at('RH-Т22-1'), 'порядок в выдаче не обратный');
});

test('обработчик детерминирован от времени: одинаковое окно — байт в байт одинаковая выдача', async () => {
  const a = await L.handleT22Nodes({ CLIENT: 'stash' }, MS + 5).text();
  const b = await L.handleT22Nodes({ CLIENT: 'stash' }, MS + W - 5).text();
  const c = await L.handleT22Nodes({ CLIENT: 'stash' }, MS + W).text();
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a, L.renderT22(MS));
});

test('боевой Loon (CLIENT не задан или чужой) маршрута не знает — 404', async () => {
  for (const env of [strictEnv(undefined), strictEnv('loon'), strictEnv('surge')]) {
    const r = await worker.fetch(req(URL0), env);
    assert.equal(r.status, 404);
  }
  assert.equal((await worker.fetch(req(URL0, { method: 'POST' }), strictEnv('stash'))).status, 404, 'только GET');
});

const PY = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
test('выдача разбирается PyYAML: ключ proxies, 4 узла, порт — число', { skip: PY.status !== 0 && 'нет python3 + PyYAML' }, () => {
  const r = spawnSync('python3', ['-c', 'import sys, json, yaml\nprint(json.dumps(yaml.safe_load(sys.stdin.read()), ensure_ascii=False))'],
    { input: L.renderT22(MS), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(d), ['proxies']);
  assert.deepEqual(d.proxies, L.t22Nodes(MS));
});
