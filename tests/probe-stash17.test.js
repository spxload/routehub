// Поведение пробы ST17 в песочнице с подставным контроллером.
//
// ЗАЧЕМ СВЕРХ probes-smoke. ST17 — вторая проба проекта, которая ВЫГРУЖАЕТ
// ИМЕНА ХОСТОВ. Телефон ходит не только в ИИ-сервисы, поэтому фильтр по
// списку WATCH — не удобство, а граница приватности, и её надо проверять, а
// не полагаться на неё. Второе: весь смысл пробы в том, читается ли исход из
// полей `log`/`tracing`; если разбор этих полей молча сломается, вердикт
// скажет «направление закрыто» там, где данные были.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = 'probes/routehub-probe-stash17.js';
const CODE = fs.readFileSync(path.join(ROOT, FILE), 'utf8');

const SECRET = 'Bearer ОЧЕНЬ-СЕКРЕТНО';
const PRIVATE_HOST = 'очень-личный-сайт.example';
const NODE = '🇩🇪 ⭐ 🟢 Германия [VPN] · 37↓202 / 7↓96';

function conn(id, host, extra = {}) {
  return Object.assign({
    id, rule: 'RuleSet', rulePayload: 'rh-ai', chains: [NODE, 'RH-AI-W', 'RH-AI'],
    upload: { current: 0, last: 0, max: 0, total: 1200 },
    download: { current: 0, last: 0, max: 0, total: 3400 },
    metadata: { host, network: 'tcp', destinationPort: '443' },
  }, extra);
}

function run(opts = {}) {
  const { conns = null, controller = null } = opts;
  const state = { done: null, note: null, ctl: [] };
  const list = conns || [
    conn('1', 'gemini.google.com', { log: 'connect failed: EOF' }),
    conn('2', 'chatgpt.com'),
    conn('3', PRIVATE_HOST, { log: 'секретная строка' }),
    conn('4', 'www.perplexity.ai'),
  ];

  function respond(o, cb) {
    const url = String(o.url || '');
    state.ctl.push({ url, auth: (o.headers && o.headers.Authorization) || null });
    const ok = (body) => setTimeout(() => cb(null, { status: 200, headers: {} }, body), 1);
    if (controller) return controller(url, ok, cb);
    if (url.indexOf('/connections') >= 0) return ok(JSON.stringify({ connections: list }));
    return ok('{}');
  }

  const sandbox = {
    console: { log: () => {} },
    JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, isFinite, encodeURIComponent, decodeURIComponent,
    setTimeout: (fn, ms) => setTimeout(fn, Math.max(1, Math.round((ms || 0) / 200))),
    clearTimeout,
    $environment: {
      'controller-url': 'http://127.0.0.1:9090',
      'controller-authorization': SECRET,
      'stash-version': '3.4.1',
    },
    $notification: { post: (t, s, b, o) => { state.note = { t, s, b, clip: (o && o.clipboard) || null }; } },
    $httpClient: {
      get: respond,
      head: respond,
      post: () => { throw new Error('проба не должна писать'); },
      put: () => { throw new Error('проба не должна писать'); },
      patch: () => { throw new Error('проба не должна писать'); },
      delete: () => { throw new Error('проба не должна писать'); },
    },
    $done: (v) => { state.done = v || {}; },
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(CODE, vm.createContext(sandbox), { filename: FILE });
  return state;
}

async function settle(state, ms = 8000) {
  const until = Date.now() + ms;
  while (!state.done && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  assert.ok(state.done, 'проба не дошла до $done');
  assert.ok(state.note && state.note.clip, 'отчёт не попал в буфер обмена');
  return JSON.parse(state.note.clip);
}

test('чужие соединения не называются — граница приватности', async () => {
  const st = run();
  const rep = await settle(st);
  const dump = JSON.stringify(rep) + JSON.stringify(st.done);
  assert.ok(dump.indexOf(PRIVATE_HOST) < 0, 'в отчёт попал хост вне списка WATCH');
  assert.ok(dump.indexOf('секретная строка') < 0, 'поле log чужого соединения выгружено');
  assert.equal(rep.ans.ии_соединений, 3, 'посчитаны не только ИИ-соединения');
  assert.ok(rep.ans.чужих_не_названо >= 1, 'чужие соединения не посчитаны числом');
});

test('исход из поля log попадает в отчёт — ради этого проба и написана', async () => {
  const st = run();
  const rep = await settle(st);
  const g = rep.ans.соединения.filter((r) => r.сервис === 'gemini.google.com')[0];
  assert.ok(g, 'соединение Gemini потеряно');
  assert.ok(String(g.поля.log).indexOf('connect failed') >= 0, 'содержимое log не сохранено: ' + JSON.stringify(g.поля));
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('ЕСТЬ ЧТО ЧИТАТЬ') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
});

test('поля пусты у всех — вердикт закрывает направление, а не молчит', async () => {
  const st = run({ conns: [conn('1', 'chatgpt.com'), conn('2', 'grok.com')] });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('ПУСТЫ') > 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.equal(rep.ans.с_неизвестными_полями, 0);
});

test('ИИ-соединений не было — это не отказ, и так и сказано', async () => {
  const st = run({ conns: [conn('9', PRIVATE_HOST)] });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('НЕ БЫЛО') > 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('не отказ') > 0, 'пустой журнал подан как поломка');
  assert.notEqual(st.done.backgroundColor, '#34C759');
});

test('чужой хост той же длины, что маркер, не выдаётся за ИИ-сервис', async () => {
  // ⛔ ДЕФЕКТ ПЕРВОЙ РЕДАКЦИИ, пойманный первым прогоном на устройстве.
  // Проверка суффикса сравнивала indexOf с арифметикой длин, и при отсутствии
  // подстроки обе части давали -1 — совпадали любые хосты, чья длина ровно на
  // единицу меньше длины маркера. Все хосты ниже взяты ДОСЛОВНО из той
  // выгрузки: каждый был выгружен наружу под чужим именем.
  const пары = [
    ['api.ip.sb', 'claude.ai'],
    ['mask.icloud.com', 'bard.google.com'],
    ['fonts.gstatic.com', 'gemini.google.com'],
    ['gateway.icloud.com', 'oaiusercontent.com'],
    ['js.stripe.com', 'oaistatic.com'],
    ['pd.itunes.apple.com', 'aistudio.google.com'],
    ['ocsp.digicert.com', 'gemini.google.com'],
    ['firebaselogging-pa.googleapis.com', 'generativelanguage.googleapis.com'],
    ['yandex.kz', 'claude.ai'],
  ];
  const st = run({ conns: пары.map((p, i) => conn(String(i + 1), p[0], { log: 'личное ' + p[0] })) });
  const rep = await settle(st);
  const dump = JSON.stringify(rep) + JSON.stringify(st.done);
  for (const [чужой, маркер] of пары) {
    assert.ok(dump.indexOf(чужой) < 0,
      'хост «' + чужой + '» (' + чужой.length + ' знаков) выгружен как «' + маркер +
      '» (' + маркер.length + ') — совпали только длины');
  }
  assert.equal(rep.ans.ии_соединений, 0, 'чужие хосты посчитаны как ИИ-соединения');
  assert.equal(rep.ans.чужих_не_названо, пары.length * 20, 'чужие не посчитаны числом');
});

test('настоящие ИИ-хосты из полевой выгрузки распознаются все', async () => {
  const свои = ['chatgpt.com', 'ws.chatgpt.com', 'auth.openai.com', 'cdn.openai.com',
                'persistent.oaistatic.com', 'gemini.google.com', 'aistudio.google.com',
                'grok.com', 'cdn.grok.com', 'assets.grok.com', 'imagine-public.x.ai'];
  const st = run({ conns: свои.map((h, i) => conn(String(i + 1), h)) });
  const rep = await settle(st);
  assert.equal(rep.ans.ии_соединений, свои.length, 'часть настоящих ИИ-хостов потеряна');
  assert.equal(rep.ans.чужих_не_названо, 0);
});

test('поддомен наблюдаемого хоста считается своим, чужой похожий — нет', async () => {
  const st = run({ conns: [
    conn('1', 'cdn.oaistatic.com'),
    conn('2', 'notchatgpt.com'),
    conn('3', 'chatgpt.com.evil.example'),
  ] });
  const rep = await settle(st);
  assert.equal(rep.ans.ии_соединений, 1, 'фильтр хостов сработал неверно');
  assert.equal(rep.ans.соединения[0].сервис, 'oaistatic.com');
  const dump = JSON.stringify(rep);
  assert.ok(dump.indexOf('evil.example') < 0, 'хост, лишь похожий на наблюдаемый, выгружен');
});

test('правило 2: к контроллеру только чтение /connections, ключ не утекает', async () => {
  const st = run();
  const rep = await settle(st);
  assert.ok(st.ctl.length > 0);
  for (const c of st.ctl) {
    assert.ok(c.url.indexOf('/connections') >= 0, 'лишний путь: ' + c.url);
    assert.equal(c.auth, SECRET);
  }
  const all = JSON.stringify(rep) + JSON.stringify(st.note) + JSON.stringify(st.done);
  assert.ok(all.indexOf('ОЧЕНЬ-СЕКРЕТНО') < 0, 'ключ контроллера виден');
});

test('контроллер молчит — вердикт называет причину', async () => {
  const st = run({ controller: (url, ok, cb) => setTimeout(() => cb('нет связи', null, null), 1) });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('контроллер не ответил') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
});

test('число снимков не превышает объявленного', async () => {
  const st = run();
  const rep = await settle(st);
  const limit = Number(/var SNAPSHOTS = (\d+)/.exec(CODE)[1]);
  assert.ok(rep.ans.снимков <= limit, 'снимков больше предела: ' + rep.ans.снимков);
  assert.ok(st.ctl.length <= limit, 'запросов больше снимков');
});
