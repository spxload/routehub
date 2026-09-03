// Поведение пробы ST13 в песочнице с подставным контроллером.
//
// ЗАЧЕМ СВЕРХ probes-smoke. Смоук проверяет одно: проба доживает до `$done`.
// У ST13 цена ошибки другая. Она единственная из проб ВЫГРУЖАЕТ ИМЕНА
// ХОСТОВ — иначе на вопрос «какое правило обслуживало загрузку в Telegram»
// ответить нечем. Значит фильтр по списку WATCH — не удобство, а граница
// приватности, и её надо проверять, а не полагаться на неё.
//
// Второе: вердикт пробы решает, какую из двух причин лечить. Ложный вердикт
// здесь дороже отсутствия вердикта — проект это уже проходил (ST11 объявила
// «счётчиков нет», когда они были).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const CODE = fs.readFileSync(path.join(ROOT, 'probes/routehub-probe-stash13.js'), 'utf8');

const SECRET = 'Bearer ОЧЕНЬ-СЕКРЕТНО';
const BYP = '🇫🇮 Финляндия [Обход] 03 · 21↓68 / 7↓96';
const NODE = '🇳🇱 Нидерланды [VPN] 01 · 30↓90 / 7↓96';

function conn(id, host, rule, payload, chains, up, down) {
  return {
    id, rule, rulePayload: payload, chains,
    upload: { current: 0, last: 0, max: 0, total: up },
    download: { current: 0, last: 0, max: 0, total: down },
    metadata: { host, network: 'tcp', destinationIP: '1.2.3.4', destinationPort: '443' },
  };
}

// Личное соединение, которого в отчёте быть не должно НИ В КАКОМ ВИДЕ.
const PRIVATE_HOST = 'очень-личный-сайт.example';

function run(opts = {}) {
  const { mode = 'rule', ruNow = 'DIRECT', conns = null } = opts;
  const state = { done: null, clip: null, calls: [] };

  const list = conns || [
    conn('1', 'upload.telegram.org', 'RuleSet', 'rh-telegram', [NODE, 'RH-АВТО-W', 'RH-АВТО'], 8_000_000, 2000),
    conn('2', '', 'RuleSet', 'rh-telegram', [NODE, 'RH-АВТО'], 500, 900_000),
    conn('3', PRIVATE_HOST, 'Match', '', [ 'DIRECT' ], 100, 200),
    conn('4', 'files.oneme.ru', 'GeoIP', 'RU', [BYP, 'RH-Обход', 'RH-RU'], 3_000_000, 500),
  ];

  function respond(o, cb) {
    const url = String(o.url || '');
    state.calls.push({ url, auth: (o.headers && o.headers.Authorization) || null });
    const ok = (body) => setTimeout(() => cb(null, { status: 200, headers: {} }, body), 1);
    if (url.indexOf('/configs') >= 0) return ok(JSON.stringify({ mode }));
    if (url.indexOf('/proxies') >= 0) {
      return ok(JSON.stringify({
        proxies: {
          'RH-RU': { type: 'Fallback', now: ruNow },
          'RH-Главный': { type: 'Selector', now: 'DIRECT' },
          'RH-Обход': { type: 'Fallback', now: BYP },
          'RH-АВТО': { type: 'Selector', now: 'RH-АВТО-W' },
          'RH-AI': { type: 'Selector', now: 'RH-AI-W' },
          'RH-Звонки': { type: 'Selector', now: 'RH-Звонки-W' },
        },
      }));
    }
    if (url.indexOf('/connections') >= 0) return ok(JSON.stringify({ connections: list }));
    return ok('{}');
  }

  const sandbox = {
    console: { log: () => {} },
    JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, isFinite, encodeURIComponent, decodeURIComponent,
    // Короткие паузы ускоряем, длинные (сторож 60 с) оставляем настоящими:
    // иначе сторож сработал бы раньше самой пробы и тест проверял бы его.
    setTimeout: (fn, ms) => setTimeout(fn, (ms || 0) < 5000 ? 1 : ms),
    clearTimeout,
    $environment: {
      'controller-url': 'http://127.0.0.1:9090',
      'controller-authorization': SECRET,
      'stash-version': '3.4.1',
    },
    $notification: { post: (t, s, b, o) => { state.clip = (o && o.clipboard) || null; } },
    $httpClient: {
      get: respond,
      head: respond,
      // Любая запись в маршрутизацию обязана уронить прогон, а не пройти тихо.
      post: () => { throw new Error('проба не должна писать в маршрутизацию'); },
      put: () => { throw new Error('проба не должна писать в маршрутизацию'); },
      patch: () => { throw new Error('проба не должна писать в маршрутизацию'); },
      delete: () => { throw new Error('проба не должна писать в маршрутизацию'); },
    },
    $done: (v) => { state.done = v || {}; },
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(CODE, vm.createContext(sandbox), { filename: 'routehub-probe-stash13.js' });
  return state;
}

async function settle(state, ms = 6000) {
  const until = Date.now() + ms;
  while (!state.done && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  return state.clip ? JSON.parse(state.clip) : null;
}

test('обходной узел в цепочке — вердикт называет причину, а не описывает данные', async () => {
  const st = run();
  const rep = await settle(st);
  assert.ok(rep, 'отчёт не попал в буфер обмена');
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('НАЙДЕНО') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('кандидат 1') >= 0, 'вердикт не назвал причину');
  // Группа RH-RU и её выбор — то, ради чего проба и читает /proxies.
  assert.ok(rep.ans.группы['RH-Обход'].indexOf('ОБХОД') >= 0, 'обходной выбор не помечен');
});

test('чужие соединения не называются — граница приватности', async () => {
  const st = run();
  const rep = await settle(st);
  const dump = JSON.stringify(rep);
  assert.ok(dump.indexOf(PRIVATE_HOST) < 0, 'в отчёт попал хост вне списка WATCH');
  const hosts = rep.ans.соединения.map((x) => x.хост);
  assert.equal(hosts.length, 3, 'ожидались только три интересующих соединения: ' + hosts.join(', '));
  assert.ok(hosts.some((h) => h.indexOf('telegram') >= 0));
  assert.ok(hosts.some((h) => h.indexOf('oneme') >= 0));
  // Соединение Telegram по IP (без имени хоста) обязано попасть — оно
  // опознаётся по правилу, а не по адресу.
  assert.ok(hosts.some((h) => h.indexOf('без имени') >= 0), 'соединение по IP потеряно');
});

test('порядок — по отданным байтам: загрузка сверху', async () => {
  const st = run();
  const rep = await settle(st);
  const first = rep.ans.соединения[0];
  assert.ok(first.хост.indexOf('telegram') >= 0, 'сверху не самое отдающее: ' + first.хост);
  assert.equal(rep.ans.отдающих_соединений, 2, 'неверно посчитаны отдающие соединения');
});

test('глобальный режим: проба не судит о правилах', async () => {
  const st = run({ mode: 'global' });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('НЕ СУДИМ') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  // Ложный вывод «правило не сработало» при выключенных правилах — ровно та
  // ошибка, из-за которой 31.08 подняли ложную тревогу.
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('Режим по правилам') >= 0);
});

test('интересующих соединений нет: проба просит повторить сбой, а не молчит', async () => {
  const st = run({ conns: [conn('9', PRIVATE_HOST, 'Match', '', ['DIRECT'], 1, 1)] });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('ПУСТО') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('повторить сбой') >= 0);
});

test('всё чисто: вердикт не выдумывает причину', async () => {
  const st = run({
    conns: [conn('1', 'upload.telegram.org', 'RuleSet', 'rh-telegram', [NODE, 'RH-АВТО'], 8_000_000, 2000)],
  });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('СНЯТО') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
});

test('секрет контроллера не утекает в отчёт', async () => {
  const st = run();
  const rep = await settle(st);
  assert.ok(JSON.stringify(rep).indexOf(SECRET) < 0, 'секрет в отчёте');
  assert.ok(JSON.stringify(rep).indexOf('ОЧЕНЬ-СЕКРЕТНО') < 0);
  for (const c of st.calls) {
    if (c.auth) assert.ok(c.url.indexOf('127.0.0.1') >= 0, 'Authorization ушёл наружу: ' + c.url);
  }
});

test('к контроллеру — только GET, и несколько снимков подряд', async () => {
  const st = run();
  await settle(st);
  const conns = st.calls.filter((c) => c.url.indexOf('/connections') >= 0);
  assert.ok(conns.length >= 5, 'снимков мало: ' + conns.length + ' — одиночный снимок загрузку не поймает');
});
