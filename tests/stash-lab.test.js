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
import { createStash, sandbox, settle } from './fake-stash.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Стенд: адреса опытов ST22 (/lab/pulse, /lab/t22-nodes) — без токена и ключа.
// В холостом режиме их в override нет вовсе.
const STAND = 'https://routehub-stash.proton4iker.workers.dev';

// ── ЕДИНСТВЕННЫЙ УКАЗАТЕЛЬ ТЕКУЩЕГО ОПЫТА ────────────────────────────────
// S-draft-12 (27.09): опыта нет — холостой режим. ST21/ST22 закончены,
// прямые узлы RH-RU переехали в профиль (tests/clients-stash-watch.test.js).
const LAB_SOURCE = 'idle';
// Узлы, группы и поставщики опыта в override — ровно эти строки (формат
// фиксирован). Холостой режим — пусто, секций нет вовсе.
const LAB_NODES = [];
const LAB_GROUPS = [];
const LAB_PROVIDERS = [];

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

// ST22 пишет (PUT) — но только в свои тестовые группы. Статически: у
// $httpClient только get и put, put — один, внутри write() за проверкой
// WRITABLE; /delay и прочих рычагов нет. Динамически — ниже, в песочнице.
test('текущий опыт: $httpClient только get/put, put один и за WRITABLE, без /delay', () => {
  if (IDLE) { assert.match(LAB_TEXT, IDLE_RE); return; }
  const code = bare(LAB_TEXT);
  assert.ok(code.indexOf('/delay') < 0, 'в опыте /delay (замер — запись в маршрутизацию)');
  const used = [...code.matchAll(/\$httpClient\s*(?:\.\s*(\w+)|\[)/g)].map((m) => m[1] || '[');
  assert.deepEqual([...new Set(used)].filter((m) => m !== 'get' && m !== 'put'), [], 'у $httpClient не только get/put: ' + used.join(','));
  const puts = used.filter((m) => m === 'put').length;
  assert.ok(puts <= 1, 'put вызывается в нескольких местах');
  if (puts) {
    const w = code.indexOf('function write(');
    const at = code.indexOf('$httpClient.put');
    assert.ok(w >= 0 && at > w && code.indexOf('WRITABLE.hasOwnProperty(group)', w) < at, 'put вне write() или до проверки WRITABLE');
    const next = code.indexOf('\nfunction ', w + 1);
    assert.ok(next < 0 || next > at, 'put не в теле write()');
  }
  for (const x of ['setSelectPolicy', 'setRunningModel', "'PATCH'", "'DELETE'", "'POST'"]) {
    assert.ok(code.indexOf(x) < 0, 'в опыте ' + x);
  }
});

// Имена групп override (секция proxy-groups) — только они доступны опыту для записи.
function ovGroupNames() {
  return BODY.slice(BODY.indexOf('proxy-groups:') + 1).filter((l) => /^ {2}- name: /.test(l)).map((l) => l.slice(10));
}

test('опыт в песочнице: пишет только в группы RH-Т22-* из override, боевые не читает и не пишет', async () => {
  if (IDLE) return;
  const P = 'RH-Т22-';
  const g = {
    'RH-RU': { type: 'Fallback', now: 'DIRECT', all: ['DIRECT', 'RH-Обход'] },
    'RH-Главный': { type: 'Fallback', now: 'DIRECT', all: ['DIRECT', 'RH-АВТО'] },
    'RH-Обход': { type: 'Fallback', all: ['🇩🇪 Узел [Обход]'] },
    'RH-Тест-RU': { type: 'URLTest', now: 'RH-Прямо-RU', all: ['RH-Прямо-RU'] },
    [P + 'Фильтр']: { type: 'Selector', use: ['rh-t22'], filter: '^(?:RH-Т22-1|RH-Т22-2|RH-Т22-3|RH-Т22-Метка-\\d+)$' },
    [P + 'F']: { type: 'Fallback', all: [P + 'С1', P + 'С2', P + 'С3'] },
  };
  for (const n of [1, 2, 3]) g[P + 'С' + n] = { type: 'Selector', use: ['rh-t22'], filter: '^RH-Т22-' + n + '$' };
  const w = createStash({ groups: g, providers: { 'rh-t22': { proxies: T.STASH_LAB.t22Nodes(Date.now()) } } });
  for (let i = 0; i < 2; i++) { await settle(sandbox(w, LAB_TEXT, LAB)); w.clock.t += 60000; }
  const names = ovGroupNames();
  assert.ok(w.writes().length > 0, 'опыт ничего не закрепил — проверка пуста');
  for (const c of w.writes()) {
    assert.equal(c.method, 'put');
    assert.ok(c.name.indexOf(P) === 0 && names.indexOf(c.name) >= 0, 'запись вне тестовых групп override: ' + c.name);
  }
  for (const c of w.calls) assert.ok(c.name === null || c.name.indexOf(P) === 0, 'опыт трогал не свою группу: ' + c.name);
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
  const allowed = ['name', 'desc', 'author', 'category', 'script-providers', 'cron', 'tiles', 'proxies', 'proxy-providers', 'proxy-groups'];
  assert.deepEqual(TOP.filter((k) => allowed.indexOf(k) < 0), [], 'лишние секции');
  for (const k of ['rules', 'rule-providers', 'mitm', 'hostname', 'dns:', 'rewrite']) {
    assert.ok(BODY.every((l) => l.indexOf(k) < 0), 'в override есть ' + k);
  }
});

const has = (key) => TOP.indexOf(key) >= 0;
const sectionOrEmpty = (key) => (has(key) ? section(key) : []);

test('узлы и группы опыта: direct / url-test / select / fallback, без «Обход», члены описаны здесь же', () => {
  const nodes = sectionOrEmpty('proxies');
  const groups = sectionOrEmpty('proxy-groups');
  assert.deepEqual(nodes, LAB_NODES);
  assert.deepEqual(groups, LAB_GROUPS);
  for (const l of nodes.concat(groups)) assert.ok(l.indexOf('Обход') < 0, 'обход в Lab: ' + l);
  for (const l of nodes) if (/^ {4}type:/.test(l)) assert.equal(l, '    type: direct');
  for (const l of groups) if (/^ {4}type:/.test(l)) assert.match(l, /^ {4}type: (url-test|select|fallback)$/);
  const names = nodes.filter((l) => /^ {2}- name: /.test(l)).map((l) => l.slice(10));
  const gnames = groups.filter((l) => /^ {2}- name: /.test(l)).map((l) => l.slice(10));
  const provs = sectionOrEmpty('proxy-providers').filter((l) => /^ {2}\S.*:$/.test(l)).map((l) => l.trim().slice(0, -1));
  // Члены `proxies:` групп — узлы или группы этого override; `use:` — только его поставщики.
  let inUse = false;
  for (const l of groups) {
    if (/^ {4}\S/.test(l)) inUse = l === '    use:';
    if (!/^ {6}- /.test(l)) continue;
    const m = l.slice(8);
    if (inUse) assert.ok(provs.indexOf(m) >= 0, 'чужой поставщик: ' + l);
    else assert.ok(names.indexOf(m) >= 0 || gnames.indexOf(m) >= 0 || m === 'DIRECT', 'член не описан: ' + l);
  }
  for (const l of groups) if (/^ {4}interval: /.test(l)) assert.ok(Number(l.slice(14)) >= 60, 'проверка чаще раза в минуту: ' + l);
});

// Холостой режим: override — только скрипт, cron и плитка. Узлы, группы и
// поставщик опыта держались бы на устройстве и без опыта: проверки узлов
// шли бы в фоне, а поставщик скачивался бы (ST22: раз в ~4 мин).
test('холостой режим: в override нет proxies / proxy-groups / proxy-providers и адресов стенда', () => {
  if (!IDLE) return;
  for (const k of ['proxies', 'proxy-groups', 'proxy-providers']) assert.ok(!has(k), 'в холостом Lab секция ' + k);
  assert.ok(BODY.every((l) => !/benchmark-|^\s*use:|filter:/.test(l)), 'в холостом Lab ключи узлов или групп');
  assert.ok(OV.indexOf('workers.dev') < 0, 'в холостом Lab адрес Worker\'а');
  assert.ok(!/RH-(Т22|Тест-RU|Прямо-RU)/.test(BODY.join('\n')), 'в холостом Lab имена опытов ST21/ST22');
});

test('поставщик опыта — только муляжи стенда /lab/t22-nodes, без токена и ключа; пульс — только /lab/pulse', () => {
  assert.deepEqual(sectionOrEmpty('proxy-providers'), LAB_PROVIDERS);
  const bench = OV.split('\n').filter((l) => /^\s*benchmark-url: /.test(l)).map((l) => l.trim().slice(15));
  for (const b of bench) assert.equal(b, STAND + '/lab/pulse?t=u60', 'адрес проверки узла Lab: ' + b);
  const urls = OV.split('\n').filter((l) => /^\s*url: /.test(l)).map((l) => l.trim().slice(5));
  assert.ok(urls.indexOf(RAW + LAB) >= 0, 'нет адреса скрипта');
  for (const u of urls) {
    assert.ok(u === RAW + LAB || u === STAND + '/lab/t22-nodes', 'чужой адрес в override: ' + u);
    assert.ok(!/\/t\/|[?&](key|token)=/.test(u), 'токен или ключ в адресе: ' + u);
  }
  const hosts = [...OV.matchAll(/[\w.-]+\.workers\.dev[^\s'"]*/g)].map((m) => m[0]);
  for (const h of hosts) {
    assert.ok([STAND.slice(8) + '/lab/pulse?t=u60', STAND.slice(8) + '/lab/t22-nodes'].indexOf(h) >= 0, 'другой адрес Worker\'а в override: ' + h);
    assert.ok(!/\/t\/|[?&](key|token)=/.test(h), 'токен или ключ: ' + h);
  }
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
  assert.deepEqual(Object.keys(d).sort(), ['author', 'category', 'cron', 'desc', 'name', 'script-providers', 'tiles']);
  assert.deepEqual(d['script-providers'], { 'rh-lab': { url: RAW + LAB, interval: 300 } });
  assert.deepEqual(d.cron.script.map((s) => [s.name, s.cron]), [['rh-lab', '* * * * *']]);
  assert.deepEqual(d.tiles.map((t) => t.name), ['rh-lab']);
  assert.equal(d.proxies, undefined);
  assert.equal(d['proxy-groups'], undefined);
  assert.equal(d['proxy-providers'], undefined);
});
