// Постоянный override лаборатории Stash (plugins/RouteHub-Stash-Lab.stoverride)
// и текущий опыт в нём (probes/routehub-lab.js).
//
// ЗАЧЕМ. Раньше каждая проба ставилась своим override по новой ссылке. Теперь
// ссылка одна: Stash сам перекачивает probes/routehub-lab.js (interval 300),
// а мы меняем только файлы в репозитории. Отсюда два риска, которые
// сторожит этот файл: (1) копия опыта в routehub-lab.js тихо разойдётся с
// файлом пробы, у которого есть свои тесты; (2) постоянный override
// обрастёт правилами, MITM или обходом — а стоит он на устройстве всегда.
//
// КАК СМЕНИТЬ ОПЫТ.
//   1. Завести пробу обычным путём: probes/routehub-probe-stashNN.js со своим
//      тестом, строки в src/files.js и tests/probes-smoke.test.js.
//   2. Скопировать её байт в байт: cp probes/routehub-probe-stashNN.js
//      probes/routehub-lab.js.
//   3. Поменять LAB_SOURCE ниже на путь новой пробы (единственный указатель).
//   4. Опыту нужны свои узлы / группы — править секции proxies / proxy-groups
//      в override и ожидания LAB_NODES / LAB_GROUPS ниже; Диане — «обновить»
//      override в Stash. Сменился только скрипт — Диана ничего не делает.
// ХОЛОСТОЙ РЕЖИМ (опыта нет, cron крутится вхолостую): probes/routehub-lab.js
//   = одна строка `$done({});`, LAB_SOURCE = 'idle'.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { T } from './harness.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── ЕДИНСТВЕННЫЙ УКАЗАТЕЛЬ ТЕКУЩЕГО ОПЫТА ────────────────────────────────
const LAB_SOURCE = 'probes/routehub-probe-stash21.js';
// Узлы и группы опыта в override — ровно эти строки (формат фиксирован).
const LAB_NODES = [
  '  - name: RH-Прямо-RU', '    type: direct', '    benchmark-url: http://ya.ru/', '    benchmark-timeout: ' + T.STASH.BENCH_TIMEOUT];
const LAB_GROUPS = [
  '  - name: RH-Тест-RU', '    type: url-test', '    interval: 60', '    lazy: false', '    proxies:', '      - RH-Прямо-RU'];

const LAB = 'probes/routehub-lab.js';
const OV_PATH = 'plugins/RouteHub-Stash-Lab.stoverride';
const OV = read(OV_PATH);
const LAB_TEXT = read(LAB);
const IDLE_RE = /^\$done\(\{\}\);?\n?$/;
const RAW = 'https://raw.githubusercontent.com/spxload/routehub/stash-client/';

// Проверка копии. null — всё в порядке, иначе текст причины.
function checkLab(labText, pointer, srcText) {
  if (pointer === 'idle') return IDLE_RE.test(labText) ? null : 'указатель idle, а routehub-lab.js не одна строка $done({})';
  if (!/^probes\/routehub-probe-[\w-]+\.js$/.test(pointer)) return 'указатель не на файл пробы: ' + pointer;
  if (typeof srcText !== 'string') return 'файла пробы нет: ' + pointer;
  if (!Buffer.from(labText, 'utf8').equals(Buffer.from(srcText, 'utf8'))) return 'routehub-lab.js разошёлся с ' + pointer;
  return null;
}
const srcOf = (p) => (p !== 'idle' && fs.existsSync(path.join(ROOT, p)) ? read(p) : undefined);
const IDLE = LAB_SOURCE === 'idle';
const SRC = srcOf(LAB_SOURCE);

// Строки override без комментариев и пустых; секции верхнего уровня.
const BODY = OV.split('\n').filter((l) => l.trim() && !/^\s*#/.test(l));
const TOP = BODY.filter((l) => /^\S/.test(l)).map((l) => l.replace(/:.*$/, ''));
function section(key) {
  const at = BODY.indexOf(key + ':');
  assert.ok(at >= 0, 'нет секции ' + key);
  const out = [];
  for (let i = at + 1; i < BODY.length && /^\s/.test(BODY[i]); i++) out.push(BODY[i]);
  return out;
}
// Код без комментариев — для сторожей правил 1–2.
const bare = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// ── КОПИЯ ОПЫТА ──────────────────────────────────────────────────────────
test('routehub-lab.js — байт в байт файл пробы из LAB_SOURCE (или холостая строка при idle)', () => {
  assert.equal(checkLab(LAB_TEXT, LAB_SOURCE, SRC), null);
  if (!IDLE) assert.notEqual(LAB_SOURCE, LAB, 'указатель на саму копию');
});

test('проверка копии ловит расхождение, чужой указатель и мусор в холостом режиме', () => {
  const probe = read('probes/routehub-probe-stash21.js');
  assert.equal(checkLab(probe, 'probes/routehub-probe-stash21.js', probe), null);
  assert.match(checkLab(probe + ' ', 'probes/routehub-probe-stash21.js', probe), /разошёлся/);
  assert.match(checkLab(probe, 'probes/routehub-probe-stash20.js', read('probes/routehub-probe-stash20.js')), /разошёлся/);
  assert.match(checkLab(probe, 'probes/routehub-probe-nope.js', undefined), /нет/);
  assert.match(checkLab(probe, 'plugins/RouteHub-Stash-Lab.stoverride', OV), /не на файл пробы/);
  for (const ok of ['$done({});\n', '$done({})\n', '$done({});']) assert.equal(checkLab(ok, 'idle'), null, JSON.stringify(ok));
  for (const bad of [probe, '', '$done({});\n$httpClient.get({url: "x"}, function () {});\n', '$done({ content: "x" });\n', '// $done({});\n']) {
    assert.match(checkLab(bad, 'idle') || '', /idle/, JSON.stringify(bad.slice(0, 40)));
  }
});

test('холостая строка в песочнице: ровно один $done, ни одного запроса', () => {
  let done = 0, calls = 0;
  const http = new Proxy({}, { get: () => () => { calls++; } });
  vm.runInNewContext('$done({});\n', { $done: () => { done++; }, $httpClient: http });
  assert.equal(done, 1);
  assert.equal(calls, 0);
});

test('текущий опыт не пишет в маршрутизацию: у $httpClient только get, без /delay и PUT', () => {
  if (IDLE) { assert.match(LAB_TEXT, IDLE_RE); return; }
  const code = bare(LAB_TEXT);
  assert.ok(code.indexOf('/delay') < 0, 'в опыте /delay (замер — запись в маршрутизацию)');
  const used = [...code.matchAll(/\$httpClient\s*(?:\.\s*(\w+)|\[)/g)].map((m) => m[1] || '[');
  assert.deepEqual([...new Set(used)], ['get'], 'у $httpClient не только get: ' + used.join(','));
  for (const w of ['setSelectPolicy', 'setRunningModel', "'PUT'", '"PUT"', "'PATCH'", "'DELETE'"]) {
    assert.ok(code.indexOf(w) < 0, 'в опыте ' + w);
  }
});

// ── OVERRIDE: СКРИПТ, CRON, ПЛИТКА ───────────────────────────────────────
test('script-providers: rh-lab на routehub-lab.js ветки stash-client, interval 300', () => {
  assert.deepEqual(section('script-providers'), [
    '  rh-lab:', '    url: ' + RAW + LAB, '    interval: 300']);
  assert.ok(OV.indexOf('install-override/raw.githubusercontent.com/spxload/routehub/stash-client/' + OV_PATH) > 0, 'в шапке нет ссылки установки');
});

test('cron раз в минуту и плитка — на rh-lab', () => {
  const cron = section('cron');
  assert.deepEqual(cron.slice(0, 3), ['  script:', '    - name: rh-lab', "      cron: '* * * * *'"]);
  assert.match(cron[3], /^ {6}timeout: \d+$/);
  const tiles = section('tiles');
  assert.equal(tiles[0], '  - name: rh-lab');
  assert.ok(tiles.indexOf("    title: 'RouteHub Lab'") > 0);
});

// Худший честный путь пробы — сторож GUARD_MS (он позже бюджета и повтора,
// см. тест самой пробы). cron не должен обрывать прогон раньше.
test('timeout cron не меньше сторожа и бюджета текущего опыта (ST14)', () => {
  const to = Number(/^ {6}timeout: (\d+)$/m.exec(OV)[1]) * 1000;
  assert.ok(to > 0);
  if (IDLE) return;
  const num = (k) => { const m = SRC.match(new RegExp('var ' + k + ' = (\\d+)')); assert.ok(m, 'в опыте нет ' + k); return Number(m[1]); };
  assert.ok(to >= num('GUARD_MS'), 'cron обрывает прогон (' + to + ' мс) раньше сторожа (' + num('GUARD_MS') + ' мс)');
  assert.ok(to >= num('BUDGET_MS'), 'cron обрывает прогон раньше бюджета');
});

// ── OVERRIDE: ЧЕГО В НЁМ БЫТЬ НЕ МОЖЕТ ──────────────────────────────────
test('верхний уровень — только скрипт, cron, плитка, узлы и группы; ни правил, ни MITM, ни DNS', () => {
  const allowed = ['name', 'desc', 'author', 'category', 'script-providers', 'cron', 'tiles', 'proxies', 'proxy-groups'];
  assert.deepEqual(TOP.filter((k) => allowed.indexOf(k) < 0), [], 'лишние секции');
  for (const k of ['rules', 'rule-providers', 'mitm', 'hostname', 'dns:', 'rewrite']) {
    assert.ok(BODY.every((l) => l.indexOf(k) < 0), 'в override есть ' + k);
  }
});

test('узлы и группы опыта: только direct / url-test, без «Обход», члены описаны здесь же', () => {
  const nodes = TOP.indexOf('proxies') >= 0 ? section('proxies') : [];
  const groups = TOP.indexOf('proxy-groups') >= 0 ? section('proxy-groups') : [];
  assert.deepEqual(nodes, LAB_NODES);
  assert.deepEqual(groups, LAB_GROUPS);
  for (const l of nodes.concat(groups)) assert.ok(l.indexOf('Обход') < 0, 'обход в Lab: ' + l);
  for (const l of nodes) if (/^ {4}type:/.test(l)) assert.equal(l, '    type: direct');
  for (const l of groups) if (/^ {4}type:/.test(l)) assert.equal(l, '    type: url-test');
  const names = nodes.filter((l) => /^ {2}- name: /.test(l)).map((l) => l.slice(10));
  for (const l of groups) if (/^ {6}- /.test(l)) assert.ok(names.indexOf(l.slice(8)) >= 0 || l.slice(8) === 'DIRECT', 'член не описан: ' + l);
  for (const l of groups) if (/^ {4}interval: /.test(l)) assert.ok(Number(l.slice(14)) >= 60, 'проверка чаще раза в минуту: ' + l);
});

test('прежние override ST21 и Watch удалены и нигде не упоминаются в плагинах и манифесте', () => {
  for (const f of ['plugins/RouteHub-Stash-ST21.stoverride', 'plugins/RouteHub-Stash-Watch.stoverride']) {
    assert.ok(!fs.existsSync(path.join(ROOT, f)), f + ' вернулся');
  }
  const files = read('src/files.js');
  assert.ok(files.indexOf('RouteHub-Stash-Lab.stoverride') > 0 && files.indexOf("'probes/routehub-lab.js'") > 0);
  for (const p of fs.readdirSync(path.join(ROOT, 'plugins'))) {
    const t = read('plugins/' + p);
    assert.ok(!/RouteHub-Stash-(ST21|Watch)\b/.test(t), p + ' ссылается на удалённый override');
  }
});

const PY = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
test('override Lab разбирается настоящим YAML-парсером', { skip: PY.status !== 0 && 'нет python3 + PyYAML' }, () => {
  const r = spawnSync('python3', ['-c', 'import sys, json, yaml\nprint(json.dumps(yaml.safe_load(sys.stdin.read()), ensure_ascii=False))'],
    { input: OV, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(d).sort(), ['author', 'category', 'cron', 'desc', 'name', 'proxies', 'proxy-groups', 'script-providers', 'tiles']);
  assert.deepEqual(d['script-providers'], { 'rh-lab': { url: RAW + LAB, interval: 300 } });
  assert.deepEqual(d.cron.script.map((s) => [s.name, s.cron]), [['rh-lab', '* * * * *']]);
  assert.deepEqual(d.tiles.map((t) => t.name), ['rh-lab']);
  assert.deepEqual(d.proxies, [{ name: 'RH-Прямо-RU', type: 'direct', 'benchmark-url': 'http://ya.ru/', 'benchmark-timeout': T.STASH.BENCH_TIMEOUT }]);
  assert.deepEqual(d['proxy-groups'], [{ name: 'RH-Тест-RU', type: 'url-test', interval: 60, lazy: false, proxies: ['RH-Прямо-RU'] }]);
  for (const g of d['proxy-groups']) {
    for (const m of g.proxies) assert.ok(m === 'DIRECT' || d.proxies.some((p) => p.name === m), 'член ' + m + ' не описан');
  }
  const json = JSON.stringify({ p: d.proxies, g: d['proxy-groups'] });
  assert.ok(json.indexOf('Обход') < 0);
});
