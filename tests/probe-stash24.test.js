// Поведение пробы ST24 (замечает ли Stash в фоне смерть узла поставщика) в
// песочнице с подставным контроллером tests/fake-stash.js (+ fake-stash-use.js).
//
// ЗАЧЕМ. ST24 — только GET к контроллеру (четыре группы, четыре поставщика,
// /rules) плюс одно касание группы T: обычный GET без заголовков на хост,
// который в T ведёт единственное правило override Lab (ревью ST24, дважды:
// заголовок выбора не подтверждён, а боевые правила — RH-AI и MATCH —
// могут кончиться обходом). Тест сторожит: касание — только после чтения
// группы T (now ∈ {TA, TB}) и сверки /rules (правило касания раньше любого
// не-DOMAIN правила); непонятный /rules — касания нет; заголовка
// X-Stash-Selected-Proxy нет; внешний хост один; в журнал — код и время.
// Переходы «ушёл / вернулся» считаются с задержкой от начала
// окна и только при опоре на прошлое чтение; вердикт различает «замечает за
// ≤ N мин» / «не заметил за окно» / «нет данных», и отсутствие данных
// никогда не читается как «замечает».

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStash, sandbox, settle, SECRET } from './fake-stash.js';
import { T } from './harness.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = 'probes/routehub-probe-stash24.js';
const CODE = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
const BARE = CODE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const L = T.STASH_LAB24;
const P = 'RH-Т24-', MIN = 60000, WIN = 600000;
const IDS = ['L', 'N', 'P', 'T'];
const GR = IDS.map((x) => P + x);
const MS = 1_800_000_000_000;        // начало чётного окна 3 000 000
const TOUCH_HOST = 'connectivitycheck.android.com';
const TOUCH = 'https://' + TOUCH_HOST + '/generate_204';
// /rules так, как его отдаёт ядро Clash-семейства: правило override Lab
// первым (Stash вставляет массивы override в начало), дальше боевые.
const R = (type, payload, proxy) => ({ type, payload, proxy, size: -1 });
const RULES_OK = [R('Domain', TOUCH_HOST, 'RH-Т24-T'), R('DomainSuffix', 'samokat.ru', 'DIRECT'), R('IPCIDR', '17.0.0.0/8', 'RH-RU'),
  R('DomainSuffix', 'chatgpt.com', 'RH-AI'), R('RuleSet', 'rh-ads', 'REJECT'), R('GeoIP', 'RU', 'RH-RU'), R('Match', '', 'RH-Главный')];
const K0 = MS / WIN;

// Модель ядра: A группы g «мёртв» глазами ядра в нечётном окне с минуты
// notice[g] (null — не замечает никогда), в следующем чётном — до минуты
// back[g] (кроме окна K0 — до него мёртвых окон модель не знает). now
// fallback — первый живой из поставщика.
function world(o = {}) {
  const g = { 'RH-RU': { type: 'Fallback', now: 'DIRECT', all: ['DIRECT', 'RH-Обход'] } };
  const providers = {};
  for (const x of IDS) {
    if (!o.noGroups) g[P + x] = { type: 'Fallback', use: ['rh-t24' + x.toLowerCase()] };
    if (!o.noProv) providers['rh-t24' + x.toLowerCase()] = { proxies: L.t24Nodes(x.toLowerCase()).map((n) => ({ name: n.name, type: 'Direct' })) };
  }
  const touches = [];
  const w = createStash({ groups: g, providers,
    route: (method, p, opt, reply, ww) => {
      ww.hdrs.push({ url: opt.url, headers: { ...(opt.headers || {}) } });
      if (opt.url === TOUCH) {
        touches.push({ method, headers: { ...(opt.headers || {}) }, timeout: opt.timeout, after: ww.calls.length - 1 });
        reply(ww.touchStatus || 204, ww.touchBody || '');
        return true;
      }
      if (p === '/rules') {
        if (ww.rulesStatus) { reply(ww.rulesStatus, '{"message":"x"}'); return true; }
        reply(200, ww.rulesBody !== undefined ? ww.rulesBody : JSON.stringify({ rules: ww.rules }));
        return true;
      }
      return undefined;
    },
    nowOf: (n, x, ww) => {
      if (!x.use) return x.now;
      if (ww.stuck && n in ww.stuck) return ww.stuck[n];
      const t = ww.clock.t, k = Math.floor(t / WIN), off = (t - k * WIN) / MIN;
      const nt = ww.notice[n], bk = ww.back[n];
      const aDead = k % 2 === 1 ? (nt !== null && nt !== undefined && off >= nt)
        : (k > K0 && nt !== null && nt !== undefined && bk !== undefined && off < bk);
      return x.all.find((m) => !(m === n + 'A' && aDead));
    }, ...(o.opts || {}) });
  w.notice = o.notice || {};
  w.back = o.back || {};
  w.touches = touches;
  w.hdrs = [];
  w.rules = o.rules || RULES_OK;
  return w;
}
// Время песочницы сжато в 1000 раз: сторож 75 с = 75 мс реального времени,
// и под нагрузкой (параллельный прогон всех тестов) он срабатывал раньше,
// чем подставной контроллер успевал ответить на 10 запросов. Поэтому сторож
// (и любой таймер ≥ 60 с) в обычных прогонах ждёт 4 с реального времени —
// меньше предела settle (5 с), но с запасом на нагрузку; повтор EOF (1 с)
// по-прежнему 1 мс. Проверка сторожа (контроллер висит) идёт с fastGuard —
// прежним сжатием, иначе settle её не дождётся.
const slowGuard = (ms) => ((ms || 0) >= 60000 ? 4000 : Math.max(1, Math.round((ms || 0) / 1000)));
async function run(w, o = {}) {
  const s = sandbox(w, CODE, FILE, { extra: o.tile ? { $script: { type: 'tile' } } : {}, ...(o.fastGuard ? {} : { timer: slowGuard }), ...(o.sb || {}) });
  await settle(s, 5000, o.grace === undefined ? 20 : o.grace);
  return s;
}
const state = (w) => JSON.parse(w.store.RH_ST24);
const dump = (s) => { const l = s.logs.find((x) => x.indexOf('[ST24] ') === 0); assert.ok(l, 'нет строки [ST24]'); return JSON.parse(l.slice(7)); };
// Чтения раз в минуту с offset мин от начала окна k0, n штук.
async function series(w, fromMs, n, o = {}) {
  let s = null;
  for (let i = 0; i < n; i++) {
    w.clock.t = fromMs + i * MIN;
    if (o.each) o.each(w, i);
    s = await run(w, o);
  }
  return s;
}

const touchCalls = (w) => w.calls.filter((c) => c.url === TOUCH).length;

test('запросы: GET 4 групп, 4 поставщиков и /rules контроллера + одно касание; timeout в секундах; ни PUT, ни /delay', async () => {
  const w = world();
  await run(w);
  const ctrl = w.calls.filter((c) => c.url !== TOUCH);
  const allowed = new Set(GR.map((g) => '/proxies/' + encodeURIComponent(g))
    .concat(IDS.map((x) => '/providers/proxies/rh-t24' + x.toLowerCase()), ['/rules']));
  assert.equal(ctrl.length, 9);
  assert.equal(touchCalls(w), 1);
  for (const c of ctrl) {
    assert.equal(c.method, 'get');
    assert.equal(c.timeout, 5, 'timeout у Stash в секундах: ' + c.timeout);
    assert.equal(c.auth, SECRET);
    assert.ok(c.url.indexOf('http://127.0.0.1:9090/') === 0 && allowed.has(c.p), 'путь ' + c.url);
  }
  assert.equal(new Set(ctrl.map((c) => c.p)).size, 9);
  assert.deepEqual(w.writes(), []);
  for (const x of ['$httpClient.put', '$httpClient.post', '$httpClient.delete', '/delay', 'setSelectPolicy', 'setRunningModel', "'PUT'", "'POST'",
    'X-Stash-Selected-Proxy', 'Selected-Proxy']) {
    assert.ok(BARE.indexOf(x) < 0, 'в пробе ' + x);
  }
  const used = [...BARE.matchAll(/\$httpClient\s*(?:\.\s*(\w+)|\[)/g)].map((m) => m[1] || '[');
  assert.deepEqual([...new Set(used)], ['get'], 'у $httpClient не только get: ' + used.join(','));
  for (const h of w.hdrs) assert.ok(!Object.keys(h.headers).some((k) => /selected-proxy/i.test(k)), 'заголовок выбора в запросе: ' + h.url);
});

// ⛔ Правило 1 (ревью ST24, дважды): внешний хост у пробы один — хост
// правила касания override Lab; других внешних адресов нет.
test('внешние адреса пробы — только контроллер и хост касания; хост касания = хост правила override Lab', async () => {
  const code = CODE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');   // без комментариев, адреса целы
  const lits = [...code.matchAll(/'(https?:\/\/[^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(lits.sort(), ['http://127.0.0.1:9090', TOUCH].sort(), 'адреса в пробе: ' + lits.join(', '));
  assert.ok(CODE.indexOf("var TOUCH_HOST = '" + TOUCH_HOST + "'") >= 0);
  const ov = fs.readFileSync(path.join(ROOT, 'plugins/RouteHub-Stash-Lab.stoverride'), 'utf8');
  assert.ok(ov.indexOf('\n  - DOMAIN,' + TOUCH_HOST + ',RH-Т24-T\n') > 0, 'в override нет правила касания для хоста пробы');
  const w = world();
  await series(w, MS + 30000, 2);
  for (const c of w.calls) {
    const h = new URL(c.url).hostname;
    assert.ok(h === '127.0.0.1' || h === TOUCH_HOST, 'запрос на посторонний хост: ' + c.url);
  }
});

test('касание T: после чтения группы T и /rules, один GET без заголовков и ключа, timeout 5 с; в журнал — код и время', async () => {
  const w = world();
  w.touchBody = 'SECRET-BODY ip=203.0.113.9';
  const s = await run(w, { tile: true });
  assert.equal(w.touches.length, 1);
  const t = w.touches[0];
  assert.equal(t.method, 'get');
  assert.equal(t.timeout, 5);
  assert.deepEqual(t.headers, {}, 'у касания заголовки');
  assert.equal(w.calls.filter((c) => c.url === TOUCH)[0].auth, undefined, 'ключ контроллера ушёл наружу');
  const iT = w.calls.findIndex((c) => c.p === '/proxies/' + encodeURIComponent(P + 'T'));
  const iR = w.calls.findIndex((c) => c.p === '/rules');
  assert.ok(iT >= 0 && iR > iT && t.after > iR, 'касание раньше чтения группы T или /rules');
  const d = dump(s).ans;
  assert.deepEqual(Object.keys(d.касание).sort(), ['код', 'мс', 'обрыв']);
  assert.deepEqual([d.касание.код, d.касание.обрыв], [204, false]);
  assert.equal(d.правило_касания, 'первое: DOMAIN,' + TOUCH_HOST + ',RH-Т24-T');
  assert.equal(state(w).журнал[0].касание, 'код 204');
  assert.deepEqual(state(w).касания, { сделано: 1, обрыв: 0, пропущено: 0 });
  const all = [JSON.stringify(w.store), s.logs.join('\n'), s.done.content, JSON.stringify(w.notes)].join('\n');
  assert.ok(all.indexOf('SECRET-BODY') < 0 && all.indexOf('203.0.113.9') < 0, 'тело ответа касания в журнале');
  // Обрыв касания: «обрыв», без повтора, чтения идут.
  const w2 = world();
  w2.eofWhen = (m, p) => p === '/generate_204';
  const d2 = dump(await run(w2, { tile: true })).ans;
  assert.equal(touchCalls(w2), 1, 'касание повторено');
  assert.deepEqual([d2.касание.код, d2.касание.обрыв], [null, true]);
  assert.equal(Object.keys(d2.сейчас).length, 4);
  assert.equal(state(w2).журнал[0].касание, 'обрыв');
  assert.deepEqual(state(w2).касания, { сделано: 0, обрыв: 1, пропущено: 0 }, 'обрыв касания засчитан как сделанное');
});

test('сверка /rules: правило касания после RULE-SET / GEOIP / MATCH / SUFFIX, нет правила, чужой прокси — касания нет', async () => {
  const touch = R('Domain', TOUCH_HOST, 'RH-Т24-T');
  const cases = [
    ['правило касания стоит после RULESET', [R('RuleSet', 'rh-ads', 'REJECT'), touch, R('Match', '', 'RH-Главный')]],
    ['правило касания стоит после GEOIP', [R('GeoIP', 'RU', 'RH-RU'), touch]],
    ['правило касания стоит после MATCH', [R('Match', '', 'RH-Главный'), touch]],
    ['правило касания стоит после DOMAINSUFFIX', [R('DomainSuffix', 'android.com', 'RH-АВТО'), touch]],
    ['правило касания стоит после DOMAINKEYWORD', [R('Domain', 'a.example', 'DIRECT'), R('DomainKeyword', 'android', 'RH-АВТО'), touch]],
    ['нет правила касания в /rules', [R('Domain', 'a.example', 'DIRECT'), R('RuleSet', 'rh-ads', 'REJECT'), R('Match', '', 'RH-Главный')]],
    ['нет правила касания в /rules', [R('Domain', 'a.example', 'DIRECT')]],
    ['правило хоста касания ведёт в DIRECT', [R('Domain', TOUCH_HOST, 'DIRECT'), touch]],
    ['правило хоста касания ведёт в RH-AI', [R('DOMAIN', TOUCH_HOST.toUpperCase(), 'RH-AI'), touch]],
    // DOMAIN — точное совпадение хоста: правило на часть имени — не правило касания.
    ['нет правила касания в /rules', [R('Domain', 'android.com', 'RH-Т24-T'), R('Match', '', 'RH-Главный')]],
    ['нет правила касания в /rules', [R('Domain', 'check.android.com', 'RH-Т24-T'), R('RuleSet', 'rh-ads', 'REJECT')]],
  ];
  for (const [why, rules] of cases) {
    const w = world({ rules });
    const d = dump(await run(w, { tile: true })).ans;
    assert.equal(touchCalls(w), 0, 'касание при: ' + why);
    assert.deepEqual(d.касание, { пропущено: why });
    assert.equal(d.правило_касания, why);
  }
  // Разрешено: перед правилом касания — только чужие DOMAIN; тип в любом регистре.
  for (const rules of [[R('Domain', 'a.example', 'DIRECT'), R('DOMAIN', TOUCH_HOST, 'RH-Т24-T'), R('Match', '', 'X')], [R('domain', TOUCH_HOST, 'RH-Т24-T')],
    [R('Domain', 'check.android.com', 'DIRECT'), R('Domain', 'x' + TOUCH_HOST, 'DIRECT'), R('Domain', TOUCH_HOST, 'RH-Т24-T')]]) {
    const w = world({ rules });
    await run(w);
    assert.equal(touchCalls(w), 1, JSON.stringify(rules));
  }
});

test('ответ /rules непонятного формата или не прочитан — «нет данных», касания нет (никогда «на всякий случай»)', async () => {
  const touch = R('Domain', TOUCH_HOST, 'RH-Т24-T');
  const bad = ['не json', 'null', '[]', '{}', JSON.stringify([touch]), JSON.stringify({ rules: {} }), JSON.stringify({ rules: [] }),
    JSON.stringify({ Rules: [touch] }), JSON.stringify({ rules: [{ payload: TOUCH_HOST, proxy: 'RH-Т24-T' }] }),
    JSON.stringify({ rules: [{ type: 'Domain', payload: TOUCH_HOST }] }), JSON.stringify({ rules: [{ type: 'Domain', proxy: 'RH-Т24-T' }, touch] }),
    JSON.stringify({ rules: [null, touch] }), JSON.stringify({ rules: ['DOMAIN,' + TOUCH_HOST + ',RH-Т24-T'] })];
  for (const body of bad) {
    const w = world();
    w.rulesBody = body;
    const d = dump(await run(w, { tile: true })).ans;
    assert.equal(touchCalls(w), 0, 'касание при /rules: ' + body);
    assert.deepEqual(d.касание, { пропущено: 'нет данных: формат /rules не разобран' }, body);
  }
  for (const set of [(w) => { w.rulesStatus = 404; }, (w) => { w.rulesStatus = 500; }, (w) => { w.eofWhen = (m, p) => p === '/rules'; }]) {
    const w = world();
    set(w);
    const d = dump(await run(w, { tile: true })).ans;
    assert.equal(touchCalls(w), 0);
    assert.deepEqual(d.касание, { пропущено: 'нет данных: /rules не прочитан' });
  }
  // Одиночный обрыв /rules (EOF, ST18) — повтор, как у прочих чтений; касание идёт.
  const w1 = world();
  let once = 0;
  w1.eofWhen = (m, p) => p === '/rules' && once++ === 0;
  await run(w1);
  assert.equal(w1.calls.filter((c) => c.p === '/rules').length, 2, 'нет повтора /rules после EOF');
  assert.equal(touchCalls(w1), 1);
});

test('касание пропущено по группе: нет группы T, now T не TA/TB, группа T не прочитана, контроллер молчит — ни /rules, ни касания', async () => {
  const cases = [
    ['нет группы T', (w) => { delete w.g[P + 'T']; }],
    ['now T не TA/TB: DIRECT', (w) => { w.stuck = { [P + 'T']: 'DIRECT' }; }],
    ['now T не TA/TB: нет данных', (w) => { w.stuck = { [P + 'T']: undefined }; }],
    ['группа T не прочитана', (w) => { w.fail = (m, p) => p === '/proxies/' + P + 'T'; }],
  ];
  for (const [why, set] of cases) {
    const w = world();
    set(w);
    const d = dump(await run(w, { tile: true })).ans;
    assert.equal(touchCalls(w), 0, 'касание при: ' + why);
    assert.equal(w.calls.filter((c) => c.p === '/rules').length, 0, '/rules при: ' + why);
    assert.deepEqual(d.касание, { пропущено: why });
    assert.equal(state(w).журнал[0].касание, 'пропущено: ' + why);
    assert.equal(state(w).касания.пропущено, 1);
  }
  const we = world();
  we.eofWhen = () => true;
  const s = await run(we);
  assert.match(s.done.content, /КОНТРОЛЛЕР НЕ ОТВЕТИЛ/);
  assert.equal(touchCalls(we), 0, 'касание без чтения группы T');
});

test('касание — только если бюджет позволяет: медленный контроллер съел бюджет до касания — «пропущено: бюджет»', async () => {
  const w = world();
  w.step = 4400;                                   // 9 ответов контроллера — 39,6 с из 45 (запас на запрос — 6 с)
  const d = dump(await run(w, { tile: true })).ans;
  assert.equal(w.calls.filter((c) => c.p === '/rules').length, 1, '/rules не прочитан — проверка пуста');
  assert.equal(touchCalls(w), 0, 'касание за краем бюджета');
  assert.deepEqual(d.касание, { пропущено: 'бюджет' });
});

test('вердикт T: без единого касания — «T не касались — итог как у L», с пропусками — с числами; прочие группы не трогает', async () => {
  const w = world({ notice: { [P + 'T']: 0 }, back: { [P + 'T']: 0 }, rules: [R('Match', '', 'RH-Главный')] });
  await series(w, MS + 30000, 21);
  let d = dump(await run(w, { tile: true })).ans;
  assert.equal(touchCalls(w), 0);
  assert.equal(d.вывод[P + 'T'], 'T не касались — итог как у L: замечает за ≤ 1 мин');
  assert.match(d.ВЕРДИКТ, /T — T не касались — итог как у L/);
  assert.equal(d.вывод[P + 'L'], 'не заметил за окно', 'прочие группы касание не трогает');
  assert.equal(state(w).касания.пропущено, 22);
  w.rules = RULES_OK;
  w.clock.t += MIN;
  d = dump(await run(w, { tile: true })).ans;
  assert.equal(d.вывод[P + 'T'], 'замечает за ≤ 1 мин (касаний 1, обрывов 0, пропущено 22)');
  const w2 = world({ notice: { [P + 'T']: 0 } });
  await series(w2, MS + 9 * MIN + 30000, 2);
  assert.equal(dump(await run(w2, { tile: true })).ans.вывод[P + 'T'], 'замечает за ≤ 1 мин');
  // Обрыв без пропусков: оговорка с числом обрывов, а не чистый вывод.
  const w3 = world({ notice: { [P + 'T']: 0 } });
  w3.eofWhen = (m, p) => p === '/generate_204';
  await series(w3, MS + 9 * MIN + 30000, 1);
  w3.eofWhen = null;
  await series(w3, MS + 10 * MIN + 30000, 1);
  const d3 = dump(await run(w3, { tile: true })).ans;
  assert.equal(state(w3).касания.пропущено, 0);
  assert.equal(d3.вывод[P + 'T'], 'замечает за ≤ 1 мин (касаний 2, обрывов 1, пропущено 0)');
});

test('замечает и возвращается: задержка от начала окна, нижняя граница — прошлое чтение с A; вердикт по группе', async () => {
  const w = world({ notice: { [P + 'L']: 2, [P + 'N']: 0, [P + 'P']: null, [P + 'T']: 4 }, back: { [P + 'L']: 1, [P + 'N']: 0, [P + 'T']: 3 } });
  // 10 чтений в чётном окне, 10 в нечётном, 10 в следующем чётном; +30 с от начала минуты.
  const s = await series(w, MS + 30000, 30, { tile: false });
  const st = state(w);
  const tr = st.переходы.map((x) => [x.г, x.вид, x.мин, x.не_раньше_мин]);
  assert.deepEqual(tr, [
    ['N', 'ушёл', 0.5, 0], ['L', 'ушёл', 2.5, 1.5], ['T', 'ушёл', 4.5, 3.5],
    ['N', 'вернулся', 0.5, 0], ['L', 'вернулся', 1.5, 0.5], ['T', 'вернулся', 3.5, 2.5]]);
  const d = dump(s).ans;
  assert.equal(d.вывод[P + 'L'], 'замечает за ≤ 3 мин');
  assert.equal(d.вывод[P + 'N'], 'замечает за ≤ 1 мин');
  assert.equal(d.вывод[P + 'T'], 'замечает за ≤ 5 мин');
  assert.equal(d.вывод[P + 'P'], 'не заметил за окно');
  assert.equal(d.возврат[P + 'L'], 'возвращается за ≤ 2 мин');
  assert.equal(d.возврат[P + 'P'], 'нет данных');
  assert.match(d.ВЕРДИКТ, /^ST24 29 мин: L — замечает за ≤ 3 мин; N — замечает за ≤ 1 мин; P — не заметил за окно; T — замечает за ≤ 5 мин$/);
  assert.ok(w.notes.some((n) => /не заметил: P/.test(n.b)), 'нет уведомления «не заметил»');
});

test('несколько мёртвых окон: N — по худшему окну; «не заметил» хоть раз — «замечает не всегда»; P — «(2 окн.)»', async () => {
  const w = world({ notice: { [P + 'L']: 2, [P + 'N']: 0, [P + 'P']: null }, back: { [P + 'L']: 0, [P + 'N']: 0 } });
  await series(w, MS + 30000, 30);                               // окна K0, K0+1 (мёртвое), K0+2
  w.notice[P + 'L'] = 6; w.notice[P + 'N'] = null;
  await series(w, MS + 3 * WIN + 30000, 10);                     // K0+3 (мёртвое)
  w.clock.t = MS + 4 * WIN + 30000;
  const d = dump(await run(w, { tile: true })).ans;
  assert.equal(d.вывод[P + 'L'], 'замечает за ≤ 7 мин', 'вердикт не по худшему окну');
  assert.equal(d.вывод[P + 'N'], 'замечает не всегда: за ≤ 1 мин в 1 окн., не заметил в 1');
  assert.equal(d.вывод[P + 'P'], 'не заметил за окно (2 окн.)');
  assert.deepEqual(state(w).переходы.filter((x) => x.г === 'L' && x.вид === 'ушёл').map((x) => x.мин), [2.5, 6.5]);
});

test('«не заметил за окно» — только когда мёртвое окно закрыто и now = A не раньше MISS_MIN; иначе «нет данных»', async () => {
  const w = world({ notice: {} });
  await series(w, MS + 30000, 9);                  // чётное окно
  await series(w, MS + WIN + 30000, 9);            // нечётное: 0,5 … 8,5 мин — A
  let d = dump(await run(w, { tile: true })).ans;
  assert.equal(d.вывод[P + 'L'], 'нет данных', 'окно ещё открыто — рано говорить «не заметил»');
  w.clock.t = MS + 2 * WIN + 30000;
  d = dump(await run(w, { tile: true })).ans;
  assert.equal(d.вывод[P + 'L'], 'не заметил за окно');
  // Последнее чтение с A в мёртвом окне — на 5-й минуте, дальше EOF: «нет данных».
  const w2 = world({ notice: {} });
  await series(w2, MS + 30000, 3);
  await series(w2, MS + WIN + 30000, 5);
  w2.clock.t = MS + 2 * WIN + 30000;
  d = dump(await run(w2, { tile: true })).ans;
  assert.equal(d.вывод[P + 'L'], 'нет данных');
  // Не вернулся: B держится всё следующее живое окно.
  const w3 = world({ notice: { [P + 'N']: 0 }, back: { [P + 'N']: 99 } });
  await series(w3, MS + 9 * MIN + 30000, 2);
  await series(w3, MS + 2 * WIN + 30000, 9);
  w3.clock.t = MS + 3 * WIN + 30000;
  d = dump(await run(w3, { tile: true })).ans;
  assert.equal(d.вывод[P + 'N'], 'замечает за ≤ 1 мин');
  assert.equal(d.возврат[P + 'N'], 'не вернулся за окно');
});

test('возврат: без опоры (прошлое B — два окна назад) — не «вернулся»; короткие данные в живом окне — не «не вернулся»', async () => {
  // Уход в K0+1 засчитан, затем EOF-пропуск двух окон; первое чтение K0+4 (живое) — A.
  const w = world({ notice: { [P + 'L']: 0 }, back: { [P + 'L']: 0 } });
  await series(w, MS + 9 * MIN + 30000, 2);                     // K0 — A, K0+1 — B
  w.clock.t = MS + 4 * WIN + 30000;
  let d = dump(await run(w, { tile: true })).ans;
  assert.deepEqual(state(w).переходы.map((x) => [x.г, x.вид]), [['L', 'ушёл']], 'возврат засчитан без опоры');
  assert.equal(d.возврат[P + 'L'], 'нет данных');
  // Живое окно после мёртвого: B только до 4,5-й минуты, дальше EOF, окно закрыто.
  const w2 = world({ notice: { [P + 'N']: 0 }, back: { [P + 'N']: 99 } });
  await series(w2, MS + 9 * MIN + 30000, 2);                    // K0 — A, K0+1 — B
  await series(w2, MS + 2 * WIN + 30000, 5);                    // K0+2 — B, 0,5…4,5 мин
  w2.clock.t = MS + 3 * WIN + 30000;
  d = dump(await run(w2, { tile: true })).ans;
  assert.equal(d.возврат[P + 'N'], 'нет данных', 'короткие данные прочитаны как «не вернулся»');
  // Для сравнения: B и на 8,5-й минуте — «не вернулся за окно».
  const w3 = world({ notice: { [P + 'N']: 0 }, back: { [P + 'N']: 99 } });
  await series(w3, MS + 9 * MIN + 30000, 2);
  await series(w3, MS + 2 * WIN + 8 * MIN + 30000, 1);
  w3.clock.t = MS + 3 * WIN + 30000;
  assert.equal(dump(await run(w3, { tile: true })).ans.возврат[P + 'N'], 'не вернулся за окно');
});

test('нет данных ≠ замечает: нет now, now не A/B, B без опоры (первое чтение, пропуск окна) — не переход', async () => {
  // Нет now у групп — «нет данных», переходов нет, хотя по модели A «мёртв».
  const w = world({ notice: { [P + 'L']: 0 }, opts: { entry: (n, x) => ({ name: n, type: x.type, all: x.all }) } });
  await series(w, MS + 9 * MIN, 3);
  let d = dump(await run(w, { tile: true })).ans;
  assert.equal(state(w).переходы.length, 0);
  assert.equal(d.вывод[P + 'L'], 'нет данных');
  assert.equal(d.сейчас[P + 'L'].now, 'нет данных');
  // now — посторонний узел.
  const w1 = world();
  w1.stuck = { [P + 'L']: 'DIRECT' };
  await series(w1, MS + 9 * MIN, 3);
  assert.equal(state(w1).переходы.length, 0);
  assert.equal(state(w1).журнал[0].L.по_now, 'нет данных');
  // Первое чтение пробы — уже в мёртвом окне и уже на B: опоры нет.
  const w2 = world({ notice: { [P + 'L']: 0 } });
  await series(w2, MS + WIN + 30000, 3);
  d = dump(await run(w2, { tile: true })).ans;
  assert.equal(state(w2).переходы.length, 0);
  assert.equal(d.вывод[P + 'L'], 'нет данных');
  assert.equal(state(w2).окна[P + 'L'][0].без_опоры, true);
  // Прошлое чтение с A — два окна назад (EOF-пропуск): тоже не опора.
  const w4 = world({ notice: { [P + 'L']: 0 } });
  w4.clock.t = MS - 2 * WIN + 5 * MIN; await run(w4);      // чётное окно, now = A
  w4.clock.t = MS + WIN + 30000; await run(w4);            // через окно: B
  assert.equal(state(w4).переходы.length, 0, 'опора из окна k-2 засчитана');
  assert.equal(dump(await run(w4, { tile: true })).ans.вывод[P + 'L'], 'нет данных');
});

test('узлы глазами ядра: alive и время последней проверки из history поставщика; нет поля — «нет данных»', async () => {
  const w = world();
  const pv = w.providers['rh-t24l'].proxies;
  pv[0].alive = false; pv[0].history = [{ time: '2026-09-27T10:00:00Z', delay: 0 }, { time: '2026-09-27T10:01:00Z', delay: 0 }];
  pv[1].alive = 'true';
  const d = dump(await run(w, { tile: true })).ans;
  const cur = d.сейчас[P + 'L'];
  assert.deepEqual(cur.A, { alive: false, проверка: '2026-09-27T10:01:00Z', delay: 0 });
  assert.deepEqual(cur.B, { alive: 'нет данных', проверка: 'нет данных', delay: null }, 'не логическое alive принято');
  const e = state(w).журнал[0];
  assert.equal(e.ждём, 'A жив');
  assert.deepEqual([e.L.aA, e.L.пA, e.L.aB], [false, '2026-09-27T10:01:00Z', 'нет данных']);
  w.clock.t = MS + WIN + 1000;
  await run(w);
  assert.equal(state(w).журнал[1].ждём, 'A мёртв');
});

test('EOF-окно в фоне: прогоны без ответа журнал не трогают; окно отмечено по следующему удачному чтению', async () => {
  const w = world();
  w.clock.t = MS + 30000;
  await run(w);
  const runs = state(w).прогонов;
  for (let i = 0; i < 10; i++) {
    w.clock.t += MIN;
    w.eofWhen = () => true;
    const s = await run(w);
    assert.match(s.done.content, /КОНТРОЛЛЕР НЕ ОТВЕТИЛ/);
  }
  assert.equal(state(w).прогонов, runs);
  w.eofWhen = null;
  w.clock.t += MIN;
  await run(w);
  const win = state(w).журнал.find((e) => e.вид === 'окно');
  assert.ok(win && win.прогонов === 10);
});

test('нет групп Т24: вердикт «override не обновлён», журнал не тронут; уведомление раз в 6 ч', async () => {
  const w = world({ noGroups: true, noProv: true });
  const s = await run(w);
  assert.match(s.done.content, /НЕТ ГРУПП Т24/);
  assert.equal(w.store.RH_ST24, undefined);
  assert.match(s.note.b, /нет групп Т24/);
  w.clock.t += 30 * MIN;
  assert.equal((await run(w)).note, null);
  const w2 = world({ noProv: true });
  const d = dump(await run(w2, { tile: true })).ans;
  assert.ok(d.нет.indexOf('поставщик rh-t24l') >= 0);
  assert.deepEqual(d.сейчас[P + 'L'].A, { alive: 'нет данных', проверка: 'нет данных' });
});

test('выгрузка — одна строка [ST24]; секрета и адреса контроллера нет; cron без событий молчит', async () => {
  const w = world();
  w.clock.t = MS + 30000;
  const s = await run(w, { tile: true });
  assert.match(s.note.b, /журнал скрипта, строка \[ST24\]/);
  const line = s.logs.find((x) => x.indexOf('[ST24] ') === 0);
  assert.equal(line.indexOf('\n'), -1);
  for (const x of [line, s.note.b, s.done.content]) assert.ok(x.indexOf('ОЧЕНЬ-СЕКРЕТНО') < 0 && x.indexOf('127.0.0.1') < 0);
  w.clock.t += MIN;
  assert.equal((await run(w)).note, null);
});

test('замок, сторож, EOF с повтором: один $done, журнал целый', async () => {
  const w = world();
  w.store.RH_ST24_lock = String(w.clock.t - 1000) + ':1';
  const s = await run(w, { tile: true });
  assert.match(s.done.content, /^ЗАНЯТО: .* через 309 с/);
  assert.equal(w.calls.length, 0);
  const wh = world();
  wh.hang = true;
  const sh = await run(wh, { grace: 300, fastGuard: true });
  assert.match(sh.done.content, /КОНТРОЛЛЕР НЕ ОТВЕТИЛ \(сторож\)/);
  assert.equal(wh.store.RH_ST24, undefined);
  assert.equal(wh.store.RH_ST24_lock, '');
  const we = world();
  let n = 0;
  we.eofWhen = (m, p) => p.indexOf('/proxies/') === 0 && n++ === 0;
  await run(we);
  const ctrl = we.calls.filter((c) => c.url !== TOUCH);
  assert.equal(ctrl[1].p, ctrl[0].p, 'нет повтора после EOF');
  assert.equal(state(we).прогонов, 1);
});

// ── СТОРОЖ И CRON (дефект ST14) ──
const numOf = (k) => Number(CODE.match(new RegExp('var ' + k + ' = (\\d+)'))[1]);

test('сторож позже худшего честного пути с повтором и растяжением фона (ST14); окно — как у стенда', () => {
  const worst = numOf('BUDGET_MS') + 2 * numOf('CTRL_SEC') * 1000 + 4 * 1000;
  assert.ok(numOf('GUARD_MS') > worst, 'сторож ' + numOf('GUARD_MS') + ' мс не позже худшего пути ' + worst + ' мс');
  assert.equal(numOf('CTRL_SEC'), 5, 'timeout Stash — секунды');
  assert.equal(numOf('WIN_MS'), L.T24_WINDOW_MS, 'окно пробы разошлось с окном стенда');
  assert.ok(numOf('MISS_MIN') >= 5 && numOf('MISS_MIN') < 10);
  assert.ok(CODE.indexOf("var TOUCH_URL = '" + TOUCH + "'") >= 0, 'адрес касания разошёлся с тестом');
});

test('timeout задания cron в Lab не меньше сторожа и бюджета пробы; замок дольше cron', () => {
  const ov = fs.readFileSync(path.join(ROOT, 'plugins/RouteHub-Stash-Lab.stoverride'), 'utf8');
  const to = Number(/\n {6}timeout:\s*(\d+)/.exec(ov)[1]) * 1000;
  assert.ok(to >= numOf('GUARD_MS'));
  assert.ok(to >= numOf('BUDGET_MS'));
  assert.ok(numOf('LOCK_MS') > to);
});
