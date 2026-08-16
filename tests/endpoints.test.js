// Тесты простых маршрутов Worker'а, не требующих ключа.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './mock-d1.js';
import { T, worker, req } from './harness.js';

// v1.9.8: /version — единственный способ проверить деплой, не заходя в панель.
test('GET /version отдаёт версию Worker\'а без ключа и токена', async () => {
  const env = makeEnv({});
  const r = await worker.fetch(req('https://w.invalid/version'), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.worker, T.WORKER_VER);
});
