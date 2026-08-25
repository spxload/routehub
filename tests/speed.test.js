// Тесты приёма метрик: POST /speed (привязка, nonce, чистка мёртвых метрик,
// атомарная запись) и POST /rkn.
// Выделено из tests/routehub-worker.test.js 2026-08-25 (ветка stash-client).
// Тесты перенесены дословно. Разбор возраста замеров — в metrics.test.js.
//
// Загрузка Worker'а и общие помощники — в tests/harness.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, nodeLine } from './mock-d1.js';
import { T, worker, DE, NL, post } from './harness.js';

// -------------------------------------------------------------- POST /speed
const SUB = {
  ts: Date.now(),
  n: 2,
  text: [nodeLine('[VPN] ' + DE + ' Германия #1'), nodeLine('[VPN] ' + NL + ' Нидерланды #1')].join('\n'),
  meta: {},
};

test('POST /speed: первое устройство привязывается и заводится запасной ключ', async () => {
  const env = makeEnv({ sub_cache: SUB });
  const r = await worker.fetch(post('https://w.invalid/speed', {
    key: 'k1', nonce: 'n-1',
    wifi: [{ name: '[VPN] ' + DE + ' Германия #1', down: 20, rtt: 40, jit: 5, bl: 10 }],
  }), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 'bound');
  const reg = env.RH_DB.get('devices');
  assert.equal(reg.k1.nonce, 'n-1');
  assert.equal(reg.k2.status, 'free', 'запасной ключ должен создаться сам');
});

test('POST /speed: чужой nonce -> 409 и статус conflict', async () => {
  const env = makeEnv({
    sub_cache: SUB,
    devices: { k1: { status: 'bound', nonce: 'n-1', token: 'a'.repeat(32) } },
  });
  const r = await worker.fetch(post('https://w.invalid/speed', { key: 'k1', nonce: 'ЧУЖОЙ' }), env);
  assert.equal(r.status, 409);
  assert.equal(env.RH_DB.get('devices').k1.status, 'conflict');
});

test('POST /speed отсекает метрики узлов, которых нет в подписке', async () => {
  const dead = T.matchKey('[VPN] ' + DE + ' Удалённый #9');
  const alive = T.matchKey('[VPN] ' + NL + ' Нидерланды #1');
  const env = makeEnv({
    sub_cache: SUB,
    devices: { k1: { status: 'bound', nonce: 'n-1', token: 'a'.repeat(32) } },
    'metrics:k1': { [dead]: { w: { down: 5, rtt: 50 } }, [alive]: { w: { down: 7, rtt: 50 } } },
  });
  const r = await worker.fetch(post('https://w.invalid/speed', {
    key: 'k1', nonce: 'n-1',
    wifi: [{ name: '[VPN] ' + DE + ' Германия #1', down: 20, rtt: 40 }],
  }), env);
  const j = await r.json();
  assert.equal(j.pruned, 1);
  const m = env.RH_DB.get('metrics:k1');
  assert.ok(!(dead in m), 'мёртвая метрика осталась');
  assert.ok(alive in m, 'живая метрика удалена ошибочно');
  assert.ok(T.matchKey('[VPN] ' + DE + ' Германия #1') in m);
});

test('предохранитель: подписки нет — метрики не чистятся', async () => {
  const dead = T.matchKey('[VPN] ' + DE + ' Удалённый #9');
  const env = makeEnv({
    devices: { k1: { status: 'bound', nonce: 'n-1', token: 'a'.repeat(32) } },
    'metrics:k1': { [dead]: { w: { down: 5, rtt: 50 } } },
  });
  const r = await worker.fetch(post('https://w.invalid/speed', { key: 'k1', nonce: 'n-1' }), env);
  const j = await r.json();
  assert.equal(j.pruned, 0);
  assert.ok(dead in env.RH_DB.get('metrics:k1'), 'при пустой подписке чистить нельзя');
});

test('предохранитель: подписка пустой строкой — метрики не чистятся', async () => {
  const dead = T.matchKey('[VPN] ' + DE + ' Удалённый #9');
  const env = makeEnv({
    sub_cache: { ts: Date.now(), n: 0, text: '', meta: {} },
    devices: { k1: { status: 'bound', nonce: 'n-1', token: 'a'.repeat(32) } },
    'metrics:k1': { [dead]: { w: { down: 5, rtt: 50 } } },
  });
  const r = await worker.fetch(post('https://w.invalid/speed', { key: 'k1', nonce: 'n-1' }), env);
  assert.equal((await r.json()).pruned, 0);
  assert.ok(dead in env.RH_DB.get('metrics:k1'));
});

test('POST /speed пишет метрики и реестр одним batch (атомарно)', async () => {
  const env = makeEnv({
    sub_cache: SUB,
    devices: { k1: { status: 'bound', nonce: 'n-1', token: 'a'.repeat(32) } },
  });
  const before = env.RH_DB.__stats.batches;
  await worker.fetch(post('https://w.invalid/speed', { key: 'k1', nonce: 'n-1' }), env);
  assert.equal(env.RH_DB.__stats.batches, before + 1);
});

// ---------------------------------------------------------------- POST /rkn
test('POST /rkn: смена режима пишет состояние и историю одним batch', async () => {
  const env = makeEnv({ devices: { k1: { status: 'bound', token: 'a'.repeat(32) } } });
  const b0 = env.RH_DB.__stats.batches;
  await worker.fetch(post('https://w.invalid/rkn', { key: 'k1', mode: 'whitelist' }), env);
  assert.equal(env.RH_DB.__stats.batches, b0 + 1);
  const b1 = env.RH_DB.__stats.batches;
  await worker.fetch(post('https://w.invalid/rkn', { key: 'k1', mode: 'whitelist' }), env);
  assert.equal(env.RH_DB.__stats.batches, b1, 'повтор режима историю не трогает');
  assert.equal(env.RH_DB.get('rkn_hist:k1').length, 1);
});

test('POST /rkn: неизвестный режим отклоняется', async () => {
  const env = makeEnv({ devices: { k1: { status: 'bound', token: 'a'.repeat(32) } } });
  const r = await worker.fetch(post('https://w.invalid/rkn', { key: 'k1', mode: 'что-то' }), env);
  assert.equal(r.status, 400);
});
