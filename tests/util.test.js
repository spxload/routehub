// Тесты констант и чистых утилит ядра: параметры, разбор имён узлов,
// нормализация ключа метрики, регионы.
// Выделено из tests/routehub-worker.test.js 2026-08-25 (ветка stash-client):
// файл перерос 29 КБ. Тесты перенесены дословно.
//
// Загрузка Worker'а и общие помощники — в tests/harness.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { T, DE, NL, US, KZ, TR, WIFI } from './harness.js';

// ---------------------------------------------------------------- параметры
test('FRESH_MS = 60 минут', () => {
  assert.equal(T.FRESH_MS, 60 * 60 * 1000);
});

// Версию намеренно НЕ хардкодим: иначе каждый релиз требует правки тестов.
// Проверяем формат и то, что панель отдаёт ту же строку, что лежит в const.js.
test('версия Worker\'а имеет вид vX.Y.Z', () => {
  assert.match(T.WORKER_VER, /^v\d+\.\d+\.\d+$/);
});

// ------------------------------------------------------------------- tagOf
// Провайдер меняет значки внутри скобочного тега, поэтому критерий — слово
// в теге, а не точная подстрока '[VPN]'. Порядок: обход -> игры -> VPN.
test('tagOf: обычный VPN-узел', () => {
  assert.equal(T.tagOf('[VPN] ' + DE + ' Германия #1'), 'vpn');
  assert.equal(T.tagOf(DE + ' ⚡⭐ Германия [VPN]'), 'vpn');
});

test('tagOf: значок внутри скобок не мешает — [🌀 VPN] это vpn', () => {
  assert.equal(T.tagOf(DE + ' ⚡⭐ Германия [\u{1F300} VPN]'), 'vpn');
  assert.equal(T.tagOf(NL + ' ⚡⭐ Нидерланды [\u{1F300} VPN] · ' + WIFI + '▅'), 'vpn');
});

test('tagOf: игровой узел', () => {
  assert.equal(T.tagOf('\u{1F1EB}\u{1F1EE} \u{1F579} Финляндия [Игры] #1'), 'game');
});

test('tagOf: обходной узел — bypass, даже если в имени встретится VPN', () => {
  assert.equal(T.tagOf(' ' + DE + ' \u{1F64F} Германия [Обход - МТС]'), 'bypass');
  assert.equal(T.tagOf(DE + ' Германия [Обход - VPN]'), 'bypass');
});

test('tagOf: посторонние имена — other', () => {
  assert.equal(T.tagOf(DE + ' Германия #1'), 'other');
  assert.equal(T.tagOf(''), 'other');
});

test('matchKey срезает метрику и нормализует пробелы', () => {
  const nm = '[VPN] ' + DE + ' Германия  #1 · ' + WIFI + '▅ ⁷⁵';
  assert.equal(T.matchKey(nm), '[VPN] ' + DE + ' Германия #1');
});

// ------------------------------------------------------------------ регионы
test('regionOf: Европа/Америка/СНГ/прочие', () => {
  assert.equal(T.regionOf(DE), 0);
  assert.equal(T.regionOf(US), 1);
  assert.equal(T.regionOf(KZ), 2);
  assert.equal(T.regionOf(TR), 3);
  assert.equal(T.regionOf('нет такого'), 3);
});
