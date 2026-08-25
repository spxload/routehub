// Тесты AI-тиеров и каскада регионов: buildAiTiers и cascadeOf.
// Выделено из tests/routehub-worker.test.js 2026-08-25 (ветка stash-client).
// Тесты перенесены дословно.
//
// Загрузка Worker'а и общие помощники — в tests/harness.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeLine } from './mock-d1.js';
import { T, DE, NL, US, KZ, RUF, TR } from './harness.js';

test('buildAiTiers: DE первой, СНГ исключён, регион важнее числа узлов', () => {
  const lines = [];
  for (let i = 0; i < 2; i++) lines.push(nodeLine('[VPN] ' + DE + ' Германия #' + i));
  for (let i = 0; i < 2; i++) lines.push(nodeLine('[VPN] ' + NL + ' Нидерланды #' + i));
  for (let i = 0; i < 2; i++) lines.push(nodeLine('[VPN] ' + US + ' США #' + i));
  for (let i = 0; i < 4; i++) lines.push(nodeLine('[VPN] ' + TR + ' Турция #' + i));
  for (let i = 0; i < 3; i++) lines.push(nodeLine('[VPN] ' + KZ + ' Казахстан #' + i));
  const tiers = T.buildAiTiers(lines, {});
  assert.equal(tiers[0], DE, 'DE обязана быть первой');
  assert.equal(tiers[1], NL, 'Европа раньше Америки');
  assert.equal(tiers[2], US, 'Америка раньше прочих');
  assert.equal(tiers[3], TR, 'Турция последняя, несмотря на 4 узла');
  assert.ok(!tiers.includes(KZ), 'СНГ в AI-тиеры попадать не должен');
});

test('AIrest исключает весь СНГ, а не только RU/BY', () => {
  const blocks = T.aiBlocks([DE, NL]);
  const line = blocks.filters.split('\n').find((l) => l.indexOf('AIrest') >= 0);
  for (const fl of [RUF, KZ]) assert.ok(line.indexOf(fl) >= 0, 'в исключениях нет ' + fl);
});

test('AIeu поднимает одноузловую Европу выше тира прочих регионов', () => {
  // Повторяет состав подписки на 2026-08-15: у Великобритании один узел,
  // поэтому в тиры она не попадает. Раньше её ловил только общий AIrest —
  // НИЖЕ тира Турции. Теперь между ними стоит региональный остаток AIeu.
  const GB = '\u{1F1EC}\u{1F1E7}';
  const tiers = [DE, NL, US, TR];
  const blocks = T.aiBlocks(tiers);
  const cascade = blocks.groups.split('\n').find((l) => l.startsWith('RH-AI-W'));
  const names = cascade.split(', ').filter((s) => s.indexOf('RH-Filter-W-AI') === 0);
  const iEu = names.indexOf('RH-Filter-W-AIeu');
  const iRest = names.indexOf('RH-Filter-W-AIrest');
  assert.ok(iEu > 0, 'AIeu должен присутствовать в каскаде');
  // Турция — регион 3, её тир обязан идти ПОСЛЕ европейского остатка.
  const tierLines = blocks.filters.split('\n');
  const trFilter = tierLines.find((l) => l.indexOf(TR) >= 0 && l.indexOf('-W-') >= 0);
  const trName = trFilter.split(' =')[0];
  assert.ok(iEu < names.indexOf(trName), 'AIeu обязан стоять выше тира Турции');
  assert.ok(names.indexOf(trName) < iRest, 'общий AIrest — последний');
  const euLine = tierLines.find((l) => l.indexOf('W-AIeu') >= 0);
  assert.ok(euLine.indexOf(GB) >= 0, 'AIeu обязан ловить Великобританию');
  assert.ok(euLine.indexOf(DE) < 0, 'занятая тиром DE в AIeu попадать не должна');
});

test('AIrest не пересекается с региональными остатками', () => {
  const blocks = T.aiBlocks([DE, NL]);
  const line = blocks.filters.split('\n').find((l) => l.indexOf('W-AIrest') >= 0);
  for (const fl of [RUF, KZ, US, '\u{1F1EC}\u{1F1E7}']) {
    assert.ok(line.indexOf(fl) >= 0, 'в исключениях AIrest нет ' + fl);
  }
});

test('cascadeOf раскладывает узлы по тирам конфига', () => {
  const lines = [
    nodeLine('[VPN] ' + DE + ' Германия #1'),
    nodeLine('[VPN] ' + US + ' США #1'),
    nodeLine('[VPN] ' + KZ + ' Казахстан #1'),
    nodeLine('[VPN] ' + TR + ' Турция #1'),
    nodeLine('[Игры] ' + DE + ' Германия #1'),
    nodeLine('[Обход] ' + DE + ' Германия'),
  ];
  const state = {};
  state[T.matchKey('[VPN] ' + DE + ' Германия #1')] = { w: { down: 10, rtt: 40 } };
  state[T.matchKey('[VPN] ' + US + ' США #1')] = { w: { dead: true } };
  const c = T.cascadeOf(lines, state);
  assert.deepEqual(c.EU, { total: 1, live: 1 });
  assert.deepEqual(c.AM, { total: 1, live: 0 }, 'dead живым не считается');
  assert.deepEqual(c.RU, { total: 1, live: 0 });
  assert.deepEqual(c.REST, { total: 1, live: 0 });
  assert.deepEqual(c.GAME, { total: 1, live: 0 });
  assert.deepEqual(c.BYPASS, { total: 1, live: 0 });
});
