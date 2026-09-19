// Устойчивый джиттер в скрипте замеров — ЗАМЕРЫ_И_ВЕСА.md, предложение 1.
//
// ЗАЧЕМ ЭТОТ ФАЙЛ. Правка уже сделана (`routehub-speedtest.js` v0.6.2,
// 16.08): `RTT_SAMPLES` 3 → 5, `jit` считается усечённым размахом. Тестом она
// не закрывалась — скрипт устройства вообще не был ничем покрыт, хотя именно
// он производит половину того, на чём Worker строит порядок узлов. Молчаливый
// откат `RTT_SAMPLES` к трём или возврат к `max − min` вернул бы срез с
// `jit` 23 726 мс, и заметить это было бы негде.
//
// ПОЧЕМУ ПЕСОЧНИЦА, А НЕ import. Скрипт — не модуль: это ES5 для движка Loon
// с `$`-объектами из его окружения. `node:vm` даёт такой контекст — тот же
// приём, что и в `probes-smoke.test.js`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts/routehub-speedtest.js'), 'utf8');

// $argument не задан, поэтому main() уходит по ветке «битый argument»,
// вызывает $done и ничего не меряет; объявленные через function/var
// jitterOf, median и RTT_SAMPLES остаются в контексте.
function loadScript() {
  const store = {};
  const ctx = {
    console: { log: () => {} },
    JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, isFinite, encodeURIComponent, decodeURIComponent,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)),
    clearTimeout,
    $persistentStore: {
      read: (k) => (k in store ? store[k] : null),
      write: (v, k) => { store[k] = v; return true; },
    },
    $httpClient: { get: () => {}, post: () => {} },
    $done: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { timeout: 5000 });
  return ctx;
}

const S = loadScript();

test('проб пять: на трёх отбрасывать нечего', () => {
  assert.equal(S.RTT_SAMPLES, 5);
});

test('jitterOf: усечённый размах гасит одиночный выброс', () => {
  // Пример из CHANGELOG (speedtest v0.6.2): полный размах дал бы 2950.
  assert.equal(S.jitterOf([50, 52, 55, 58, 3000]), 6);
  // Чистый набор считается как прежде — отбрасывание не занижает джиттер
  // там, где его действительно много.
  assert.equal(S.jitterOf([50, 52, 55, 58, 60]), 6);
  assert.equal(S.jitterOf([50, 150, 250, 350, 450]), 200,
    'настоящий большой джиттер обязан дойти до Worker\'а');
});

test('отбрасываются крайние ПО ЗНАЧЕНИЮ, а не по порядку прихода', () => {
  // Здесь снимается кажущееся противоречие с правилом памяти проекта
  // «первый замер систематически занижен — брать медиану без первого».
  // Правило записано про СКОРОСТЬ (8,8 против 17,8 Мбит/с); скорость меряется
  // одним заходом (rateOf), а не массивом, и медианы по ней нет вовсе.
  // Здесь же массив ПИНГ-проб, у которого холодная первая проба обычно,
  // наоборот, самая ДОЛГАЯ. Усечение идёт по значению после сортировки,
  // поэтому крайняя проба снимается независимо от того, где она стояла,
  // и отдельное правило «выбросить первую» не нужно.
  assert.equal(S.jitterOf([3000, 50, 52, 55, 58]), 6, 'выброс пришёл первым');
  assert.equal(S.jitterOf([50, 52, 3000, 55, 58]), 6, 'выброс пришёл в середине');
  assert.equal(S.jitterOf([50, 52, 55, 58, 3000]), 6, 'выброс пришёл последним');
});

test('при неполном наборе проб поведение прежнее — полный размах', () => {
  // Часть проб может не ответить: rttSamples складывает в массив только
  // успешные. Отбрасывать из трёх нечего, это заявлено в v0.6.2.
  assert.equal(S.jitterOf([50, 58, 3000]), 2950);
  assert.equal(S.jitterOf([50, 58]), 8);
  assert.equal(S.jitterOf([50]), 0);
});

test('median: середина по значению, пустой набор — null', () => {
  assert.equal(S.median([58, 50, 3000, 52, 55]), 55);
  assert.equal(S.median([50, 60]), 55);
  assert.equal(S.median([]), null);
});
