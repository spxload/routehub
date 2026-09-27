// Профиль Stash S-draft-9: резолв имён обходных серверов и наблюдательные
// группы (src/clients/stash-dns.js, src/clients/stash-watch.js).
//
// Что сторожится и почему:
//   * глобального proxy-server-nameserver НЕТ — вне whitelist plain-гонка
//     отравила бы имена ВСЕХ узлов; в nameserver-policy — только имена
//     обходных серверов, IP и мусор не попадают (ключи не кавычатся);
//   * RH-Часы — только DIRECT, ни одного обходного узла (правило 1), на неё не
//     ссылается ни одно правило и ни одна группа;
//   * RH-Прямо-RU / RH-Тест-RU — НЕ в профиле, а в override Watch (ревью
//     27.09): отказ Stash от benchmark-* у direct роняет только override;
//   * RH-RU, RH-Главный и интервалы групп с обходом — прежние.
// Имена серверов в тесте вымышленные (example.net / example.org).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { T, ROOT } from './harness.js';

const P = T.STASH_PROFILE, S = T.STASH;
const W = await import('../src/clients/stash-watch.js');

const L = (host, name) => 'vless://uuid@' + host + ':443?type=tcp#' + encodeURIComponent(name);
const N = {
  de: '[VPN] 🇩🇪 Германия #1', nl: '[VPN] 🇳🇱 Нидерланды #1',
  b1: '🇩🇪 Германия [Обход - МТС]', b2: '🇩🇪 Германия [Обход - МТС] #2',
  b3: '🇫🇮 Финляндия [Обход]', b4: '[Обход] 🇳🇱 v6',
};
const LINES = [
  L('de1.example.org', N.de), L('nl1.example.org', N.nl),
  L('Byp-A.Example.NET', N.b1), L('byp-a.example.net', N.b2),
  L('203.0.113.70', N.b3), L('[2001:db8::1]', N.b4),
];
const STATE = {};
const CTX = { key: 'k1', base: 'https://w.invalid/t/T', masterLines: LINES, state: STATE };
const TEXT = P.renderProfile(CTX);
const WATCH_NAMES = [W.G_CLOCK, W.G_TEST_RU, W.N_DIRECT_RU];
const OV = fs.readFileSync(path.join(ROOT, 'plugins/RouteHub-Stash-Watch.stoverride'), 'utf8');

function allGroups() { return P.profileGroups(LINES, STATE, {}).concat(W.watchGroups()); }
function section(text, key) {
  const lines = text.split('\n'), at = lines.indexOf(key + ':');
  assert.ok(at >= 0, 'нет секции ' + key);
  const out = [];
  for (let i = at + 1; i < lines.length && /^\s/.test(lines[i]); i++) out.push(lines[i]);
  return out;
}

test('версия профиля — S-draft-9', () => {
  assert.equal(P.VERSION, 'S-draft-9');
  assert.equal(TEXT.split('\n')[0], '# RouteHub — профиль Stash, S-draft-9');
});

// ── DNS ──────────────────────────────────────────────────────────────────
test('proxy-server-nameserver НЕ задан: глобальный plain отравил бы имена всех узлов', () => {
  assert.ok(TEXT.indexOf('proxy-server-nameserver') < 0, 'вернулся глобальный proxy-server-nameserver');
  const prov = P.renderProfile({ ...CTX, membership: 'provider' });
  assert.ok(prov.indexOf('proxy-server-nameserver') < 0);
});

test('nameserver-policy: имена обходных серверов → [system, 77.88.8.8]; обычные узлы, IP и v6 — нет', () => {
  const pol = P.bypassNsPolicy(S.nodeSet(LINES, STATE, {}));
  assert.deepEqual(Object.keys(pol), ['byp-a.example.net'], 'дубликат по регистру схлопнут, IP пропущены');
  assert.deepEqual(pol['byp-a.example.net'], ['system', '77.88.8.8']);
  assert.deepEqual(P.DNS_BYPASS_NS, ['system', '77.88.8.8']);
  // Значение — копия: правка одного ключа не меняет константу и соседей.
  pol['byp-a.example.net'].push('x');
  assert.deepEqual(P.DNS_BYPASS_NS, ['system', '77.88.8.8']);
  const ns = section(TEXT, 'dns');
  const at = ns.indexOf('    byp-a.example.net:');
  assert.ok(at > 0, 'имя обходного сервера не доехало до YAML');
  assert.deepEqual(ns.slice(at + 1, at + 3), ["      - 'system'", "      - '77.88.8.8'"]);
  for (const h of ['de1.example.org', 'nl1.example.org', '203.0.113.70', '2001:db8::1']) {
    assert.ok(ns.every((l) => l.indexOf(h) < 0), h + ' попал в секцию dns');
  }
  // Постоянные зоны не тронуты.
  assert.ok(ns.indexOf("    +.ru: 'system'") > 0);
  for (const k of Object.keys(P.DNS_NS_POLICY)) assert.equal(P.DNS_NS_POLICY[k], 'system');
  assert.equal(P.DNS_NS_POLICY['byp-a.example.net'], undefined, 'константа policy изменена сборкой');
});

test('bypassNsPolicy: только строго доменные имена обходных узлов (ключи не кавычатся)', () => {
  const set = (rows) => ({ items: rows.map((r) => ({ tag: r[0] })), nodes: rows.map((r) => ({ server: r[1] })) });
  const pol = P.bypassNsPolicy(set([
    ['bypass', 'ok.example.net'], ['vpn', 'vpn.example.net'], ['bypass', '198.51.100.1'],
    ['bypass', '2001:db8::2'], ['bypass', "x'y.example.net"], ['bypass', '*.example.net'],
    ['bypass', 'a b.example.net'], ['bypass', 'nodot'], ['bypass', '-bad.example.net'],
    ['bypass', '__proto__'], ['bypass', 'x.example.net:443'], ['bypass', ''], ['bypass', undefined],
    ['bypass', 'xn--80ak6aa92e.example.net'], ['bypass', '198.51.100.23'], ['bypass', '203.0.113.200'],
    ['bypass', 'UP.Example.NET'],
  ]));
  assert.deepEqual(Object.keys(pol).sort(), ['ok.example.net', 'up.example.net', 'xn--80ak6aa92e.example.net']);
  assert.deepEqual(P.bypassNsPolicy(null), {});
  assert.deepEqual(P.bypassNsPolicy({ items: [{ tag: 'bypass' }], nodes: [] }), {});
});

test('подписка без обхода — nameserver-policy как в S-draft-8', () => {
  const t = P.renderProfile({ ...CTX, masterLines: LINES.slice(0, 2) });
  const ns = section(t, 'dns');
  const from = ns.indexOf('  nameserver-policy:') + 1;
  let to = from;
  while (to < ns.length && /^ {4}/.test(ns[to])) to++;
  assert.deepEqual(ns.slice(from, to), Object.keys(P.DNS_NS_POLICY).map((k) => '    ' + k + ": 'system'"));
});

// ── НАБЛЮДАТЕЛЬНЫЕ ГРУППЫ ───────────────────────────────────────────────
test('RH-Часы: url-test [DIRECT], interval 60, lazy false; других наблюдательных групп в профиле нет', () => {
  assert.deepEqual(W.watchGroups(), [{ name: 'RH-Часы', type: 'url-test', proxies: ['DIRECT'], interval: 60, lazy: false }]);
  for (const x of W.watchGroups()) for (const m of x.proxies) assert.ok(m.indexOf('Обход') < 0, x.name + ': обходной член ' + m);
});

test('RH-Прямо-RU и RH-Тест-RU в профиле НЕТ (живут в override Watch) — ни в одной форме', () => {
  for (const t of [TEXT, P.renderProfile({ ...CTX, membership: 'provider' })]) {
    for (const n of [W.G_TEST_RU, W.N_DIRECT_RU]) assert.ok(t.indexOf(n) < 0, 'в профиле ' + n);
    assert.ok(!/type: 'direct'/.test(t), 'узел type: direct в профиле');
    assert.ok(t.indexOf("benchmark-url: 'http://ya.ru/'") < 0);
  }
});

// Override разбирается построчно (формат фиксирован) и, если есть, PyYAML (ниже).
test('override Watch: узел RH-Прямо-RU type direct с ya.ru, группа RH-Тест-RU; ни обхода, ни правил, ни MITM', () => {
  const body = OV.split('\n').filter((l) => l && !/^\s*#/.test(l));
  const at = (k) => body.indexOf(k + ':');
  assert.ok(at('proxies') >= 0 && at('proxy-groups') > at('proxies'), 'нет секций proxies / proxy-groups');
  assert.deepEqual(body.slice(at('proxies') + 1, at('proxy-groups')), [
    '  - name: RH-Прямо-RU', '    type: direct', '    benchmark-url: http://ya.ru/', '    benchmark-timeout: ' + S.BENCH_TIMEOUT]);
  assert.deepEqual(body.slice(at('proxy-groups') + 1), [
    '  - name: RH-Тест-RU', '    type: url-test', '    interval: 60', '    lazy: false', '    proxies:', '      - RH-Прямо-RU']);
  assert.equal(W.G_TEST_RU, 'RH-Тест-RU');
  assert.equal(W.N_DIRECT_RU, 'RH-Прямо-RU');
  assert.ok(OV.indexOf('Обход') < 0, 'слово «Обход» в override Watch');
  for (const k of ['rules:', 'script', 'cron', 'mitm', 'hostname', 'dns:']) {
    assert.ok(body.every((l) => l.indexOf(k) < 0), 'в override Watch есть ' + k);
  }
});

test('на наблюдательные группы и узел не ссылается ни одно правило и ни одна рабочая группа', () => {
  const rules = section(TEXT, 'rules');
  assert.ok(rules.length > 10);
  for (const r of rules) for (const n of WATCH_NAMES) assert.ok(r.indexOf(n) < 0, 'правило ведёт на ' + n + ': ' + r);
  for (const g of P.profileGroups(LINES, STATE, {})) {
    for (const n of WATCH_NAMES) assert.ok((g.proxies || []).indexOf(n) < 0, g.name + ' содержит ' + n);
  }
  assert.ok(section(TEXT, 'rule-providers').every((l) => WATCH_NAMES.every((n) => l.indexOf(n) < 0)));
});

test('в YAML: RH-Часы — последней в proxy-groups, с lazy: false; узлы — только подписки', () => {
  const pg = section(TEXT, 'proxy-groups').filter((l) => /^ {2}- name: /.test(l));
  assert.equal(pg[pg.length - 1], "  - name: 'RH-Часы'");
  assert.ok(section(TEXT, 'proxy-groups').indexOf('    lazy: false') > 0);
  const names = section(TEXT, 'proxies').filter((l) => /^ {2}- name: /.test(l));
  assert.equal(names.length, S.nodeSet(LINES, STATE, {}).nodes.length, 'в proxies лишний узел');
  const prov = P.renderProfile({ ...CTX, membership: 'provider' });
  assert.ok(prov.indexOf('proxy-providers:') >= 0);
  assert.equal(prov.split('\n').indexOf('proxies:'), -1, 'в форме Б лишняя секция proxies');
});

test('каждый член каждой группы (с наблюдательными) разрешается внутри профиля', () => {
  const head = TEXT.split('proxy-groups:')[0];
  const known = Object.create(null);
  known.DIRECT = true; known.REJECT = true;
  head.split('\n').forEach((l) => { const m = /^\s*-\s+name:\s+'(.*)'\s*$/.exec(l); if (m) known[m[1].split("''").join("'")] = true; });
  const gs = allGroups();
  gs.forEach((g) => { known[g.name] = true; });
  const bad = [];
  gs.forEach((g) => (g.proxies || []).forEach((m) => { if (!known[m]) bad.push(g.name + ' -> ' + m); }));
  assert.deepEqual(bad, []);
});

// ── ПРЕЖНЕЕ НЕ ТРОНУТО ──────────────────────────────────────────────────
test('RH-RU и RH-Главный не изменились; интервалы групп с обходом — 600 с', () => {
  const g = {};
  allGroups().forEach((x) => { g[x.name] = x; });
  assert.deepEqual(g['RH-RU'], { name: 'RH-RU', type: 'fallback', proxies: ['DIRECT', 'RH-Обход'], interval: 600 });
  assert.deepEqual(g['RH-Главный'], { name: 'RH-Главный', type: 'fallback', proxies: ['DIRECT', 'RH-АВТО'], interval: 600 });
  const byp = new Set(S.nodeSet(LINES, STATE, {}).items.filter((i) => i.tag === 'bypass').map((i) => i.display));
  assert.ok(byp.size >= 3);
  let n = 0;
  for (const x of allGroups()) {
    const hasByp = (x.proxies || []).some((m) => byp.has(m) || m === 'RH-Обход');
    if (!hasByp) continue;
    n++;
    assert.equal(x.interval, 600, x.name + ': интервал группы с обходом ' + x.interval);
    assert.equal(x.lazy, undefined, x.name + ': lazy у группы с обходом');
  }
  assert.ok(n >= 7, 'групп с обходом подозрительно мало: ' + n);
  assert.equal(S.GROUP_INTERVAL, 600);
});

// Настоящий YAML-парсер (PyYAML), если он есть на машине: зависимостей у
// проекта нет, поэтому без него тест пропускается, а не падает.
const PY = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
test('профиль S-draft-9 разбирается настоящим YAML-парсером (обе формы членства)', { skip: PY.status !== 0 && 'нет python3 + PyYAML' }, () => {
  const src = 'import sys, json, yaml\nd = yaml.safe_load(sys.stdin.read())\n' +
    'print(json.dumps({"pol": d["dns"]["nameserver-policy"], "psn": "proxy-server-nameserver" in d["dns"],' +
    ' "tail": d["proxy-groups"][-1:]}, ensure_ascii=False))';
  for (const t of [TEXT, P.renderProfile({ ...CTX, membership: 'provider' })]) {
    const r = spawnSync('python3', ['-c', src], { input: t, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(r.stdout);
    assert.equal(d.psn, false);
    assert.deepEqual(d.pol['byp-a.example.net'], ['system', '77.88.8.8']);
    assert.equal(d.pol['+.ru'], 'system');
    assert.deepEqual(d.tail, W.watchGroups());
  }
});

test('override Watch разбирается настоящим YAML-парсером: только direct / url-test, члены разрешаются', { skip: PY.status !== 0 && 'нет python3 + PyYAML' }, () => {
  const r = spawnSync('python3', ['-c', 'import sys, json, yaml\nprint(json.dumps(yaml.safe_load(sys.stdin.read()), ensure_ascii=False))'],
    { input: OV, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(d).sort(), ['author', 'category', 'desc', 'name', 'proxies', 'proxy-groups']);
  assert.deepEqual(d.proxies, [{ name: 'RH-Прямо-RU', type: 'direct', 'benchmark-url': 'http://ya.ru/', 'benchmark-timeout': S.BENCH_TIMEOUT }]);
  assert.deepEqual(d['proxy-groups'], [{ name: 'RH-Тест-RU', type: 'url-test', interval: 60, lazy: false, proxies: ['RH-Прямо-RU'] }]);
  for (const p of d.proxies) assert.equal(p.type, 'direct');
  for (const g of d['proxy-groups']) {
    assert.equal(g.type, 'url-test');
    for (const m of g.proxies) assert.ok(d.proxies.some((p) => p.name === m), 'член ' + m + ' не описан в override');
  }
  assert.ok(JSON.stringify(d).indexOf('Обход') < 0);
});
