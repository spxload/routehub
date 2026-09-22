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

// Служебные группы (v0.2.1, журнал выбора): по умолчанию — штатное
// состояние, RH-Главный и RH-RU на DIRECT, RH-Обход смотрит на обходной узел.
function proxiesBody(opts = {}) {
  const { tail = '21↓68 / 7↓96', now = null, alive2 = true,
    main = 'DIRECT', ru = 'DIRECT', byp = null, noMain = false, more = [] } = opts;
  const n1 = full(B1, tail), n2 = full(B2, tail), nb = full(BB, tail);
  const service = {
    'RH-Главный': { type: 'Fallback', now: main, all: ['DIRECT', 'RH-АВТО'] },
    'RH-RU': { type: 'Fallback', now: ru, all: ['DIRECT', 'RH-Обход'] },
    'RH-Обход': { type: 'Fallback', now: byp || nb, all: [nb] },
  };
  if (noMain) delete service['RH-Главный'];
  // v0.2.2: дополнительные рабочие узлы пула — для сводок, которым нужна
  // выборка больше двух узлов. {base, delay, alive}
  const extra = {}, extraNames = [];
  for (const x of more) {
    const nm = full(x.base, tail);
    extraNames.push(nm);
    extra[nm] = { type: 'Vless', alive: x.alive !== false, delay: x.delay || 0 };
  }
  return JSON.stringify({
    proxies: {
      ...service,
      'RH-AI': { type: 'Selector', now: 'RH-AI-W' },
      'RH-АВТО': { type: 'Selector', now: 'RH-АВТО-W' },
      'RH-Звонки': { type: 'Selector', now: 'RH-Звонки-W' },
      'RH-АВТО-W': { type: 'Fallback', now: now || n1, all: [n1, n2, ...extraNames, nb] },
      'RH-АВТО-C': { type: 'Fallback', now: n1, all: [n1, n2, nb] },
      // Живая форма записи узла у Stash 3.4.1 (ST9): одно поле `delay`,
      // истории НЕТ. У второго узла нарочно оставлена `history` — это
      // запасной путь разбора, и он должен оставаться рабочим.
      [n1]: { type: 'Vless', alive: true, address: 'x:443', state: 'ok', delay: 70 },
      [n2]: { type: 'Vless', alive: alive2, history: [{ delay: 90 }] },
      [nb]: { type: 'Vless', alive: true },                // benchmark-disabled
      ...extra,
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
    main, ru, byp, noMain,    // выбор служебных групп (журнал v0.2.1)
    more,                     // доп. узлы пула (v0.2.2)
  } = opts;

  const calls = [];
  const state = { done: false, post: null, notes: [], logs: [] };

  // Метод записывается ТАКИМ, КАКИМ ОН УЙДЁТ: поле method в опциях
  // перекрывает имя функции. Иначе `$httpClient.get({method: 'PUT'})`
  // прошёл бы проверку правила 2 как GET.
  function respond(o, cb, fn = 'GET') {
    const url = String(o.url || '');
    const rawPin = o.headers && o.headers['X-Stash-Selected-Proxy'];
    const pinName = rawPin ? decodeURIComponent(rawPin) : null;
    const auth = (o.headers && o.headers.Authorization) || null;
    calls.push({ url, pin: pinName, auth, method: String(o.method || fn).toUpperCase() });
    const ok = (body, ms = 1) => setTimeout(() => cb(null, { status: 200, headers: {} }, body), ms);
    const fail = (ms = 1) => setTimeout(() => cb('нет ответа', null, null), ms);

    if (url.indexOf('/proxies') >= 0) return ctlSilent ? fail() : ok(proxiesBody({ tail, now, alive2, main, ru, byp, noMain, more }));
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
    console: { log: (s) => state.logs.push(String(s)) },
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
      get: (o, cb) => respond(o, cb, 'GET'),
      head: (o, cb) => respond(o, cb, 'HEAD'),
      post: (o, cb) => {
        const url = String(o.url);
        calls.push({ url, pin: null, method: String(o.method || 'POST').toUpperCase() });
        // Правило 2: POST к контроллеру недопустим. Ловим здесь, а не
        // надеемся, что последняя выгрузка затрёт следы.
        assert.ok(url.indexOf('127.0.0.1') < 0, 'POST к контроллеру — запись в маршрутизацию');
        state.post = { url, body: JSON.parse(o.body) };
        setTimeout(() => cb(null, { status: 200, headers: {} }, '{"ok":true}'), 1);
      },
      // Запись фиксируется ДО исключения: скрипт оборачивает вызовы в
      // try/catch, и одно исключение он бы молча проглотил.
      put: (o) => { calls.push({ url: String(o && o.url), pin: null, method: 'PUT' }); throw new Error('сборщик не должен писать в маршрутизацию'); },
      patch: (o) => { calls.push({ url: String(o && o.url), pin: null, method: 'PATCH' }); throw new Error('сборщик не должен писать в маршрутизацию'); },
      delete: (o) => { calls.push({ url: String(o && o.url), pin: null, method: 'DELETE' }); throw new Error('сборщик не должен писать в маршрутизацию'); },
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

// ── v0.2.1: ЖУРНАЛ ВЫБОРА СЛУЖЕБНЫХ ГРУПП ─────────────────────────────
// Первая строка итогового отчёта — вердикт по RH-Главный и RH-RU. Отчёт —
// одна запись console.log, начинающаяся с «RH-Collect отчёт:».
const reportLines = (r) => {
  const rep = r.state.logs.find((s) => s.indexOf('RH-Collect отчёт:') === 0);
  assert.ok(rep, 'итоговый отчёт не выведен');
  return rep.split('\n').slice(1);
};
const lastLog = (store) => { const l = JSON.parse(store['rh_stash_log']); return l[l.length - 1]; };
const ctlCalls = (r) => r.calls.filter((c) => c.url.indexOf('127.0.0.1') >= 0);

test('журнал выбора: штатно — первая строка «выбор штатный», now всех шести групп записан', async () => {
  const store = makeStore();
  const r = await settle(run(store, { pin: 'works' }));
  const head = reportLines(r)[0];
  assert.ok(head.indexOf('выбор штатный') === 0, 'первая строка отчёта: ' + head);
  assert.ok(head.indexOf('ТРЕВОГА') < 0);
  const e = lastLog(store);
  assert.equal(e.sel, head, 'вердикт выбора не попал в хранимый журнал');
  assert.deepEqual(Object.keys(e.g).sort(),
    ['RH-AI', 'RH-RU', 'RH-АВТО', 'RH-Главный', 'RH-Звонки', 'RH-Обход'].sort(), 'записаны не все группы');
  assert.equal(e.g['RH-Главный'], 'DIRECT');
  assert.equal(e.g['RH-АВТО'], 'RH-АВТО-W');
  assert.ok(e.g['RH-Обход'].indexOf('Обход') >= 0);
});

test('RH-Главный ушёл с DIRECT: тревога ПЕРВОЙ строкой, с цепочкой до узла', async () => {
  const store = makeStore();
  const r = await settle(run(store, { pin: 'works', main: 'RH-АВТО' }));
  const head = reportLines(r)[0];
  assert.ok(head.indexOf('⚠ ТРЕВОГА') === 0, 'тревога не первой строкой: ' + head);
  assert.ok(head.indexOf('RH-Главный не на DIRECT') >= 0, head);
  assert.ok(head.indexOf('RH-Главный → RH-АВТО → RH-АВТО-W → ' + B1) >= 0, 'цепочка не раскрыта: ' + head);
  assert.equal(lastLog(store).sel, head);
  assert.equal(lastLog(store).g['RH-Главный'], 'RH-АВТО');
});

test('RH-Главный на обходе: тревога помечает платный трафик', async () => {
  const store = makeStore();
  const nb = full(BB, '21↓68 / 7↓96');
  const r = await settle(run(store, { pin: 'works', main: 'RH-Обход', byp: nb }));
  const head = reportLines(r)[0];
  assert.ok(head.indexOf('⚠ ТРЕВОГА') === 0, head);
  assert.ok(head.indexOf('ОБХОД, платный трафик') >= 0, 'не помечен платный обход: ' + head);
});

test('RH-RU -> RH-Обход -> обходной узел: тревога о платном обходе ПЕРВОЙ строкой', async () => {
  const store = makeStore();
  const r = await settle(run(store, { pin: 'works', ru: 'RH-Обход' }));
  const head = reportLines(r)[0];
  assert.ok(head.indexOf('⚠ ТРЕВОГА') === 0, head);
  assert.ok(head.indexOf('РФ-трафик идёт по ПЛАТНОМУ обходу') >= 0, head);
  assert.ok(head.indexOf('RH-RU → RH-Обход → ' + BB) >= 0, head);
});

test('RH-RU на RH-Обход, но обход сам на DIRECT: тревога есть, «платного» нет', async () => {
  const store = makeStore();
  const r = await settle(run(store, { pin: 'works', ru: 'RH-Обход', byp: 'DIRECT' }));
  const head = reportLines(r)[0];
  assert.ok(head.indexOf('⚠ ТРЕВОГА') === 0 && head.indexOf('RH-RU не на DIRECT') >= 0, head);
  assert.ok(head.indexOf('ПЛАТНОМУ') < 0, 'обход на DIRECT назван платным: ' + head);
});

test('группы RH-Главный нет в /proxies: это тревога, а не молчание', async () => {
  const store = makeStore();
  const r = await settle(run(store, { pin: 'works', noMain: true }));
  const head = reportLines(r)[0];
  assert.ok(head.indexOf('⚠ ТРЕВОГА') === 0 && head.indexOf('RH-Главный нет в /proxies') >= 0, head);
});

test('у RH-Главный пустое now: тревога «выбор неизвестен», а не «штатно»', async () => {
  const store = makeStore();
  const r = await settle(run(store, { pin: 'works', main: '' }));
  const head = reportLines(r)[0];
  assert.ok(head.indexOf('⚠ ТРЕВОГА') === 0 && head.indexOf('RH-Главный: поле now пусто') >= 0, head);
});

test('контроллер молчит: первая строка отчёта говорит, что выбор не прочитан', async () => {
  const store = makeStore();
  const r = await settle(run(store, { ctlSilent: true }));
  assert.ok(reportLines(r)[0].indexOf('выбор групп не прочитан') === 0, reportLines(r)[0]);
});

test('журнал выбора не порождает трафика: тревога не добавляет ни одного запроса (правило 1)', async () => {
  const sA = makeStore(), sB = makeStore();
  await settle(run(sA, { pin: 'works' }));
  await settle(run(sB, { pin: 'works' }));
  const a = await settle(run(sA, { pin: 'works' }));
  const b = await settle(run(sB, { pin: 'works', main: 'RH-Обход', ru: 'RH-Обход' }));
  const shape = (r) => r.calls.map((c) => c.method + ' ' + c.url.replace(/[?&]t=[^&]*/g, '') + ' ' + (c.pin || '')).sort();
  assert.deepEqual(shape(b), shape(a), 'при тревоге набор запросов изменился');
  assert.ok(!bypassTouched(b), 'обходной узел задет запросом');
  assert.deepEqual(ctlCalls(b).map((c) => c.url.replace('http://127.0.0.1:9090', '')).sort(),
    ['/connections', '/proxies'], 'к контроллеру ушло что-то кроме /proxies и /connections');
});

test('правило 2: к контроллеру — ни одного запроса методом, отличным от GET', async () => {
  const store = makeStore();
  const runs = [
    await settle(run(store, { pin: 'works' })),
    await settle(run(store, { pin: 'works' })),
    await settle(run(store, { pin: 'works', main: 'RH-АВТО', ru: 'RH-Обход' })),
    await settle(run(makeStore(), { pin: 'works', noMain: true })),
  ];
  for (const r of runs) {
    assert.ok(ctlCalls(r).length >= 1, 'песочница не видит запросов к контроллеру');
    for (const c of ctlCalls(r)) assert.equal(c.method, 'GET', 'к контроллеру ушёл ' + c.method + ' ' + c.url);
    for (const c of r.calls) {
      assert.ok(['PUT', 'PATCH', 'DELETE'].indexOf(c.method) < 0, 'запрос на запись: ' + c.method + ' ' + c.url);
    }
  }
});

// ── v0.2.1: СТОРОЖ И ХУДШИЙ ЧЕСТНЫЙ ПУТЬ ──────────────────────────────
// Прогон на ВИРТУАЛЬНЫХ ЧАСАХ без растяжения таймеров — самый жёсткий для
// сторожа случай: 90 с номинала здесь ровно 90 с. Каждый запрос отвечает
// за миллисекунду до своего тайм-аута (или отказывает ровно по нему) —
// дольше честный запрос идти не может. Контроллер и выгрузка отвечают
// всегда (иначе прогон кончается FATAL за 5 с и проверять нечего), а в
// кэше заранее лежит один свежий узел: без него выгрузки не было бы, и
// самый дорогой хвост пути — POST_SEC — остался бы непроверенным.
const numConst = (name) => {
  const m = CODE.match(new RegExp('^var ' + name + ' = ([^;]+);', 'm'));
  assert.ok(m, 'нет константы ' + name);
  return Function('return (' + m[1] + ')')();
};

function runVirtual(mode) {
  const START = Date.UTC(2026, 8, 21, 6, 5, 0);
  const clock = { now: START };
  const q = [];
  let seq = 0;
  const vSet = (fn, ms) => { const id = ++seq; q.push({ at: clock.now + Math.max(0, +ms || 0), id, fn }); return id; };
  const vClear = (id) => { const i = q.findIndex((t) => t.id === id); if (i >= 0) q.splice(i, 1); };
  class VDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.now); }
    static now() { return clock.now; }
  }
  const store = makeStore();
  store['rh_stash_pin'] = JSON.stringify({ ok: true, firm: true, streak: 2, why: 'тест', ts: START });
  store['rh_stash_wifi'] = JSON.stringify({
    [B1]: { down: 80, rtt: 40, med: 45, jit: 5, bl: 10, ts: START, ats: START },
    [B2]: { down: 60, rtt: 50, med: 55, jit: 6, bl: 12, ts: START - 25 * 3600e3, ats: START - 25 * 3600e3 },
  });
  const st = { doneAt: null, dones: 0, logs: [], maxTimeout: 0, posts: 0 };
  function respond(o, cb, isPost) {
    const sec = +o.timeout;
    if (sec > st.maxTimeout) st.maxTimeout = sec;
    const url = String(o.url || '');
    let body = '{}';
    const ctl = url.indexOf('127.0.0.1') >= 0;
    if (url.indexOf('/proxies') >= 0) body = proxiesBody();
    else if (url.indexOf('/connections') >= 0) body = connBody();
    if (isPost) st.posts++;
    if (mode === 'timeout' && !ctl && !isPost) vSet(() => cb('тайм-аут', null, null), sec * 1000);
    else vSet(() => cb(null, { status: 200, headers: {} }, body), sec * 1000 - 1);
  }
  const sandbox = {
    console: { log: (s) => st.logs.push(String(s)) },
    JSON, Math, Date: VDate, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, isFinite, encodeURIComponent, decodeURIComponent,
    setTimeout: vSet, clearTimeout: vClear,
    $argument: 'k1|https://stand.example|',
    $environment: { 'controller-url': 'http://127.0.0.1:9090' },
    $notification: { post: () => {} },
    $persistentStore: {
      read: (k) => (k in store ? store[k] : null),
      write: (v, k) => { store[k] = v; return true; },
    },
    $httpClient: { get: (o, cb) => respond(o, cb), head: (o, cb) => respond(o, cb), post: (o, cb) => respond(o, cb, true) },
    $done: () => { st.dones++; if (st.doneAt == null) st.doneAt = clock.now - START; },
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(CODE, vm.createContext(sandbox), { filename: 'routehub-stash-collect.js' });
  for (let n = 0; q.length && n < 100000; n++) {
    q.sort((x, y) => x.at - y.at || x.id - y.id);
    const t = q.shift();
    clock.now = t.at;
    t.fn();
  }
  return st;
}

test('сторож: арифметика — GUARD_MS не меньше 90 с и перекрывает бюджет плюс выгрузку с запасом', () => {
  const GUARD_MS = numConst('GUARD_MS'), BUDGET_MS = numConst('BUDGET_MS'), POST_SEC = numConst('POST_SEC');
  assert.ok(GUARD_MS >= 90000, 'сторож ниже 90 с: ' + GUARD_MS);
  assert.ok(BUDGET_MS + POST_SEC * 1000 + 10000 <= GUARD_MS,
    'худший путь ' + (BUDGET_MS + POST_SEC * 1000) + ' мс не оставляет сторожу 10 с запаса до ' + GUARD_MS);
});

for (const mode of ['slow', 'timeout']) {
  test('сторож: худший честный путь (' + mode + ') доходит до $done сам, раньше сторожа', () => {
    const GUARD_MS = numConst('GUARD_MS');
    const st = runVirtual(mode);
    assert.equal(st.dones, 1, '$done вызван ' + st.dones + ' раз');
    assert.equal(st.posts, 1, 'путь без выгрузки — не худший');
    assert.ok(!st.logs.some((s) => s.indexOf('сторож') >= 0), 'сработал сторож: честный прогон оборван');
    assert.ok(st.doneAt <= GUARD_MS - 10000, '$done на ' + st.doneAt + ' мс — меньше 10 с запаса до сторожа');
    assert.ok(st.maxTimeout > 0 && st.maxTimeout <= 60, 'тайм-аут не в секундах: ' + st.maxTimeout);
  });
}

// ── v0.2.2: ДОЛЯ ПОТЕРЬ ЯДРА И delay ЯДРА ПРОТИВ rtt ──────────────────
// Обе сводки — вычисления над ответом /proxies и кэшем. Прогоны ниже идут
// с закреплённым вердиктом «пиновка не работает»: активной фазы нет, и
// любой запрос через узел был бы порождён именно новыми сводками.
const PIN_OFF = JSON.stringify({ ok: false, firm: true, why: 'тест', ts: Date.now() });
const lossLine = (r) => reportLines(r).find((s) => s.indexOf('потери ядра') === 0);
const dvLine = (r) => reportLines(r).find((s) => s.indexOf('delay ядра против rtt') === 0);
const X = (i) => '🇵🇱 Польша [VPN] 1' + i;

test('доля потерь: окно ключуется базовым именем и переживает смену хвоста метрик', async () => {
  const store = makeStore();
  store['rh_stash_pin'] = PIN_OFF;
  const seq = [true, false, true, false, false, true];
  for (let i = 0; i < seq.length; i++) {
    await settle(run(store, { pin: 'ignored', alive2: seq[i], tail: (20 + i) + '↓68 / 7↓96' }));
  }
  const c = JSON.parse(store['rh_stash_wifi']);
  assert.equal(c[B2].lw, '010110', 'окно не сложилось по базовому имени: ' + c[B2].lw);
  assert.equal(c[B1].lw, '000000');
  assert.equal(c[B2].fails, 0, 'fails подряд должен обнулиться удачной проверкой');
  const r = await settle(run(store, { pin: 'ignored', alive2: true, tail: '99↓1 / 1↓1' }));
  const l = lossLine(r);
  assert.ok(l, 'строки о потерях нет в отчёте');
  assert.ok(l.indexOf(B2 + ' 3/7 (43%)') >= 0, 'доля узла не выведена: ' + l);
  assert.ok(l.indexOf('с потерями 1') >= 0, l);
  assert.equal(lastLog(store).lz, 1, 'число узлов с потерями не попало в журнал');
});

test('доля потерь: окно, а не накопление — старше LOSS_N попыток забывается', async () => {
  const N = numConst('LOSS_N');
  const store = makeStore();
  store['rh_stash_pin'] = PIN_OFF;
  store['rh_stash_wifi'] = JSON.stringify({ [B2]: { lw: '1'.repeat(N) } });
  await settle(run(store, { pin: 'ignored', alive2: true }));
  const c = JSON.parse(store['rh_stash_wifi']);
  assert.equal(c[B2].lw.length, N, 'окно выросло за LOSS_N — это накопление');
  assert.equal(c[B2].lw, '1'.repeat(N - 1) + '0', 'новое наблюдение не встало в конец');
});

test('доля потерь: меньше LOSS_MIN попыток — доля не выводится', async () => {
  const store = makeStore();
  store['rh_stash_pin'] = PIN_OFF;
  let r;
  for (let i = 0; i < 3; i++) r = await settle(run(store, { pin: 'ignored', alive2: false }));
  const l = lossLine(r);
  assert.ok(l.indexOf('меньше 5 попыток') >= 0, 'при трёх попытках выведена доля: ' + l);
  assert.ok(l.indexOf('%') < 0, l);
  assert.equal(lastLog(store).lz, undefined);
});

test('delay против rtt: меньше CMP_MIN пар — «данных мало», числа нет', async () => {
  const store = makeStore();
  store['rh_stash_pin'] = PIN_OFF;
  const t = Date.now();
  store['rh_stash_wifi'] = JSON.stringify({
    [B1]: { down: 50, rtt: 50, ats: t, ts: t },
    [B2]: { down: 50, rtt: 60, ats: t, ts: t },
  });
  const r = await settle(run(store, { pin: 'ignored' }));
  const l = dvLine(r);
  assert.ok(l && l.indexOf('данных мало') >= 0 && l.indexOf('пар 2') >= 0, 'нет «данных мало»: ' + l);
  assert.ok(l.indexOf('×') < 0 && l.indexOf('медиана') < 0, 'при двух парах выдано число: ' + l);
  assert.deepEqual(lastLog(store).dv, { n: 2 });
});

test('delay против rtt: медианы расхождения и отношения по свежим живым парам', async () => {
  const store = makeStore();
  store['rh_stash_pin'] = PIN_OFF;
  const t = Date.now(), old = t - 25 * 3600e3;
  // B1: delay 70, B2: history 90. Пары (delay, rtt):
  //   B1 70/50, B2 90/60, X0 100/50, X1 80/40, X2 66/60  -> в выборке 5;
  //   X3 — мёртв по ядру, X4 — rtt старше суток, X5 — delay 0: не в выборке.
  const cache = {
    [B1]: { down: 50, rtt: 50, ats: t, ts: t },
    [B2]: { down: 50, rtt: 60, ats: t, ts: t },
    [X(0)]: { down: 50, rtt: 50, ats: t, ts: t },
    [X(1)]: { down: 50, rtt: 40, ats: t, ts: t },
    [X(2)]: { down: 50, rtt: 60, ats: t, ts: t },
    [X(3)]: { down: 50, rtt: 10, ats: t, ts: t },
    [X(4)]: { down: 50, rtt: 10, ats: old, ts: old },
    [X(5)]: { down: 50, rtt: 10, ats: t, ts: t },
  };
  store['rh_stash_wifi'] = JSON.stringify(cache);
  const more = [
    { base: X(0), delay: 100 }, { base: X(1), delay: 80 }, { base: X(2), delay: 66 },
    { base: X(3), delay: 500, alive: false }, { base: X(4), delay: 500 }, { base: X(5), delay: 0 },
  ];
  const r = await settle(run(store, { pin: 'ignored', more }));
  const l = dvLine(r);
  // расхождения 20, 30, 50, 40, 6 -> медиана 30; отношения 1.40, 1.50, 2.00,
  // 2.00, 1.10 -> медиана 1.50.
  assert.ok(l.indexOf('узлов 5') >= 0, 'в выборку попали не те узлы: ' + l);
  assert.ok(l.indexOf('медиана расхождения +30 мс') >= 0, l);
  assert.ok(l.indexOf('отношение ×1.50') >= 0, l);
  assert.deepEqual(lastLog(store).dv, { n: 5, d: 30, r: 1.5 });
  // Окно потерь: «жив» без delay — ядро узел не проверяло, это не удача.
  const c = JSON.parse(store['rh_stash_wifi']);
  assert.equal(c[X(5)].lw, undefined, '«жив» без delay записан в окно как удача');
  assert.equal(c[X(3)].lw, '1', 'провал ядра не записан');
  assert.equal(c[X(0)].lw, '0');
});

test('сводки v0.2.2 не порождают запросов и не трогают контракт /speed (правила 1 и 2)', async () => {
  const store = makeStore();
  store['rh_stash_pin'] = PIN_OFF;
  const t = Date.now();
  const cache = { [B1]: { down: 50, rtt: 50, ats: t, ts: t, lw: '0101010' }, [B2]: { down: 50, rtt: 60, ats: t, ts: t } };
  const more = [];
  for (let i = 0; i < 4; i++) { cache[X(i)] = { down: 40, rtt: 40, ats: t, ts: t }; more.push({ base: X(i), delay: 90 }); }
  store['rh_stash_wifi'] = JSON.stringify(cache);
  const r = await settle(run(store, { pin: 'ignored', more }));
  assert.ok(dvLine(r).indexOf('узлов ') >= 0, 'сводка не посчитана — проверка пустая');
  assert.ok(!r.calls.some((c) => c.pin), 'запрос через узел при выключенной активной фазе');
  assert.deepEqual(r.calls.map((c) => c.method + ' ' + c.url.replace('http://127.0.0.1:9090', '')).sort(),
    ['GET /connections', 'GET /proxies', 'POST https://stand.example/speed']);
  const body = r.state.post.body;
  assert.deepEqual(Object.keys(body).sort(), ['cell', 'key', 'nonce', 'wifi']);
  const allowed = ['name', 'down', 'rtt', 'jit', 'med', 'bl', 'ts', 'tsp', 'dead'];
  for (const it of body.wifi) {
    for (const k of Object.keys(it)) assert.ok(allowed.indexOf(k) >= 0, 'в /speed ушло новое поле ' + k);
  }
});
