// Прогон КАЖДОЙ пробы в песочнице с подставным клиентом.
//
// ЗАЧЕМ. 24.08 в пробу ST6 попал вызов `stepDns(...)` без определения самой
// функции: питоновский патч упал на середине, файл записался частично, а
// `node --check` этого не видит — синтаксис-то верный. На устройстве это
// дало бы ReferenceError, цепочка после первого шага не выполнилась бы, и
// проба молча не дошла бы до `$done`. Поймал ревьюер при заливке, но ловить
// такое должен тест.
//
// ЧТО ПРОВЕРЯЕТСЯ: проба доходит до конца и вызывает `$done`, не бросив
// исключения. Ни сети, ни клиента при этом нет — все `$`-объекты подставные,
// `$httpClient` отвечает заранее заготовленным телом, `WebSocket` сразу
// закрывается. Это не проверка выводов пробы; это проверка, что она вообще
// доживает до вывода.
//
// ПОЧЕМУ ПЕСОЧНИЦА, А НЕ import. Пробы — не модули: это ES5-скрипты для
// движка клиента, с `$`-объектами из его окружения. `node:vm` даёт ровно
// такой контекст.
//
// СПИСОК ВЕДЁТСЯ РУКАМИ, и это уже подводило: ST7 отработала на устройстве
// 24.08, а в списке её не было — то есть боевая проба тестом не покрывалась.
// Завёл пробу — добавь строку сюда.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const PROBES = [
  'probes/routehub-probe-context.js',
  'probes/routehub-probe-store.js',
  'probes/routehub-probe-stash6.js',
  'probes/routehub-probe-stash7.js',
  'probes/routehub-probe-stash8.js',
  'probes/routehub-probe-stash9.js',
  'probes/routehub-probe-stash10.js',
  'probes/routehub-probe-stash11.js',
  'probes/routehub-probe-stash12.js',
  'probes/routehub-probe-stash13.js',
  'probes/routehub-probe-surge.js',
  'probes/routehub-probe-surge2.js',
  'probes/routehub-probe-surge3.js',
];

// Тела, которые подставной контроллер отдаёт на любой путь. Форма взята из
// настоящих замеров: у Stash `/connections` отдаёт {connections:[…]},
// у Surge `/v1/policies` — {proxies:[],policy-groups:[…]}.
const BODY = JSON.stringify({
  // Счётчики байт и цепочка добавлены для ST11: она ищет в записи именно их,
  // и без них ветка разбора в тесте не выполнялась бы вовсе.
  downloadTotal: 12345, uploadTotal: 678,
  connections: [{ id: '1', rule: 'FINAL', ruleType: 'DOMAIN-SUFFIX',
    chain: ['узел', 'RH-АВТО-C'], download: 29810000, upload: 66440,
    chains: ['DIRECT'], metadata: { host: 'example.com' } }],
  dnsCache: [{ domain: 'example.com', data: ['93.184.216.34'] }],
  proxies: [],
  'policy-groups': ['G1'],
  requests: [{ remoteHost: 'example.com', failed: false, rejected: false }],
  events: [{ content: 'test' }],
  providers: { 'rh-wl-domains': { behavior: 'classical', ruleCount: 3 } },
  rules: [{ type: 'RuleSet', payload: 'rh-wl-domains', proxy: 'DIRECT' }],
  mode: 'rule',
});

// Заголовки ответа подставного контроллера. Форма взята из того, что ищет
// ST10: если контроллер Stash CORS отдаёт, поля называются именно так.
const RESP_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};

function makeSandbox(state) {
  const done = { called: false, value: undefined };
  const sandbox = {
    console: { log: () => {} },
    JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, isNaN, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent, isFinite,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)),
    clearTimeout,
    $argument: 'apikey=TESTKEY',
    $trigger: 'button',
    $script: { name: 'test', type: 'generic' },
    $input: { purpose: 'panel' },
    $environment: {
      'controller-url': 'http://127.0.0.1:9090',
      'controller-authorization': 'Bearer test',
      'device-model': 'iPhone', system: 'iOS',
      'stash-version': '3.0', 'surge-version': '5.21.1',
    },
    $network: { wifi: { ssid: 'test' }, v4: { primaryAddress: '10.0.0.1' }, 'cellular-data': { radio: 'LTE' } },
    $notification: { post: () => {} },
    $persistentStore: { read: () => null, write: () => true },
    $utils: { geoip: () => 'US', ipasn: () => '1', ipaso: () => 'Test' },
    $surge: {
      selectGroupDetails: () => ({ groups: {} }),
      logbook: () => true,
      // Пишущие функции подставлены НАРОЧНО падающими: если проба однажды
      // начнёт их звать, тест это покажет, а не пропустит.
      setSelectGroupPolicy: () => { throw new Error('проба не должна менять политику'); },
      setOutboundMode: () => { throw new Error('проба не должна менять режим'); },
    },
    $httpAPI: (m, p, b, cb) => setTimeout(() => cb(JSON.parse(BODY)), 1),
    // У ответа ЕСТЬ заголовки: ST10 спрашивает у контроллера про CORS, и без
    // них ветка разбора заголовков в тесте не выполнялась бы вовсе.
    // Методы head/options заведены потому, что предзапрос — это OPTIONS.
    // put/patch/delete подставлены НАРОЧНО падающими: если проба однажды
    // начнёт писать в боевую маршрутизацию, тест это покажет, а не пропустит
    // (то же соглашение, что у пишущих функций $surge выше).
    $httpClient: {
      get: (opts, cb) => setTimeout(() => cb(null, { status: 200, headers: RESP_HEADERS }, BODY), 1),
      head: (opts, cb) => setTimeout(() => cb(null, { status: 200, headers: RESP_HEADERS }, ''), 1),
      options: (opts, cb) => setTimeout(() => cb(null, { status: 204, headers: RESP_HEADERS }, ''), 1),
      post: (opts, cb) => setTimeout(() => cb(null, { status: 200, headers: RESP_HEADERS }, '{}'), 1),
      put: () => { throw new Error('проба не должна писать в маршрутизацию'); },
      patch: () => { throw new Error('проба не должна писать в маршрутизацию'); },
      delete: () => { throw new Error('проба не должна писать в маршрутизацию'); },
    },
    WebSocket: function () {
      // Сразу закрываемся: пробы обязаны это пережить и пойти дальше.
      setTimeout(() => { if (this.onclose) this.onclose(); }, 1);
      this.close = () => {};
    },
    $done: (v) => { done.called = true; done.value = v; },
  };
  sandbox.globalThis = sandbox;
  state.done = done;
  return sandbox;
}

for (const rel of PROBES) {
  test('проба доживает до $done: ' + rel, async () => {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), 'файла нет: ' + rel);
    const code = fs.readFileSync(file, 'utf8');
    const state = {};
    const sandbox = makeSandbox(state);
    const ctx = vm.createContext(sandbox);

    let threw = null;
    try {
      vm.runInContext(code, ctx, { filename: rel, timeout: 5000 });
    } catch (e) { threw = e; }
    assert.equal(threw, null, 'проба упала при запуске: ' + (threw && threw.message));

    // Пробы асинхронные: ждём, пока отработают подставные таймеры.
    const until = Date.now() + 4000;
    while (!state.done.called && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(state.done.called,
      'проба не дошла до $done — цепочка шагов оборвалась (частая причина: вызов функции, которой нет)');
  });
}
