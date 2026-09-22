// Сглаживание EWMA в скрипте замеров — техдолг 3, пункт 52, speedtest v0.7.1.
//
// ЧТО ДЕРЖИТ ЭТОТ ФАЙЛ.
// 1. α = 0.2 и это вес НОВОГО замера: новое = 0.2·замер + 0.8·прежнее.
//    Перепутать направление (0.8 на новый замер) — главная ловушка: число
//    в константе останется «0.2», а сглаживание станет почти отсутствующим.
// 2. Флаг `ewma` решает всё: без него замер пишется сырым, прежнее значение
//    не участвует. Флаг приходит третьим полем $argument, его туда кладёт
//    Worker из реестра устройств (renderConfig, src/clients/loon.js).
// Скрипт гоняется в node:vm целиком, от cron до POST /speed, — тот же приём,
// что в upload.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts/routehub-speedtest.js'), 'utf8');

const NODE = '[VPN] 🇩🇪 Германия 🛜';
const T0 = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;

function runScript(arg, store) {
  let clock = T0;
  let speedBody = null;
  return new Promise((resolve) => {
    let finished = false;
    const ctx = {
      console: { log: () => {} },
      JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error,
      isNaN, parseInt, parseFloat, isFinite,
      Date: { now: () => clock },
      setTimeout: (fn) => setImmediate(fn),
      $argument: arg,
      $persistentStore: {
        read: (k) => (k in store ? store[k] : null),
        write: (v, k) => { store[k] = v; return true; },
      },
      $config: {
        getConfig: () => JSON.stringify({ ssid: 'home' }),
        getSubPolicies: (g, cb) => setImmediate(() => cb(JSON.stringify([NODE]))),
      },
      $httpClient: {
        get: (o, cb) => setImmediate(() => {
          if (o.url.indexOf('__down') >= 0) { clock += 2000; cb(null, { status: 200 }, ''); }
          else { clock += 60; cb(null, { status: 204 }, ''); }
        }),
        post: (o, cb) => setImmediate(() => {
          if (o.url === 'https://w.invalid/speed') { speedBody = JSON.parse(o.body); cb(null, { status: 200 }, '{}'); return; }
          clock += 1000;
          cb(null, { status: 200, headers: { 'cf-meta-upload-bytes': String(o.body.length) } }, '');
        }),
      },
      $done: () => {
        if (!finished) { finished = true; setTimeout(() => resolve({ speedBody: () => speedBody, store, ctx }), 30); }
      },
    };
    vm.createContext(ctx);
    vm.runInContext(SCRIPT, ctx, { timeout: 5000 });
  });
}

// Прежний замер старше суток: узел идёт на ПОЛНЫЙ замер, где и работает EWMA.
const PREV = { down: 100, up: 5, rtt: 500, med: 500, jit: 200, bl: 900, ts: T0 - 2 * DAY, tsp: T0 - 2 * DAY, att: T0 - 2 * DAY, fails: 0 };
function prevStore() { const c = {}; c[NODE] = PREV; return { rh_speed_wifi: JSON.stringify(c) }; }

async function measured(opts) {
  const r = await runScript('k1|https://w.invalid|' + opts, prevStore());
  const it = r.speedBody().wifi.find((x) => x.name === NODE);
  assert.ok(it, 'узел не дошёл до POST /speed');
  return { it, cache: JSON.parse(r.store.rh_speed_wifi)[NODE], ctx: r.ctx };
}

test('α = 0.2, и это вес нового замера', async () => {
  const { ctx } = await measured('');
  assert.equal(ctx.EWMA_A, 0.2);
  assert.equal(ctx.ewmaOf(0, 100), 80, 'прежнее значение весит 0.8');
  assert.equal(ctx.ewmaOf(100, 0), 20, 'новый замер весит 0.2');
});

test('без флага ewma замер пишется сырым, прежнее значение не участвует', async () => {
  const raw = (await measured('')).it;
  // Поддельные часы: 4 МБ за 2 с = 16 Мбит/с, пинг 60 мс — далеко от PREV.
  assert.equal(raw.down, 16);
  assert.equal(raw.rtt, 60);
});

test('с флагом ewma: 0.2·замер + 0.8·прежнее — по всем сглаживаемым полям', async () => {
  const raw = (await measured('')).it;
  const { it, cache } = await measured('ewma');
  const exp = (nv, pv) => Math.round(0.2 * nv + 0.8 * pv);
  assert.equal(it.down, exp(raw.down, PREV.down), 'down: ' + it.down);
  assert.equal(it.rtt, exp(raw.rtt, PREV.rtt), 'rtt: ' + it.rtt);
  assert.equal(it.jit, exp(raw.jit, PREV.jit), 'jit: ' + it.jit);
  assert.equal(it.med, exp(raw.med, PREV.med), 'med: ' + it.med);
  assert.notEqual(raw.bl, null, 'проверка bl пустая: сырой замер без bl');
  assert.equal(it.bl, exp(raw.bl, PREV.bl), 'bl: ' + it.bl);
  assert.equal(cache.down, it.down, 'в кэш устройства ушло то же сглаженное значение');
  // Страховка от перепутанного направления: сглаженное ближе к прежнему.
  assert.ok(Math.abs(it.down - PREV.down) < Math.abs(it.down - raw.down));
});

test('флаг читается среди других опций аргумента', async () => {
  const a = (await measured('ewma')).it.down;
  const b = (await measured('cellall,ewma')).it.down;
  assert.equal(b, a);
});
