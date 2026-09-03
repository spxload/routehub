// СЦЕПКА СБОРЩИКА С РЕНДЕРЕРОМ ПРОФИЛЯ.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ НАБОР. `tests/stash-collect.test.js` гоняет сборщик в
// песочнице с ПОДСТАВНЫМ контроллером: он проверяет поведение скрипта, но
// ничего не знает о том, что на самом деле лежит в профиле. А сборщик держит
// у себя ЗАШИТЫЕ ИМЕНА — `RH-АВТО-W`, `RH-АВТО-C`, три родительские группы,
// пометку обходного узла, разделитель метрик. Все они приходят из
// `src/clients/stash*.js`, и связь между двумя файлами не выражена ничем,
// кроме совпадения строк.
//
// ЦЕНА РАСХОЖДЕНИЯ. Переименуй группу в рендерере — сборщик не упадёт и не
// пожалуется: он просто не найдёт пул, объявит «сеть не определена» и будет
// молча ничего не собирать прогон за прогоном. Это ровно тот класс отказа,
// который проект уже ловил дважды (тихо отброшенные члены групп, набор
// правил с `ruleCount: 0`): всё выглядит рабочим, а результата нет.
//
// ПОЭТОМУ ЗДЕСЬ имена не переписываются от руки, а ВЫНИМАЮТСЯ ИЗ ФАЙЛА
// сборщика регулярным выражением и сверяются с тем, что рендерер реально
// кладёт в профиль. Набор ломается при переименовании с любой стороны.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { T, DE, NL, US, KZ } from './harness.js';
import { nodeLine } from './mock-d1.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts/routehub-stash-collect.js'), 'utf8');

// ── Вынимаем константы сборщика из его исходника ─────────────────────
function strConst(name) {
  const m = SRC.match(new RegExp('^var ' + name + " = '([^']*)';", 'm'));
  assert.ok(m, 'в сборщике не найдена строковая константа ' + name);
  return m[1];
}
function arrConst(name) {
  const m = SRC.match(new RegExp('^var ' + name + ' = \\[([^\\]]*)\\];', 'm'));
  assert.ok(m, 'в сборщике не найден массив ' + name);
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

const C = {
  PARENTS: arrConst('PARENTS'),
  POOL_W: strConst('POOL_W'),
  POOL_C: strConst('POOL_C'),
  BYPASS: strConst('BYPASS'),
  METRIC_SEP: strConst('METRIC_SEP'),
};

// ── Профиль на подставной подписке ───────────────────────────────────
const NAMES = {
  de: '[VPN] ' + DE + ' Германия #1',
  nl: '[VPN] ' + NL + ' Нидерланды #1',
  us: '[VPN] ' + US + ' США #1',
  kz: '[VPN] ' + KZ + ' Казахстан #1',
  byp: '[Обход] ' + NL + ' Нидерланды #7',
};
const LINES = Object.values(NAMES).map(nodeLine);
const M = (down, rtt) => ({ down, rtt, jit: 5, bl: 10 });
const STATE = {
  [NAMES.de]: { w: M(90, 40), c: M(5, 200) },
  [NAMES.nl]: { w: M(50, 60), c: M(40, 70) },
  [NAMES.us]: { w: M(70, 90), c: M(60, 95) },
  [NAMES.kz]: { w: M(95, 20), c: M(95, 20) },
};

const GROUPS = {};
T.STASH.buildGroups(LINES, STATE, {}).forEach((g) => { GROUPS[g.name] = g; });

test('родительские группы сборщика существуют в профиле и несут ssid-policy', () => {
  for (const p of C.PARENTS) {
    assert.ok(GROUPS[p], 'сборщик ждёт родителя ' + p + ', а рендерер такой группы не делает');
    assert.ok(GROUPS[p]['ssid-policy'], 'у ' + p + ' нет ssid-policy — сборщику нечего читать');
  }
});

test('сеть читается по хвосту -W/-C: именно на этом стоит определение сети', () => {
  // Сборщик берёт последние два символа имени члена, на который смотрит
  // родитель, и по ним решает, Wi-Fi это или сотовая. Если рендерер когда-то
  // назовёт детей иначе, определение сети сломается молча.
  for (const p of C.PARENTS) {
    const sp = GROUPS[p]['ssid-policy'];
    assert.equal(sp.default.slice(-2), '-W', 'член по умолчанию у ' + p + ' не оканчивается на -W');
    assert.equal(sp.cellular.slice(-2), '-C', 'сотовый член у ' + p + ' не оканчивается на -C');
  }
});

test('пул сборщика — существующие группы, и он же родительский член', () => {
  assert.ok(GROUPS[C.POOL_W], 'нет группы ' + C.POOL_W);
  assert.ok(GROUPS[C.POOL_C], 'нет группы ' + C.POOL_C);
  // Пул обязан быть тем же, на который смотрит родитель: иначе сборщик мерил
  // бы один набор узлов, а трафик шёл через другой.
  const parent = C.POOL_W.replace(/-W$/, '');
  assert.ok(C.PARENTS.includes(parent), 'пул ' + C.POOL_W + ' не принадлежит ни одному родителю');
  assert.equal(GROUPS[parent]['ssid-policy'].default, C.POOL_W);
  assert.equal(GROUPS[parent]['ssid-policy'].cellular, C.POOL_C);
});

test('обходной узел опознаётся пометкой, которую ищет сборщик (правило 1)', () => {
  const members = GROUPS[C.POOL_W].proxies;
  const byp = members.filter((n) => n.indexOf(C.BYPASS) >= 0);
  assert.equal(byp.length, 1, 'пометка «' + C.BYPASS + '» не находит обходной узел в профиле');
  // И обратно: рабочие узлы под неё не подпадают, иначе сборщик выбросил бы
  // половину пула и молча мерил меньше, чем думает.
  assert.equal(members.length - byp.length, 4, 'под пометку обхода попали рабочие узлы');
});

test('члены пула проходят фильтр looksLikeNode сборщика', () => {
  // Сборщик отбрасывает членов без скобки в имени: так отсеиваются служебные
  // политики. Если провайдер однажды сменит формат имён, пул опустеет.
  const re = /\[/;
  for (const n of GROUPS[C.POOL_W].proxies) {
    assert.ok(n.length >= 5 && re.test(n), 'член пула не пройдёт фильтр сборщика: ' + n);
  }
});

test('разделитель метрик один и тот же, и baseName обращает метку узла', () => {
  assert.equal(C.METRIC_SEP, T.METRIC_SEP, 'сборщик и ядро разошлись в разделителе метрик');
  // ЭТО ТОТ САМЫЙ ДЕФЕКТ, который ревью нашло в v0.1.0: имя узла в профиле
  // несёт метрики и меняется при каждой перевыдаче конфига, поэтому ключом
  // кэша обязано быть базовое имя. Проверяется с обеих сторон сразу.
  const labeled = GROUPS[C.POOL_W].proxies.filter((n) => n.indexOf(C.METRIC_SEP) >= 0);
  assert.ok(labeled.length >= 4, 'рендерер не поставил метрики в имена — проверять нечего');
  for (const full of labeled) {
    const base = full.slice(0, full.indexOf(C.METRIC_SEP)).replace(/^\s+|\s+$/g, '');
    assert.ok(base.length > 0 && base.indexOf(C.METRIC_SEP) < 0);
    assert.ok(full.startsWith(base), 'базовое имя не является началом полного');
  }
});

test('без единого замера имена ЧИСТЫЕ — переход к меткам не должен стирать кэш', () => {
  // Стенд сейчас именно в этом состоянии: замеров нет, метки пусты. Первая же
  // выгрузка сборщика добавит хвост метрик ко ВСЕМ именам разом. Кэш обязан
  // это пережить, поэтому базовое имя до и после перехода должно совпасть.
  const clean = {};
  T.STASH.buildGroups(LINES, {}, {}).forEach((g) => { clean[g.name] = g; });
  const before = clean[C.POOL_W].proxies;
  const after = GROUPS[C.POOL_W].proxies;
  assert.equal(before.length, after.length);
  for (const n of before) {
    assert.ok(n.indexOf(C.METRIC_SEP) < 0, 'без замеров метка не должна появляться: ' + n);
  }
  const baseOf = (s) => {
    const i = s.indexOf(C.METRIC_SEP);
    return (i >= 0 ? s.slice(0, i) : s).replace(/^\s+|\s+$/g, '');
  };
  assert.deepEqual(after.map(baseOf).sort(), before.map(baseOf).sort(),
    'базовые имена до и после появления метрик разошлись — кэш сборщика обнулится');
});
