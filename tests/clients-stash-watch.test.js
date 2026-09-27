// Профиль Stash S-draft-9..12: резолв имён обходных серверов
// (src/clients/stash-dns.js) и прямые узлы RH-RU с наблюдательной группой
// (src/clients/stash-watch.js, S-draft-12; #SUBSCRIBED убран — сторож в
// tests/stash-subscribed.test.js).
//
// Что сторожится и почему:
//   * глобального proxy-server-nameserver НЕТ — вне whitelist plain-гонка
//     отравила бы имена ВСЕХ узлов; в nameserver-policy — только имена
//     обходных серверов, IP и мусор не попадают (ключи не кавычатся);
//   * RH-RU = [RH-Прямо-RU-1, RH-Прямо-RU-2, RH-Обход], interval 600: узлы
//     `type: direct` с РАЗНЫМИ российскими адресами проверки ВНЕ whitelist
//     (адрес из whitelist жив под whitelist — RH-RU не ушла бы на обход);
//   * RH-Прямо-RU-Часы — только прямые узлы (правило 1), 60 с, lazy false,
//     на неё не ссылается ни одно правило и ни одна рабочая группа;
//   * RH-Часы (S-draft-9) снята: мерила DIRECT по apple.com и не помогла (ST21);
//   * RH-Главный и интервалы групп с обходом — прежние.
// Имена серверов в тесте вымышленные (example.net / example.org).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { T } from './harness.js';

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
const WATCH_NAMES = [W.G_DIRECT_RU_CLOCK];
const DIRECT_NODES = [W.N_DIRECT_RU_1, W.N_DIRECT_RU_2];

function allGroups() { return P.profileGroups(LINES, STATE, {}).concat(W.watchGroups()); }
function section(text, key) {
  const lines = text.split('\n'), at = lines.indexOf(key + ':');
  assert.ok(at >= 0, 'нет секции ' + key);
  const out = [];
  for (let i = at + 1; i < lines.length && /^\s/.test(lines[i]); i++) out.push(lines[i]);
  return out;
}

test('версия профиля — S-draft-12; строка версии — первая (#SUBSCRIBED убран)', () => {
  assert.equal(P.VERSION, 'S-draft-12');
  assert.equal(TEXT.split('\n')[0], '# RouteHub — профиль Stash, S-draft-12');
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

// ── ПРЯМЫЕ УЗЛЫ RH-RU И НАБЛЮДАТЕЛЬНАЯ ГРУППА (S-draft-12) ─────────────
// «Запрещённые» адреса проверки: минимальный набор из forg-lib
// whitelist-domains.list / hxehex-whitelist.list (сверка 27.09) — плюс
// docs/СРАВНЕНИЕ_КЛИЕНТОВ_И_WHITELIST.md, разд. 4. Адрес отсюда жив под
// whitelist, и RH-RU осталась бы на прямом узле, а мелкие банки — без связи.
const WL_FORBIDDEN = ['ya.ru', 'yandex.ru', 'ozon.ru', 'ozone.ru', 'ozonusercontent.com', 'vk.com',
  'gosuslugi.ru', 'gov.ru', 'mail.ru', 'dzen.ru', 'ok.ru', 'avito.ru', 'wildberries.ru', 'sberbank.ru',
  'vtb.ru', 'alfabank.ru', 'mos.ru', 'rbc.ru', 'lenta.ru', 'kp.ru', 'rutube.ru', '2gis.ru', 'hh.ru',
  '2ip.ru', 'ipify.org', 'ifconfig.me', 'ip.sb', 'rambler.ru', 'kinopoisk.ru', 'dns-shop.ru', 'cbr.ru'];
// Подмножество forg-lib category-ru.list (набор rh-ru-banks -> RH-RU) вне whitelist.
const CATEGORY_RU = ['avtoto.ru', 'tilda.cc', 'mangalib.me', 'kinescope.io', 'showip.net'];
const hostOf = (u) => new URL(u).hostname.toLowerCase();
const inList = (h, list) => list.some((d) => h === d || h.endsWith('.' + d));
// Проверка адреса. null — годится, иначе причина.
function badBenchUrl(u) {
  let h;
  try { h = hostOf(u); } catch (e) { return 'не адрес: ' + u; }
  if (!/^http:\/\//.test(u)) return 'не http: ' + u;
  if (inList(h, WL_FORBIDDEN)) return 'адрес из whitelist: ' + h;
  if (!/\.(ru|xn--p1ai)$/.test(h) && !inList(h, CATEGORY_RU)) return 'не российский (.ru/.рф/category-ru): ' + h;
  return null;
}

test('проверка адреса ловит whitelist, поддомены, не-РФ и не-http', () => {
  for (const ok of ['http://avtoto.ru/', 'http://tilda.cc/', 'http://example.ru/', 'http://xn--80ak6aa92e.xn--p1ai/']) assert.equal(badBenchUrl(ok), null, ok);
  for (const bad of ['http://ya.ru/', 'http://www.ya.ru/', 'http://YA.RU/', 'http://ozon.ru/', 'http://m.vk.com/',
    'http://www.gosuslugi.ru/', 'http://nalog.gov.ru/', 'http://www.apple.com/', 'http://example.com/', 'https://avtoto.ru/', 'avtoto.ru']) {
    assert.ok(badBenchUrl(bad), bad);
  }
});

test('узлы RH-Прямо-RU-1/-2: type direct, разные адреса вне whitelist, тайм-аут BENCH_TIMEOUT', () => {
  const nodes = W.directRuNodes();
  assert.deepEqual(nodes.map((n) => n.name), ['RH-Прямо-RU-1', 'RH-Прямо-RU-2']);
  for (const n of nodes) {
    assert.deepEqual(Object.keys(n).sort(), ['benchmark-timeout', 'benchmark-url', 'name', 'type']);
    assert.equal(n.type, 'direct');
    assert.equal(n['benchmark-timeout'], S.BENCH_TIMEOUT);
    assert.equal(S.BENCH_TIMEOUT, 5, 'урок ST14: порог не ниже 5 с');
    assert.equal(badBenchUrl(n['benchmark-url']), null);
  }
  const hosts = nodes.map((n) => hostOf(n['benchmark-url']));
  assert.equal(new Set(hosts).size, 2, 'один адрес на оба узла — сбой одного сайта уводит RH-RU на обход');
  assert.notEqual(hosts[0].split('.').slice(-2).join('.'), hosts[1].split('.').slice(-2).join('.'), 'один домен на оба узла');
  // Копия: правка результата не меняет следующую выдачу.
  nodes[0]['benchmark-url'] = 'http://ya.ru/';
  assert.notEqual(W.directRuNodes()[0]['benchmark-url'], 'http://ya.ru/');
});

test('RH-RU = [RH-Прямо-RU-1, RH-Прямо-RU-2, RH-Обход], interval 600; DIRECT в ней нет', () => {
  const g = {};
  allGroups().forEach((x) => { g[x.name] = x; });
  assert.deepEqual(g['RH-RU'], { name: 'RH-RU', type: 'fallback', proxies: ['RH-Прямо-RU-1', 'RH-Прямо-RU-2', 'RH-Обход'], interval: 600 });
  const prov = {};
  P.profileGroups(LINES, STATE, { membership: 'provider' }).forEach((x) => { prov[x.name] = x; });
  assert.deepEqual(prov['RH-RU'], g['RH-RU'], 'в форме Б RH-RU иная');
});

test('RH-Прямо-RU-Часы: url-test только из прямых узлов, 60 с, lazy false; RH-Часы нет', () => {
  assert.deepEqual(W.watchGroups(), [{ name: 'RH-Прямо-RU-Часы', type: 'url-test', proxies: ['RH-Прямо-RU-1', 'RH-Прямо-RU-2'], interval: 60, lazy: false }]);
  const direct = new Set(W.directRuNodes().map((n) => n.name));
  for (const x of W.watchGroups()) for (const m of x.proxies) assert.ok(direct.has(m), x.name + ': не прямой член ' + m);
  for (const t of [TEXT, P.renderProfile({ ...CTX, membership: 'provider' })]) {
    assert.ok(t.indexOf('RH-Часы') < 0, 'RH-Часы вернулась');
    assert.ok(t.indexOf('RH-Тест-RU') < 0 && t.indexOf("'RH-Прямо-RU'") < 0, 'узел/группа Lab ST21 в профиле');
    assert.ok(t.indexOf("benchmark-url: 'http://ya.ru/'") < 0);
  }
});

test('на наблюдательную группу не ссылается ни одно правило и ни одна рабочая группа; на прямые узлы — только RH-RU', () => {
  const rules = section(TEXT, 'rules');
  assert.ok(rules.length > 10);
  for (const r of rules) for (const n of WATCH_NAMES.concat(DIRECT_NODES)) assert.ok(r.indexOf(n) < 0, 'правило ведёт на ' + n + ': ' + r);
  for (const g of P.profileGroups(LINES, STATE, {})) {
    for (const n of WATCH_NAMES) assert.ok((g.proxies || []).indexOf(n) < 0, g.name + ' содержит ' + n);
    if (g.name !== 'RH-RU') for (const n of DIRECT_NODES) assert.ok((g.proxies || []).indexOf(n) < 0, g.name + ' содержит ' + n);
  }
  assert.ok(section(TEXT, 'rule-providers').every((l) => WATCH_NAMES.concat(DIRECT_NODES).every((n) => l.indexOf(n) < 0)));
  // Выдача поставщика /nodes — только узлы подписки.
  const nodesText = S.renderNodes(LINES, STATE, {});
  assert.ok(nodesText.indexOf('Германия') > 0, 'выдача /nodes пуста — проверка ниже пуста');
  for (const n of DIRECT_NODES) assert.ok(nodesText.indexOf(n) < 0, 'прямой узел в /nodes');
});

test('в YAML: часы — последней в proxy-groups; прямые узлы в proxies обеих форм членства', () => {
  const pg = section(TEXT, 'proxy-groups').filter((l) => /^ {2}- name: /.test(l));
  assert.equal(pg[pg.length - 1], "  - name: 'RH-Прямо-RU-Часы'");
  assert.ok(section(TEXT, 'proxy-groups').indexOf('    lazy: false') > 0);
  const names = section(TEXT, 'proxies').filter((l) => /^ {2}- name: /.test(l));
  assert.equal(names.length, S.nodeSet(LINES, STATE, {}).nodes.length + 2, 'в proxies не подписка + 2 прямых');
  assert.deepEqual(names.slice(-2), ["  - name: 'RH-Прямо-RU-1'", "  - name: 'RH-Прямо-RU-2'"]);
  const px = section(TEXT, 'proxies');
  assert.deepEqual(px.slice(-8), ["  - name: 'RH-Прямо-RU-1'", "    type: 'direct'", "    benchmark-url: '" + W.DIRECT_RU_URLS[0] + "'",
    '    benchmark-timeout: 5', "  - name: 'RH-Прямо-RU-2'", "    type: 'direct'", "    benchmark-url: '" + W.DIRECT_RU_URLS[1] + "'", '    benchmark-timeout: 5']);
  const prov = P.renderProfile({ ...CTX, membership: 'provider' });
  assert.ok(prov.indexOf('proxy-providers:') >= 0);
  const pl = section(prov, 'proxies');
  assert.deepEqual(pl.filter((l) => /^ {2}- name: /.test(l)), ["  - name: 'RH-Прямо-RU-1'", "  - name: 'RH-Прямо-RU-2'"], 'в форме Б в proxies не ровно прямые узлы');
  assert.equal(prov.split('\n').filter((l) => l === 'proxies:').length, 1);
});

test('каждый член каждой группы (с наблюдательными) разрешается внутри профиля — обе формы', () => {
  for (const membership of [undefined, 'provider']) {
    const t = P.renderProfile({ ...CTX, membership });
    const head = t.split('proxy-groups:')[0];
    const known = Object.create(null);
    known.DIRECT = true; known.REJECT = true;
    head.split('\n').forEach((l) => { const m = /^\s*-\s+name:\s+'(.*)'\s*$/.exec(l); if (m) known[m[1].split("''").join("'")] = true; });
    const gs = P.profileGroups(LINES, STATE, { membership }).concat(W.watchGroups());
    gs.forEach((g) => { known[g.name] = true; });
    const bad = [];
    gs.forEach((g) => (g.proxies || []).forEach((m) => { if (!known[m]) bad.push(g.name + ' -> ' + m); }));
    assert.deepEqual(bad, [], String(membership));
  }
});

// ── ПРЕЖНЕЕ НЕ ТРОНУТО ──────────────────────────────────────────────────
test('RH-Главный не изменилась; интервалы групп с обходом — 600 с', () => {
  const g = {};
  allGroups().forEach((x) => { g[x.name] = x; });
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
test('профиль S-draft-12 разбирается настоящим YAML-парсером (обе формы членства)', { skip: PY.status !== 0 && 'нет python3 + PyYAML' }, () => {
  const src = 'import sys, json, yaml\nd = yaml.safe_load(sys.stdin.read())\n' +
    'print(json.dumps({"pol": d["dns"]["nameserver-policy"], "psn": "proxy-server-nameserver" in d["dns"],' +
    ' "tail": d["proxy-groups"][-1:], "direct": [p for p in d["proxies"] if p.get("type") == "direct"],' +
    ' "ru": [g for g in d["proxy-groups"] if g["name"] == "RH-RU"]}, ensure_ascii=False))';
  for (const t of [TEXT, P.renderProfile({ ...CTX, membership: 'provider' })]) {
    const r = spawnSync('python3', ['-c', src], { input: t, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(r.stdout);
    assert.equal(d.psn, false);
    assert.deepEqual(d.pol['byp-a.example.net'], ['system', '77.88.8.8']);
    assert.equal(d.pol['+.ru'], 'system');
    assert.deepEqual(d.tail, W.watchGroups());
    assert.deepEqual(d.direct, W.directRuNodes());
    assert.deepEqual(d.ru.map((g) => g.proxies), [['RH-Прямо-RU-1', 'RH-Прямо-RU-2', 'RH-Обход']]);
  }
});
