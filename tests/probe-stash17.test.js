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
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('ВСЁ ОТВЕЧАЕТ') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
});

test('поля пусты у всех — вердикт закрывает направление, а не молчит', async () => {
  const st = run({ conns: [conn('1', 'chatgpt.com'), conn('2', 'grok.com')] });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('ПУСТЫ') > 0 || rep.ans.ВЕРДИКТ.indexOf('ОТВЕЧАЕТ') === 0,
    'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.equal(rep.ans.с_неизвестными_полями, 0);
});

test('запрос ушёл, ответа ноль — проба называет сервис И узел', async () => {
  // Данные из прогона 06.09, 22:30, дословно: grok.com через Германию ⭐🟢
  // отдал 1528 байт и принял ноль, провисев так десять снимков, тогда как
  // тот же Grok через соседние узлы отдавал 6–9 КБ.
  const st = run({ conns: [
    Object.assign(conn('1', 'grok.com'), {
      chains: ['🇩🇪 ⭐ 🟢 Германия [VPN] · 42↓181 / ∅'],
      upload: { total: 1528 }, download: { total: 0 },
    }),
    Object.assign(conn('2', 'chatgpt.com'), {
      chains: ['🇩🇪 ⭐ 🟢 Германия [VPN] · 42↓181 / ∅'],
      upload: { total: 2116 }, download: { total: 7813 },
    }),
  ] });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('НЕ ОТВЕТИЛИ') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('grok.com через 🇩🇪 ⭐ 🟢 Германия [VPN]') >= 0,
    'вердикт не назвал пару «сервис через узел»: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('chatgpt') < 0, 'ответивший сервис объявлен молчащим');
  assert.equal(rep.ans.ответили, 1);
  assert.equal(st.done.backgroundColor, '#FF3B30', 'молчащий сервис не окрашен как отказ');
  assert.ok(st.done.content.indexOf('без ответа') >= 0, 'отказ не виден в тексте');
});

test('только что открытое соединение без ответа отказом не считается', async () => {
  // Ноль у соединения, прожившего один-два снимка, не значит ничего: ответ
  // ещё в пути. Судить можно только по тому, что молчало долго.
  const st = run({ controller: (url, ok) => ok(JSON.stringify({ connections: [
    Object.assign(conn('1', 'grok.com'), { upload: { total: 1528 }, download: { total: 0 } }),
  ] })) });
  // Один снимок из двадцати даст мало «снимков» только если соединение
  // появилось поздно; здесь оно есть во всех, поэтому проверяем границу прямо.
  const rep = await settle(st);
  const limit = Number(/var MIN_SNAPS = (\d+)/.exec(CODE)[1]);
  assert.ok(limit >= 3, 'порог снимков слишком мал: ' + limit);
  assert.ok(rep.ans.соединения[0].снимков >= limit, 'соединение прожило меньше порога');
});

test('мало отдано — не судим: запрос толком не ушёл', async () => {
  const st = run({ conns: [
    Object.assign(conn('1', 'grok.com'), { upload: { total: 40 }, download: { total: 0 } }),
  ] });
  const rep = await settle(st);
  assert.ok(!rep.ans.БЕЗ_ОТВЕТА, 'соединение с 40 байтами отдачи объявлено отказом');
  assert.ok(String(rep.ans.соединения[0].ИТОГ).indexOf('рано судить') >= 0,
    'итог: ' + rep.ans.соединения[0].ИТОГ);
});

test('ручной выбор узла: имя берётся из лога, когда правил нет', async () => {
  // При ручном выборе правило «NO-RULE», а узел ядро пишет только в лог.
  const st = run({ conns: [
    Object.assign(conn('1', 'gemini.google.com'), {
      rule: 'NO-RULE', rulePayload: '', chains: [],
      log: '["22:30:00.248 connect with selected proxy: 🇵🇱 ⭐ 🟢 Польша [VPN] · 58↓125 / ∅"]',
      upload: { total: 2472 }, download: { total: 10342 },
    }),
  ] });
  const rep = await settle(st);
  assert.equal(rep.ans.соединения[0].узел, '🇵🇱 ⭐ 🟢 Польша [VPN]', 'узел из лога не разобран');
  assert.equal(rep.ans.соединения[0].выбран_вручную, true);
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

// ───────────────────────────────────────────────────────────────────────
// ПУНКТ 10: протокол, повторы, расширенный WATCH.
// ───────────────────────────────────────────────────────────────────────

// Соединение с заданным протоколом и портом: `network` лежит в metadata, и
// подменять его надо именно там, иначе проверка ничего не проверяет.
function connNet(id, host, network, port, extra = {}) {
  const c = conn(id, host, extra);
  c.metadata = Object.assign({}, c.metadata, { network, destinationPort: port });
  return c;
}
const МОЛЧИТ = { upload: { total: 1528 }, download: { total: 0 } };

// Список WATCH читается из исходника: тест обязан проверять ТОТ набор, что
// уедет на телефон, а не свою копию, которая разойдётся с ним на первой правке.
const WATCH = (() => {
  const src = /var WATCH = \[([\s\S]*?)\];/.exec(CODE)[1];
  return src.split('\n').join(' ').match(/'([^']+)'/g).map((s) => s.slice(1, -1));
})();

test('протокол несостоявшегося соединения назван: udp/443 — это QUIC', async () => {
  // ЗАЧЕМ. QUIC ходит по UDP/443. Блокировку QUIC проект сознательно не
  // включает, но отличить обрыв QUIC от обрыва TCP нечем — этим и отличаем.
  const st = run({ conns: [connNet('1', 'gemini.google.com', 'udp', '443', МОЛЧИТ)] });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('НЕ ОТВЕТИЛИ') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('udp/443 QUIC') > 0, 'протокол не назван: ' + rep.ans.ВЕРДИКТ);
  assert.equal(rep.ans.udp_без_ответа, 1, 'UDP-отказ не посчитан отдельно');
  assert.equal(rep.ans.quic_без_ответа, 1, 'QUIC-отказ не посчитан отдельно');
  assert.equal(rep.ans.соединения[0].сеть, 'udp');
  assert.equal(rep.ans.по_протоколам.udp, 1);
});

test('отказ по TCP не выдаётся за UDP и за QUIC', async () => {
  const st = run({ conns: [connNet('1', 'grok.com', 'tcp', '443', МОЛЧИТ)] });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('[tcp]') > 0, 'протокол не назван: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('QUIC') < 0, 'TCP объявлен QUIC-ом');
  assert.equal(rep.ans.udp_без_ответа, undefined, 'TCP посчитан как UDP-отказ');
  assert.equal(rep.ans.по_протоколам.tcp, 1);
});

test('UDP не на 443 QUIC-ом не называется', async () => {
  // Звонки и DNS тоже UDP. Назвать их QUIC-ом — увести разбор в сторону.
  const st = run({ conns: [connNet('1', 'grok.com', 'udp', '8801', МОЛЧИТ)] });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('[udp]') > 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('QUIC') < 0, 'UDP/8801 объявлен QUIC-ом');
  assert.equal(rep.ans.udp_без_ответа, 1);
  assert.equal(rep.ans.quic_без_ответа, undefined, 'не-QUIC посчитан QUIC-ом');
});

test('протокол неизвестен — так и сказано, а не «tcp» по умолчанию', async () => {
  const c = conn('1', 'chatgpt.com', МОЛЧИТ);
  delete c.metadata.network;
  const st = run({ conns: [c] });
  const rep = await settle(st);
  assert.equal(rep.ans.соединения[0].сеть, '?', 'пустое поле network подменено догадкой');
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('[?]') > 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
});

test('повторы: разные соединения к одному хосту считаются и выносятся в вердикт', async () => {
  // ЗАЧЕМ. Приложение, которому не ответили, заходит заново. Байты при этом
  // могут идти в обе стороны, и проба по ним молчит — а переоткрытия видны.
  // Поле log заполнено намеренно: без него проба и так не красит вывод
  // зелёным, и проверка цвета ничего бы не значила.
  const st = run({ conns: [
    conn('1', 'gemini.google.com', { log: 'connect failed: EOF' }),
    conn('2', 'gemini.google.com', { log: 'connect failed: EOF' }),
    conn('3', 'gemini.google.com'), conn('4', 'chatgpt.com'),
  ] });
  const rep = await settle(st);
  assert.deepEqual(rep.ans.ПОВТОРЫ, ['gemini.google.com ×3'], 'повторы: ' + JSON.stringify(rep.ans.ПОВТОРЫ));
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('ПЕРЕОТКРЫВАЕТ') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('gemini.google.com ×3') > 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.equal(st.done.backgroundColor, '#FF9F0A', 'переоткрытия окрашены как «всё хорошо»');
  assert.ok(st.done.content.indexOf('переоткрытия') >= 0, 'переоткрытия не видны в тексте');
});

test('одно соединение во всех снимках повтором не считается', async () => {
  // Соединение живёт двадцать снимков и остаётся ОДНИМ: считать снимки за
  // повторы — значит объявлять повтором любое долгое соединение.
  const st = run({ conns: [conn('1', 'gemini.google.com'), conn('2', 'chatgpt.com')] });
  const rep = await settle(st);
  assert.equal(rep.ans.ПОВТОРЫ, undefined, 'повторы: ' + JSON.stringify(rep.ans.ПОВТОРЫ));
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('ПЕРЕОТКРЫВАЕТ') < 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
});

test('порог повторов: два потока — норма, ниже порога не сообщаем', async () => {
  const порог = Number(/var MIN_REPEAT = (\d+)/.exec(CODE)[1]);
  assert.ok(порог >= 3, 'порог повторов слишком мал: ' + порог);
  const st = run({ conns: [conn('1', 'grok.com'), conn('2', 'grok.com')] });
  const rep = await settle(st);
  assert.equal(rep.ans.ПОВТОРЫ, undefined, 'два соединения объявлены повтором');
});

test('отказ и повторы вместе: вердикт начинается с отказа, повторы рядом', async () => {
  const st = run({ conns: [
    Object.assign(conn('1', 'gemini.google.com'), МОЛЧИТ),
    Object.assign(conn('2', 'gemini.google.com'), МОЛЧИТ),
    conn('3', 'gemini.google.com'),
  ] });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('НЕ ОТВЕТИЛИ') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('Переоткрывает: gemini.google.com ×3 (без ответа 2)') > 0,
    'повторы не попали в вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.equal(st.done.backgroundColor, '#FF3B30');
});

test('новые домены Gemini и AI Studio распознаются', async () => {
  // Каждый домен подтверждён боевым контуром: правилами RH-AI в routehub.conf
  // ветки main либо набором viewer12/OverseasAI.list, который тот же конфиг
  // подключает с policy=RH-AI.
  const свои = ['ai.google.dev', 'makersuite.google.com',
                'alkalimakersuite-pa.clients6.google.com', 'aiplatform.googleapis.com',
                'proactivebackend-pa.googleapis.com', 'business.gemini.google',
                'generativeai.google', 'www.generativeai.google'];
  const st = run({ conns: свои.map((h, i) => conn(String(i + 1), h)) });
  const rep = await settle(st);
  assert.equal(rep.ans.ии_соединений, свои.length,
    'часть доменов Gemini не распознана: ' + JSON.stringify(rep.ans.по_сервисам));
  assert.equal(rep.ans.чужих_не_названо, 0);
});

test('расширенный WATCH не выносит наружу личные хосты Google и Apple', async () => {
  // ⛔ Расширение списка — самое опасное место пробы: каждая строка WATCH это
  // разрешение выгрузить имя хоста. Хосты ниже ходят с того же телефона и к
  // ИИ отношения не имеют; ни один не должен совпасть.
  const чужие = ['google.com', 'www.google.com', 'mail.google.com', 'photos.google.com',
                 'drive.google.com', 'calendar.google.com', 'accounts.google.com',
                 'play.google.com', 'clients6.google.com', 'waa-pa.clients6.google.com',
                 'clients4.google.com', 'googleapis.com', 'storage.googleapis.com',
                 'fonts.googleapis.com', 'people-pa.googleapis.com',
                 'firebaselogging-pa.googleapis.com', 'fonts.gstatic.com',
                 'mask.icloud.com', 'gateway.icloud.com', 'mzstatic.com',
                 'gemini.google.com.evil.example', 'notgemini.google',
                 'myai.google.dev.example'];
  const st = run({ conns: чужие.map((h, i) => conn(String(i + 1), h, { log: 'личное ' + h })) });
  const rep = await settle(st);
  const dump = JSON.stringify(rep) + JSON.stringify(st.done);
  for (const h of чужие) assert.ok(dump.indexOf(h) < 0, 'личный хост выгружен наружу: ' + h);
  assert.equal(rep.ans.ии_соединений, 0, 'личные хосты посчитаны как ИИ-соединения');
});

test('ловушка «минус единицы» закрыта для КАЖДОГО домена WATCH, включая новые', async () => {
  // Прежняя редакция сравнивала indexOf с арифметикой длин, и совпадал любой
  // хост ровно на символ короче маркера. Проверка идёт по всему списку, а не
  // по девяти известным хостам: новый домен обязан проходить её сам.
  const подделки = [];
  for (const w of WATCH) {
    // Хост ровно на символ короче маркера — тот самый случай, на котором
    // старое сравнение давало -1 === -1. Для коротких маркеров вроде
    // `claude.ai` доменного хвоста уже не остаётся, и берётся голая строка
    // нужной длины: проверяется арифметика, а не красота имени.
    const n = w.length - 1 - '.example'.length;
    подделки.push(n > 0 ? ('z'.repeat(n) + '.example') : 'z'.repeat(w.length - 1));
    подделки.push(w + '.example');                    // маркер как ПРЕФИКС, а не хвост
    подделки.push('не' + w);                          // маркер как хвост без точки
  }
  const st = run({ conns: подделки.map((h, i) => conn(String(i + 1), h)) });
  const rep = await settle(st);
  const dump = JSON.stringify(rep) + JSON.stringify(st.done);
  for (const h of подделки) assert.ok(dump.indexOf(h) < 0, 'подделка принята за ИИ-хост: ' + h);
  assert.equal(rep.ans.ии_соединений, 0, 'подделки посчитаны ИИ-соединениями');
});

test('в WATCH нет широких маркеров — список не должен «подрасти» до всего Google', async () => {
  // В наборе OverseasAI.list есть строки `google.com`, `apis.google.com` и
  // подобные. Для маршрутизации они уместны, для ВЫГРУЗКИ ИМЁН — нет.
  const запрещено = ['google.com', 'google', 'googleapis.com', 'apis.google.com',
                     'gstatic.com', 'clients6.google.com', 'com', 'ai', 'dev'];
  for (const w of WATCH) {
    assert.ok(запрещено.indexOf(w) < 0, 'в WATCH попал широкий маркер: ' + w);
    assert.ok(w.indexOf('.') > 0, 'маркер без точки ловит целую зону: ' + w);
  }
  assert.ok(WATCH.indexOf('gemini.google.com') >= 0, 'потерян основной домен Gemini');
});

test('соединения без собственного id повтором не считаются', async () => {
  // ⛔ Запасной ключ соединения строится из НОМЕРА записи в списке. Номер
  // съезжает, как только закрылось соседнее соединение, и одно и то же
  // соединение получило бы в следующем снимке другой ключ — счётчик повторов
  // насчитал бы переоткрытия там, где соединение всё время было одно.
  let n = 0;
  const без_id = (host) => { const c = conn('x', host); delete c.id; return c; };
  const st = run({ controller: (url, ok) => {
    // Соединение к Gemini всё время ОДНО, но в каждом снимке стоит на новом
    // месте списка — запасной ключ пробегает :0, :1, :2.
    const список = [без_id('gemini.google.com'), без_id('chatgpt.com'), без_id('grok.com')];
    const сдвиг = n++ % 3;
    for (let k = 0; k < сдвиг; k++) список.push(список.shift());
    return ok(JSON.stringify({ connections: список }));
  } });
  const rep = await settle(st);
  assert.equal(rep.ans.ПОВТОРЫ, undefined,
    'соединения без id посчитаны переоткрытиями: ' + JSON.stringify(rep.ans.ПОВТОРЫ));
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('ПЕРЕОТКРЫВАЕТ') < 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
});

test('в вердикт идут три самых настойчивых хоста, остальные — числом', async () => {
  // Вердикт читают с экрана телефона: перечень из десятка имён вытесняет из
  // первой строки главное. Полный список остаётся в отчёте.
  const хосты = ['gemini.google.com', 'chatgpt.com', 'grok.com', 'claude.ai'];
  const conns = [];
  хосты.forEach((h, k) => { for (let j = 0; j <= k; j++) conns.push(conn(h + ':' + j, h)); });
  // 1, 2, 3, 4 соединения: порог MIN_REPEAT пройдут два хоста из четырёх,
  // ещё два добираются ниже — всего четыре, то есть на один больше показа.
  const ещё = ['x.ai', 'perplexity.ai'].reduce((a, h) =>
    a.concat([conn(h + ':1', h), conn(h + ':2', h), conn(h + ':3', h)]), []);
  const st = run({ conns: conns.concat(ещё) });
  const rep = await settle(st);
  assert.equal(rep.ans.ПОВТОРЫ.length, 4, 'повторы: ' + JSON.stringify(rep.ans.ПОВТОРЫ));
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('claude.ai ×4') > 0, 'самый настойчивый хост не первый: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('и ещё 1') > 0, 'хвост списка не свёрнут: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('perplexity') < 0, 'в вердикт попал четвёртый хост: ' + rep.ans.ВЕРДИКТ);
  assert.ok(JSON.stringify(rep.ans.ПОВТОРЫ).indexOf('perplexity.ai ×3') > 0, 'хост потерян в отчёте');
  assert.ok(rep.ans.ВЕРДИКТ.length < 300, 'вердикт разросся до портянки: ' + rep.ans.ВЕРДИКТ.length);
});
