// Прогон сборщика Stash в песочнице с подставным контроллером.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ СТРОКА В probes-smoke. Смоук проверяет одно:
// что скрипт доживает до $done. Сборщику этого мало — он единственный код
// проекта, который ХОДИТ ЧЕРЕЗ УЗЛЫ, и цена ошибки здесь не «проба молча не
// доехала», а платный трафик и метрики, снятые мимо узла.
//
// ГЛАВНОЕ, ЧЕМУ НАУЧИЛО РЕВЬЮ v0.1.0: имена узлов в песочнице обязаны быть
// ТАКИМИ ЖЕ, КАК В БОЮ — с хвостом метрик «· 21↓68 / 7↓96». На чистых именах
// тест не видел дефекта, из-за которого кэш стирался целиком при каждой
// перевыдаче конфига. И прогонов должно быть НЕСКОЛЬКО ПОДРЯД ПО ОДНОМУ
// ХРАНИЛИЩУ: всё, что связано со сроком годности, блокировкой и накоплением
// вердикта, на одиночном прогоне невидимо.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'scripts/routehub-stash-collect.js');
const CODE = fs.readFileSync(FILE, 'utf8');

// Имена — боевой формы: базовое имя плюс разделитель ' · ' и метрики.
// Хвост меняется между прогонами, как его меняет перевыдача конфига.
const B1 = '🇳🇱 Нидерланды [VPN] 01';
const B2 = '🇩🇪 Германия [VPN] 02';
const BB = '🇫🇮 Финляндия [Обход] 03';
const full = (base, tail) => `${base} · ${tail}`;

const SECRET = 'Bearer ОЧЕНЬ-СЕКРЕТНО';

function proxiesBody(opts = {}) {
  const { tail = '21↓68 / 7↓96', now = null, alive2 = true } = opts;
  const n1 = full(B1, tail), n2 = full(B2, tail), nb = full(BB, tail);
  return JSON.stringify({
    proxies: {
      'RH-AI': { type: 'Selector', now: 'RH-AI-W' },
      'RH-АВТО': { type: 'Selector', now: 'RH-АВТО-W' },
      'RH-Звонки': { type: 'Selector', now: 'RH-Звонки-W' },
      'RH-АВТО-W': { type: 'Fallback', now: now || n1, all: [n1, n2, nb] },
      'RH-АВТО-C': { type: 'Fallback', now: n1, all: [n1, n2, nb] },
      // Живая форма записи узла у Stash 3.4.1 (ST9): одно поле `delay`,
      // истории НЕТ. У второго узла нарочно оставлена `history` — это
      // запасной путь разбора, и он должен оставаться рабочим.
      [n1]: { type: 'Vless', alive: true, address: 'x:443', state: 'ok', delay: 70 },
      [n2]: { type: 'Vless', alive: alive2, history: [{ delay: 90 }] },
      [nb]: { type: 'Vless', alive: true },                // benchmark-disabled
    },
  });
}

// Пик 2 200 000 Б/с = 17,6 Мбит/с -> 18 после округления. Соединение идёт
// через ВТОРОЙ узел, и имя в цепочке — тоже с хвостом метрик.
function connBody(tail = '21↓68 / 7↓96') {
  return JSON.stringify({
    connections: [{
      id: '1', chains: [full(B2, tail), 'RH-АВТО-W'],
      download: { current: 0, last: 0, max: 2200000, total: 40000000 },
      upload: { current: 0, last: 0, max: 1000, total: 2000 },
    }],
  });
}

// Одно хранилище на серию прогонов — как на устройстве.
function makeStore() { return Object.create(null); }

function run(store, opts = {}) {
  const {
    pin = 'works',            // works | ignored | ambiguous | dead
    argument = 'k1|https://stand.example|',
    tail = '21↓68 / 7↓96',
    now = null,               // кого выбрал пул (null -> первый узел)
    ctlSilent = false,
    alive2 = true,
    pingMs = 30, loadedMs = 60, downMs = 200,
  } = opts;

  const calls = [];
  const state = { done: false, post: null, notes: [] };

  function respond(o, cb) {
    const url = String(o.url || '');
    const rawPin = o.headers && o.headers['X-Stash-Selected-Proxy'];
    const pinName = rawPin ? decodeURIComponent(rawPin) : null;
    const auth = (o.headers && o.headers.Authorization) || null;
    calls.push({ url, pin: pinName, auth, method: 'GET' });
    const ok = (body, ms = 1) => setTimeout(() => cb(null, { status: 200, headers: {} }, body), ms);
    const fail = (ms = 1) => setTimeout(() => cb('нет ответа', null, null), ms);

    if (url.indexOf('/proxies') >= 0) return ctlSilent ? fail() : ok(proxiesBody({ tail, now, alive2 }));
    if (url.indexOf('/connections') >= 0) return ctlSilent ? fail() : ok(connBody(tail));
    if (url.indexOf('ipify') >= 0) {
      if (pin === 'dead' && pinName) return fail();
      if (!pinName) return ok(JSON.stringify({ ip: '5.5.5.5' }));
      if (pin === 'ignored') return ok(JSON.stringify({ ip: '5.5.5.5' }));
      if (pin === 'ambiguous') return ok(JSON.stringify({ ip: '9.9.9.9' }));
      return ok(JSON.stringify({ ip: pinName.indexOf(B1) === 0 ? '1.2.3.1' : '1.2.3.2' }));
    }
    if (url.indexOf('speed.cloudflare') >= 0) return ok('x', downMs);
    if (url.indexOf('generate_204') >= 0) return ok('', url.indexOf('t=L') >= 0 ? loadedMs : pingMs);
    return ok('{}');
  }

  const sandbox = {
    console: { log: () => {} },
    JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, isFinite, encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout,
    $argument: argument,
    $environment: {
      'controller-url': 'http://127.0.0.1:9090',
      'controller-authorization': SECRET,
      'stash-version': '3.4.1',
    },
    $notification: { post: (t, s, b) => state.notes.push(String(s) + ' / ' + String(b)) },
    $persistentStore: {
      read: (k) => (k in store ? store[k] : null),
      write: (v, k) => { store[k] = v; return true; },
    },
    $httpClient: {
      get: respond,
      head: respond,
      post: (o, cb) => {
        const url = String(o.url);
        calls.push({ url, pin: null, method: 'POST' });
        // Правило 2: POST к контроллеру недопустим. Ловим здесь, а не
        // надеемся, что последняя выгрузка затрёт следы.
        assert.ok(url.indexOf('127.0.0.1') < 0, 'POST к контроллеру — запись в маршрутизацию');
        state.post = { url, body: JSON.parse(o.body) };
        setTimeout(() => cb(null, { status: 200, headers: {} }, '{"ok":true}'), 1);
      },
      put: () => { throw new Error('сборщик не должен писать в маршрутизацию'); },
      patch: () => { throw new Error('сборщик не должен писать в маршрутизацию'); },
      delete: () => { throw new Error('сборщик не должен писать в маршрутизацию'); },
    },
    $done: () => { state.done = true; },
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(CODE, vm.createContext(sandbox), { filename: 'routehub-stash-collect.js' });
  return { calls, store, state };
}

async function settle(r, ms = 5000) {
  const until = Date.now() + ms;
  while (!r.state.done && Date.now() < until) await new Promise((res) => setTimeout(res, 10));
  await new Promise((res) => setTimeout(res, 80));
  return r;
}

const downloads = (r) => r.calls.filter((c) => c.url.indexOf('speed.cloudflare') >= 0);
const bypassTouched = (r) => r.calls.some((c) => c.pin === null
  ? c.url.indexOf('Обход') >= 0
  : c.pin.indexOf('Обход') >= 0);

test('файл на месте и синтаксически цел', () => {
  assert.ok(fs.existsSync(FILE));
  new vm.Script(CODE);
});

test('вердикт пиновки требует ДВУХ подтверждений подряд', async () => {
  const store = makeStore();
  const r1 = await settle(run(store, { pin: 'works' }));
  assert.equal(downloads(r1).length, 0, 'закачка пошла после ПЕРВОЙ проверки');
  const p1 = JSON.parse(store['rh_stash_pin']);
  assert.equal(p1.ok, false);
  assert.equal(p1.streak, 1);

  const r2 = await settle(run(store, { pin: 'works' }));
  const p2 = JSON.parse(store['rh_stash_pin']);
  assert.equal(p2.ok, true, 'второе подтверждение не приняло вердикт: ' + p2.why);
  assert.equal(downloads(r2).length, 2, 'мерить надо оба рабочих узла');
});

test('кэш переживает смену метрик в имени узла и не мерит повторно', async () => {
  const store = makeStore();
  await settle(run(store, { pin: 'works' }));                       // прогон 1: копим вердикт
  const r2 = await settle(run(store, { pin: 'works' }));            // прогон 2: меряем
  assert.equal(downloads(r2).length, 2);
  const cache2 = JSON.parse(store['rh_stash_wifi']);
  assert.deepEqual(Object.keys(cache2).sort(), [B1, B2].sort(),
    'ключ кэша должен быть БАЗОВЫМ именем, без хвоста метрик');

  // Прогон 3 — конфиг перевыдан, хвост метрик другой. Кэш обязан уцелеть.
  const r3 = await settle(run(store, { pin: 'works', tail: '23↓71 / 8↓99' }));
  assert.equal(downloads(r3).length, 0, 'узлы перемеряны заново после смены имени — кэш потерян');
  const cache3 = JSON.parse(store['rh_stash_wifi']);
  assert.deepEqual(Object.keys(cache3).sort(), [B1, B2].sort());
  assert.equal(cache3[B1].down, cache2[B1].down, 'значение замера не сохранилось');
});

test('метрики сняты по методу Loon: rtt минимум, bl прирост, down из времени', async () => {
  const store = makeStore();
  await settle(run(store, { pin: 'works' }));
  const r = await settle(run(store, { pin: 'works', pingMs: 30, loadedMs: 60, downMs: 200 }));
  const m = r.state.post.body.wifi.find((x) => x.name === B1);
  assert.ok(m, 'узел не попал в выгрузку');
  // 4 МБ за ~0,2 с -> около 160 Мбит/с. Допуск широкий: таймеры песочницы.
  assert.ok(m.down > 60 && m.down < 400, 'скорость посчитана неверно: ' + m.down);
  assert.ok(m.rtt >= 25 && m.rtt <= 90, 'rtt не похож на минимум проб: ' + m.rtt);
  // bl — ПРИРОСТ: нагруженная минус ненагруженная, около 30 мс, а не 60.
  assert.ok(m.bl != null && m.bl < 55, 'bl похож на абсолют, а не на прирост: ' + m.bl);
});

test('пассив поднимает down, но не снимает узел с очереди на замер', async () => {
  const store = makeStore();
  await settle(run(store, { pin: 'works' }));
  await settle(run(store, { pin: 'works' }));
  const cache = JSON.parse(store['rh_stash_wifi']);
  // Занижаем замер второго узла так, чтобы пассивные 18 Мбит/с его перебили,
  // и состариваем ОБЕ отметки: активную и общую.
  cache[B2].down = 5;
  cache[B2].ats = Date.now() - 25 * 3600 * 1000;
  cache[B2].ts = cache[B2].ats;
  store['rh_stash_wifi'] = JSON.stringify(cache);

  const r = await settle(run(store, { pin: 'works' }));
  const after = JSON.parse(store['rh_stash_wifi']);
  assert.ok(after[B2].down > 5, 'просроченный узел не перемерян');
  const dl = downloads(r).map((c) => c.pin);
  assert.ok(dl.some((n) => String(n).indexOf(B2) === 0), 'узел с пассивом выпал из кандидатов');
  assert.equal(dl.length, 1, 'свежий узел мерить не надо');
});

test('узел с пассивной скоростью, но без активного замера, наружу не уходит', async () => {
  const store = makeStore();
  // Пиновка не работает: активной фазы нет вовсе, но /connections пассив даёт.
  const r = await settle(run(store, { pin: 'ignored' }));
  assert.equal(downloads(r).length, 0);
  assert.equal(r.state.post, null, 'ушла выгрузка без единого активного замера');
  const pin = JSON.parse(store['rh_stash_pin']);
  assert.equal(pin.ok, false);
  assert.ok(pin.why.indexOf('игнорируется') >= 0, 'причина не записана: ' + pin.why);
});

test('неоднозначный вердикт не закрепляется: следующий прогон проверяет снова', async () => {
  const store = makeStore();
  await settle(run(store, { pin: 'ambiguous' }));
  const p = JSON.parse(store['rh_stash_pin']);
  assert.equal(p.ok, false);
  assert.equal(p.firm, false, 'неоднозначный вердикт закреплён как окончательный');
  const r2 = await settle(run(store, { pin: 'ambiguous' }));
  assert.ok(r2.calls.some((c) => c.url.indexOf('ipify') >= 0), 'проверка не повторилась');
});

test('пул смотрит на обходной узел: ни проверки, ни замера (правило 1, второй рубеж)', async () => {
  const store = makeStore();
  const r = await settle(run(store, { pin: 'works', now: full(BB, '21↓68 / 7↓96') }));
  assert.equal(downloads(r).length, 0, 'закачка при выбранном обходном узле');
  assert.ok(!r.calls.some((c) => c.url.indexOf('ipify') >= 0), 'самопроверка при выбранном обходном узле');
  assert.ok(!bypassTouched(r), 'обходной узел задет запросом');
});

test('обходной узел не задет ни одним запросом и не попал в выгрузку', async () => {
  const store = makeStore();
  await settle(run(store, { pin: 'works' }));
  const r = await settle(run(store, { pin: 'works' }));
  assert.ok(!bypassTouched(r), 'обходной узел задет запросом');
  const names = r.state.post.body.wifi.map((x) => x.name);
  assert.ok(names.indexOf(BB) < 0 && !names.some((n) => n.indexOf('Обход') >= 0));
  assert.deepEqual(names.sort(), [B1, B2].sort());
  assert.equal(r.state.post.body.cell.length, 0, 'сотовый слот не заполняется на Wi-Fi');
});

test('секрет контроллера не утекает ни в выгрузку, ни в хранилище', async () => {
  const store = makeStore();
  await settle(run(store, { pin: 'works' }));
  const r = await settle(run(store, { pin: 'works' }));
  assert.ok(JSON.stringify(r.state.post.body).indexOf(SECRET) < 0, 'секрет в теле выгрузки');
  for (const k of Object.keys(store)) {
    assert.ok(String(store[k]).indexOf(SECRET) < 0, 'секрет в хранилище, ключ ' + k);
  }
  // Заголовок Authorization уходит ТОЛЬКО на контроллер.
  for (const c of r.calls) {
    if (c.auth) assert.ok(c.url.indexOf('127.0.0.1') === 0 || c.url.indexOf('http://127.0.0.1') === 0,
      'Authorization ушёл наружу: ' + c.url);
  }
});

test('контроллер молчит: выгрузки нет, отказ виден уведомлением', async () => {
  const store = makeStore();
  const r = await settle(run(store, { ctlSilent: true }));
  assert.equal(r.state.done, true);
  assert.equal(r.state.post, null);
  assert.equal(downloads(r).length, 0);
  assert.ok(r.state.notes.length > 0, 'отказ прошёл молча');
  assert.ok(r.state.notes[0].indexOf('контроллер') >= 0, 'в уведомлении нет причины: ' + r.state.notes[0]);
});

test('чужая блокировка: выход без единого запроса и без снятия замка', async () => {
  const store = makeStore();
  store['rh_stash_lock'] = String(Date.now());
  const r = await settle(run(store, { pin: 'works' }), 1500);
  assert.equal(r.state.done, true);
  assert.equal(r.calls.length, 0, 'при чужой блокировке запросов быть не должно');
  assert.ok(store['rh_stash_lock'], 'замок работающего прогона снят чужим сторожем');
});

test('битый argument: ни одного запроса, и сам аргумент не попал в журнал', async () => {
  const store = makeStore();
  const r = await settle(run(store, { argument: 'apikey=ТОКЕН-СЕКРЕТ' }), 1500);
  assert.equal(r.state.done, true);
  assert.equal(r.calls.length, 0);
  assert.equal(r.state.post, null);
  assert.ok(String(store['rh_stash_log']).indexOf('ТОКЕН-СЕКРЕТ') < 0, 'аргумент попал в журнал');
});

test('узел, который ядро считает мёртвым, помечается dead после MAX_FAILS прогонов', async () => {
  const store = makeStore();
  await settle(run(store, { pin: 'works' }));
  await settle(run(store, { pin: 'works' }));      // оба измерены
  let last = null;
  for (let i = 0; i < 5; i++) last = await settle(run(store, { pin: 'works', alive2: false }));
  const m2 = last.state.post.body.wifi.find((x) => x.name === B2);
  assert.ok(m2 && m2.dead === true, 'мёртвый узел не помечен: ' + JSON.stringify(m2));
});
