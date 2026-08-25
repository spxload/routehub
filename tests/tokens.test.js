// Тесты токенов устройства: tokenGate, две фазы, префикс пути /t/<token>/.
// Выделено из tests/routehub-worker.test.js 2026-08-25 (ветка stash-client).
// Тесты перенесены дословно.
//
// Загрузка Worker'а и общие помощники — в tests/harness.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './mock-d1.js';
import { T, worker, req } from './harness.js';

// ------------------------------------------------------------------- токены
test('tokenGate: верный токен пропускает, чужой отклоняется всегда', async () => {
  const env = makeEnv({ settings: { token_required: false } });
  const reg = { k1: { token: 'a'.repeat(32) } };
  assert.equal(await T.tokenGate(env, reg, 'k1', 'a'.repeat(32), false), null);
  const bad = await T.tokenGate(env, reg, 'k1', 'b'.repeat(32), false);
  assert.equal(bad.status, 403);
});

test('tokenGate: фаза 1 пропускает без токена, фаза 2 — нет', async () => {
  const reg = { k1: { token: 'a'.repeat(32) } };
  const env1 = makeEnv({ settings: { token_required: false } });
  assert.equal(await T.tokenGate(env1, reg, 'k1', '', false), null);
  const env2 = makeEnv({ settings: { token_required: true } });
  const bad = await T.tokenGate(env2, reg, 'k1', '', false);
  assert.equal(bad.status, 403);
});

test('settings отсутствуют — по умолчанию фаза 1 (token_required=false)', async () => {
  const env = makeEnv({});
  assert.deepEqual(await T.loadSettings(env), { token_required: false });
});

test('токен из settings читается только при запросе без токена', async () => {
  const env = makeEnv({ settings: { token_required: false } });
  const reg = { k1: { token: 'a'.repeat(32) } };
  const before = env.RH_DB.__stats.reads;
  await T.tokenGate(env, reg, 'k1', 'a'.repeat(32), false);
  assert.equal(env.RH_DB.__stats.reads, before, 'лишнее чтение D1 по новой ссылке');
  await T.tokenGate(env, reg, 'k1', '', false);
  assert.equal(env.RH_DB.__stats.reads, before + 1);
});

test('префикс пути /t/<token>/ срезается и не мешает маршрутизации', async () => {
  const env = makeEnv({ devices: { k1: { status: 'bound', token: 'a'.repeat(32) } } });
  const r = await worker.fetch(req('https://w.invalid/t/' + 'a'.repeat(32) + '/status?key=k1'), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.key, 'k1');
});

test('чужой токен в префиксе пути — отказ', async () => {
  const env = makeEnv({ devices: { k1: { status: 'bound', token: 'a'.repeat(32) } } });
  const r = await worker.fetch(req('https://w.invalid/t/' + 'z'.repeat(32) + '/status?key=k1'), env);
  assert.equal(r.status, 403);
});

test('ensureTokens выдаёт токен ключу без него', () => {
  const reg = { k1: { status: 'bound' }, k2: { status: 'free', token: 'a'.repeat(32) } };
  assert.equal(T.ensureTokens(reg), true);
  assert.match(reg.k1.token, /^[A-Za-z0-9]{32}$/);
  assert.equal(reg.k2.token, 'a'.repeat(32), 'существующий токен не трогаем');
  assert.equal(T.ensureTokens(reg), false, 'повторный вызов реестр не меняет');
});
