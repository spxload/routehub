// Тесты routehub-worker.js. Запуск: node --test "tests/*.test.js"
// CI нет намеренно — прогон ручной, перед коммитом.
//
// Worker импортирует routehub-admin.html (модуль типа Text, его подставляет
// Wrangler при сборке). Node такой импорт не понимает, поэтому тесты грузят
// копию исходника с заменённой строкой импорта. Остальной код не трогается.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { makeEnv, nodeLine } from './mock-d1.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'routehub-worker.js'), 'utf8');
const SHIM = SRC.replace(/^import ADMIN_HTML from .+$/m,
  "const ADMIN_HTML = '<!doctype html><title>test</title>';");
assert.notEqual(SHIM, SRC, 'строка импорта HTML не найдена — проверить шапку worker.js');
const TMP = path.join(os.tmpdir(), 'rh-worker-under-test.mjs');
fs.writeFileSync(TMP, SHIM);
const W = await import(pathToFileURL(TMP).href);
const T = W.__test;
const worker = W.default;

const DE = '\u{1F1E9}\u{1F1EA}', NL = '\u{1F1F3}\u{1F1F1}', US = '\u{1F1FA}\u{1F1F8}';
const KZ = '\u{1F1F0}\u{1F1FF}', RUF = '\u{1F1F7}\u{1F1FA}', TR = '\u{1F1F9}\u{1F1F7}';
const WIFI = '\u{1F6DC}';

function req(url, opts) {
  return new Request(url, opts || {});
}
function post(url, body, headers) {
  return new Request(url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------- параметры
test('FRESH_MS = 60 минут', () => {
  assert.equal(T.FRESH_MS, 60 * 60 * 1000);
});

test('версия Worker\'а — v1.9.0', () => {
  assert.equal(T.WORKER_VER, 'v1.9.0');
});

test('subParamsFromConf сохраняет хвост параметров подписки', () => {
  const conf = 'Lastdep = https://x.invalid/nodes?key=k1,block-quic=false,udp=true,enabled=true\n';
  assert.equal(T.subParamsFromConf(conf), ',block-quic=false,udp=true,enabled=true');
});

test('subParamsFromConf: строки нет либо параметров нет — запасной дефолт', () => {
  assert.equal(T.subParamsFromConf('# пусто'), ',udp=true,enabled=true');
  assert.equal(T.subParamsFromConf('Lastdep = https://x.invalid/n'), ',udp=true,enabled=true');
});

test('matchKey срезает метрику и нормализует пробелы', () => {
  const nm = '[VPN] ' + DE + ' Германия  #1 \u00B7 ' + WIFI + '\u2585 \u2077\u2075';
  assert.equal(T.matchKey(nm), '[VPN] ' + DE + ' Германия #1');
});

// ------------------------------------------------------------------ регионы
test('regionOf: Европа/Америка/СНГ/прочие', () => {
  assert.equal(T.regionOf(DE), 0);
  assert.equal(T.regionOf(US), 1);
  assert.equal(T.regionOf(KZ), 2);
  assert.equal(T.regionOf(TR), 3);
  assert.equal(T.regionOf('нет такого'), 3);
});

test('buildAiTiers: DE первой, СНГ исключён, регион важнее числа узлов', () => {
  const lines = [];
  for (let i = 0; i < 2; i++) lines.push(nodeLine('[VPN] ' + DE + ' Германия #' + i));
  for (let i = 0; i < 2; i++) lines.push(nodeLine('[VPN] ' + NL + ' Нидерланды #' + i));
  for (let i = 0; i < 2; i++) lines.push(nodeLine('[VPN] ' + US + ' США #' + i));
  for (let i = 0; i < 4; i++) lines.push(nodeLine('[VPN] ' + TR + ' Турция #' + i));
  for (let i = 0; i < 3; i++) lines.push(nodeLine('[VPN] ' + KZ + ' Казахстан #' + i));
  const tiers = T.buildAiTiers(lines, {});
  assert.equal(tiers[0], DE, 'DE обязана быть первой');
  assert.equal(tiers[1], NL, 'Европа раньше Америки');
  assert.equal(tiers[2], US, 'Америка раньше прочих');
  assert.equal(tiers[3], TR, 'Турция последняя, несмотря на 4 узла');
  assert.ok(!tiers.includes(KZ), 'СНГ в AI-тиеры попадать не должен');
});

test('AIrest исключает весь СНГ, а не только RU/BY', () => {
  const blocks = T.aiBlocks([DE, NL]);
  const line = blocks.filters.split('\n').find((l) => l.indexOf('AIrest') >= 0);
  for (const fl of [RUF, KZ]) assert.ok(line.indexOf(fl) >= 0, 'в исключениях нет ' + fl);
});

test('cascadeOf раскладывает узлы по тирам конфига', () => {
  const lines = [
    nodeLine('[VPN] ' + DE + ' Германия #1'),
    nodeLine('[VPN] ' + US + ' США #1'),
    nodeLine('[VPN] ' + KZ + ' Казахстан #1'),
    nodeLine('[VPN] ' + TR + ' Турция #1'),
    nodeLine('[Игры] ' + DE + ' Германия #1'),
    nodeLine('[Обход] ' + DE + ' Германия'),
  ];
  const state = {};
  state[T.matchKey('[VPN] ' + DE + ' Германия #1')] = { w: { down: 10, rtt: 40 } };
  state[T.matchKey('[VPN] ' + US + ' США #1')] = { w: { dead: true } };
  const c = T.cascadeOf(lines, state);
  assert.deepEqual(c.EU, { total: 1, live: 1 });
  assert.deepEqual(c.AM, { total: 1, live: 0 }, 'dead живым не считается');
  assert.deepEqual(c.RU, { total: 1, live: 0 });
  assert.deepEqual(c.REST, { total: 1, live: 0 });
  assert.deepEqual(c.GAME, { total: 1, live: 0 });
  assert.deepEqual(c.BYPASS, { total: 1, live: 0 });
});

// ------------------------------------------------------------------- токены
test('tokenGate: верный токен пропускает, чужой отклоняется всегда', async () => {
  const env = makeEnv({ settings: { token_required: false } });
  const reg = { k1: { token: 'a'.repeat(32) } };
  assert.equal(await T.tokenGate(env, reg, 'k1', 'a'.repeat(32), false), null);
  const bad = await T.tokenGate(env, reg, 'k1', 'b'.repeat(32), false);
  assert.equal(bad.status, 403);
});

test('tokenGate: фаза 1 пропускает без токена, фаза 2 — нет', async () => {
  const reg = { k1: { token: 'a'.repeat(32) } };
  const env1 = makeEnv({ settings: { token_required: false } });
  assert.equal(await T.tokenGate(env1, reg, 'k1', '', false), null);
  const env2 = makeEnv({ settings: { token_required: true } });
  const bad = await T.tokenGate(env2, reg, 'k1', '', false);
  assert.equal(bad.status, 403);
});

test('settings отсутствуют — по умолчанию фаза 1 (token_required=false)', async () => {
  const env = makeEnv({});
  assert.deepEqual(await T.loadSettings(env), { token_required: false });
});

test('токен из settings читается только при запросе без токена', async () => {
  const env = makeEnv({ settings: { token_required: false } });
  const reg = { k1: { token: 'a'.repeat(32) } };
  const before = env.RH_DB.__stats.reads;
  await T.tokenGate(env, reg, 'k1', 'a'.repeat(32), false);
  assert.equal(env.RH_DB.__stats.reads, before, 'лишнее чтение D1 по новой ссылке');
  await T.tokenGate(env, reg, 'k1', '', false);
  assert.equal(env.RH_DB.__stats.reads, before + 1);
});

test('префикс пути /t/<token>/ срезается и не мешает маршрутизации', async () => {
  const env = makeEnv({ devices: { k1: { status: 'bound', token: 'a'.repeat(32) } } });
  const r = await worker.fetch(req('https://w.invalid/t/' + 'a'.repeat(32) + '/status?key=k1'), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.key, 'k1');
});

test('чужой токен в префиксе пути — отказ', async () => {
  const env = makeEnv({ devices: { k1: { status: 'bound', token: 'a'.repeat(32) } } });
  const r = await worker.fetch(req('https://w.invalid/t/' + 'z'.repeat(32) + '/status?key=k1'), env);
  assert.equal(r.status, 403);
});

test('ensureTokens выдаёт токен ключу без него', () => {
  const reg = { k1: { status: 'bound' }, k2: { status: 'free', token: 'a'.repeat(32) } };
  assert.equal(T.ensureTokens(reg), true);
  assert.match(reg.k1.token, /^[A-Za-z0-9]{32}$/);
  assert.equal(reg.k2.token, 'a'.repeat(32), 'существующий токен не трогаем');
  assert.equal(T.ensureTokens(reg), false, 'повторный вызов реестр не меняет');
});

// -------------------------------------------------------------- POST /speed
const SUB = {
  ts: Date.now(),
  n: 2,
  text: [nodeLine('[VPN] ' + DE + ' Германия #1'), nodeLine('[VPN] ' + NL + ' Нидерланды #1')].join('\n'),
  meta: {},
};

test('POST /speed: первое устройство привязывается и заводится запасной ключ', async () => {
  const env = makeEnv({ sub_cache: SUB });
  const r = await worker.fetch(post('https://w.invalid/speed', {
    key: 'k1', nonce: 'n-1',
    wifi: [{ name: '[VPN] ' + DE + ' Германия #1', down: 20, rtt: 40, jit: 5, bl: 10 }],
  }), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.status, 'bound');
  const reg = env.RH_DB.get('devices');
  assert.equal(reg.k1.nonce, 'n-1');
  assert.equal(reg.k2.status, 'free', 'запасной ключ должен создаться сам');
});

test('POST /speed: чужой nonce -> 409 и статус conflict', async () => {
  const env = makeEnv({
    sub_cache: SUB,
    devices: { k1: { status: 'bound', nonce: 'n-1', token: 'a'.repeat(32) } },
  });
  const r = await worker.fetch(post('https://w.invalid/speed', { key: 'k1', nonce: 'ЧУЖОЙ' }), env);
  assert.equal(r.status, 409);
  assert.equal(env.RH_DB.get('devices').k1.status, 'conflict');
});

test('POST /speed отсекает метрики узлов, которых нет в подписке', async () => {
  const dead = T.matchKey('[VPN] ' + DE + ' Удалённый #9');
  const alive = T.matchKey('[VPN] ' + NL + ' Нидерланды #1');
  const env = makeEnv({
    sub_cache: SUB,
    devices: { k1: { status: 'bound', nonce: 'n-1', token: 'a'.repeat(32) } },
    'metrics:k1': { [dead]: { w: { down: 5, rtt: 50 } }, [alive]: { w: { down: 7, rtt: 50 } } },
  });
  const r = await worker.fetch(post('https://w.invalid/speed', {
    key: 'k1', nonce: 'n-1',
    wifi: [{ name: '[VPN] ' + DE + ' Германия #1', down: 20, rtt: 40 }],
  }), env);
  const j = await r.json();
  assert.equal(j.pruned, 1);
  const m = env.RH_DB.get('metrics:k1');
  assert.ok(!(dead in m), 'мёртвая метрика осталась');
  assert.ok(alive in m, 'живая метрика удалена ошибочно');
  assert.ok(T.matchKey('[VPN] ' + DE + ' Германия #1') in m);
});

test('предохранитель: подписки нет — метрики не чистятся', async () => {
  const dead = T.matchKey('[VPN] ' + DE + ' Удалённый #9');
  const env = makeEnv({
    devices: { k1: { status: 'bound', nonce: 'n-1', token: 'a'.repeat(32) } },
    'metrics:k1': { [dead]: { w: { down: 5, rtt: 50 } } },
  });
  const r = await worker.fetch(post('https://w.invalid/speed', { key: 'k1', nonce: 'n-1' }), env);
  const j = await r.json();
  assert.equal(j.pruned, 0);
  assert.ok(dead in env.RH_DB.get('metrics:k1'), 'при пустой подписке чистить нельзя');
});

test('предохранитель: подписка пустой строкой — метрики не чистятся', async () => {
  const dead = T.matchKey('[VPN] ' + DE + ' Удалённый #9');
  const env = makeEnv({
    sub_cache: { ts: Date.now(), n: 0, text: '', meta: {} },
    devices: { k1: { status: 'bound', nonce: 'n-1', token: 'a'.repeat(32) } },
    'metrics:k1': { [dead]: { w: { down: 5, rtt: 50 } } },
  });
  const r = await worker.fetch(post('https://w.invalid/speed', { key: 'k1', nonce: 'n-1' }), env);
  assert.equal((await r.json()).pruned, 0);
  assert.ok(dead in env.RH_DB.get('metrics:k1'));
});

test('POST /speed пишет метрики и реестр одним batch (атомарно)', async () => {
  const env = makeEnv({
    sub_cache: SUB,
    devices: { k1: { status: 'bound', nonce: 'n-1', token: 'a'.repeat(32) } },
  });
  const before = env.RH_DB.__stats.batches;
  await worker.fetch(post('https://w.invalid/speed', { key: 'k1', nonce: 'n-1' }), env);
  assert.equal(env.RH_DB.__stats.batches, before + 1);
});

// ---------------------------------------------------------------- POST /rkn
test('POST /rkn: смена режима пишет состояние и историю одним batch', async () => {
  const env = makeEnv({ devices: { k1: { status: 'bound', token: 'a'.repeat(32) } } });
  const b0 = env.RH_DB.__stats.batches;
  await worker.fetch(post('https://w.invalid/rkn', { key: 'k1', mode: 'whitelist' }), env);
  assert.equal(env.RH_DB.__stats.batches, b0 + 1);
  const b1 = env.RH_DB.__stats.batches;
  await worker.fetch(post('https://w.invalid/rkn', { key: 'k1', mode: 'whitelist' }), env);
  assert.equal(env.RH_DB.__stats.batches, b1, 'повтор режима историю не трогает');
  assert.equal(env.RH_DB.get('rkn_hist:k1').length, 1);
});

test('POST /rkn: неизвестный режим отклоняется', async () => {
  const env = makeEnv({ devices: { k1: { status: 'bound', token: 'a'.repeat(32) } } });
  const r = await worker.fetch(post('https://w.invalid/rkn', { key: 'k1', mode: 'что-то' }), env);
  assert.equal(r.status, 400);
});

// ---------------------------------------------------------------- админ-зона
const ADM = { 'X-Admin-Key': 'ADMIN-TEST-KEY' };

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
  assert.equal(j.worker, 'v1.9.0');
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

// ------------------------------------------------------- снятые эндпоинты
test('миграционные эндпоинты сняты (404)', async () => {
  const env = makeEnv({});
  for (const p of ['/admin/backup', '/admin/migrate', '/admin/verify']) {
    const r = await worker.fetch(req('https://w.invalid' + p + '?key=ADMIN-TEST-KEY'), env);
    assert.equal(r.status, 404, p + ' должен быть снят');
  }
});

test('в коде Worker\'а не осталось обращений к KV (RH_KV)', () => {
  const code = SRC.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(code.indexOf('RH_KV') < 0, 'найдено обращение к RH_KV вне комментариев');
});

// ------------------------------------------------------------------- прочее
test('renderNodesBoth отдаёт оба набора и обходные без дублирования', () => {
  const lines = [
    nodeLine('[VPN] ' + DE + ' Германия #1'),
    nodeLine('[Обход] ' + DE + ' Германия'),
  ];
  const state = {};
  state[T.matchKey('[VPN] ' + DE + ' Германия #1')] = { w: { down: 10, rtt: 40 }, c: { down: 5, rtt: 60 } };
  const out = T.renderNodesBoth(lines, state, false).split('\n');
  assert.equal(out.length, 3, 'ожидались Wi-Fi + сотовый + один обходной');
});

test('flags устройства инициализируются булевыми', () => {
  const reg = { k1: {} };
  assert.equal(T.ensureFlags(reg), true);
  for (const f of T.FLAGS) assert.equal(reg.k1[f], false);
});

test('неизвестный путь -> 404', async () => {
  const env = makeEnv({});
  const r = await worker.fetch(req('https://w.invalid/no-such-path'), env);
  assert.equal(r.status, 404);
});
