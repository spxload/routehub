// Прокси файлов репозитория /t/<токен>/repo/<путь> (T-private-repo; в main —
// v1.12.0, в ветке stash-client — перенос, Worker v1.11.0).
//
// Что держит этот набор:
//   — без токена в пути и с чужим токеном — 403, при любой фазе token_required;
//   — вне белого списка (docs/, README, вложенные каталоги, «..», «%») — 404;
//   — разрешённый файл — 200, текст файла с диска байт в байт, где ссылки на
//     spxload/routehub (raw и jsDelivr, ветки main и stash-client) заменены
//     на прокси с токеном
//     ЗАПРОСИВШЕГО устройства; прочие ссылки не тронуты;
//   — прокси не ходит в сеть и не пишет в D1.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeEnv } from './mock-d1.js';
import { worker, req, ROOT, T } from './harness.js';

const { FILES } = await import('../src/files.js');

const TA = 'a'.repeat(32);
const TB = 'B'.repeat(24) + 'c'.repeat(8);
const ORIGIN = 'https://w.invalid';

function envTwo(extra) {
  return makeEnv(Object.assign({
    devices: { k1: { status: 'bound', token: TA }, k2: { status: 'bound', token: TB } },
  }, extra || {}));
}

// Сеть запрещена целиком: любой fetch — исключение и запись в журнал.
async function noNet(fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (u) => { seen.push(String(u)); throw new Error('сеть из прокси: ' + u); };
  try { return await fn(seen); } finally { globalThis.fetch = real; }
}

function get(p, tok) { return req(ORIGIN + (tok ? '/t/' + tok : '') + p); }

// Ожидаемый текст считается НЕЗАВИСИМО от кода Worker'а: подстановка строк
// по списку манифеста, длинные пути первыми.
function expected(disk, tok) {
  const base = ORIGIN + '/t/' + tok + '/repo/';
  let out = disk;
  const paths = Object.keys(FILES).sort((a, b) => b.length - a.length);
  for (const p of paths) {
    for (const pre of ['https://raw.githubusercontent.com/spxload/routehub/main/', 'https://cdn.jsdelivr.net/gh/spxload/routehub@main/',
      'https://raw.githubusercontent.com/spxload/routehub/stash-client/', 'https://cdn.jsdelivr.net/gh/spxload/routehub@stash-client/']) {
      out = out.split(pre + p).join(base + p);
      // Ссылка установки Stash: тот же адрес без схемы после install-override/.
      const inst = 'https://link.stash.ws/install-override/';
      out = out.split(inst + pre.slice('https://'.length) + p).join(inst + base.slice('https://'.length) + p);
    }
  }
  return out;
}

// ---------------------------------------------------------------- токен
test('прокси без токена — 403 (и при token_required=false, и при true)', async () => {
  for (const st of [undefined, { token_required: false }, { token_required: true }]) {
    const env = envTwo(st ? { settings: st } : {});
    await noNet(async () => {
      const r = await worker.fetch(get('/repo/routehub.conf'), env);
      assert.equal(r.status, 403, 'settings=' + JSON.stringify(st));
      assert.match(await r.text(), /токен/);
    });
  }
});

test('прокси: токен в ?token= не заменяет токен в пути — 403', async () => {
  const env = envTwo();
  const r = await worker.fetch(req(ORIGIN + '/repo/routehub.conf?token=' + TA), env);
  assert.equal(r.status, 403);
});

test('прокси с чужим токеном — 403, текст объясняет причину', async () => {
  const env = envTwo();
  await noNet(async () => {
    const r = await worker.fetch(get('/repo/scripts/routehub-dash.js', 'Z'.repeat(32)), env);
    assert.equal(r.status, 403);
    assert.match(r.headers.get('Content-Type') || '', /text\/plain/);
    assert.match(await r.text(), /RouteHub: .*токен/);
  });
});

test('прокси: при пустом реестре любой токен — 403', async () => {
  const env = makeEnv({});
  const r = await worker.fetch(get('/repo/routehub.conf', TA), env);
  assert.equal(r.status, 403);
});

test('прокси: без токена 403 даже на запрещённый путь (белый список не раскрывается)', async () => {
  const env = envTwo();
  assert.equal((await worker.fetch(get('/repo/docs/x.md'), env)).status, 403);
});

// ---------------------------------------------------------------- пути
const DENY = [
  '/repo/docs/ADR-01.md',
  '/repo/README.md',
  '/repo/CHANGELOG.md',
  '/repo/СТАРТ.md',
  '/repo/studio/README.md',
  '/repo/.github/workflows/x.yml',
  '/repo/Photo/a.png',
  '/repo/wrangler.toml',
  '/repo/routehub-worker.js',
  '/repo/src/api.js',
  '/repo/web/routehub-admin.html',
  '/repo/scripts/../docs/ADR-01.md',
  '/repo/scripts/%2e%2e/docs/ADR-01.md',
  '/repo/scripts/.%2e/docs/ADR-01.md',
  '/repo/scripts%2F..%2Fdocs%2FADR-01.md',
  '/repo/scripts%2Froutehub-dash.js',
  '/repo/scripts/routehub%2Ddash.js',
  '/repo/scripts/sub/routehub-dash.js',
  '/repo/scripts/routehub-dash.js/',
  '/repo/scripts/',
  '/repo/scripts',
  '/repo/',
  '/repo/Scripts/routehub-dash.js',
  '/repo/scripts/routehub-nope.js',
  '/repo/probes/routehub-stash-probe.yaml',
  '/repo/probes/RouteHub-Surge.sgmodule',
  '/repo/probes/routehub-surge-stand.conf',
  '/repo/plugins/RouteHub-Stash-ST6-inline.stoverride',
  // Есть только в main: стенд отдаёт свои файлы, чужих не выдумывает.
  '/repo/plugins/RouteHub-DNS-L12.plugin',
  '/repo/probes/routehub-probe-dnstime.js',
  '/repo/tools/build-inline-override.mjs',
  '/repo/routehub.conf.bak',
  '/repo//routehub.conf',
];

test('прокси: пути вне белого списка и манифеста — 404', async () => {
  const env = envTwo();
  await noNet(async () => {
    for (const p of DENY) {
      const r = await worker.fetch(get(p, TA), env);
      assert.equal(r.status, 404, p + ' -> ' + r.status);
    }
  });
});

// Node (как и рантайм) схлопывает «..» и «%2e%2e» при разборе URL, поэтому
// сырую проверку видно только при прямом вызове с несхлопнутым req.url.
test('прокси: белый список сверяется с СЫРЫМ путём запроса', async () => {
  const env = envTwo();
  const raw = [
    '/t/' + TA + '/repo/scripts/../routehub.conf',
    '/t/' + TA + '/repo/scripts/%2e%2e/routehub.conf',
    '/t/' + TA + '/repo/./routehub.conf',
    '/t/' + TA + '/repo/scripts/routehub%2Ddash.js',
    '/t/' + TA + '/x/../repo/routehub.conf',
  ];
  for (const p of raw) {
    const r = await T.handleRepo({ url: ORIGIN + p }, new URL(ORIGIN + '/repo/routehub.conf'), env, TA);
    assert.equal(r.status, 404, p);
  }
  // Токен в сыром пути обязан совпасть с тем, что проверил гейт.
  const r = await T.handleRepo({ url: ORIGIN + '/t/' + TB + '/repo/routehub.conf' },
    new URL(ORIGIN + '/repo/routehub.conf'), env, TA);
  assert.equal(r.status, 404);
  // Контроль: тот же вызов с чистым путём отдаёт файл.
  const ok = await T.handleRepo({ url: ORIGIN + '/t/' + TA + '/repo/routehub.conf' },
    new URL(ORIGIN + '/repo/routehub.conf'), env, TA);
  assert.equal(ok.status, 200);
});

test('REPO_RAW_RE: только routehub.conf и одно имя в scripts|probes|plugins', () => {
  const t = '/t/' + TA + '/repo/';
  for (const ok of ['routehub.conf', 'scripts/routehub-dash.js', 'probes/a.b-c_d.js', 'plugins/RouteHub-Dash.plugin']) {
    assert.ok(T.REPO_RAW_RE.test(t + ok), ok);
  }
  for (const bad of ['docs/a.md', 'scripts/sub/a.js', 'scripts/../a.js', 'scripts/..', 'scripts/.hidden',
    'scripts/a%2e.js', 'scripts%2Fa.js', 'README.md', 'routehub.conf/', 'xrouteHub.conf', 'routehub.confx',
    'web/routehub-admin.html', 'scripts/', 'scripts/a.js?x', 'scripts/a b.js',
    'Scripts/routehub-dash.js', 'ROUTEHUB.CONF', 'PLUGINS/RouteHub-Dash.plugin']) {
    assert.ok(!T.REPO_RAW_RE.test(t + bad), bad);
  }
  assert.ok(!T.REPO_RAW_RE.test('/t/short/repo/routehub.conf'), 'короткий токен');
  assert.ok(!T.REPO_RAW_RE.test('/repo/routehub.conf'), 'без токена');
});

// ---------------------------------------------------------------- выдача
test('прокси: каждый файл манифеста — 200, байт в байт с диском после переписывания', async () => {
  const env = envTwo();
  await noNet(async (seen) => {
    for (const p of Object.keys(FILES)) {
      const r = await worker.fetch(get('/repo/' + p, TB), env);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get('Location'), null);
      assert.equal(r.headers.get('Content-Type'), 'text/plain; charset=utf-8');
      assert.equal(r.headers.get('Cache-Control'), 'no-store');
      const body = Buffer.from(await r.arrayBuffer());
      const disk = fs.readFileSync(path.join(ROOT, p), 'utf8');
      assert.ok(body.equals(Buffer.from(expected(disk, TB), 'utf8')), p + ': тело не совпало');
    }
    assert.deepEqual(seen, []);
  });
});

test('прокси: ссылки внутри файла — с токеном ЗАПРОСИВШЕГО устройства', async () => {
  const env = envTwo();
  const fl = await (await worker.fetch(get('/repo/plugins/RouteHub-FailLog.plugin', TB), env)).text();
  assert.ok(fl.indexOf('script-path=' + ORIGIN + '/t/' + TB + '/repo/scripts/routehub-faillog.js,') >= 0);
  assert.equal(fl.indexOf(TA), -1, 'в ответе токен другого устройства');
  assert.equal(fl.indexOf('raw.githubusercontent.com/spxload'), -1);
  const fa = await (await worker.fetch(get('/repo/plugins/RouteHub-FailLog.plugin', TA), env)).text();
  assert.ok(fa.indexOf(ORIGIN + '/t/' + TA + '/repo/scripts/routehub-faillog.js') >= 0);
  // jsDelivr-зеркало переписывается так же.
  const st = await (await worker.fetch(get('/repo/plugins/RouteHub-Stash.stoverride', TB), env)).text();
  assert.ok(st.indexOf('url: ' + ORIGIN + '/t/' + TB + '/repo/probes/routehub-probe-stash7.js') >= 0);
  // Остаётся лишь ссылка установщика link.stash.ws в комментарии — её
  // адрес без https:// перед зеркалом, это не ссылка на файл.
  assert.equal(st.indexOf('https://cdn.jsdelivr.net/gh/spxload'), -1);
  // Override стенда со ссылкой на ветку stash-client (raw).
  const s13 = await (await worker.fetch(get('/repo/plugins/RouteHub-Stash-ST13.stoverride', TB), env)).text();
  assert.ok(s13.indexOf('url: ' + ORIGIN + '/t/' + TB + '/repo/probes/routehub-probe-stash13.js') >= 0);
  assert.equal(s13.indexOf('https://raw.githubusercontent.com/spxload'), -1);
  const col = await (await worker.fetch(get('/repo/plugins/RouteHub-Stash-Collect.stoverride', TA), env)).text();
  assert.ok(col.indexOf(ORIGIN + '/t/' + TA + '/repo/scripts/routehub-stash-collect.js') >= 0);
  assert.equal(col.indexOf(TB), -1, 'в ответе токен другого устройства');
});

test('прокси: HEAD отвечает 200, POST — 404', async () => {
  const env = envTwo();
  assert.equal((await worker.fetch(req(ORIGIN + '/t/' + TA + '/repo/routehub.conf', { method: 'HEAD' }), env)).status, 200);
  assert.equal((await worker.fetch(req(ORIGIN + '/t/' + TA + '/repo/routehub.conf', { method: 'POST', body: 'x' }), env)).status, 404);
});

test('прокси не пишет в D1', async () => {
  const env = envTwo();
  await worker.fetch(get('/repo/routehub.conf', TA), env);
  await worker.fetch(get('/repo/routehub.conf', 'Z'.repeat(32)), env);
  await worker.fetch(get('/repo/docs/x.md', TA), env);
  assert.equal(env.RH_DB.__stats.writes, 0);
  assert.equal(env.RH_DB.__stats.batches, 0);
});

// ---------------------------------------------------------------- переписчик
test('rewriteRepoLinks: ссылка установки Stash ведёт на прокси без схемы', () => {
  const o = ORIGIN, t = TA, host = o.replace(/^https:\/\//, '');
  const R = (s) => T.rewriteRepoLinks(s, o, t);
  assert.equal(R('# https://link.stash.ws/install-override/raw.githubusercontent.com/spxload/routehub/stash-client/plugins/RouteHub-Stash-ST13.stoverride'),
    '# https://link.stash.ws/install-override/' + host + '/t/' + t + '/repo/plugins/RouteHub-Stash-ST13.stoverride');
  assert.equal(R('https://link.stash.ws/install-override/cdn.jsdelivr.net/gh/spxload/routehub@main/plugins/RouteHub-Stash.stoverride'),
    'https://link.stash.ws/install-override/' + host + '/t/' + t + '/repo/plugins/RouteHub-Stash.stoverride');
  // Вне манифеста и чужой ref — без изменений.
  for (const keep of [
    'https://link.stash.ws/install-override/raw.githubusercontent.com/spxload/routehub/main/docs/x.stoverride',
    'https://link.stash.ws/install-override/raw.githubusercontent.com/spxload/routehub/egern/plugins/RouteHub-Stash.stoverride',
  ]) assert.equal(R(keep), keep);
});

test('в отдаваемых override не остаётся ни одной ссылки на spxload', async () => {
  const env = envTwo();
  for (const p of Object.keys(FILES).filter((f) => f.endsWith('.stoverride'))) {
    const body = await (await worker.fetch(get('/repo/' + p, TA), env)).text();
    assert.ok(!/spxload/.test(body), p + ' всё ещё ссылается на spxload');
  }
});

test('rewriteRepoLinks: только spxload/routehub и только пути из манифеста', () => {
  const o = ORIGIN, t = TA, b = o + '/t/' + t + '/repo/';
  const R = (s) => T.rewriteRepoLinks(s, o, t);
  assert.equal(R('https://raw.githubusercontent.com/spxload/routehub/main/scripts/routehub-dash.js, x'),
    b + 'scripts/routehub-dash.js, x');
  assert.equal(R('url: https://cdn.jsdelivr.net/gh/spxload/routehub@main/probes/routehub-probe-stash.js\n'),
    'url: ' + b + 'probes/routehub-probe-stash.js\n');
  // Ветка stash-client — оба зеркала; отдаётся копия этой ветки.
  assert.equal(R('https://raw.githubusercontent.com/spxload/routehub/stash-client/routehub.conf'), b + 'routehub.conf');
  assert.equal(R('url: https://raw.githubusercontent.com/spxload/routehub/stash-client/probes/routehub-probe-stash17.js'),
    'url: ' + b + 'probes/routehub-probe-stash17.js');
  assert.equal(R('https://cdn.jsdelivr.net/gh/spxload/routehub@stash-client/scripts/routehub-stash-collect.js'),
    b + 'scripts/routehub-stash-collect.js');
  for (const keep of [
    'https://raw.githubusercontent.com/spxload/routehub/main/docs/ADR-01.md',
    'https://raw.githubusercontent.com/spxload/routehub/main/routehub-stash-probe.yaml',
    'https://raw.githubusercontent.com/spxload/routehub/main/probes/RouteHub-Surge.sgmodule',
    'https://raw.githubusercontent.com/spxload/routehub/egern/routehub.conf',
    'https://raw.githubusercontent.com/spxload/routehub/stash-clientx/routehub.conf',
    'https://raw.githubusercontent.com/spxload/routehub/stash/routehub.conf',
    'https://cdn.jsdelivr.net/gh/spxload/routehub@stash-client2/routehub.conf',
    'https://raw.githubusercontent.com/spxload/routehub/main/probes/routehub-probe-dnstime.js',
    'https://raw.githubusercontent.com/spxload/other/main/routehub.conf',
    'https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Loon/Privacy/Privacy.list',
    'https://cdn.jsdelivr.net/gh/Orz-3/mini@master/Color/AI.png',
  ]) assert.equal(R(keep), keep, keep);
});
