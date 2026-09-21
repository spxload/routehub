// Замер отдачи (`up`) — ADR-05, Worker v1.11.0 + speedtest v0.7.0.
//
// ЧТО ДЕРЖИТ ЭТОТ ФАЙЛ.
// 1. Worker принимает `up` и хранит его; старые записи без `up` читаются.
// 2. Отсутствие замера НЕ превращается ни в 0, ни в «идеальный узел»
//    (дефект 19.09: `jit: null` в scoreOf давал лучший компонент).
// 3. `up` НЕ влияет на балл и порядок узлов: сначала меряем, потом решаем.
// 4. Правило 1: обходной узел не получает ни одного запроса — ни загрузки,
//    ни отдачи, ни пинга. Скрипт гоняется в node:vm целиком, от cron до
//    POST /speed, с поддельными $httpClient и $config.
// 5. Ровно один $done на любой ветви скрипта.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { makeEnv, nodeLine } from './mock-d1.js';
import { T, worker, req, post, DE, NL } from './harness.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts/routehub-speedtest.js'), 'utf8');

// ── Worker ──────────────────────────────────────────────────────────────────

const NAME = '[VPN] ' + DE + ' Германия #1';
const SUB = { ts: Date.now(), n: 1, text: nodeLine(NAME), meta: {} };

function speed(env, m) {
  return worker.fetch(post('https://w.invalid/speed',
    { key: 'k1', nonce: 'n-1', wifi: [Object.assign({ name: NAME }, m)], cell: [] }), env);
}
function slotW(env) {
  const st = env.RH_DB.get('metrics:k1');
  return st[Object.keys(st)[0]].w;
}
async function dash(env) {
  const tok = env.RH_DB.get('devices').k1.token;
  const r = await worker.fetch(req('https://w.invalid/t/' + tok + '/dashboard?key=k1'), env);
  assert.equal(r.status, 200);
  return (await r.json()).nodes.wifi[0];
}

test('metricOf: up принимается числом, округляется до десятых, минус зажат', () => {
  assert.equal(T.metricOf({ down: 20, rtt: 60, jit: 5, up: 7.26 }).up, 7.3);
  assert.equal(T.metricOf({ down: 20, rtt: 60, jit: 5, up: 0 }).up, 0, '0 — настоящий результат «не ушло»');
  assert.equal(T.metricOf({ down: 20, rtt: 60, jit: 5, up: -3 }).up, 0);
});

test('metricOf: нет замера отдачи — нет поля; не 0 и не число', () => {
  for (const v of [undefined, null, '5', '', NaN, Infinity, {}]) {
    const m = T.metricOf({ down: 20, rtt: 60, jit: 5, up: v });
    assert.equal('up' in m, false, 'up=' + String(v) + ' обязан остаться отсутствием поля');
  }
});

test('POST /speed: up сохраняется в слот, дашборд отдаёт его рядом с down', async () => {
  const env = makeEnv({ sub_cache: SUB });
  assert.equal((await speed(env, { down: 20, up: 4.5, rtt: 60, jit: 5, bl: 10, ts: Date.now() })).status, 200);
  assert.equal(slotW(env).up, 4.5);
  const n = await dash(env);
  assert.equal(n.up, 4.5);
  assert.equal(n.down, 20);
});

test('отдача 0 доходит до дашборда нулём, а не прочерком', async () => {
  const env = makeEnv({ sub_cache: SUB });
  await speed(env, { down: 20, up: 0, rtt: 60, jit: 5, bl: 10, ts: Date.now() });
  assert.equal((await dash(env)).up, 0);
});

test('старая запись без up: читается, дашборд даёт up: null, балл цел', async () => {
  // Так лежат все слоты D1 до v1.11.0 и всё, что шлёт спидтест до v0.7.0.
  const env = makeEnv({ sub_cache: SUB });
  await speed(env, { down: 20, rtt: 60, jit: 5, bl: 10 });
  assert.equal('up' in slotW(env), false, 'старый формат не должен получать поле');
  const n = await dash(env);
  assert.equal(n.up, null, 'не мерялось — null, а не 0');
  assert.ok(n.score > 0);
});

test('up НЕ влияет на балл: scoreOf до и после добавления up одинаков', () => {
  const bases = [
    { down: 43, rtt: 93, med: 93, jit: 9, bl: 13 },
    { down: 5, rtt: 60, med: 61, jit: 2, bl: null },
    { down: 1, rtt: 300, jit: null, bl: 400 },
  ];
  for (const b of bases) {
    const before = T.scoreOf(T.metricOf(b), 70);
    for (const up of [0, 0.1, 3, 50, 1000]) {
      const after = T.scoreOf(T.metricOf(Object.assign({}, b, { up: up })), 70);
      assert.equal(after, before, 'up=' + up + ' сдвинул балл');
    }
    assert.equal(T.voiceOk(T.metricOf(Object.assign({}, b, { up: 0 }))), T.voiceOk(T.metricOf(b)),
      'up не должен решать и пригодность для звонков');
  }
});

test('up НЕ влияет на порядок и подписи узлов в подписке', () => {
  const A = '[VPN] ' + DE + ' Германия #1', B = '[VPN] ' + NL + ' Нидерланды #2';
  const lines = [nodeLine(A), nodeLine(B)];
  const k = (n) => T.matchKey(n);
  const plain = {};
  plain[k(A)] = { w: T.metricOf({ down: 30, rtt: 60, jit: 5, bl: 10 }), c: T.metricOf({ down: 9, rtt: 90, jit: 5, bl: 10 }) };
  plain[k(B)] = { w: T.metricOf({ down: 10, rtt: 60, jit: 5, bl: 10 }), c: T.metricOf({ down: 20, rtt: 90, jit: 5, bl: 10 }) };
  // Отдача нарочно обратна баллу: лучший узел — худшая отдача.
  const withUp = JSON.parse(JSON.stringify(plain));
  withUp[k(A)].w.up = 0; withUp[k(A)].c.up = 900;
  withUp[k(B)].w.up = 900; withUp[k(B)].c.up = 0;
  assert.equal(T.renderNodesBoth(lines, withUp, false), T.renderNodesBoth(lines, plain, false));
  assert.equal(T.renderNodesBoth(lines, withUp, true), T.renderNodesBoth(lines, plain, true));
});

// ── Скрипт устройства в песочнице ───────────────────────────────────────────

const BYP = '[Обход] ' + DE + ' Германия 🛜';
const N1 = '[VPN] ' + DE + ' Германия 🛜';
const N2 = '[VPN] ' + NL + ' Нидерланды 🛜';

// opts: pool, store, up: 'ok' | 'err' | 'status' | 'short', post: 'ok' | 'err',
// arg (строка $argument), ssid.
function runScript(opts) {
  opts = opts || {};
  let clock = 1_800_000_000_000;
  const store = Object.assign({}, opts.store || {});
  const calls = [];
  let doneN = 0, speedBody = null;
  return new Promise((resolve) => {
    let finished = false;
    const ctx = {
      console: { log: () => {} },
      JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error,
      isNaN, parseInt, parseFloat, isFinite,
      Date: { now: () => clock },
      setTimeout: (fn) => setImmediate(fn),
      $argument: opts.arg != null ? opts.arg : 'k1|https://w.invalid|',
      $persistentStore: {
        read: (k) => (k in store ? store[k] : null),
        write: (v, k) => { store[k] = v; return true; },
      },
      $config: {
        getConfig: () => JSON.stringify({ ssid: opts.ssid != null ? opts.ssid : 'home' }),
        getSubPolicies: (g, cb) => setImmediate(() => cb(JSON.stringify(opts.pool || []))),
      },
      $httpClient: {
        get: (o, cb) => {
          calls.push({ m: 'GET', url: o.url, node: o.node });
          setImmediate(() => {
            if (o.url.indexOf('__down') >= 0) { clock += 2000; cb(null, { status: 200 }, ''); }
            else { clock += 60; cb(null, { status: 204 }, ''); }
          });
        },
        post: (o, cb) => {
          calls.push({ m: 'POST', url: o.url, node: o.node, timeout: o.timeout, len: o.body ? o.body.length : 0 });
          setImmediate(() => {
            if (o.url === 'https://w.invalid/speed') {
              speedBody = JSON.parse(o.body);
              if (opts.post === 'err') cb('network down'); else cb(null, { status: 200 }, '{}');
              return;
            }
            clock += 1000;
            const mode = opts.up || 'ok';
            if (mode === 'err') cb('timeout');
            else if (mode === 'status') cb(null, { status: 403, headers: {} }, '');
            else if (mode === 'short') cb(null, { status: 200, headers: { 'CF-Meta-Upload-Bytes': '4096' } }, '');
            else cb(null, { status: 200, headers: { 'cf-meta-upload-bytes': String(o.body.length) } }, '');
          });
        },
      },
      $done: () => {
        doneN++;
        // Ждём ещё тик: второй $done в той же ветви обязан быть пойман.
        if (!finished) { finished = true; setTimeout(() => resolve({ doneN: () => doneN, calls, store, speedBody: () => speedBody }), 30); }
      },
    };
    vm.createContext(ctx);
    vm.runInContext(SCRIPT, ctx, { timeout: 5000 });
  });
}

const POOL = [N1, BYP, N2];

test('отдача меряется в полном замере: 1 МБ, таймаут в миллисекундах, через тот же узел', async () => {
  const r = await runScript({ pool: POOL });
  const ups = r.calls.filter((c) => c.m === 'POST' && c.url.indexOf('speed.cloudflare.com/__up') >= 0);
  assert.deepEqual(ups.map((c) => c.node).sort(), [N1, N2].sort());
  for (const u of ups) {
    assert.equal(u.len, 1000000, 'тело — ровно 1 МБ, расчёт трафика в ADR-05 на это опирается');
    assert.ok(u.timeout >= 1000, 'Loon ждёт миллисекунды; ' + u.timeout + ' похоже на секунды Stash');
  }
  const body = r.speedBody();
  assert.ok(body, 'POST /speed не ушёл');
  assert.equal(body.wifi.length, 2);
  // 1 МБ за 1 с поддельных часов = 8 Мбит/с; пробы под нагрузкой от загрузки
  // могут вернуться во время отдачи и сдвинуть часы, отсюда допуск вниз.
  for (const it of body.wifi) assert.ok(it.up > 6 && it.up <= 8, 'up=' + it.up);
});

test('ПРАВИЛО 1: обходной узел не получает ни одного запроса — ни загрузки, ни отдачи', async () => {
  const r = await runScript({ pool: POOL });
  const hit = r.calls.filter((c) => c.node === BYP);
  assert.deepEqual(hit, [], 'через обход ушли запросы: ' + JSON.stringify(hit));
  assert.ok(r.calls.some((c) => c.node === N1), 'проверка пустая: обычный узел тоже не мерялся');
});

test('ПРАВИЛО 1 и в пинг-свипе: свежий кэш -> свип, обход не трогается, отдачи нет', async () => {
  const now = 1_800_000_000_000;
  const fresh = { down: 20, up: 5, rtt: 60, jit: 5, ts: now, tsp: now, att: now, fails: 0 };
  const cache = {}; cache[N1] = fresh; cache[N2] = fresh;
  const r = await runScript({ pool: POOL, store: { rh_speed_wifi: JSON.stringify(cache) } });
  assert.deepEqual(r.calls.filter((c) => c.node === BYP), []);
  assert.deepEqual(r.calls.filter((c) => c.url.indexOf('__up') >= 0 || c.url.indexOf('__down') >= 0), [],
    'в пинг-свипе нет ни загрузки, ни отдачи — только generate_204');
  assert.ok(r.calls.some((c) => c.node === N1 && c.url.indexOf('generate_204') >= 0), 'свип не прошёл');
  assert.equal(r.speedBody().wifi[0].up, 5, 'свип не затирает прежний замер отдачи');
});

test('isBypass: не уже фильтра обхода в конфиге и не уже Worker\'а', () => {
  // Песочница по ветке «битый argument»: main() выходит сразу, предикат остаётся.
  const S = { console: { log() {} }, JSON, Math, Date, Object, Array, String, Number, parseInt,
    $argument: '', $persistentStore: { read: () => null, write: () => true }, $done() {} };
  vm.createContext(S); vm.runInContext(SCRIPT, S);
  // RH-Filter-Обход = NameKeyword «Обход»: всё, что туда попадает, обязано
  // пропускаться, включая значок внутри скобок.
  for (const n of [BYP, '[🌀 Обход] ' + DE + ' Германия 🛜', '[Обход-2] x', 'Обход ' + NL + ' 📱']) {
    assert.equal(S.isBypass(n), true, n);
  }
  for (const n of [N1, N2]) assert.equal(S.isBypass(n), false, n);
  // Всё, что Worker считает обходом, скрипт тоже пропускает.
  for (const n of [BYP, N1, N2, '[Обход] x', '[🌀 Обход] x']) {
    if (T.tagOf(n) === 'bypass') assert.equal(S.isBypass(n), true, n);
  }
});

test('ПРАВИЛО 1: обход со значком в скобках тоже не меряется', async () => {
  const B2 = '[🌀 Обход] ' + NL + ' Нидерланды 🛜';
  const r = await runScript({ pool: [N1, B2] });
  assert.deepEqual(r.calls.filter((c) => c.node === B2), []);
});

test('отдача не ушла (ошибка/таймаут) -> up 0; узел при этом не мёртв', async () => {
  const r = await runScript({ pool: [N1], up: 'err' });
  const it = r.speedBody().wifi[0];
  assert.equal(it.up, 0);
  assert.equal(it.down > 0, true);
  assert.equal(JSON.parse(r.store.rh_speed_wifi)[N1].fails, 0);
});

test('сервер принял не всё тело -> up 0 (заголовок читается без учёта регистра)', async () => {
  const r = await runScript({ pool: [N1], up: 'short' });
  assert.equal(r.speedBody().wifi[0].up, 0);
});

test('ответ не 200 -> замера нет: поле up не уходит, а не становится 0', async () => {
  const r = await runScript({ pool: [N1], up: 'status' });
  assert.equal('up' in r.speedBody().wifi[0], false);
});

test('ровно один $done на любой ветви скрипта', async () => {
  const now = 1_800_000_000_000;
  const fresh = { down: 20, rtt: 60, jit: 5, ts: now, tsp: now, att: now, fails: 0 };
  const cache = {}; cache[N1] = fresh;
  const branches = {
    'битый argument': { arg: '' },
    'занято (блокировка)': { pool: POOL, store: { rh_speed_lock: String(now - 1000) } },
    'пул пуст': { pool: [] },
    'полный замер': { pool: POOL },
    'полный замер, отдача упала': { pool: POOL, up: 'err' },
    'полный замер, отдача не 200': { pool: POOL, up: 'status' },
    'полный замер, POST /speed упал': { pool: POOL, post: 'err' },
    'пинг-свип': { pool: POOL, store: { rh_speed_wifi: JSON.stringify(cache) } },
    'только обход в пуле (нечего мерить)': { pool: [BYP] },
    'сотовая': { pool: POOL, ssid: '' },
  };
  for (const [name, o] of Object.entries(branches)) {
    const r = await runScript(o);
    assert.equal(r.doneN(), 1, name + ': $done вызван ' + r.doneN() + ' раз');
  }
});
