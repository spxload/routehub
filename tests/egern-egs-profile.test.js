// Сводная проба Egern EGS: профиль plugins/RouteHub-Egern-EGS.yaml, подписка-
// образец plugins/RouteHub-Egern-EGS-nodes.yaml и строка журнала их раздачи
// (src/clients/egern-lab.js через src/repo.js).
//
// ЗАЧЕМ. Профиль целиком заменяет на телефоне рабочий на время пробы. Ошибка
// здесь — это либо платный трафик (узел с «Обход», подписка боевых узлов,
// хост вне стенда — правило 1), либо ложный вывод: кириллица в имени группы
// (прежний 404 «по имени» не различал «нет механизма» и «имя не совпало»),
// секунды вместо миллисекунд, cron каждую минуту (не отличить «фон идёт сам»
// от «его будит cron»), группа скрипта совпала с фоновой. Журнал раздачи —
// единственный способ увидеть auto_update в фоне; в нём не должно быть
// токена и адреса устройства.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeEnv } from './mock-d1.js';
import { worker, req, ROOT, T } from './harness.js';

const PROFILE = 'plugins/RouteHub-Egern-EGS.yaml';
const NODES = 'plugins/RouteHub-Egern-EGS-nodes.yaml';
const SCRIPT = 'probes/routehub-probe-egern-egs.js';
const STAND = 'https://routehub-stash.proton4iker.workers.dev';
const RAW = 'https://raw.githubusercontent.com/spxload/routehub/stash-client/';
const NAME_RE = /^EGS-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const TAG_RE = /^[a-z0-9-]{1,16}$/;
const BACKGROUND = ['EGS-F60', 'EGS-F60N', 'EGS-A30', 'EGS-SM', 'EGS-DG', 'EGS-SUB', 'EGS-NAT', 'EGS-DIE-R'];
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PY = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
const noPy = PY.status !== 0 && 'нет python3 + PyYAML';
function yaml(text) {
  const r = spawnSync('python3', ['-c', 'import sys, json, yaml\nprint(json.dumps(yaml.safe_load(sys.stdin.read()), ensure_ascii=False))'],
    { input: text, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
// Группа Egern — объект с одним ключом-типом: {fallback: {...}}.
function groups(P) { return P.policy_groups.map((g) => { const k = Object.keys(g); assert.equal(k.length, 1); return Object.assign({ type: k[0] }, g[k[0]]); }); }
function rules(P) { return P.rules.map((r) => { const k = Object.keys(r); assert.equal(k.length, 1); return Object.assign({ type: k[0] }, r[k[0]]); }); }

test('профиль разбирается PyYAML; поля верхнего уровня — только документированные, без MITM, модулей и наборов', { skip: noPy }, () => {
  const P = yaml(read(PROFILE));
  assert.deepEqual(Object.keys(P).sort(), ['auto_update', 'direct_latency_test_url', 'ipv6', 'policy_groups', 'proxies',
    'proxy_latency_test_url', 'rules', 'scriptings'].sort());
  assert.equal(P.auto_update.url, RAW + PROFILE, 'auto_update — на этот же файл (стенд перепишет на адрес с токеном)');
  assert.ok(Number.isInteger(P.auto_update.interval) && P.auto_update.interval >= 600 && P.auto_update.interval <= 3600,
    'auto_update.interval — секунды, 10–60 мин: ' + P.auto_update.interval);
  assert.equal(P.ipv6, false);
});

test('имена групп, узлов профиля и подписки-образца — только латиница EGS-…', { skip: noPy }, () => {
  const P = yaml(read(PROFILE)), N = yaml(read(NODES));
  const names = groups(P).map((g) => g.name)
    .concat(P.proxies.map((p) => p.socks5.name))
    .concat(N.proxies.map((p) => p.socks5.name));
  assert.ok(names.length >= 20, 'подозрительно мало имён: ' + names.length);
  for (const n of names) assert.match(n, NAME_RE, 'имя не латиницей: ' + n);
  assert.equal(new Set(names).size, names.length, 'имена обязаны быть уникальны');
});

test('нигде в файлах пробы нет «Обход» (правило 1, BYPASS_WORD)', () => {
  assert.equal(T.BYPASS_WORD, 'Обход');
  for (const p of [PROFILE, NODES, SCRIPT]) assert.ok(!/обход/i.test(read(p)), p);
});

test('узлы — только муляжи TEST-NET socks5 порт 1, без паролей; порядок образца N3, N1, N2', { skip: noPy }, () => {
  const P = yaml(read(PROFILE)), N = yaml(read(NODES));
  assert.deepEqual(Object.keys(N), ['proxies']);
  for (const x of P.proxies.concat(N.proxies)) {
    assert.deepEqual(Object.keys(x), ['socks5']);
    assert.deepEqual(Object.keys(x.socks5).sort(), ['name', 'port', 'server']);
    assert.match(x.socks5.server, /^192\.0\.2\.\d{1,3}$/);
    assert.equal(x.socks5.port, 1);
  }
  assert.deepEqual(N.proxies.map((p) => p.socks5.name), ['EGS-N3', 'EGS-N1', 'EGS-N2']);
});

test('члены групп — DIRECT, REJECT, муляжи и группы EGS; подписки — только стенд /lab/t23-nodes и образец', { skip: noPy }, () => {
  const P = yaml(read(PROFILE));
  const G = groups(P);
  const known = new Set(['DIRECT', 'REJECT'].concat(P.proxies.map((p) => p.socks5.name), G.map((g) => g.name)));
  for (const g of G) {
    if (g.type === 'conditional') {
      for (const r of g.rules) for (const k in r) assert.ok(['DIRECT', 'REJECT'].includes(r[k].policy), g.name);
      assert.ok(['DIRECT', 'REJECT'].includes(g.default_policy));
      continue;
    }
    assert.ok(['fallback', 'auto_test', 'smart'].includes(g.type) || (g.type === 'select' && g.name === 'EGS-GRP'), g.name + ': ' + g.type);
    for (const m of g.policies || []) assert.ok(known.has(m), g.name + ' → ' + m);
    for (const u of g.urls || []) assert.ok(u === STAND + '/lab/t23-nodes' || u === RAW + NODES, g.name + ' → ' + u);
    assert.ok((g.policies && g.policies.length) || (g.urls && g.urls.length), g.name + ' пуста');
  }
  const subs = G.filter((g) => g.urls).map((g) => g.name).sort();
  assert.deepEqual(subs, ['EGS-NAT', 'EGS-SUB', 'EGS-SUBS']);
  for (const g of G.filter((x) => x.urls)) assert.equal(g.update_interval, 300, g.name + ': update_interval — секунды');
});

test('интервалы и тайм-ауты групп — секунды; у каждой группы своя метка проверки; метки стенда допустимы', { skip: noPy }, () => {
  const P = yaml(read(PROFILE));
  const tags = [];
  const urlTag = (u) => {
    let m = u.match(/^https:\/\/routehub-stash\.proton4iker\.workers\.dev\/lab\/pulse\?t=(.+)$/);
    if (m) { assert.match(m[1], TAG_RE, u); return m[1]; }
    m = u.match(/^https:\/\/routehub-stash\.proton4iker\.workers\.dev\/lab\/t24-pulse\?t=(.+)$/);
    if (m) { assert.ok(T.STASH_LAB24.T24_TAGS.includes(m[1]), u); assert.ok(T.STASH_LAB24.t24Dead(m[1], 600000), 'метка t24 обязана «умирать»: ' + u); return m[1]; }
    assert.equal(u, 'http://192.0.2.1/', 'адрес проверки вне стенда и не TEST-NET: ' + u);
    return u;
  };
  for (const g of groups(P)) {
    if (g.type === 'conditional') continue;
    if (g.interval !== undefined) assert.ok(Number.isInteger(g.interval) && g.interval >= 30 && g.interval <= 600, g.name + ' interval ' + g.interval);
    if (g.timeout !== undefined) assert.ok(Number.isInteger(g.timeout) && g.timeout >= 1 && g.timeout <= 60, g.name + ' timeout ' + g.timeout);
    if (g.name === 'EGS-DG') { assert.equal(g.latency_test_url, undefined, 'у EGS-DG нет своего адреса'); continue; }
    assert.ok(g.latency_test_url, g.name + ' без адреса проверки');
    tags.push(urlTag(g.latency_test_url));
  }
  tags.push(urlTag(P.direct_latency_test_url), urlTag(P.proxy_latency_test_url));
  assert.equal(new Set(tags).size, tags.length, 'метки проверки повторяются: ' + tags.join(','));
  const g = Object.fromEntries(groups(P).map((x) => [x.name, x]));
  assert.equal(g['EGS-A30'].interval, 30);
  assert.equal(g['EGS-F60'].interval, 60);
  assert.equal(g['EGS-DIE-R'].latency_test_url, STAND + '/lab/t24-pulse?t=t24na');
  assert.equal(g['EGS-DIE-S'].latency_test_url, STAND + '/lab/t24-pulse?t=t24ta');
  assert.deepEqual(g['EGS-ORD'].policies, ['EGS-DEAD-1', 'DIRECT'], 'первый член EGS-ORD — муляж');
  assert.deepEqual(g['EGS-REJ'].policies, ['REJECT', 'DIRECT']);
  assert.deepEqual(g['EGS-DIE-R'].policies, ['DIRECT', 'REJECT']);
  assert.deepEqual(g['EGS-DIE-S'].policies, ['DIRECT', 'REJECT']);
});

test('правила: домены .invalid на группы EGS, у EGS-F60N, EGS-COND и EGS-GRP правил нет, последнее — default DIRECT', { skip: noPy }, () => {
  const P = yaml(read(PROFILE));
  const R = rules(P);
  const names = new Set(groups(P).map((g) => g.name));
  const last = R.pop();
  assert.deepEqual(last, { type: 'default', policy: 'DIRECT' });
  for (const r of R) {
    assert.equal(r.type, 'domain');
    assert.match(r.match, /^egs-[a-z0-9-]+\.invalid$/);
    assert.ok(names.has(r.policy), r.policy);
  }
  const ruled = new Set(R.map((r) => r.policy));
  const free = ['EGS-F60N', 'EGS-COND', 'EGS-GRP'];
  for (const n of free) assert.ok(names.has(n) && !ruled.has(n), n);
  for (const n of names) if (!free.includes(n)) assert.ok(ruled.has(n), 'у группы нет правила: ' + n);
});

// Шаг минут cron: разбор «*/n», «a-b/n» и списков.
function cronMinutes(f) {
  const out = new Set();
  for (const part of f.split(',')) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    assert.ok(m, 'поле минут: ' + f);
    let [a, b] = m[1] === '*' ? [0, 59] : m[1].split('-').map(Number);
    if (b === undefined) b = m[2] ? 59 : a;
    for (let x = a; x <= b; x += Number(m[2] || 1)) out.add(x);
  }
  return [...out].sort((x, y) => x - y);
}

test('скрипты: schedule раз в 10 мин (не каждую минуту) и network; адрес — этот скрипт; timeout — секунды', { skip: noPy }, () => {
  const P = yaml(read(PROFILE));
  const S = P.scriptings.map((s) => { const k = Object.keys(s); assert.equal(k.length, 1); return Object.assign({ type: k[0] }, s[k[0]]); });
  assert.deepEqual(S.map((s) => s.type), ['schedule', 'network']);
  for (const s of S) {
    assert.equal(s.script_url, RAW + SCRIPT);
    assert.ok(Number.isInteger(s.timeout) && s.timeout >= 20 && s.timeout <= 600, s.name + ' timeout — секунды: ' + s.timeout);
    assert.ok(s.update_interval >= 600, s.name);
    assert.equal(s.env, undefined, 'env скрипту не нужен (токенов в профиле нет)');
  }
  const f = S[0].cron.split(' ');
  assert.equal(f.length, 5);
  assert.deepEqual(f.slice(1), ['*', '*', '*', '*']);
  const mins = cronMinutes(f[0]);
  assert.equal(mins.length, 6, 'cron — шесть запусков в час: ' + S[0].cron);
  for (let i = 1; i < mins.length; i++) assert.equal(mins[i] - mins[i - 1], 10);
  assert.ok(mins[0] % 10 !== 0, 'запуск в середине окна стенда, не на границе :00/:10: ' + S[0].cron);
  // Худший честный путь прогона: контроль 5 с, затем параллельно — до 25 с,
  // если Egern не соблюдает timeout 3000 мс (именно это и проверяется).
  assert.ok(S[0].timeout >= 45, 'timeout schedule меньше худшего пути: ' + S[0].timeout);
});

test('адреса в значениях профиля и образца — только стенд, файлы пробы в репозитории и TEST-NET', { skip: noPy }, () => {
  const urls = [];
  const walk = (v) => {
    if (typeof v === 'string') { if (/^[a-z]+:\/\//i.test(v)) urls.push(v); } else if (v && typeof v === 'object') for (const k in v) walk(v[k]);
  };
  walk(yaml(read(PROFILE)));
  walk(yaml(read(NODES)));
  assert.ok(urls.length >= 20);
  for (const u of urls) {
    assert.ok(u.startsWith(STAND + '/lab/') || u === RAW + PROFILE || u === RAW + NODES || u === RAW + SCRIPT || u === 'http://192.0.2.1/', u);
  }
});

// ------------------------------------------------------------ журнал раздачи
const TOK = 'e'.repeat(32);
const ORIGIN = 'https://w.invalid';
function envOf(client) {
  return makeEnv({ devices: { k1: { status: 'bound', token: TOK } } }, client ? { CLIENT: client } : {});
}
async function capture(fn) {
  const real = console.log, out = [];
  console.log = (...a) => { out.push(a.map(String).join(' ')); };
  try { return { r: await fn(), out }; } finally { console.log = real; }
}
const egsLines = (out) => out.filter((s) => s.indexOf('"egs-file"') >= 0).map((s) => JSON.parse(s));

test('раздача файлов пробы на стенде Stash: одна строка журнала на файл, f и m верны, без токена и пути', async () => {
  for (const [p, f] of [[PROFILE, 'profile'], [NODES, 'nodes'], [SCRIPT, 'script']]) {
    for (const method of ['GET', 'HEAD']) {
      const { r, out } = await capture(() => worker.fetch(req(ORIGIN + '/t/' + TOK + '/repo/' + p, { method }), envOf('stash')));
      assert.equal(r.status, 200, p);
      const L = egsLines(out);
      assert.equal(L.length, 1, p + ' ' + method);
      assert.deepEqual(Object.keys(L[0]).sort(), ['asn', 'f', 'lab', 'm', 'org', 'ts']);
      assert.equal(L[0].f, f);
      assert.equal(L[0].m, method);
      assert.match(L[0].ts, /^\d{4}-\d\d-\d\dT/);
      for (const s of out) assert.ok(s.indexOf(TOK) < 0 && s.indexOf('/repo/') < 0, 'токен или путь в журнале: ' + s);
    }
  }
});

test('профиль со стенда: все ссылки на репозиторий переписаны на адрес с токеном запросившего', async () => {
  const r = await worker.fetch(req(ORIGIN + '/t/' + TOK + '/repo/' + PROFILE), envOf('stash'));
  const body = await r.text();
  assert.ok(body.indexOf('https://raw.githubusercontent.com') < 0);
  for (const p of [PROFILE, NODES, SCRIPT]) assert.ok(body.indexOf(ORIGIN + '/t/' + TOK + '/repo/' + p) > 0, p);
});

test('журнала нет: у прочих файлов, при 403 и 404, у боевого Loon', async () => {
  const cases = [
    [ORIGIN + '/t/' + TOK + '/repo/routehub.conf', 'stash', 200],
    [ORIGIN + '/t/' + TOK + '/repo/probes/routehub-lab.js', 'stash', 200],
    [ORIGIN + '/t/' + 'f'.repeat(32) + '/repo/' + PROFILE, 'stash', 403],
    [ORIGIN + '/repo/' + PROFILE + '?token=' + TOK, 'stash', 403],
    [ORIGIN + '/t/' + TOK + '/repo/plugins/RouteHub-Egern-EGS-x.yaml', 'stash', 404],
    [ORIGIN + '/t/' + TOK + '/repo/' + PROFILE, '', 200],
    [ORIGIN + '/t/' + TOK + '/repo/' + PROFILE, 'loon', 200],
  ];
  for (const [u, c, st] of cases) {
    const { r, out } = await capture(() => worker.fetch(req(u), envOf(c)));
    assert.equal(r.status, st, u + ' ' + c);
    assert.deepEqual(egsLines(out), [], u + ' ' + c);
  }
});

test('noteRepoServe: сеть источника — только asn и санированное название, прочие поля cf не пишутся', () => {
  const out = [];
  const cf = { asn: 31133, asOrganization: 'PJSC "MegaFon"\nX', city: 'Город', clientTcpRtt: 5, latitude: '55.1' };
  T.EGERN_LAB.noteRepoServe(PROFILE, { CLIENT: 'stash' }, cf, 'GET', Date.UTC(2026, 8, 28), (s) => out.push(s));
  assert.equal(out.length, 1);
  const L = JSON.parse(out[0]);
  assert.deepEqual(L, { lab: 'egs-file', f: 'profile', m: 'GET', ts: '2026-09-28T00:00:00.000Z', asn: 31133, org: 'PJSC MegaFon X' });
  T.EGERN_LAB.noteRepoServe('routehub.conf', { CLIENT: 'stash' }, cf, 'GET', 0, (s) => out.push(s));
  T.EGERN_LAB.noteRepoServe(PROFILE, { CLIENT: 'loon' }, cf, 'GET', 0, (s) => out.push(s));
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(T.EGERN_LAB.EGS_FILES).sort(), [NODES, PROFILE, SCRIPT].sort());
});

test('сбой отметки раздачи не роняет ответ; отметка получает путь из манифеста, без токена', async () => {
  const env = envOf('stash');
  const seen = [];
  const r = await T.handleRepo({ url: ORIGIN + '/t/' + TOK + '/repo/' + PROFILE }, new URL(ORIGIN + '/repo/' + PROFILE), env, TOK,
    (p) => { seen.push(p); throw new Error('сбой'); });
  assert.equal(r.status, 200);
  assert.deepEqual(seen, [PROFILE]);
  const bad = [];
  const r2 = await T.handleRepo({ url: ORIGIN + '/t/' + TOK + '/repo/docs/x.md' }, new URL(ORIGIN + '/repo/docs/x.md'), env, TOK, (p) => bad.push(p));
  assert.equal(r2.status, 404);
  assert.deepEqual(bad, []);
});
