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

// Страница-проба смешанного содержимого (ADR-04, раздел 4). Отдаётся без
// ключа и без токена намеренно: в ней нет данных, а открывать её надо в один
// шаг с телефона. Тест сторожит именно это — что маршрут не уехал за
// tokenGate при следующей правке роутинга, иначе проба перестанет открываться,
// а понять это можно будет только с устройства.
test('GET /mixed отдаёт HTML без ключа и токена', async () => {
  const env = makeEnv({});
  const r = await worker.fetch(req('https://w.invalid/mixed'), env);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Content-Type') || '', /text\/html/);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  const html = await r.text();
  assert.ok(html.indexOf('<!doctype html') >= 0, 'это не HTML');
});
