// Признак обходного узла (Worker v1.11.1). Запуск: node --test "tests/*.test.js"
//
// Обход — слово «Обход» в ЛЮБОМ месте имени, как в боевом конфиге:
// RH-Filter-Обход = NameKeyword «Обход», VPN-фильтры — «^(?!.*Обход)». Так же
// с v0.7.0 работает isBypass() в scripts/routehub-speedtest.js. Прежний
// признак Worker'а — подстрока '[Обход' — пропускал значок внутри скобок
// («[🌀 Обход]»). Мутация «вернуть '[Обход'» обязана ронять этот файл.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { nodeLine } from './mock-d1.js';
import { T, DE, NL } from './harness.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts/routehub-speedtest.js'), 'utf8');

test('tagOf: обход распознаётся по слову в любом месте имени', () => {
  for (const n of [
    '[Обход] ' + DE + ' Германия #1',
    '[🌀 Обход] ' + DE + ' Германия #1',
    DE + ' 🙏 Германия [🌀 Обход]',
    DE + ' Германия Обход МТС',
    // Самый опасный случай для узкого признака: без '[Обход' имя ушло бы в vpn.
    DE + ' Германия [🌀 Обход VPN]',
  ]) assert.equal(T.tagOf(n), 'bypass', n);
});

test('tagOf: обычные узлы без слова «Обход» обходом не считаются', () => {
  assert.equal(T.tagOf('[VPN] ' + DE + ' Германия #1'), 'vpn');
  assert.equal(T.tagOf(DE + ' ⚡⭐ Германия [🌀 VPN]'), 'vpn');
  assert.equal(T.tagOf('🇫🇮 🕹 Финляндия [Игры] #1'), 'game');
  assert.equal(T.tagOf(DE + ' Германия #1'), 'other');
});

// Похожие слова решены явно, по правилам конфига. «Обходной» содержит
// «Обход» — NameKeyword конфига и isBypass() его поймают, значит и Worker
// (ложное «обход» стоит узла, пропущенное — платного трафика). Строчное
// «обход» регулярка «^(?!.*Обход)» конфига НЕ исключает: Worker с ней
// согласован и такой узел обходом не считает.
test('tagOf: «Обходной» — обход, строчное «обход» — нет (как в конфиге)', () => {
  assert.equal(T.tagOf(DE + ' Германия [Обходной] #1'), 'bypass');
  assert.equal(T.tagOf(DE + ' Германия [обход VPN]'), 'vpn');
  assert.equal(T.BYPASS_WORD, 'Обход');
});

test('renderNodesBoth: обход со значком в скобках — один раз и без метки сети', () => {
  const byp = '[🌀 Обход] ' + DE + ' Германия';
  const lines = [nodeLine('[VPN] ' + DE + ' Германия #1'), nodeLine(byp)];
  const out = T.renderNodesBoth(lines, {}, false).split('\n');
  assert.equal(out.length, 3, 'ожидались Wi-Fi + сотовый + один обходной');
  const names = out.map((l) => T.decodeName(T.fragOf(l)));
  assert.equal(names.filter((n) => n.indexOf('Обход') >= 0).length, 1);
  assert.equal(names[2], byp, 'обходной — в хвосте, без 🛜/📱');
});

test('buildAiTiers: обходной узел со словом VPN тир стране не даёт', () => {
  const lines = [
    nodeLine('[VPN] ' + DE + ' Германия #1'),
    nodeLine(NL + ' Нидерланды [🌀 Обход VPN] #1'),
    nodeLine(NL + ' Нидерланды [🌀 Обход VPN] #2'),
  ];
  assert.deepEqual(T.buildAiTiers(lines, {}), [DE]);
});

test('cascadeOf: обход со значком в скобках — в тире BYPASS', () => {
  const c = T.cascadeOf([nodeLine('[🌀 Обход] ' + DE + ' Германия')], {});
  assert.deepEqual(c.BYPASS, { total: 1, live: 0 });
});

test('признак обхода у Worker\'а и isBypass() спидтеста совпадает в обе стороны', () => {
  // Песочница по ветке «битый argument»: main() выходит сразу, предикат остаётся.
  const S = { console: { log() {} }, JSON, Math, Date, Object, Array, String, Number, parseInt,
    $argument: '', $persistentStore: { read: () => null, write: () => true }, $done() {} };
  vm.createContext(S); vm.runInContext(SCRIPT, S);
  for (const n of ['[Обход] x', '[🌀 Обход] x', 'x Обход y', '[Обходной] x',
    '[обход VPN] x', '[VPN] ' + DE + ' Германия #1', '[🌀 VPN] ' + NL + ' 🛜']) {
    assert.equal(T.tagOf(n) === 'bypass', S.isBypass(n), n);
  }
});
