// Поведение пробы ST25 (ревизия ST24 под живой опыт) в песочнице с
// подставным контроллером tests/fake-stash.js (+ fake-stash-use.js).
//
// ЗАЧЕМ. ST25 добавляет к ST24 то, что нужно для опыта с Дианой в чате:
// короткий отчёт на стенд после каждого прогона, стоп-флаг и автостоп с
// холостым режимом, вердикт без переходов, сделанных плиткой. Тест сторожит:
// - правило 1: отчёт уходит только после сверки /rules (DOMAIN стенда →
//   DIRECT раньше любого не-DOMAIN и любого другого правила хоста), без
//   ключа контроллера, один POST без повтора; наружу — только касание и отчёт;
// - указатель «отправлено до seq» сдвигается только после 200;
// - stop от стенда, срок 6 ч, «данных достаточно» → холостой режим: ни
//   одного запроса, ровно один $done, плитка показывает итог;
// - переход по плитке (сам, опора или плитка между ними) — не фоновый;
//   «замечает» — только при ≥ 2 окнах; «застрял на B» — исход окна;
// - размер: строка журнала на cron ≤ 2 КБ при худшем хвосте, тело отчёта ≤ 2 КБ;
// - хранилище ST25 не смешивается с ST24 (ключи RH_ST25*).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createStash, sandbox, settle, SECRET } from './fake-stash.js';
import { T } from './harness.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = 'probes/routehub-probe-stash25.js';
const CODE = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
const BARE = CODE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const L = T.STASH_LAB24;
const P = 'RH-Т24-', MIN = 60000, WIN = 600000, HOUR = 3600000;
const IDS = ['L', 'N', 'P', 'T'];
const GR = IDS.map((x) => P + x);
const MS = 1_800_000_000_000;        // начало чётного окна 3 000 000
const TOUCH_HOST = 'connectivitycheck.android.com';
const TOUCH = 'https://' + TOUCH_HOST + '/generate_204';
const STAND_HOST = new URL(L.T24_STAND).hostname;
const REPORT = L.T24_STAND + L.T24_REPORT_PATH;
const R = (type, payload, proxy) => ({ type, payload, proxy, size: -1 });
// /rules так, как его отдаёт ядро: правила override Lab первыми (стенд, касание), дальше боевые.
const STAND_RULE = R('Domain', STAND_HOST, 'DIRECT');
const TOUCH_RULE = R('Domain', TOUCH_HOST, 'RH-Т24-T');
const RULES_OK = [STAND_RULE, TOUCH_RULE, R('DomainSuffix', 'samokat.ru', 'DIRECT'), R('IPCIDR', '17.0.0.0/8', 'RH-RU'),
  R('DomainSuffix', 'chatgpt.com', 'RH-AI'), R('RuleSet', 'rh-ads', 'REJECT'), R('GeoIP', 'RU', 'RH-RU'), R('Match', '', 'RH-Главный')];
const K0 = MS / WIN;
const utf8 = (s) => Buffer.byteLength(s, 'utf8');

// Модель ядра — как в тесте ST24: A группы g «мёртв» в нечётном окне с
// минуты notice[g] (null — никогда), в следующем чётном — до минуты back[g].
// stuck[g] — now группы держится как задано. Стенд отчёта: w.reports,
// ответ — reportStatus (200) и stop.
function world(o = {}) {
  const g = { 'RH-RU': { type: 'Fallback', now: 'DIRECT', all: ['DIRECT', 'RH-Обход'] },
    [P + 'К']: { type: 'URLTest', now: P + 'Пульс', all: [P + 'Пульс'] } };
  const providers = {};
  for (const x of IDS) {
    if (!o.noGroups) g[P + x] = { type: 'Fallback', use: ['rh-t24' + x.toLowerCase()] };
    if (!o.noProv) providers['rh-t24' + x.toLowerCase()] = { proxies: L.t24Nodes(x.toLowerCase()).map((n) => ({ name: n.name, type: 'Direct' })) };
  }
  if (o.noGroups) delete g[P + 'К'];
  const touches = [], reports = [];
  const w = createStash({ groups: g, providers,
    route: (method, p, opt, reply, ww) => {
      ww.hdrs.push({ url: opt.url, method, headers: { ...(opt.headers || {}) } });
      if (opt.url === TOUCH) {
        touches.push({ method, headers: { ...(opt.headers || {}) }, timeout: opt.timeout, after: ww.calls.length - 1 });
        reply(ww.touchStatus || 204, '');
        return true;
      }
      if (p === '/configs') {
        if (ww.configsStatus) { reply(ww.configsStatus, '{"message":"x"}'); return true; }
        reply(200, ww.configsBody !== undefined ? ww.configsBody : JSON.stringify({ port: 7890, mode: ww.mode || 'rule', 'log-level': 'info' }));
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
  // Стенд отчёта — до модели контроллера: обрыв (reportEof) и зависание
  // (reportHang) отдаются колбэком $httpClient, как на устройстве.
  const h = w.handle;
  w.handle = (method, opt, cb) => {
    if (opt.url !== REPORT) return h(method, opt, cb);
    w.calls.push({ method, url: opt.url, p: L.T24_REPORT_PATH, t: w.clock.t });
    reports.push({ method, headers: { ...(opt.headers || {}) }, timeout: opt.timeout, body: opt.body, at: w.calls.length - 1, t: w.clock.t });
    if (w.reportHang) return undefined;
    const b = w.reportBody !== undefined ? w.reportBody : JSON.stringify({ ok: 1, stop: !!w.stop });
    return setTimeout(() => {
      w.clock.t += w.step;
      if (w.reportEof) cb('Post "' + opt.url + '": EOF', null, null);
      else cb(null, { status: w.reportStatus || 200, headers: {} }, b);
    }, 1);
  };
  w.notice = o.notice || {};
  w.back = o.back || {};
  w.touches = touches;
  w.reports = reports;
  w.hdrs = [];
  w.rules = o.rules || RULES_OK;
  return w;
}
// Время песочницы сжато (как в тесте ST24): сторож ждёт 4 с реального времени.
const slowGuard = (ms) => ((ms || 0) >= 60000 ? 4000 : Math.max(1, Math.round((ms || 0) / 1000)));
async function run(w, o = {}) {
  const s = sandbox(w, CODE, FILE, { forbid: ['patch'], extra: o.tile ? { $script: { type: 'tile' } } : {},
    ...(o.fastGuard ? {} : { timer: slowGuard }), ...(o.sb || {}) });
  await settle(s, 5000, o.grace === undefined ? 20 : o.grace);
  return s;
}
const state = (w) => JSON.parse(w.store.RH_ST25);
const line = (s) => { const l = s.logs.find((x) => x.indexOf('[ST25] ') === 0); assert.ok(l, 'нет строки [ST25]'); return l; };
const dump = (s) => JSON.parse(line(s).slice(7));
const body = (w, i) => JSON.parse(w.reports[i === undefined ? w.reports.length - 1 : i].body);
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
const ctrlCalls = (w) => w.calls.filter((c) => c.url !== TOUCH && c.url !== REPORT);

// ── ЗАПРОСЫ И ПРАВИЛО 1 ────────────────────────────────────────────────
test('запросы: GET 5 групп, 4 поставщиков, /rules; касание; один POST отчёта на стенд — без ключа, timeout в секундах', async () => {
  const w = world();
  await run(w);
  const ctrl = ctrlCalls(w);
  const allowed = new Set(GR.concat([P + 'К']).map((g) => '/proxies/' + encodeURIComponent(g))
    .concat(IDS.map((x) => '/providers/proxies/rh-t24' + x.toLowerCase()), ['/rules', '/configs']));
  assert.equal(ctrl.length, 11);
  for (const c of ctrl) {
    assert.equal(c.method, 'get');
    assert.equal(c.timeout, 5, 'timeout у Stash в секундах: ' + c.timeout);
    assert.equal(c.auth, SECRET);
    assert.ok(c.url.indexOf('http://127.0.0.1:9090/') === 0 && allowed.has(c.p), 'путь ' + c.url);
  }
  assert.equal(new Set(ctrl.map((c) => c.p)).size, 11);
  assert.equal(touchCalls(w), 1);
  assert.equal(w.reports.length, 1);
  const r = w.reports[0];
  assert.equal(r.method, 'post');
  assert.equal(r.timeout, 5, 'timeout отчёта у Stash в секундах');
  assert.deepEqual(r.headers, { 'Content-Type': 'application/json' }, 'у отчёта лишние заголовки (ключ контроллера?)');
  assert.ok(r.at > w.calls.findIndex((c) => c.p === '/rules'), 'отчёт раньше сверки /rules');
  assert.deepEqual(w.writes().filter((c) => c.url !== REPORT), [], 'запись в контроллер');
  for (const x of ['$httpClient.put', '$httpClient.delete', '$httpClient.patch', '/delay', 'setSelectPolicy', 'setRunningModel', "'PUT'", "'POST'",
    'X-Stash-Selected-Proxy', 'Selected-Proxy']) {
    assert.ok(BARE.indexOf(x) < 0, 'в пробе ' + x);
  }
  const used = [...BARE.matchAll(/\$httpClient\s*(?:\.\s*(\w+)|\[)/g)].map((m) => m[1] || '[');
  assert.deepEqual([...new Set(used)].sort(), ['get', 'post'], 'у $httpClient не только get/post: ' + used.join(','));
  assert.equal(used.filter((m) => m === 'post').length, 1, 'post — не в одном месте');
  const fn = BARE.indexOf('function sendReport('), at = BARE.indexOf('$httpClient.post');
  assert.ok(fn >= 0 && at > fn && BARE.indexOf('if (REPORT_GATE) return', fn) < at, 'post вне sendReport или до проверки REPORT_GATE');
  assert.ok(BARE.indexOf('\nfunction ', fn + 1) > at, 'post не в теле sendReport');
});

test('внешние адреса пробы — только контроллер, хост касания и отчёт стенда; хосты = правила override Lab (стенд — первым, DIRECT)', async () => {
  const code = CODE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const lits = [...code.matchAll(/'(https?:\/\/[^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(lits.sort(), ['http://127.0.0.1:9090', TOUCH, REPORT].sort(), 'адреса в пробе: ' + lits.join(', '));
  assert.ok(CODE.indexOf("var STAND_HOST = '" + STAND_HOST + "'") >= 0);
  const ov = fs.readFileSync(path.join(ROOT, 'plugins/RouteHub-Stash-Lab.stoverride'), 'utf8');
  assert.ok(ov.indexOf('\nrules:\n  - DOMAIN,' + STAND_HOST + ',DIRECT\n  - DOMAIN,' + TOUCH_HOST + ',RH-Т24-T\n') > 0, 'правила override: стенд DIRECT первым, затем касание');
  const w = world();
  await series(w, MS + 30000, 2);
  for (const c of w.calls) {
    const h = new URL(c.url).hostname;
    assert.ok(h === '127.0.0.1' || h === TOUCH_HOST || c.url === REPORT, 'запрос на посторонний адрес: ' + c.url);
  }
  assert.ok(w.bypass.length === 0);
});

// ⛔ Правило 1: без подтверждённого DIRECT для стенда — ни одного POST.
test('сверка /rules для отчёта: правило стенда после RULE-SET / MATCH / SUFFIX, нет правила, не DIRECT — отчёта нет, причина в журнале', async () => {
  const cases = [
    ['правило стенда стоит после RULESET', [R('RuleSet', 'rh-ads', 'REJECT'), STAND_RULE, TOUCH_RULE]],
    ['правило стенда стоит после MATCH', [TOUCH_RULE, R('Match', '', 'RH-Главный'), STAND_RULE]],
    ['правило стенда стоит после DOMAINSUFFIX', [R('DomainSuffix', 'workers.dev', 'RH-Главный'), STAND_RULE, TOUCH_RULE]],
    ['нет правила стенда в /rules', [TOUCH_RULE, R('Match', '', 'RH-Главный')]],
    ['нет правила стенда в /rules', [TOUCH_RULE]],
    ['правило хоста стенда ведёт в RH-Главный', [R('Domain', STAND_HOST, 'RH-Главный'), STAND_RULE, TOUCH_RULE]],
    ['правило хоста стенда ведёт в RH-Т24-T', [R('DOMAIN', STAND_HOST.toUpperCase(), 'RH-Т24-T'), TOUCH_RULE]],
    ['нет правила стенда в /rules', [R('Domain', 'proton4iker.workers.dev', 'DIRECT'), TOUCH_RULE, R('Match', '', 'X')]],
  ];
  for (const [why, rules] of cases) {
    const w = world({ rules });
    const s = await run(w, { tile: true });
    assert.equal(w.reports.length, 0, 'отчёт при: ' + why);
    const d = dump(s).ans;
    assert.deepEqual(d.отчёт, { пропущено: why });
    assert.equal(d.правило_стенда, why);
    assert.equal(state(w).журнал[0].отчёт, 'пропущено: ' + why);
    assert.equal(state(w).отпр, 0);
  }
  for (const rules of [[R('Domain', 'a.example', 'DIRECT'), R('DOMAIN', STAND_HOST, 'DIRECT'), TOUCH_RULE, R('Match', '', 'X')],
    [TOUCH_RULE, STAND_RULE], [R('domain', STAND_HOST, 'DIRECT')]]) {
    const w = world({ rules });
    await run(w);
    assert.equal(w.reports.length, 1, JSON.stringify(rules));
  }
});

test('/rules не прочитан или не разобран — ни отчёта, ни касания (никогда «на всякий случай»); одиночный EOF /rules — повтор', async () => {
  const bad = ['не json', '[]', '{}', JSON.stringify({ rules: [] }), JSON.stringify({ rules: [STAND_RULE, null] }),
    JSON.stringify({ rules: [{ type: 'Domain', proxy: 'DIRECT' }, STAND_RULE] }), JSON.stringify({ rules: ['DOMAIN,' + STAND_HOST + ',DIRECT'] }),
    JSON.stringify({ rules: [STAND_RULE, TOUCH_RULE, { payload: 'x', proxy: 'y' }] })];
  for (const b of bad) {
    const w = world();
    w.rulesBody = b;
    const d = dump(await run(w, { tile: true })).ans;
    assert.equal(w.reports.length, 0, 'отчёт при /rules: ' + b);
    assert.equal(touchCalls(w), 0, 'касание при /rules: ' + b);
    assert.deepEqual(d.отчёт, { пропущено: 'нет данных: формат /rules не разобран' }, b);
  }
  for (const set of [(w) => { w.rulesStatus = 500; }, (w) => { w.eofWhen = (m, p) => p === '/rules'; }]) {
    const w = world();
    set(w);
    const d = dump(await run(w, { tile: true })).ans;
    assert.equal(w.reports.length, 0);
    assert.deepEqual(d.отчёт, { пропущено: 'нет данных: /rules не прочитан' });
  }
  const w1 = world();
  let once = 0;
  w1.eofWhen = (m, p) => p === '/rules' && once++ === 0;
  await run(w1);
  assert.equal(w1.calls.filter((c) => c.p === '/rules').length, 2);
  assert.equal(w1.reports.length, 1);
});

test('касание T: сверка /rules та же (ruleGate), правило касания после стенда разрешено; группа T не TA/TB — касания нет, отчёт есть', async () => {
  const touchCases = [
    ['правило касания стоит после RULESET', [STAND_RULE, R('RuleSet', 'rh-ads', 'REJECT'), TOUCH_RULE]],
    ['нет правила касания в /rules', [STAND_RULE, R('Match', '', 'X')]],
    ['правило хоста касания ведёт в DIRECT', [STAND_RULE, R('Domain', TOUCH_HOST, 'DIRECT'), TOUCH_RULE]],
  ];
  for (const [why, rules] of touchCases) {
    const w = world({ rules });
    const d = dump(await run(w, { tile: true })).ans;
    assert.equal(touchCalls(w), 0, why);
    assert.deepEqual(d.касание, { пропущено: why });
    assert.equal(w.reports.length, 1, 'отчёт не зависит от касания');
    assert.match(body(w).r, new RegExp('кас:-' + why.slice(0, 28).replace(/[()]/g, '.')));
  }
  for (const [why, set] of [['нет группы T', (w) => { delete w.g[P + 'T']; }], ['now T не TA/TB: DIRECT', (w) => { w.stuck = { [P + 'T']: 'DIRECT' }; }],
    ['группа T не прочитана', (w) => { w.fail = (m, p) => p === '/proxies/' + P + 'T'; }]]) {
    const w = world();
    set(w);
    const d = dump(await run(w, { tile: true })).ans;
    assert.equal(touchCalls(w), 0, why);
    assert.deepEqual(d.касание, { пропущено: why });
    assert.equal(w.reports.length, 1);
  }
  const w = world();
  const s = await run(w, { tile: true });
  const t = w.touches[0];
  assert.deepEqual([t.method, t.timeout, t.headers], ['get', 5, {}]);
  assert.equal(dump(s).ans.правило_касания, 'первое: DOMAIN,' + TOUCH_HOST + ',RH-Т24-T');
  assert.equal(dump(s).ans.правило_стенда, 'первое: DOMAIN,' + STAND_HOST + ',DIRECT');
});

test('бюджет: медленный контроллер — ни касания, ни отчёта за краем бюджета; контроллер молчит — ни /rules, ни отчёта', async () => {
  const w = world();
  w.step = 3700;                                   // 9 чтений, /rules и /configs — 40,7 с из 45: на касание и отчёт места нет
  const d = dump(await run(w, { tile: true })).ans;
  assert.equal(w.calls.filter((c) => c.p === '/rules').length, 1);
  assert.equal(w.calls.filter((c) => c.p === '/configs').length, 1);
  assert.equal(d.режим, 'rule');
  assert.equal(touchCalls(w), 0, 'касание за краем бюджета');
  assert.deepEqual(d.касание, { пропущено: 'бюджет' });
  assert.equal(w.reports.length, 0);
  assert.deepEqual(d.отчёт, { пропущено: 'бюджет' });
  const we = world();
  we.eofWhen = () => true;
  const s = await run(we);
  assert.match(s.done.content, /КОНТРОЛЛЕР НЕ ОТВЕТИЛ/);
  assert.equal(we.calls.filter((c) => c.p === '/rules' || c.url === REPORT || c.url === TOUCH).length, 0);
});

// ⛔ Правило 1 (ревью ST25): в режиме global / direct правила не действуют —
// отчёт и касание ушли бы мимо правил override (global — через селектор GLOBAL).
test('режим ядра (GET /configs): только rule — отчёт и касание; global / direct / нет ответа / мусор — оба пропущены с причиной', async () => {
  for (const m of ['rule', 'Rule', 'RULE']) {
    const w = world();
    w.mode = m;
    const d = dump(await run(w, { tile: true })).ans;
    assert.equal(w.reports.length, 1, m);
    assert.equal(touchCalls(w), 1, m);
    assert.equal(d.режим, 'rule');
    const iC = w.calls.findIndex((c) => c.p === '/configs');
    assert.ok(iC >= 0 && w.reports[0].at > iC && w.touches[0].after > iC, 'отправка раньше сверки режима');
    assert.equal(w.calls[iC].method, 'get');
    assert.equal(w.calls[iC].timeout, 5);
  }
  const cases = [
    ['режим global — правила не действуют', (w) => { w.mode = 'global'; }],
    ['режим global — правила не действуют', (w) => { w.mode = 'Global'; }],
    ['режим direct — правила не действуют', (w) => { w.mode = 'direct'; }],
    ['режим script — правила не действуют', (w) => { w.mode = 'script'; }],
    ['режим: нет данных — /configs не прочитан', (w) => { w.configsStatus = 404; }],
    ['режим: нет данных — /configs не прочитан', (w) => { w.configsStatus = 500; }],
    ['режим: нет данных — /configs не прочитан', (w) => { w.eofWhen = (m, p) => p === '/configs'; }],
    ...['не json', 'null', '[]', '{}', '{"mode":""}', '{"mode":5}', '{"Mode":"rule"}', '"rule"']
      .map((b) => ['режим: нет данных — формат /configs не разобран', (w) => { w.configsBody = b; }]),
  ];
  for (const [why, set] of cases) {
    const w = world();
    set(w);
    const s = await run(w, { tile: true });
    const d = dump(s).ans;
    assert.equal(w.reports.length, 0, 'отчёт при: ' + why);
    assert.equal(touchCalls(w), 0, 'касание при: ' + why);
    assert.equal(d.режим, why);
    assert.deepEqual(d.отчёт, { пропущено: why });
    assert.deepEqual(d.касание, { пропущено: why });
    assert.equal(state(w).журнал[0].отчёт, 'пропущено: ' + why);
    assert.equal(state(w).касания.пропущено, 1);
  }
  // Одиночный обрыв /configs — повтор, как у прочих чтений.
  const w1 = world();
  let once = 0;
  w1.eofWhen = (m, p) => p === '/configs' && once++ === 0;
  await run(w1);
  assert.equal(w1.calls.filter((c) => c.p === '/configs').length, 2);
  assert.equal(w1.reports.length, 1);
  // Бюджета на /configs нет — «нет данных», не «rule».
  const wb = world();
  wb.step = 3900;                                  // 9 чтений и /rules — 39 с: /configs не начат
  const db = dump(await run(wb, { tile: true })).ans;
  assert.equal(wb.calls.filter((c) => c.p === '/configs').length, 0);
  assert.equal(db.режим, 'режим: нет данных — бюджет');
  assert.equal(wb.reports.length + touchCalls(wb), 0);
});

// ── ОТЧЁТ: СОДЕРЖАНИЕ И УКАЗАТЕЛЬ ──────────────────────────────────────
test('тело отчёта: rev, seq, строка чтения (время, окно, now L/N/P/T/К, alive A, тип, касание), только новые переходы', async () => {
  const w = world({ notice: { [P + 'N']: 0 }, back: { [P + 'N']: 0 } });
  w.providers['rh-t24l'].proxies[0].alive = false;
  w.providers['rh-t24n'].proxies[0].alive = true;
  w.clock.t = MS + 9 * MIN + 30000;
  await run(w);
  let b = body(w);
  assert.deepEqual(Object.keys(b).sort(), ['r', 'rev', 'seq', 'tr']);
  assert.equal(b.rev, 'ST25');
  assert.equal(b.seq, 1);
  assert.equal(b.r, '08:09:30 w' + K0 + ' 9.5м cron L:A N:A P:A T:A К:Пульс aA:01?? кас:204');
  assert.deepEqual(b.tr, []);
  w.clock.t = MS + WIN + 30000;
  await run(w, { opts: {} });
  b = body(w);
  assert.equal(b.seq, 2);
  assert.equal(b.r, '08:10:30 w' + (K0 + 1) + '† 0.5м cron L:A N:B P:A T:A К:Пульс aA:01?? кас:204');
  assert.deepEqual(b.tr, ['N ушёл 0.5м (≥0) фон #2']);
  w.clock.t += MIN;
  await run(w);
  assert.deepEqual(body(w).tr, [], 'отправленный переход повторён');
  // Плитка: тип в строке.
  w.clock.t += MIN;
  await run(w, { tile: true });
  assert.match(body(w).r, / плитка L:/);
  // Нет группы К — «-», группа К не прочитана — «?».
  delete w.g[P + 'К'];
  w.clock.t += MIN;
  await run(w);
  assert.match(body(w).r, / К:- /);
  for (const b2 of w.reports.map((r) => r.body)) assert.ok(b2.indexOf('ОЧЕНЬ-СЕКРЕТНО') < 0 && b2.indexOf('127.0.0.1') < 0);
});

test('указатель «отправлено до seq» — только после 200; ошибка и обрыв — без повтора, переходы уходят следующим отчётом', async () => {
  const w = world({ notice: { [P + 'N']: 0, [P + 'T']: 0 } });
  w.clock.t = MS + 9 * MIN + 30000;
  await run(w);
  assert.equal(state(w).отпр, 1);
  w.reportStatus = 500;
  w.clock.t = MS + WIN + 30000;
  let d = dump(await run(w)).ans;
  assert.equal(w.reports.length, 2, 'повтор отчёта при ошибке');
  assert.equal(d.отчёт.код, 500);
  assert.equal(state(w).отпр, 1, 'указатель сдвинут без 200');
  assert.equal(state(w).журнал[1].отчёт, 'код 500');
  w.reportStatus = 0; w.reportEof = true;
  w.clock.t += MIN;
  d = dump(await run(w)).ans;
  assert.equal(w.reports.length, 3, 'повтор отчёта при обрыве');
  assert.equal(d.отчёт.код, null);
  assert.equal(state(w).отпр, 1);
  assert.equal(state(w).журнал[2].отчёт, 'обрыв');
  w.reportEof = false;
  w.clock.t += MIN;
  await run(w);
  assert.deepEqual(body(w).tr, ['N ушёл 0.5м (≥0) фон #2', 'T ушёл 0.5м (≥0) фон #2'], 'неотправленные переходы потеряны');
  assert.equal(state(w).отпр, 4);
  assert.deepEqual(state(w).отчёты, { ok: 2, нет: 2, пропущено: 0 });
  w.clock.t += MIN;
  await run(w);
  assert.deepEqual(body(w).tr, []);
});

test('отчёт ≤ 2 КБ при любом хвосте: лишние старые переходы — счётчиком «пр», итог обрезан', async () => {
  const w = world({ notice: {} });
  w.clock.t = MS + 30000;
  await run(w);
  const s = state(w);
  for (let i = 0; i < 60; i++) s.переходы.push({ seq: 2, г: 'T', вид: i % 2 ? 'ушёл' : 'вернулся', окно: K0 + i, t: 'x', мин: 9.9, не_раньше_мин: 9.8, фон: false });
  w.store.RH_ST25 = JSON.stringify(s);
  w.rules = [STAND_RULE, R('Match', '', 'X')];                 // касание пропущено — длинная причина в строке
  w.clock.t += MIN;
  await run(w);
  const b = body(w);
  assert.ok(utf8(w.reports[w.reports.length - 1].body) <= 2048);
  assert.equal(b.tr.length, 8);
  assert.equal(b.пр, 52);
  assert.ok(b.tr.every((x) => utf8(x) <= 80));
  // Итог при стопе (срок) с худшими вердиктами — тоже ≤ 2 КБ.
  const s2 = state(w);
  s2.t0 = w.clock.t - 7 * HOUR;
  for (let i = 0; i < 60; i++) s2.переходы.push({ seq: 99, г: 'T', вид: 'ушёл', окно: K0, t: 'x', мин: 9.9, не_раньше_мин: 9.8, фон: true });
  w.store.RH_ST25 = JSON.stringify(s2);
  w.clock.t += MIN;
  await run(w);
  const last = w.reports[w.reports.length - 1].body;
  assert.ok(utf8(last) <= L.T24_REPORT_MAX, 'тело ' + utf8(last) + ' байт');
  assert.equal(JSON.parse(last).стоп, 'срок 6 ч');
});

// ── СТОП И ХОЛОСТОЙ РЕЖИМ ──────────────────────────────────────────────
test('stop:true от стенда → итог в хранилище и холостой режим: ни запроса, один $done, плитка показывает итог', async () => {
  const w = world({ notice: { [P + 'N']: 0 } });
  await series(w, MS + 8 * MIN + 30000, 3);
  w.stop = true;
  w.clock.t += MIN;
  const s = await run(w);
  const st = state(w);
  assert.equal(st.стоп.почему, 'стоп от стенда');
  assert.match(st.итог, /^ST25 .* мин: L — .*; N — .*возврат: L — /);
  assert.match(s.done.content, /^ST25 ОСТАНОВЛЕН: стоп от стенда/);
  assert.ok(s.note && /стоп: стоп от стенда/.test(s.note.b), 'нет уведомления о стопе');
  const calls = w.calls.length, reps = w.reports.length;
  w.stop = false;
  for (let i = 0; i < 3; i++) {
    w.clock.t += MIN;
    const si = await run(w);
    assert.equal(w.calls.length, calls, 'в холостом режиме есть запросы');
    assert.equal(si.logs.length, 0, 'cron в холостом режиме пишет журнал');
    assert.equal(si.note, null);
    assert.match(si.done.content, /^ST25 остановлен: стоп от стенда/);
  }
  const t = await run(w, { tile: true });
  assert.equal(w.calls.length, calls);
  assert.equal(w.reports.length, reps);
  assert.ok(t.done.content.indexOf(st.итог) > 0, 'плитка не показывает итог');
  const d = dump(t);
  assert.equal(d.холостой, true);
  assert.equal(d.итог, st.итог);
  assert.ok(d.журнал.length > 0 && d.окна[P + 'N'].length > 0, 'плитка в холостом режиме не выгружает журнал');
  assert.equal(w.store.RH_ST25_lock || '', '', 'холостой режим трогал замок');
  // Ответ без stop или stop не true — работать дальше.
  for (const rb of ['{"ok":1,"stop":false}', '{"ok":1}', '{"ok":1,"stop":"true"}', 'не json', '']) {
    const w2 = world();
    w2.reportBody = rb;
    await run(w2);
    assert.equal(state(w2).стоп, undefined, 'стоп по ответу ' + rb);
  }
  const w3 = world();
  w3.stop = true; w3.reportStatus = 500;
  await run(w3);
  assert.equal(state(w3).стоп, undefined, 'stop без 200 принят');
});

test('автостоп по сроку 6 ч от t0: итог, отчёт несёт «стоп» и итог, дальше холостой режим; хранилище ST24 не читается', async () => {
  const w = world();
  w.store.RH_ST24 = JSON.stringify({ v: 1, t0: 1, lastMs: 1, прогонов: 999, прев: {}, окна: {}, журнал: [], переходы: [], стоп: { почему: 'x' } });
  w.clock.t = MS + 30000;
  await run(w);
  assert.equal(state(w).прогонов, 1, 'данные ST24 смешались с ST25');
  w.clock.t = MS + 6 * HOUR - MIN;
  await run(w);
  assert.equal(state(w).стоп, undefined, 'стоп раньше срока');
  w.clock.t = MS + 6 * HOUR + 30000;
  const s = await run(w);
  const b = body(w);
  assert.equal(b.стоп, 'срок 6 ч');
  assert.match(b.ит, /^L — /);
  assert.equal(state(w).стоп.почему, 'срок 6 ч');
  assert.match(s.done.content, /ОСТАНОВЛЕН: срок 6 ч/);
  const n = w.calls.length;
  w.clock.t += MIN;
  await run(w, { tile: true });
  assert.equal(w.calls.length, n);
});

// Автостоп по данным — только когда ВСЕ четыре группы набрали по 6 исходов:
// одна группа с 5 исходами держит опыт.
test('автостоп «данных достаточно»: три группы по 6 исходов, одна — 5 → опыт идёт; все по 6 → стоп', async () => {
  const deadWins = (n) => Array.from({ length: n }, (_, i) => ({ k: K0 + 2 * i + 1, вид: 'смерть', чтений: 3, от_мин: 0.5, на_A_мин: 9.5 }));
  for (const short of IDS) {
    const w = world({ notice: {} });
    w.clock.t = MS + 30000;
    await run(w);
    const s = state(w);
    for (const x of IDS) s.окна[P + x] = deadWins(x === short ? 5 : 6);
    w.store.RH_ST25 = JSON.stringify(s);
    w.clock.t = MS + 13 * WIN + 30000;                         // все 6 мёртвых окон (K0+1 … K0+11) закрыты
    await run(w);
    assert.equal(state(w).стоп, undefined, 'стоп при 5 исходах у ' + short);
    const s2 = state(w);
    s2.окна[P + short] = deadWins(6);
    w.store.RH_ST25 = JSON.stringify(s2);
    w.clock.t += MIN;
    await run(w);
    assert.equal(state(w).стоп && state(w).стоп.почему, 'данных достаточно', 'нет стопа при 6 исходах у всех (' + short + ')');
  }
});

test('автостоп «данных достаточно»: по каждой группе ≥ 6 закрытых окон смерти с исходом (фон / не заметил / застрял на B)', async () => {
  // L — застрял на B с самого начала, N и T — замечают, P — не замечает.
  const w = world({ notice: { [P + 'N']: 1, [P + 'P']: null, [P + 'T']: 1 }, back: { [P + 'N']: 0, [P + 'T']: 0 } });
  w.stuck = { [P + 'L']: P + 'LB' };
  const dead = (i) => K0 + 2 * i + 1;
  // Чётное окно K0, затем 6 пар «мёртвое + живое» (шестое живое — не читаем); минуты 0,5; 1,5; 8,5; 9,5.
  const mins = [0.5, 1.5, 8.5, 9.5];
  for (let k = K0; k <= dead(5); k++) for (const m of mins) { w.clock.t = k * WIN + m * MIN; await run(w); }
  // Шестое мёртвое окно ещё открыто — стопа нет.
  assert.equal(state(w).стоп, undefined, 'стоп при открытом шестом окне');
  const sm = dump(await run(w, { tile: true })).ans.сейчас;
  assert.deepEqual(GR.map((g) => sm[g].исходов), [5, 5, 5, 5]);
  w.clock.t = (dead(5) + 1) * WIN + 30000;
  await run(w);
  const st = state(w);
  assert.equal(st.стоп && st.стоп.почему, 'данных достаточно');
  assert.equal(body(w).стоп, 'данных достаточно');
  assert.match(st.итог, /L — застрял на B \(6 окн\.\)/);
  assert.match(st.итог, /N — замечает за ≤ 2 мин/);
  assert.match(st.итог, /P — не заметил за окно \(6 окн\.\)/);
  assert.match(st.итог, /T — замечает за ≤ 2 мин/);
});

test('«застрял на B» — только если B видно с начала мёртвого окна (≤ 2-й мин) и до MISS_MIN; иначе окно без исхода', async () => {
  const w = world({ notice: { [P + 'L']: 0 }, back: { [P + 'L']: 99 } });
  const mins = [3.5, 8.5];                                    // начало окна не видно
  for (let k = K0; k <= K0 + 4; k++) for (const m of mins) { w.clock.t = k * WIN + m * MIN; await run(w); }
  w.clock.t = (K0 + 5) * WIN + 30000;
  const d = dump(await run(w, { tile: true })).ans;
  assert.equal(d.сейчас[P + 'L'].исходов, 1, 'исход — только первое окно (заметил)');
  assert.equal(d.сейчас[P + 'L'].вывод, '1 окно — не вывод (заметил за ≤ 4 мин)');
});

// ── ПЛИТКА И ФОН (дефект вердикта ST24) ─────────────────────────────────
test('переход по плитке — не фоновый: сам на плитке, опора на плитке, плитка между ними (и занятая замком), плитка за 30 с до опоры', async () => {
  const cases = [
    ['переход на плитке', (w) => ({ tileAt: 1 })],
    ['опора на плитке', (w) => ({ tileAt: 0 })],
    ['плитка между (занята замком)', (w) => ({ between: true })],
    ['плитка за 20 с до опоры', (w) => ({ before: 20000 })],
  ];
  for (const [why, f] of cases) {
    const w = world({ notice: { [P + 'N']: 0 } });
    const o = f(w);
    const times = [MS + 9 * MIN + 30000, MS + WIN + 30000];
    if (o.before) {
      w.store.RH_ST25_lock = String(times[0] - o.before) + ':1';
      w.clock.t = times[0] - o.before;
      await run(w, { tile: true });                                  // ЗАНЯТО, но время плитки записано
      w.store.RH_ST25_lock = '';
    }
    for (let i = 0; i < 2; i++) {
      if (o.between && i === 1) {
        w.store.RH_ST25_lock = String(times[0] + 10000) + ':1';
        w.clock.t = times[0] + 20000;
        const sb = await run(w, { tile: true });
        assert.match(sb.done.content, /^ЗАНЯТО/);
        w.store.RH_ST25_lock = '';
      }
      w.clock.t = times[i];
      await run(w, { tile: o.tileAt === i });
    }
    const tr = state(w).переходы;
    assert.equal(tr.length, 1, why);
    assert.equal(tr[0].фон, false, 'засчитан фоновым: ' + why);
    assert.match(body(w).tr[0], /плитка #2$/);
    w.clock.t = MS + 2 * WIN + 30000;
    const d = dump(await run(w, { tile: true })).ans;
    assert.equal(d.сейчас[P + 'N'].вывод, 'нет данных; по плитке 1', why);
  }
  // Время плиток не записалось (хранилище отказало): плитка остаётся не фоном —
  // по флагу самого прогона и по флагу опорного чтения.
  for (const tileAt of [0, 1]) {
    const w = world({ notice: { [P + 'N']: 0 } });
    const sw = (v, k) => { if (k === 'RH_ST25_tiles') return false; w.store[k] = v; return true; };
    const times = [MS + 9 * MIN + 30000, MS + WIN + 30000];
    for (let i = 0; i < 2; i++) { w.clock.t = times[i]; await run(w, { tile: tileAt === i, sb: { storeWrite: sw } }); }
    assert.equal(w.store.RH_ST25_tiles, undefined);
    assert.deepEqual(state(w).переходы.map((x) => x.фон), [false], 'без записи времени плитка стала фоном: ' + (tileAt ? 'переход' : 'опора'));
  }
  // Контроль: плитка за 40 с до опоры и после перехода — переход фоновый.
  const w = world({ notice: { [P + 'N']: 0 } });
  w.clock.t = MS + 9 * MIN - 10000; await run(w, { tile: true });
  w.clock.t = MS + 9 * MIN + 30000; await run(w);
  w.clock.t = MS + WIN + 30000; await run(w);
  w.clock.t = MS + WIN + 40000; await run(w, { tile: true });
  assert.deepEqual(state(w).переходы.map((x) => x.фон), [true]);
});

test('«замечает» — только при ≥ 2 фоновых окнах; одно — «1 окно — не вывод»; возврат — так же', async () => {
  const w = world({ notice: { [P + 'N']: 1 }, back: { [P + 'N']: 2 } });
  await series(w, MS + 30000, 30);                             // K0, K0+1 (мёртвое), K0+2
  let d = dump(await run(w, { tile: true })).ans;              // плитка в конце K0+2 — вдали от следующих переходов
  assert.equal(d.сейчас[P + 'N'].вывод, '1 окно — не вывод (заметил за ≤ 2 мин)');
  assert.equal(d.сейчас[P + 'N'].возврат, '1 окно — не вывод (вернулся за ≤ 3 мин)');
  assert.doesNotMatch(d.ВЕРДИКТ, /N — замечает/);
  await series(w, MS + 3 * WIN + 30000, 20);                  // K0+3 (мёртвое), K0+4
  w.clock.t = MS + 5 * WIN + 30000;
  d = dump(await run(w, { tile: true })).ans;
  assert.equal(d.сейчас[P + 'N'].вывод, 'замечает за ≤ 2 мин');
  assert.equal(d.сейчас[P + 'N'].возврат, 'возвращается за ≤ 3 мин');
  assert.match(d.ВЕРДИКТ, /^ST25 \d+(\.\d)? мин: L — /);
});

test('несколько окон: «не заметил» хоть раз — «замечает не всегда»; «не заметил» и «застрял» — только в закрытом окне и до MISS_MIN', async () => {
  const w = world({ notice: { [P + 'N']: 0, [P + 'P']: null } , back: { [P + 'N']: 0 } });
  await series(w, MS + 30000, 30);
  await series(w, MS + 3 * WIN + 30000, 10);
  w.notice[P + 'N'] = null;
  await series(w, MS + 5 * WIN + 30000, 10);
  w.clock.t = MS + 6 * WIN + 30000;
  const d = dump(await run(w, { tile: true })).ans;
  assert.equal(d.сейчас[P + 'N'].вывод, 'замечает не всегда: за ≤ 1 мин в 2 окн., не заметил в 1');
  assert.equal(d.сейчас[P + 'P'].вывод, 'не заметил за окно (3 окн.)');
  // Окно ещё открыто — рано; последнее чтение на 5-й минуте — «нет данных».
  const w2 = world({ notice: {} });
  await series(w2, MS + 30000, 3);
  await series(w2, MS + WIN + 30000, 9);
  let d2 = dump(await run(w2, { tile: true })).ans;
  assert.equal(d2.сейчас[P + 'L'].вывод, 'нет данных');
  const w3 = world({ notice: { [P + 'L']: 0 }, back: { [P + 'L']: 99 } });
  await series(w3, MS + 9 * MIN + 30000, 2);                  // уход в K0+1
  await series(w3, MS + 3 * WIN + 30000, 5);                  // K0+3 на B, но только до 4,5-й минуты
  w3.clock.t = MS + 4 * WIN + 30000;
  d2 = dump(await run(w3, { tile: true })).ans;
  assert.equal(d2.сейчас[P + 'L'].вывод, '1 окно — не вывод (заметил за ≤ 1 мин)', 'короткие данные прочитаны как «застрял»');
  await series(w3, MS + 5 * WIN + 30000, 9);                  // K0+5 на B с 0,5 до 8,5 мин
  w3.clock.t = MS + 6 * WIN + 30000;
  d2 = dump(await run(w3, { tile: true })).ans;
  assert.equal(d2.сейчас[P + 'L'].вывод, '1 окно — не вывод (заметил за ≤ 1 мин); застрял на B в 1');
});

test('нет данных ≠ замечает: нет now, now не A/B, B без опоры — не переход', async () => {
  const w = world({ notice: { [P + 'L']: 0 }, opts: { entry: (n, x) => ({ name: n, type: x.type, all: x.all }) } });
  await series(w, MS + 9 * MIN, 3);
  let d = dump(await run(w, { tile: true })).ans;
  assert.equal(state(w).переходы.length, 0);
  assert.equal(d.сейчас[P + 'L'].вывод, 'нет данных');
  assert.match(body(w).r, / L:нет /);
  const w2 = world({ notice: { [P + 'L']: 0 } });
  await series(w2, MS + WIN + 30000, 3);
  d = dump(await run(w2, { tile: true })).ans;
  assert.equal(state(w2).переходы.length, 0);
  assert.equal(d.сейчас[P + 'L'].вывод, 'нет данных');
  const w4 = world({ notice: { [P + 'L']: 0 } });
  w4.clock.t = MS - 2 * WIN + 5 * MIN; await run(w4);
  w4.clock.t = MS + WIN + 30000; await run(w4);
  assert.equal(state(w4).переходы.length, 0, 'опора из окна k-2 засчитана');
});

// ── РАЗМЕР ВЫГРУЗКИ ────────────────────────────────────────────────────
test('строка журнала на cron ≤ 2 КБ при худшем накопленном хвосте и отказах; полный дамп — только по плитке', async () => {
  const w = world({ notice: { [P + 'N']: 0, [P + 'T']: 0 }, back: { [P + 'N']: 0, [P + 'T']: 0 } });
  await series(w, MS + 30000, 45);
  const s = state(w);
  assert.ok(s.журнал.length >= 45 && s.окна[P + 'N'].length >= 5);
  // Худший хвост: журнал, переходы и окна — до предела.
  while (s.журнал.length < 60) s.журнал.push(s.журнал[0]);
  while (s.переходы.length < 60) s.переходы.push(s.переходы[0]);
  for (const g of GR) while (s.окна[g].length < 40) s.окна[g].unshift({ ...s.окна[g][0], k: s.окна[g][0].k - 2 });
  w.store.RH_ST25 = JSON.stringify(s);
  w.fail = (m, p) => p === '/providers/proxies/rh-t24l' || p === '/providers/proxies/rh-t24p' || p === '/proxies/' + P + 'К';
  w.rules = [STAND_RULE, R('RuleSet', 'rh-ads', 'REJECT'), TOUCH_RULE];
  w.clock.t = MS + 45 * MIN + 30000;
  const c = await run(w);
  const l = line(c);
  assert.ok(utf8(l) <= 2048, 'строка cron ' + utf8(l) + ' байт');
  assert.equal(l.indexOf('\n'), -1);
  const d = JSON.parse(l.slice(7)).ans;
  for (const k of ['журнал', 'переходы', 'окна', 'сейчас']) assert.equal(d[k], undefined, 'на cron в строке ' + k);
  assert.equal(d.обрезано, undefined, 'обычная строка cron сама длиннее 2 КБ (' + utf8(l) + ' байт) — спасает только усечение');
  assert.ok(d.r && d.ВЕРДИКТ, 'в короткой строке нет чтения или вердикта');
  const t = await run(w, { tile: true });
  const dt = dump(t).ans;
  assert.ok(dt.журнал.length === 30 && dt.переходы.length === 60 && dt.окна[P + 'N'].length === 40, 'плитка — не полный дамп');
  for (const x of [l, line(t), t.note.b, t.done.content]) assert.ok(x.indexOf('ОЧЕНЬ-СЕКРЕТНО') < 0 && x.indexOf('127.0.0.1') < 0);
  // Все чтения с ошибкой — строка тоже короткая.
  const w2 = world();
  w2.fail = () => ({ status: 500, body: 'x' });
  w2.clock.t = MS + 30000;
  const e2 = await run(w2);
  assert.ok(utf8(line(e2)) <= 2048);
});

// ── ЗАМОК, СТОРОЖ, CRON ────────────────────────────────────────────────
test('замок, сторож (контроллер или стенд висят), EOF с повтором: один $done, журнал целый', async () => {
  const w = world();
  w.store.RH_ST25_lock = String(w.clock.t - 1000) + ':1';
  const s = await run(w, { tile: true });
  assert.match(s.done.content, /^ЗАНЯТО: .* через 309 с/);
  assert.equal(w.calls.length, 0);
  assert.deepEqual(JSON.parse(w.store.RH_ST25_tiles), [w.clock.t], 'время занятой плитки не записано');
  const wh = world();
  wh.hang = true;
  const sh = await run(wh, { grace: 300, fastGuard: true });
  assert.match(sh.done.content, /КОНТРОЛЛЕР НЕ ОТВЕТИЛ \(сторож\)/);
  assert.equal(wh.store.RH_ST25, undefined);
  assert.equal(wh.store.RH_ST25_lock, '');
  // Стенд висит: сторож сохраняет чтение, указатель не сдвинут.
  const wr = world();
  wr.reportHang = true;
  const s2 = await run(wr, { grace: 300, fastGuard: true });
  assert.match(line(s2), /сторож/);
  assert.equal(wr.reports.length, 1);
  assert.equal(state(wr).прогонов, 1);
  assert.equal(state(wr).отпр, 0);
});

const numOf = (k) => Number(CODE.match(new RegExp('(?:var |, )' + k + ' = (\\d+)'))[1]);

test('сторож позже худшего честного пути (повтор EOF, растяжение фона, отчёт); окно и лимит — как у стенда', () => {
  const req = Math.max(numOf('CTRL_SEC'), numOf('STAND_SEC')) * 1000;
  const worst = numOf('BUDGET_MS') + 2 * req + 4 * 1000;
  assert.ok(numOf('GUARD_MS') > worst, 'сторож ' + numOf('GUARD_MS') + ' мс не позже худшего пути ' + worst + ' мс');
  assert.equal(numOf('CTRL_SEC'), 5, 'timeout Stash — секунды');
  assert.equal(numOf('STAND_SEC'), 5, 'timeout отчёта — секунды');
  assert.equal(numOf('WIN_MS'), L.T24_WINDOW_MS);
  assert.ok(numOf('REPORT_MAX') <= L.T24_REPORT_MAX);
  assert.ok(numOf('TR_SEND') <= 8);
  assert.ok(CODE.indexOf("var REPORT_URL = '" + REPORT + "'") >= 0);
  const ov = fs.readFileSync(path.join(ROOT, 'plugins/RouteHub-Stash-Lab.stoverride'), 'utf8');
  const to = Number(/\n {6}timeout:\s*(\d+)/.exec(ov)[1]) * 1000;
  assert.ok(to >= numOf('GUARD_MS') && to >= numOf('BUDGET_MS') && numOf('LOCK_MS') > to);
  // Сторож — setTimeout: в фоне растягивается до 4 раз (ST14) и всё равно
  // должен сработать раньше, чем Stash сам оборвёт задание cron.
  assert.ok(numOf('GUARD_MS') * 4 < to, 'растянутый сторож ' + numOf('GUARD_MS') * 4 + ' мс не раньше timeout cron ' + to + ' мс');
});

// Ужатие тела отчёта при штатных данных недостижимо (расчёт — в коде у
// reportBody); проверяем саму функцию: тело из кода пробы в отдельном vm.
function reportFn(o) {
  const src = ['utf8', 'trLine', 'reportBody'].map((n) => {
    const m = CODE.match(new RegExp('\\nfunction ' + n + '\\([\\s\\S]*?\\n}\\n'));
    assert.ok(m, 'нет функции ' + n);
    return m[0];
  }).join('');
  const ctx = { JSON, REV: 'ST25', TR_SEND: numOf('TR_SEND'), REPORT_MAX: numOf('REPORT_MAX'), S: o.S, shortVerdicts: () => o.ит };
  vm.runInNewContext(src, ctx);
  return (e, stop) => ctx.reportBody(e, stop, 0);
}
test('ужатие отчёта: тело ≤ REPORT_MAX, отброшены самые старые переходы (счётчик «пр»), итог цел; крайний случай — итог до 150', () => {
  const S = { отпр: 0, переходы: Array.from({ length: 60 }, (_, i) => ({ seq: i + 1, г: 'T', вид: 'вернулся', мин: 9.9, не_раньше_мин: 9.8, фон: false })) };
  const ит = 'Ж'.repeat(500);
  const f = reportFn({ S, ит });
  const s = f({ seq: 61, r: 'Ж'.repeat(300) }, 'срок 6 ч');
  const b = JSON.parse(s);
  assert.ok(utf8(s) <= numOf('REPORT_MAX'), 'тело ' + utf8(s) + ' байт');
  assert.ok(b.tr.length > 0 && b.tr.length < 8, 'ужатие не сработало или выбросило всё: ' + b.tr.length);
  assert.equal(b.пр, 60 - b.tr.length);
  const seqs = b.tr.map((x) => Number(x.split('#')[1]));
  assert.deepEqual(seqs, Array.from({ length: b.tr.length }, (_, i) => 61 - b.tr.length + i), 'выброшены не самые старые');
  assert.equal(b.ит, ит, 'итог обрезан, хотя хватало ужатия переходов');
  const x = JSON.parse(f({ seq: 61, r: 'Ж'.repeat(700) }, 'срок 6 ч'));
  assert.deepEqual(x.tr, []);
  assert.equal(x.пр, 60);
  assert.equal(x.ит, ит.slice(0, 150));
  assert.ok(utf8(JSON.stringify(x)) <= numOf('REPORT_MAX'));
  // Без стопа и при коротком r — ужатия нет: 8 новейших.
  const y = JSON.parse(f({ seq: 61, r: 'r' }, null));
  assert.deepEqual([y.tr.length, y.пр, y.ит], [8, 52, undefined]);
});
