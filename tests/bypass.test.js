// Признак обходного узла на стенде Stash (перенос Worker v1.11.1 из main,
// 21.09). Запуск: node --test tests/*.test.js
//
// Обход — слово «Обход» в ЛЮБОМ месте имени, как в конфиге Loon:
// RH-Filter-Обход = NameKeyword «Обход», VPN-фильтры — «^(?!.*Обход)».
// Прежний признак — подстрока '[Обход' — пропускал значок внутри скобок
// («[🌀 Обход]»).
//
// ПОЧЕМУ ДЛЯ STASH ЭТО ГЛАВНОЕ. У Loon правило 1 держат ещё и регулярки
// конфига; у Stash страховки нет — раскладку по группам решает только tagOf
// (clients/stash-order.js). Нераспознанный обход с «VPN]» получал тег vpn и
// вставал в страновой тир: для 🇩🇪 это ранг 0 в RH-AI, выше всех обычных узлов
// прочих стран. Без «VPN]» — тег other, узел выпадал из профиля совсем,
// включая RH-Обход. Мутация «вернуть '[Обход'» обязана ронять этот файл.
//
// ОГОВОРКА О СХЕМЕ СТЕНДА. Обходные узлы по замыслу S-draft-5 стоят в КАЖДОЙ
// рабочей группе — последним звеном каскада (см. clients-stash.test.js,
// «обходной последний»). Поэтому правило 1 здесь формулируется как «строго
// после всех обычных узлов», а не «отсутствует в группе».

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { T, DE, NL, US } from './harness.js';
import { nodeLine } from './mock-d1.js';

const ROOT = path.resolve(import.meta.dirname, '..');

test('tagOf: обход распознаётся по слову в любом месте имени', () => {
  for (const n of [
    '[Обход] ' + DE + ' Германия #1',
    '[🌀 Обход] ' + DE + ' Германия #1',
    DE + ' 🙏 Германия [🌀 Обход]',
    DE + ' Германия Обход МТС',
    // Самый опасный случай для узкого признака: без '[Обход' имя ушло бы в vpn.
    DE + ' Германия [🌀 Обход VPN] #1',
  ]) assert.equal(T.tagOf(n), 'bypass', n);
});

test('tagOf: обычные узлы без слова «Обход» обходом не считаются', () => {
  assert.equal(T.tagOf('[VPN] ' + DE + ' Германия #1'), 'vpn');
  assert.equal(T.tagOf(DE + ' ⚡⭐ Германия [🌀 VPN]'), 'vpn');
  assert.equal(T.tagOf('🇫🇮 🕹 Финляндия [Игры] #1'), 'game');
  assert.equal(T.tagOf(DE + ' Германия #1'), 'other');
});

// Похожие слова решены явно, по правилам конфига Loon. «Обходной» содержит
// «Обход» — NameKeyword конфига его поймает, значит и Worker (ложное «обход»
// стоит узла, пропущенное — платного трафика). Строчное «обход» регулярка
// «^(?!.*Обход)» НЕ исключает: Worker с ней согласован.
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

test('Loon aiBlocks: регулярки исключения обхода прежние', () => {
  const b = T.LOON.aiBlocks([DE, NL]);
  const text = JSON.stringify(b);
  assert.ok(text.indexOf('FilterKey = ^(?!.*Обход).*' + DE + '.*VPN].*') >= 0, 'тир DE');
  assert.ok(text.indexOf('^(?!.*(Обход|') >= 0, 'AIrest');
});

// ── ПРАВИЛО 1 ДЛЯ STASH ─────────────────────────────────────────────────
// Обычные узлы с замерами, обходной — 🇩🇪 со словом VPN в скобке. Обходной
// обязан стоять ПОСЛЕ ВСЕХ обычных узлов в каждой рабочей группе (-W и -C),
// а не в тире своей страны, и обязан быть членом RH-Обход.

const BYP = DE + ' Германия [🌀 Обход VPN] #1';
const BYP2 = DE + ' Германия [🌀 Обход] #2';     // без «VPN]»: прежде тег other
const NORMAL = ['[VPN] ' + DE + ' Германия #1', '[VPN] ' + NL + ' Нидерланды #1', '[VPN] ' + US + ' США #1'];
const LINES = NORMAL.concat([BYP, BYP2]).map(nodeLine);
function m(down, rtt) { return { down: down, rtt: rtt, jit: 3, bl: 5 }; }
const STATE = {
  [NORMAL[0]]: { w: m(90, 40), c: m(80, 45) },
  [NORMAL[1]]: { w: m(50, 60), c: m(40, 70) },
  [NORMAL[2]]: { w: m(70, 90), c: m(60, 95) },
};

function byName(list) {
  const out = {};
  list.forEach(function (g) { out[g.name] = g; });
  return out;
}

test('Stash, правило 1: обход 🇩🇪 не встаёт в тир страны ни в RH-AI, ни в RH-АВТО', () => {
  const G = byName(T.STASH_PROFILE.profileGroups(LINES, STATE, {}));
  for (const gname of ['RH-AI-W', 'RH-AI-C', 'RH-АВТО-W', 'RH-АВТО-C', 'RH-Звонки-W', 'RH-Звонки-C']) {
    const p = G[gname].proxies;
    assert.ok(Array.isArray(p) && p.length, gname + ': пустая группа');
    assert.ok(p[0].indexOf('Обход') < 0, gname + ': обходной узел открывает каскад');
    const firstByp = p.findIndex(function (n) { return n.indexOf('Обход') >= 0; });
    assert.ok(firstByp >= 0, gname + ': обходного звена нет в хвосте каскада');
    const lastNormal = p.reduce(function (acc, n, i) { return n.indexOf('Обход') < 0 ? i : acc; }, -1);
    assert.ok(lastNormal < firstByp,
      gname + ': обычный узел стоит ниже обходного — обход попал в тир страны: ' + JSON.stringify(p));
  }
});

test('Stash, правило 1: оба обходных узла — члены RH-Обход', () => {
  const G = byName(T.STASH_PROFILE.profileGroups(LINES, STATE, {}));
  const p = G['RH-Обход'].proxies;
  assert.ok(p.indexOf('DIRECT') < 0, 'RH-Обход выродился в DIRECT — обход не распознан');
  assert.deepEqual(p.slice().sort(), [BYP, BYP2].sort());
  const names = T.STASH.nodeSet(LINES, STATE, {}).items.map(function (it) { return it.base; });
  assert.ok(names.indexOf(BYP2) >= 0, 'обход без «VPN]» выпал из профиля');
});

test('Stash, правило 1: обход — единственный узел 🇩🇪 — тира DE не создаёт', () => {
  const lines = [BYP, '[VPN] ' + NL + ' Нидерланды #1'].map(nodeLine);
  assert.deepEqual(T.buildAiTiers(lines, {}), []);
  const G = byName(T.STASH.buildGroups(lines, {}, {}));
  assert.equal(G['RH-AI-W'].proxies[0], '[VPN] ' + NL + ' Нидерланды #1', 'обход открыл RH-AI');
});

// Сборщик Stash и проба ST15 держат свой признак (скрипты устройства, в
// Worker не импортируются). Сторож расхождения: если одна сторона сузит или
// переименует слово, раскладка профиля и первый рубеж скрипта разойдутся.
test('признак обхода Worker\'а совпадает со сборщиком Stash и пробой ST15', () => {
  for (const f of ['scripts/routehub-stash-collect.js', 'probes/routehub-probe-stash15.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const m = src.match(/^var BYPASS = '([^']*)';/m);
    assert.ok(m, f + ': константа BYPASS не найдена');
    assert.equal(m[1], T.BYPASS_WORD, f);
    assert.ok(/indexOf\(BYPASS\) >= 0/.test(src), f + ': isBypass перестал искать слово в любом месте');
  }
});
