// Тесты админ-зоны: гейт, /admin/state, /admin/device, /admin/settings,
// /admin/mylist, /admin/action и сессионная cookie панели.
// Выделено из tests/routehub-worker.test.js 2026-08-25 (ветка stash-client).
// Тесты перенесены дословно.
//
// Загрузка Worker'а и общие помощники — в tests/harness.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, nodeLine } from './mock-d1.js';
import { T, worker, DE, NL, req, post } from './harness.js';

// ---------------------------------------------------------------- админ-зона
const ADM = { 'X-Admin-Key': 'ADMIN-TEST-KEY' };

// Фикстура подписки — та же, что в speed.test.js: /admin/state читает
// sub_cache и считает по нему каскад. Дословная копия из общего файла
// тестов до разреза 2026-08-25.
const SUB = {
  ts: Date.now(),
  n: 2,
  text: [nodeLine('[VPN] ' + DE + ' Германия #1'), nodeLine('[VPN] ' + NL + ' Нидерланды #1')].join('\n'),
  meta: {},
};


test('GET /admin отдаёт HTML без ключа', async () => {
  const env = makeEnv({});
  const r = await worker.fetch(req('https://w.invalid/admin'), env);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Content-Type'), /text\/html/);
});

test('adminGate принимает ключ из заголовка и из ?key=', async () => {
  const env = makeEnv({});
  const h = await worker.fetch(req('https://w.invalid/admin/state', { headers: ADM }), env);
  assert.equal(h.status, 200);
  const q = await worker.fetch(req('https://w.invalid/admin/state?key=ADMIN-TEST-KEY'), env);
  assert.equal(q.status, 200);
});

test('админ-эндпоинты без ключа и с чужим ключом закрыты', async () => {
  const env = makeEnv({});
  assert.equal((await worker.fetch(req('https://w.invalid/admin/state'), env)).status, 403);
  const bad = await worker.fetch(req('https://w.invalid/admin/state', { headers: { 'X-Admin-Key': 'wrong-key' } }), env);
  assert.equal(bad.status, 403);
});

test('без секрета ADMIN_KEY админ-зона закрыта наглухо', async () => {
  const env = makeEnv({});
  delete env.ADMIN_KEY;
  const r = await worker.fetch(req('https://w.invalid/admin/state', { headers: ADM }), env);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, 'admin disabled');
});

test('/admin/state отдаёт подписку, каскад, устройства и хранилище', async () => {
  const env = makeEnv({
    sub_cache: SUB,
    devices: { k1: { status: 'bound', token: 'a'.repeat(32), conf_ver: 'C-draft-36' } },
    'metrics:k1': { [T.matchKey('[VPN] ' + DE + ' Германия #1')]: { w: { down: 9, rtt: 40 } } },
    'mylist:k1': ['whoosh.bike'],
  });
  const r = await worker.fetch(req('https://w.invalid/admin/state', { headers: ADM }), env);
  const j = await r.json();
  assert.equal(j.worker, T.WORKER_VER, 'панель и const.js разошлись в версии');
  assert.equal(j.dev, 'k1');
  assert.equal(j.sub.nodes, 2);
  assert.equal(j.sub.fresh_min, 60);
  assert.deepEqual(j.cascade.EU, { total: 2, live: 1 }, 'в SUB два европейских узла, метрика есть у одного');
  assert.deepEqual(j.mylist, ['whoosh.bike']);
  assert.equal(j.devices[0].config_url, 'https://w.invalid/t/' + 'a'.repeat(32) + '/config?key=k1');
  assert.ok(j.storage.some((s) => s.key === 'metrics:k1' && s.len > 0));
});

test('/admin/device переключает флаги устройства', async () => {
  const env = makeEnv({ devices: { k1: { status: 'bound', token: 'a'.repeat(32) } } });
  const r = await worker.fetch(post('https://w.invalid/admin/device',
    { key: 'k1', flags: { cell_unlim: true, show_rtt: true } }, ADM), env);
  assert.equal(r.status, 200);
  const reg = env.RH_DB.get('devices');
  assert.equal(reg.k1.cell_unlim, true);
  assert.equal(reg.k1.show_rtt, true);
  assert.equal(reg.k1.ewma, false, 'непереданные флаги инициализируются false');
});

test('/admin/device перевыпускает токен', async () => {
  const old = 'a'.repeat(32);
  const env = makeEnv({ devices: { k1: { status: 'bound', token: old } } });
  const r = await worker.fetch(post('https://w.invalid/admin/device',
    { key: 'k1', action: 'regen_token' }, ADM), env);
  const j = await r.json();
  assert.notEqual(j.device.token, old);
  assert.match(j.device.token, /^[A-Za-z0-9]{32}$/);
});

test('/admin/device отвязывает устройство и оставляет запасной ключ', async () => {
  const env = makeEnv({ devices: { k1: { status: 'bound', nonce: 'n-1', token: 'a'.repeat(32) } } });
  await worker.fetch(post('https://w.invalid/admin/device', { key: 'k1', action: 'unbind' }, ADM), env);
  const reg = env.RH_DB.get('devices');
  assert.equal(reg.k1.status, 'free');
  assert.ok(!('nonce' in reg.k1));
});

test('/admin/device: неизвестное действие и чужой ключ отклоняются', async () => {
  const env = makeEnv({ devices: { k1: { status: 'bound', token: 'a'.repeat(32) } } });
  const a = await worker.fetch(post('https://w.invalid/admin/device', { key: 'k1', action: 'wipe-all' }, ADM), env);
  assert.equal(a.status, 400);
  const b = await worker.fetch(post('https://w.invalid/admin/device', { key: 'k9' }, ADM), env);
  assert.equal(b.status, 404);
});

test('/admin/settings переключает фазу токенов и она сразу действует', async () => {
  const env = makeEnv({ devices: { k1: { status: 'bound', token: 'a'.repeat(32) } } });
  const ok1 = await worker.fetch(req('https://w.invalid/status?key=k1'), env);
  assert.equal(ok1.status, 200, 'фаза 1: ссылка без токена работает');

  const r = await worker.fetch(post('https://w.invalid/admin/settings', { token_required: true }, ADM), env);
  assert.equal(r.status, 200);
  assert.equal(env.RH_DB.get('settings').token_required, true);

  const denied = await worker.fetch(req('https://w.invalid/status?key=k1'), env);
  assert.equal(denied.status, 403, 'фаза 2: ссылка без токена должна отвалиться');
  const withTok = await worker.fetch(req('https://w.invalid/t/' + 'a'.repeat(32) + '/status?key=k1'), env);
  assert.equal(withTok.status, 200, 'ссылка с токеном обязана работать');

  await worker.fetch(post('https://w.invalid/admin/settings', { token_required: false }, ADM), env);
  assert.equal((await worker.fetch(req('https://w.invalid/status?key=k1'), env)).status, 200,
    'откат тумблера должен возвращать доступ');
});

test('/admin/settings отвергает мусор вместо булева значения', async () => {
  const env = makeEnv({});
  const r = await worker.fetch(post('https://w.invalid/admin/settings', { token_required: 'да' }, ADM), env);
  assert.equal(r.status, 400);
});

test('/admin/mylist добавляет и удаляет домен', async () => {
  const env = makeEnv({ devices: { k1: { status: 'bound', token: 'a'.repeat(32) } } });
  await worker.fetch(post('https://w.invalid/admin/mylist', { key: 'k1', domain: 'whoosh.bike' }, ADM), env);
  assert.deepEqual(env.RH_DB.get('mylist:k1'), ['whoosh.bike']);
  const r = await worker.fetch(post('https://w.invalid/admin/mylist',
    { key: 'k1', domain: 'whoosh.bike', add: false }, ADM), env);
  assert.deepEqual((await r.json()).domains, []);
});

test('/admin/mylist отвергает некорректный домен', async () => {
  const env = makeEnv({ devices: { k1: { status: 'bound', token: 'a'.repeat(32) } } });
  const r = await worker.fetch(post('https://w.invalid/admin/mylist', { key: 'k1', domain: 'не домен' }, ADM), env);
  assert.equal(r.status, 400);
});

test('/admin/action refresh_sub обновляет кэш подписки', async () => {
  const env = makeEnv({});
  const body = [nodeLine('[VPN] ' + DE + ' Германия #1'), nodeLine('[VPN] ' + NL + ' Нидерланды #1')].join('\n');
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status: 200 });
  try {
    const r = await worker.fetch(post('https://w.invalid/admin/action', { action: 'refresh_sub' }, ADM), env);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.nodes, 2);
    assert.equal(env.RH_DB.get('sub_cache').n, 2);
  } finally { globalThis.fetch = real; }
});

test('/admin/action: неизвестное действие отклоняется', async () => {
  const env = makeEnv({});
  const r = await worker.fetch(post('https://w.invalid/admin/action', { action: 'удалить всё' }, ADM), env);
  assert.equal(r.status, 400);
});

// ------------------------------------------------- сессия панели (v1.9.1)
// Сессия — подписанная cookie, сервер ничего не хранит. Ключ подписи —
// ADMIN_KEY, поэтому его смена обязана обесценивать выданные сессии.
function cookieHdr(v) { return { 'Cookie': T.ADMIN_COOKIE + '=' + v }; }

test('/admin/login с верным ключом выдаёт защищённую cookie на 30 суток', async () => {
  const env = makeEnv({});
  const r = await worker.fetch(post('https://w.invalid/admin/login', { key: 'ADMIN-TEST-KEY' }), env);
  assert.equal(r.status, 200);
  const sc = r.headers.get('Set-Cookie');
  assert.ok(sc, 'Set-Cookie не выставлен');
  assert.ok(sc.startsWith(T.ADMIN_COOKIE + '='));
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Strict/);
  assert.match(sc, /Path=\/admin/, 'cookie не должна уходить на эндпоинты устройств');
  assert.match(sc, new RegExp('Max-Age=' + Math.round(T.ADMIN_SESSION_MS / 1000)));
});

test('/admin/login с чужим ключом — 403 и без cookie', async () => {
  const env = makeEnv({});
  const r = await worker.fetch(post('https://w.invalid/admin/login', { key: 'wrong-key' }), env);
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('Set-Cookie'), null, 'при отказе cookie выдавать нельзя');
});

test('сессионная cookie открывает админ-эндпоинты без ключа', async () => {
  const env = makeEnv({});
  const val = await T.makeSession(env.ADMIN_KEY);
  const r = await worker.fetch(req('https://w.invalid/admin/state', { headers: cookieHdr(val) }), env);
  assert.equal(r.status, 200);
  const p = await worker.fetch(new Request('https://w.invalid/admin/device', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, cookieHdr(val)),
    body: JSON.stringify({ key: 'k1', flags: { ewma: true } }),
  }), env);
  assert.equal(p.status, 200, 'POST-эндпоинты тоже должны пускать по сессии');
});

test('поддельная и просроченная сессии отвергаются', async () => {
  const env = makeEnv({});
  const good = await T.makeSession(env.ADMIN_KEY);
  const forged = good.slice(0, good.indexOf('.') + 1) + 'A'.repeat(43);
  assert.equal(await T.verifySession(env.ADMIN_KEY, forged), false, 'подпись не проверена');
  const expTs = Date.now() - 1000;
  const expired = expTs + '.' + (await T.signSession(env.ADMIN_KEY, expTs));
  assert.equal(await T.verifySession(env.ADMIN_KEY, expired), false, 'срок не проверен');
  assert.equal(await T.verifySession(env.ADMIN_KEY, 'мусор'), false);
  const r = await worker.fetch(req('https://w.invalid/admin/state', { headers: cookieHdr(forged) }), env);
  assert.equal(r.status, 403);
});

test('смена ADMIN_KEY обнуляет ранее выданные сессии', async () => {
  const env = makeEnv({});
  const val = await T.makeSession(env.ADMIN_KEY);
  env.ADMIN_KEY = 'NEW-ADMIN-KEY';
  const r = await worker.fetch(req('https://w.invalid/admin/state', { headers: cookieHdr(val) }), env);
  assert.equal(r.status, 403);
});

test('/admin/logout гасит cookie', async () => {
  const env = makeEnv({});
  const r = await worker.fetch(post('https://w.invalid/admin/logout', {}), env);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Set-Cookie'), /Max-Age=0/);
});

test('timingEq: равные строки, разные строки, разная длина', () => {
  assert.equal(T.timingEq('abc', 'abc'), true);
  assert.equal(T.timingEq('abc', 'abd'), false);
  assert.equal(T.timingEq('abc', 'abcd'), false);
  assert.equal(T.timingEq('abc', null), false);
});
