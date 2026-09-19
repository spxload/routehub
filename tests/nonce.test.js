// Чужой нонс при привязке ключа — техдолг 11b, Worker v1.10.2.
//
// Отдельный файл по той же причине, по которой тесты вообще разложены по
// файлам (см. harness.js): правка одного набора не должна требовать
// перезаливки 34 КБ routehub-worker.test.js через GitHub API — именно на
// ручном переносе плотного файла проект дважды получал порчу текста.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, nodeLine } from './mock-d1.js';
import { worker, post, DE, NL } from './harness.js';

const SUB = {
  ts: Date.now(),
  n: 2,
  text: [nodeLine('[VPN] ' + DE + ' Германия #1'), nodeLine('[VPN] ' + NL + ' Нидерланды #1')].join('\n'),
  meta: {},
};

// ── Чужой нонс (v1.10.2, техдолг 11b) ───────────────────────────────────────
// Нонс — единственное, чем Worker отличает одно физическое устройство от
// другого. В боевой базе у k1 и k2 он общий (срез 16.08: на k2 восстановили
// копию $persistentStore), из-за чего защита от подмены устройства не
// срабатывала ни разу. Проверка стоит на привязке СВОБОДНОГО ключа.

test('POST /speed: нонс, занятый другим ключом, не привязывается', async () => {
  const env = makeEnv({
    sub_cache: SUB,
    devices: {
      k1: { status: 'bound', nonce: 'n-1', token: 'a'.repeat(32) },
      k2: { status: 'free', token: 'b'.repeat(32) },
    },
  });
  const r = await worker.fetch(post('https://w.invalid/speed', {
    key: 'k2', nonce: 'n-1',
    wifi: [{ name: '[VPN] ' + DE + ' Германия #1', down: 20, rtt: 40, jit: 5, bl: 10 }],
  }), env);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, 'nonce taken',
    'устройство должно отличить этот отказ от конфликта по своему нонсу');
  const reg = env.RH_DB.get('devices');
  assert.equal(reg.k2.status, 'free', 'отклонённая привязка не должна менять реестр');
  assert.ok(!('nonce' in reg.k2), 'нонс не должен записаться');
  assert.equal(reg.k1.status, 'bound', 'боевой ключ правка трогать не имеет права');
  assert.equal(reg.k1.nonce, 'n-1');
  assert.equal(env.RH_DB.get('metrics:k2'), null, 'метрики по отказу не пишутся');
});

test('POST /speed: свободный ключ со СВОИМ нонсом привязывается как раньше', async () => {
  const env = makeEnv({
    sub_cache: SUB,
    devices: {
      k1: { status: 'bound', nonce: 'n-1', token: 'a'.repeat(32) },
      k2: { status: 'free', token: 'b'.repeat(32) },
    },
  });
  const r = await worker.fetch(post('https://w.invalid/speed', { key: 'k2', nonce: 'n-2' }), env);
  assert.equal(r.status, 200);
  assert.equal(env.RH_DB.get('devices').k2.nonce, 'n-2');
});

test('POST /speed: общий нонс у двух ПРИВЯЗАННЫХ ключей правку переживает', async () => {
  // Боевой случай k1/k2. Оба ключа уже bound, поэтому проверка до них не
  // доходит: правка предотвращает повторение, а существующую пару не чинит
  // и не ломает. Отвязка — только руками Дианы.
  const env = makeEnv({
    sub_cache: SUB,
    devices: {
      k1: { status: 'bound', nonce: 'общий', token: 'a'.repeat(32) },
      k2: { status: 'bound', nonce: 'общий', token: 'b'.repeat(32) },
    },
  });
  for (const key of ['k1', 'k2']) {
    const r = await worker.fetch(post('https://w.invalid/speed', { key: key, nonce: 'общий' }), env);
    assert.equal(r.status, 200, key + ' перестал приниматься');
  }
  const reg = env.RH_DB.get('devices');
  assert.equal(reg.k1.status, 'bound');
  assert.equal(reg.k2.status, 'bound');
});

test('POST /speed: нонс ключа В КОНФЛИКТЕ тоже занят', async () => {
  // Сужать проверку до статуса bound нельзя: тогда нонс ключа, который уже
  // в конфликте, можно занять третьим ключом и получить ровно ту же пару
  // «два устройства на одном нонсе», ради которой правка и делалась.
  const env = makeEnv({
    sub_cache: SUB,
    devices: {
      k1: { status: 'conflict', nonce: 'n-1', token: 'a'.repeat(32) },
      k2: { status: 'free', token: 'b'.repeat(32) },
    },
  });
  const r = await worker.fetch(post('https://w.invalid/speed', { key: 'k2', nonce: 'n-1' }), env);
  assert.equal(r.status, 409);
  assert.equal(env.RH_DB.get('devices').k2.status, 'free');
});

test('POST /speed: перепривязка того же устройства после unbind не блокируется', async () => {
  // unbind удаляет нонс у своего ключа (admin.js), но даже если бы не удалял —
  // «другим владельцем» ключ сам себе не бывает, иначе устройство после
  // отвязки уже не смогло бы вернуться.
  const env = makeEnv({
    sub_cache: SUB,
    devices: { k1: { status: 'free', nonce: 'n-1', token: 'a'.repeat(32) } },
  });
  const r = await worker.fetch(post('https://w.invalid/speed', { key: 'k1', nonce: 'n-1' }), env);
  assert.equal(r.status, 200);
  assert.equal(env.RH_DB.get('devices').k1.status, 'bound');
});
