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

// Стенд: адреса опытов (/lab/t24-nodes, /lab/t24-pulse) — без токена и ключа.
// В холостом режиме их в override нет вовсе.
const STAND = 'https://routehub-stash.proton4iker.workers.dev';
const L24 = T.STASH_LAB24;

// ── ЕДИНСТВЕННЫЙ УКАЗАТЕЛЬ ТЕКУЩЕГО ОПЫТА ────────────────────────────────
// ST25 (28.09, ревизия ST24; согласие Дианы «Живой лог да», «стоп флаг
// делай»): замечает ли Stash в фоне смерть узла поставщика (путь А). Чтение
// + касание группы T по правилу override Lab + короткий отчёт на стенд
// (хост стенда — DIRECT первым правилом); холостой режим — 'idle' и пустые
// списки ниже. ST24 — архив (probes/routehub-probe-stash24.js).
const LAB_SOURCE = 'probes/routehub-probe-stash25.js';
const ARCHIVE = ['probes/routehub-probe-stash24.js'];
// Узлы, группы и поставщики опыта в override — ровно эти строки (формат
// фиксирован). Холостой режим — пусто, секций нет вовсе.
const PULSE24 = STAND + L24.T24_PULSE_PATH + '?t=';
const LAB_NODES = [
  '  - name: RH-Т24-Пульс', '    type: direct', '    benchmark-url: ' + PULSE24 + 't24ctl',
  '    benchmark-timeout: ' + T.STASH.BENCH_TIMEOUT];
const fb = (G, extra) => ['  - name: RH-Т24-' + G, '    type: fallback', '    interval: 60'].concat(extra || [], ['    use:', '      - rh-t24' + G.toLowerCase()]);
const LAB_GROUPS = [].concat(fb('L'), fb('N', ['    lazy: false']), fb('P'), fb('T'),
  ['  - name: RH-Т24-К', '    type: url-test', '    interval: 60', '    lazy: false', '    proxies:', '      - RH-Т24-Пульс']);
const prov = (g, extra) => ['  rh-t24' + g + ':', '    url: ' + STAND + L24.T24_NODES_PATH + '?g=' + g, '    path: ./providers/rh-t24' + g + '.yaml',
  '    interval: 300'].concat(extra || []);
const LAB_PROVIDERS = [].concat(prov('l'), prov('n'),
  prov('p', ['    health-check:', '      enable: true', '      url: ' + PULSE24 + 't24p-hc', '      interval: 60', '      lazy: false']), prov('t'));
// Адреса стенда, которые вправе стоять в override: поставщики опыта, пульсы его узлов и health-check.
const STAND_URLS = LAB_PROVIDERS.concat(LAB_NODES).filter((l) => /^\s*(url|benchmark-url): /.test(l)).map((l) => l.replace(/^\s*[\w-]+: /, ''));
// Касание группы T (ревью ST24, дважды): проба шлёт обычный GET на хост,
// который в T ведёт ЕДИНСТВЕННОЕ правило override. Stash вставляет массивы
// override в начало массива профиля (stash.wiki/en/configuration/override);
// проба это сверяет по /rules и без сверки не касается.
const TOUCH_HOST = 'connectivitycheck.android.com';
const TOUCH = 'https://' + TOUCH_HOST + '/generate_204';
// ST25: отчёт на стенд идёт $httpClient скрипта по правилам профиля —
// первым правилом хост стенда ведётся DIRECT (правило 1), проба сверяет это
// по /rules и без сверки отчёт не шлёт.
const STAND_HOST = new URL(STAND).hostname;
const REPORT = STAND + L24.T24_REPORT_PATH;
const LAB_RULES = ['  - DOMAIN,' + STAND_HOST + ',DIRECT', '  - DOMAIN,' + TOUCH_HOST + ',RH-Т24-T'];

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
test('текущий опыт: $httpClient только get/put/post, put один и за WRITABLE, post один и за REPORT_GATE, без /delay', () => {
  if (IDLE) { assert.match(LAB_TEXT, IDLE_RE); return; }
  const code = bare(LAB_TEXT);
  assert.ok(code.indexOf('/delay') < 0, 'в опыте /delay (замер — запись в маршрутизацию)');
  const used = [...code.matchAll(/\$httpClient\s*(?:\.\s*(\w+)|\[)/g)].map((m) => m[1] || '[');
  assert.deepEqual([...new Set(used)].filter((m) => m !== 'get' && m !== 'put' && m !== 'post'), [], 'у $httpClient не только get/put/post: ' + used.join(','));
  // POST — только отчёт стенда ST25: один вызов, в sendReport(), после проверки REPORT_GATE.
  const posts = used.filter((m) => m === 'post').length;
  assert.ok(posts <= 1, 'post вызывается в нескольких местах');
  if (posts) {
    const f = code.indexOf('function sendReport(');
    const at = code.indexOf('$httpClient.post');
    assert.ok(f >= 0 && at > f && code.indexOf('if (REPORT_GATE) return', f) < at, 'post вне sendReport() или до проверки REPORT_GATE');
    const next = code.indexOf('\nfunction ', f + 1);
    assert.ok(next < 0 || next > at, 'post не в теле sendReport()');
    assert.ok(LAB_TEXT.indexOf("var REPORT_URL = '" + REPORT + "'") > 0, 'адрес отчёта не стенд');
  }
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

// Песочница: опыт читает только группы и поставщиков своего override и ничего
// не пишет в боевые группы; наружу — касание и отчёт стенда (ST25). ST22 писал (PUT) в свои тестовые группы; ST23 и
// ST24 — только чтение (группы, поставщики, /rules). ST24 ещё шлёт один GET
// касания на хост правила касания — без ключа контроллера и без заголовков.
const READ_ONLY = true;
test('опыт в песочнице: читает только группы, поставщиков override и /rules, не пишет; наружу — только хост касания', async () => {
  if (IDLE) return;
  const P = 'RH-Т24-';
  const g = {
    'RH-RU': { type: 'Fallback', now: 'DIRECT', all: ['DIRECT', 'RH-Обход'] },
    'RH-Главный': { type: 'Fallback', now: 'DIRECT', all: ['DIRECT', 'RH-АВТО'] },
    'RH-Обход': { type: 'Fallback', all: ['🇩🇪 Узел [Обход]'] },
    [P + 'К']: { type: 'URLTest', now: P + 'Пульс', all: [P + 'Пульс'] },
  };
  const providers = {};
  for (const x of L24.T24_GROUPS) {
    g[P + x.toUpperCase()] = { type: 'Fallback', use: ['rh-t24' + x] };
    providers['rh-t24' + x] = { proxies: L24.t24Nodes(x) };
  }
  const rules = [{ type: 'Domain', payload: STAND_HOST, proxy: 'DIRECT' }, { type: 'Domain', payload: TOUCH_HOST, proxy: P + 'T' },
    { type: 'Match', payload: '', proxy: 'RH-Главный' }];
  const w = createStash({ groups: g, providers,
    route: (m, p, opt, reply) => (p === '/rules' ? (reply(200, JSON.stringify({ rules })), true)
      : opt.url === REPORT ? (reply(200, '{"ok":1,"stop":false}'), true) : undefined) });
  for (let i = 0; i < 2; i++) { await settle(sandbox(w, LAB_TEXT, LAB, { forbid: ['patch'] })); w.clock.t += 60000; }
  const names = ovGroupNames();
  const provs = sectionOrEmpty('proxy-providers').filter((l) => /^ {2}\S.*:$/.test(l)).map((l) => l.trim().slice(0, -1));
  assert.ok(w.calls.length > 0, 'опыт ничего не прочитал — проверка пуста');
  assert.ok(w.calls.some((c) => c.url === TOUCH), 'касания нет — песочница не проверила его путь');
  if (READ_ONLY) assert.deepEqual(w.writes().filter((c) => c.url !== REPORT), [], 'опыт только для чтения, а пишет');
  for (const c of w.calls) {
    if (c.url === TOUCH || c.url === REPORT) { assert.equal(c.auth, undefined, 'ключ контроллера ушёл наружу'); continue; }
    assert.ok(c.url.indexOf('http://127.0.0.1:9090/') === 0, 'запрос мимо контроллера: ' + c.url);
    if (c.p === '/rules') { assert.equal(c.method, 'get'); continue; }
    const prov = /^\/providers\/proxies\/([^/?]+)$/.exec(c.p);
    if (prov) { assert.ok(provs.indexOf(decodeURIComponent(prov[1])) >= 0, 'чужой поставщик: ' + c.p); continue; }
    assert.ok(c.name !== null && names.indexOf(c.name) >= 0, 'опыт трогал не свою группу: ' + c.p);
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
test('верхний уровень — скрипт, cron, плитка, узлы, группы и два правила (стенд DIRECT, касание); ни наборов, ни MITM, ни DNS', () => {
  const allowed = ['name', 'desc', 'author', 'category', 'script-providers', 'cron', 'tiles', 'proxies', 'proxy-providers', 'proxy-groups', 'rules'];
  assert.deepEqual(TOP.filter((k) => allowed.indexOf(k) < 0), [], 'лишние секции');
  for (const k of ['rule-providers', 'mitm', 'hostname', 'dns:', 'rewrite', '#!replace', 'MATCH', 'RULE-SET', 'GEOIP']) {
    assert.ok(BODY.every((l) => l.indexOf(k) < 0), 'в override есть ' + k);
  }
  // Ровно два правила: стенд DIRECT первым (отчёт ST25), хост касания в группу T (ревью ST24).
  if (!IDLE) assert.deepEqual(section('rules'), LAB_RULES);
});

// Хост касания не должен совпадать ни с одним локальным правилом боевого
// профиля Stash: иначе его трафик был бы боевым, а касание — не «чистым».
// Удалённые наборы сверены вручную 27.09 (CHANGELOG ST24); личный список —
// из D1, его порядок закрывает сверка /rules в пробе.
test('хост касания не встречается в боевых правилах Stash и в других override', async () => {
  const R = await import('../src/clients/stash-rules.js');
  const hit = (type, v) => {
    const h = TOUCH_HOST;
    if (type === 'DOMAIN') return h === v;
    if (type === 'DOMAIN-SUFFIX') return h === v || h.endsWith('.' + v);
    if (type === 'DOMAIN-KEYWORD') return h.indexOf(v) >= 0;
    return false;
  };
  const lines = R.buildRules([]);
  assert.ok(lines.length > 20);
  for (const l of lines) {
    const [type, v] = l.split(',');
    assert.ok(!hit(type, v), 'боевое правило ловит хост касания: ' + l);
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'plugins'))) {
    if (f === path.basename(OV_PATH)) continue;
    assert.ok(read('plugins/' + f).indexOf(TOUCH_HOST) < 0, 'хост касания в ' + f);
  }
  assert.ok(read('routehub.conf').indexOf(TOUCH_HOST) < 0);
  // Хост касания проектом больше нигде не используется (cp.cloudflare.com
  // отвергнут: его зовут скрипты Loon netwatch и rkn).
  for (const dir of ['src', 'src/clients', 'src/api', 'src/admin', 'scripts', 'probes']) {
    if (!fs.existsSync(path.join(ROOT, dir))) continue;
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      const rel = dir + '/' + f;
      if (!/\.js$/.test(f) || rel === LAB || rel === LAB_SOURCE || ARCHIVE.indexOf(rel) >= 0) continue;
      assert.ok(read(rel).indexOf(TOUCH_HOST) < 0, 'хост касания в ' + rel);
    }
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
  // Проверка чаще раза в минуту — только у группы, чей единственный член —
  // узел-пульс (direct с проверкой по /lab/pulse стенда): трафик — ответ 204
  // стенда (ST23: частота при interval 30). Прочим группам — не чаще 60 с.
  const pulses = [];
  for (let i = 0; i < nodes.length; i++) {
    if (/^ {2}- name: /.test(nodes[i]) && nodes.slice(i + 1, i + 4).some((l) => l.indexOf('    benchmark-url: ' + STAND + '/lab/pulse?') === 0)
      && nodes[i + 1] === '    type: direct') pulses.push(nodes[i].slice(10));
  }
  let cur = null;
  const blocks = {};
  for (const l of groups) {
    if (/^ {2}- name: /.test(l)) { cur = l.slice(10); blocks[cur] = []; } else blocks[cur].push(l);
  }
  for (const n of Object.keys(blocks)) {
    const b = blocks[n], iv = b.find((l) => /^ {4}interval: /.test(l));
    if (!iv) continue;
    const members = b.filter((l) => /^ {6}- /.test(l)).map((l) => l.slice(8));
    const pulseOnly = b.indexOf('    use:') < 0 && members.length === 1 && pulses.indexOf(members[0]) >= 0;
    assert.ok(Number(iv.slice(14)) >= (pulseOnly ? 30 : 60), 'проверка слишком часто: ' + n + ' ' + iv.trim());
  }
});

// Холостой режим: override — только скрипт, cron и плитка. Узлы, группы и
// поставщик опыта держались бы на устройстве и без опыта: проверки узлов
// шли бы в фоне, а поставщик скачивался бы (ST22: раз в ~4 мин).
test('холостой режим: в override нет proxies / proxy-groups / proxy-providers и адресов стенда', () => {
  if (!IDLE) return;
  for (const k of ['proxies', 'proxy-groups', 'proxy-providers', 'rules']) assert.ok(!has(k), 'в холостом Lab секция ' + k);
  assert.ok(BODY.every((l) => !/benchmark-|^\s*use:|filter:/.test(l)), 'в холостом Lab ключи узлов или групп');
  assert.ok(OV.indexOf('workers.dev') < 0, 'в холостом Lab адрес Worker\'а');
  assert.ok(!/RH-(Т22|Тест-RU|Прямо-RU)/.test(BODY.join('\n')), 'в холостом Lab имена опытов ST21/ST22');
});

test('поставщики опыта — только стенд /lab/t24-nodes, без токена и ключа; пульс и health-check — только /lab/t24-pulse', () => {
  assert.deepEqual(sectionOrEmpty('proxy-providers'), LAB_PROVIDERS);
  for (const u of STAND_URLS) {
    assert.ok(/^https:\/\/routehub-stash\.proton4iker\.workers\.dev\/lab\/t24-nodes\?g=[lnpt]$/.test(u) || u.indexOf(PULSE24) === 0, 'ожидание вне стенда: ' + u);
    if (u.indexOf(PULSE24) === 0) assert.ok(L24.T24_TAGS.indexOf(u.slice(PULSE24.length)) >= 0, 'метка вне белого списка стенда: ' + u);
  }
  const bench = OV.split('\n').filter((l) => /^\s*benchmark-url: /.test(l)).map((l) => l.trim().slice(15));
  for (const b of bench) assert.ok(b.indexOf(PULSE24) === 0 && STAND_URLS.indexOf(b) >= 0, 'адрес проверки узла Lab: ' + b);
  const urls = OV.split('\n').filter((l) => /^\s*url: /.test(l)).map((l) => l.trim().slice(5));
  assert.ok(urls.indexOf(RAW + LAB) >= 0, 'нет адреса скрипта');
  for (const u of urls) {
    assert.ok(u === RAW + LAB || (u.indexOf(STAND) === 0 && STAND_URLS.indexOf(u) >= 0), 'чужой адрес в override: ' + u);
    assert.ok(!/\/t\/|[?&](key|token)=/.test(u), 'токен или ключ в адресе: ' + u);
  }
  const hosts = [...OV.matchAll(/[\w.-]+\.workers\.dev[^\s'"]*/g)].map((m) => m[0])
    .filter((h) => h !== STAND_HOST + ',DIRECT');                // правило стенда (ST25), сверено тестом правил
  for (const h of hosts) {
    assert.ok(STAND_URLS.map((u) => u.slice(8)).indexOf(h) >= 0, 'другой адрес Worker\'а в override: ' + h);
    assert.ok(!/\/t\/|[?&](key|token)=/.test(h), 'токен или ключ: ' + h);
  }
  // Опыт ST23 из override убран (маршрут /lab/t23-nodes в Worker'е оставлен).
  assert.ok(BODY.every((l) => l.indexOf('Т23') < 0 && l.indexOf('t23') < 0), 'в Lab остались группы или поставщик ST23');
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
  assert.deepEqual(d['script-providers'], { 'rh-lab': { url: RAW + LAB, interval: 300 } });
  assert.deepEqual(d.cron.script.map((s) => [s.name, s.cron]), [['rh-lab', '* * * * *']]);
  assert.deepEqual(d.tiles.map((t) => t.name), ['rh-lab']);
  if (IDLE) {
    assert.deepEqual(Object.keys(d).sort(), ['author', 'category', 'cron', 'desc', 'name', 'script-providers', 'tiles']);
    for (const k of ['proxies', 'proxy-groups', 'proxy-providers', 'rules']) assert.equal(d[k], undefined);
    return;
  }
  assert.deepEqual(d.rules, ['DOMAIN,' + STAND_HOST + ',DIRECT', 'DOMAIN,' + TOUCH_HOST + ',RH-Т24-T'], 'правила стенда и касания');
  // ST24: четыре поставщика (у rh-t24p — health-check), узел-пульс и группы;
  // выдача каждого поставщика — узлы A и B своей группы.
  const pv = d['proxy-providers'];
  assert.deepEqual(Object.keys(pv), ['rh-t24l', 'rh-t24n', 'rh-t24p', 'rh-t24t']);
  for (const x of L24.T24_GROUPS) {
    const want = { url: STAND + '/lab/t24-nodes?g=' + x, path: './providers/rh-t24' + x + '.yaml', interval: 300 };
    if (x === 'p') want['health-check'] = { enable: true, url: STAND + '/lab/t24-pulse?t=t24p-hc', interval: 60, lazy: false };
    assert.deepEqual(pv['rh-t24' + x], want, 'поставщик rh-t24' + x);
  }
  assert.deepEqual(d.proxies.map((n) => [n.name, n.type, n['benchmark-url'], n['benchmark-timeout']]),
    [['RH-Т24-Пульс', 'direct', STAND + '/lab/t24-pulse?t=t24ctl', 5]]);
  const byName = Object.fromEntries(d['proxy-groups'].map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(byName), ['RH-Т24-L', 'RH-Т24-N', 'RH-Т24-P', 'RH-Т24-T', 'RH-Т24-К']);
  for (const G of ['L', 'N', 'P', 'T']) {
    const x = byName['RH-Т24-' + G];
    assert.deepEqual([x.type, x.interval, x.use, x.filter, x.proxies], ['fallback', 60, ['rh-t24' + G.toLowerCase()], undefined, undefined], G);
    assert.equal(x.lazy, G === 'N' ? false : undefined, 'lazy у ' + G);
  }
  assert.deepEqual([byName['RH-Т24-К'].type, byName['RH-Т24-К'].interval, byName['RH-Т24-К'].lazy, byName['RH-Т24-К'].proxies],
    ['url-test', 60, false, ['RH-Т24-Пульс']]);
});
