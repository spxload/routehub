// Тесты выдачи подписки и маршрутов, которых нет: renderNodesBoth, флаги
// устройства, снятые миграционные эндпоинты и неизвестный путь -> 404.
// Выделено из tests/routehub-worker.test.js 2026-08-25 (ветка stash-client).
// Тесты перенесены дословно.
//
// Загрузка Worker'а и общие помощники — в tests/harness.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, nodeLine } from './mock-d1.js';
import { T, worker, SRC, DE, req } from './harness.js';

// ------------------------------------------------------- снятые эндпоинты
test('миграционные эндпоинты сняты (404)', async () => {
  const env = makeEnv({});
  for (const p of ['/admin/backup', '/admin/migrate', '/admin/verify']) {
    const r = await worker.fetch(req('https://w.invalid' + p + '?key=ADMIN-TEST-KEY'), env);
    assert.equal(r.status, 404, p + ' должен быть снят');
  }
});

test('в коде Worker\'а не осталось обращений к KV (RH_KV)', () => {
  const code = SRC.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(code.indexOf('RH_KV') < 0, 'найдено обращение к RH_KV вне комментариев');
});

// ------------------------------------------------------------------- прочее
test('renderNodesBoth отдаёт оба набора и обходные без дублирования', () => {
  const lines = [
    nodeLine('[VPN] ' + DE + ' Германия #1'),
    nodeLine('[Обход] ' + DE + ' Германия'),
  ];
  const state = {};
  state[T.matchKey('[VPN] ' + DE + ' Германия #1')] = { w: { down: 10, rtt: 40 }, c: { down: 5, rtt: 60 } };
  const out = T.renderNodesBoth(lines, state, false).split('\n');
  assert.equal(out.length, 3, 'ожидались Wi-Fi + сотовый + один обходной');
});

test('flags устройства инициализируются булевыми', () => {
  const reg = { k1: {} };
  assert.equal(T.ensureFlags(reg), true);
  for (const f of T.FLAGS) assert.equal(reg.k1[f], false);
});

test('неизвестный путь -> 404', async () => {
  const env = makeEnv({});
  const r = await worker.fetch(req('https://w.invalid/no-such-path'), env);
  assert.equal(r.status, 404);
});
