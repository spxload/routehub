// Поведение пробы ST18 в песочнице с подставным контроллером Clash-вида.
//
// ЗАЧЕМ СВЕРХ probes-smoke. ST18 — первая проба стенда, которая ПИШЕТ в
// контроллер (решение Дианы 24.09: управление узлами на стенде разрешено).
// Поэтому проверяется не только «дошла до $done», но и граница записи:
// писать можно лишь в две тестовые группы, исходный выбор возвращается даже
// при нехватке времени, секрет контроллера в выгрузку не попадает, а вердикт
// не выдаёт «работает» по одному коду 204 — только по смене `now`.
//
// ЧАСЫ ПОДСТАВНЫЕ: бюджет пробы считается по Date.now(), и проверить
// «время на исходе» на настоящих часах можно было бы лишь минутами ожидания.
// Каждый ответ контроллера сдвигает часы на `step` мс.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = 'probes/routehub-probe-stash18.js';
const CODE = fs.readFileSync(path.join(ROOT, FILE), 'utf8');

const SECRET = 'Bearer ОЧЕНЬ-СЕКРЕТНО';
const SEL = 'RH-Тест-Выбор';
const FB = 'RH-Тест-Резерв';
const PIN = 'RH-Тест-Прямо';

function groups() {
  return {
    [SEL]: { name: SEL, type: 'Selector', now: 'DIRECT', all: ['DIRECT', 'REJECT', FB] },
    [FB]: { name: FB, type: 'Fallback', now: 'DIRECT', fixed: '', all: ['DIRECT', PIN] },
    [PIN]: { name: PIN, type: 'Selector', now: 'DIRECT', all: ['DIRECT'] },
    'RH-AI': { name: 'RH-AI', type: 'Selector', now: 'RH-AI-W', all: ['RH-AI-W', 'RH-AI-C'] },
  };
}

// opts.fallback: 'fix' — fallback закрепляется (поле fixed, как у mihomo),
// 'reject' — 400 как у Clash («Must be a Selector»), 'ignore' — 204 без
// перемены, 'pinOnly' — 204, `now` прежний, но `fixed` проставлен.
// opts.noDelete — DELETE не снимает закрепление (404).
// opts.status — код первого чтения вместо 200 (401, 500).
// opts.failReadAfterPut — первое чтение после первой записи в группу даёт 500.
// opts.freezeSel = k — после k записей в SEL выбор больше не меняется (204).
// opts.freezeFb — после первой записи в FB выбор не меняется (204).
// opts.ghostShifts — несуществующее имя сбивает выбор на REJECT.
// opts.noFbMember — в SEL нет члена FB; opts.noFb — группы FB нет.
// opts.late(call) — первый запрос, для которого вернёт true, получает ответ
// ПОСЛЕ сторожа.
// Адрес с не-ASCII символами (кириллица без encodeURIComponent) — 400.
// opts.noGroups — override не применился. opts.put204NoMove — 204, но `now`
// не меняется. opts.step — сдвиг часов на ответ. opts.hang — не отвечать.
function run(opts = {}) {
  const g = opts.noGroups ? { 'RH-AI': groups()['RH-AI'] } : groups();
  if (opts.noFbMember) g[SEL].all = ['DIRECT', 'REJECT'];
  if (opts.noFb) delete g[FB];
  const clock = { t: 1_800_000_000_000 };
  const state = { done: null, doneCalls: 0, note: null, calls: [], g };
  const wrote = {}, failed = {}, puts = {};
  state.clock = clock; state.T0 = clock.t;
  const RealDate = Date;
  function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(clock.t); }
  FakeDate.now = () => clock.t;

  function answer(method) {
    return (o, cb) => {
      const url = String(o.url || '');
      const name = decodeURIComponent(url.replace(/^.*\/proxies\//, ''));
      const call = { method, name, url, auth: o.headers && o.headers.Authorization, body: o.body || null, timeout: o.timeout, end: null };
      state.calls.push(call);
      if (opts.hang) return;
      let delay = 1;
      if (opts.late && !state.lateUsed && opts.late(call)) { state.lateUsed = true; state.lateIdx = state.calls.length - 1; delay = 250; }
      const reply = (st, body) => setTimeout(() => { clock.t += opts.step || 30; call.end = clock.t; cb(null, { status: st, headers: {} }, body); }, delay);
      if (/[^\x00-\x7F]/.test(url)) return reply(400, '{"message":"bad path"}');
      const grp = g[name];
      if (opts.status && state.calls.length === 1) return reply(opts.status, '{"message":"Unauthorized"}');
      if (!grp) return reply(404, '{"message":"Resource not found"}');
      if (method === 'get') {
        if (opts.failReadAfterPut && wrote[name] && !failed[name]) { failed[name] = 1; return reply(500, 'oops'); }
        return reply(200, JSON.stringify(grp));
      }
      wrote[name] = 1;
      puts[name] = (puts[name] || 0) + (method === 'put' ? 1 : 0);
      if (method === 'delete') {
        if (opts.noDelete || grp.type !== 'Fallback') return reply(404, '404 page not found');
        grp.fixed = ''; grp.now = grp.all[0];
        return reply(204, '');
      }
      const want = JSON.parse(o.body).name;
      if (grp.all.indexOf(want) < 0) {
        if (opts.ghostShifts) grp.now = 'REJECT';
        return reply(400, '{"message":"Proxy does not exist"}');
      }
      if (opts.freezeSel && name === SEL && puts[name] > opts.freezeSel) return reply(204, '');
      if (opts.freezeFb && name === FB && puts[name] > 1) return reply(204, '');
      if (grp.type === 'Fallback') {
        const mode = opts.fallback || 'reject';
        if (mode === 'reject') return reply(400, '{"message":"Must be a Selector"}');
        if (mode === 'fix') { grp.now = want; grp.fixed = want; }
        if (mode === 'pinOnly') grp.fixed = want;
        return reply(204, '');
      }
      if (!opts.put204NoMove) grp.now = want;
      return reply(204, '');
    };
  }

  const sandbox = {
    console: { log: () => {} },
    JSON, Math, Date: FakeDate, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, isFinite, encodeURIComponent, decodeURIComponent,
    setTimeout: (fn, ms) => setTimeout(fn, Math.max(1, Math.round((ms || 0) / 1000))),
    clearTimeout,
    $environment: {
      'controller-url': 'http://127.0.0.1:9090/',
      'controller-authorization': SECRET,
      'stash-version': '3.4.1',
    },
    $notification: { post: (t, s, b, o) => { state.note = { t, s, b, clip: (o && o.clipboard) || null }; } },
    $httpClient: {
      get: answer('get'),
      put: answer('put'),
      post: () => { throw new Error('проба не должна слать POST'); },
      patch: () => { throw new Error('проба не должна менять настройки'); },
      delete: answer('delete'),
    },
    $done: (v) => { state.doneCalls++; state.done = v || {}; },
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(CODE, vm.createContext(sandbox), { filename: FILE });
  return state;
}

async function settle(state, ms = 5000) {
  const until = Date.now() + ms;
  while (!state.done && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  assert.ok(state.done, 'проба не дошла до $done');
  await new Promise((r) => setTimeout(r, 150)); // второй $done, если он есть, успеет прийти
  assert.equal(state.doneCalls, 1, 'ровно один $done на любой ветви');
  assert.ok(state.note && state.note.clip, 'отчёт не попал в буфер обмена');
  return JSON.parse(state.note.clip);
}

function writes(state) { return state.calls.filter((c) => c.method !== 'get'); }

test('запись — только в тестовые группы, секрет только в заголовке', async () => {
  const st = run({ fallback: 'fix' });
  const rep = await settle(st);
  const w = writes(st);
  assert.ok(w.length >= 4, 'проба почти ничего не записала: ' + w.length);
  for (const c of w) assert.ok(c.name === SEL || c.name === FB, 'запись вне тестовых групп: ' + c.name);
  assert.ok(w.some((c) => c.method === 'delete'), 'снятие закрепления не проверялось');
  for (const c of st.calls) assert.equal(c.auth, SECRET, 'запрос без секрета: ' + c.url);
  // У Stash timeout $httpClient — в СЕКУНДАХ: 5000 значило бы полтора часа.
  for (const c of st.calls) assert.equal(c.timeout, 5, 'timeout не в секундах: ' + c.timeout);
  for (const c of st.calls) assert.ok(c.url.indexOf('9090//') < 0, 'двойная косая в адресе: ' + c.url);
  const dump = JSON.stringify(rep) + JSON.stringify(st.done) + JSON.stringify(st.note);
  assert.ok(dump.indexOf('ОЧЕНЬ-СЕКРЕТНО') < 0, 'секрет контроллера попал в выгрузку');
});

test('выбор сменился и вернулся — вердикт «работает», обе группы как были', async () => {
  const st = run({ fallback: 'fix' });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('ВЫБОР ИЗ СКРИПТА РАБОТАЕТ') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.equal(rep.ans.выбор.ждали, 'REJECT');
  assert.equal(rep.ans.кириллица.сработал, true);
  assert.equal(rep.ans.откат.сработал, true);
  assert.equal(rep.ans.fallback.закрепился, true);
  assert.equal(rep.ans.fallback.ждали, PIN, 'цель закрепления — не здоровый член');
  assert.equal(rep.ans.fallback.fixed, PIN);
  assert.equal(rep.ans.снятие.сработало, true);
  assert.ok(!rep.ans.откат_fallback, 'PUT-возврат при сработавшем DELETE лишний');
  assert.equal(st.g[SEL].now, 'DIRECT', 'тестовая группа не возвращена');
  assert.equal(st.g[FB].now, 'DIRECT', 'fallback не возвращён');
  assert.equal(st.g[FB].fixed, '', 'fallback остался закреплённым');
  assert.ok(st.done.content.indexOf('DELETE 204 снимает закрепление') >= 0, st.done.content);
  assert.equal(st.done.backgroundColor, '#34C759');
  assert.ok(!rep.ans.ВНИМАНИЕ, 'ложная тревога об откате: ' + rep.ans.ВНИМАНИЕ);
});

test('кириллица в теле уходит как есть, чужое имя не сбивает выбор', async () => {
  const st = run();
  const rep = await settle(st);
  const cyr = writes(st).filter((c) => JSON.parse(c.body).name === FB);
  assert.equal(cyr.length, 1, 'имя кириллицей не отправлено');
  assert.equal(rep.ans.чужое_имя.код, 400);
  assert.equal(rep.ans.чужое_имя.выбор_не_сбит, true);
  assert.ok(st.done.content.indexOf('выбор не сбит') >= 0, 'итог по чужому имени не виден');
});

test('DELETE не снимает — возврат через PUT, и видно, что группа осталась закреплённой', async () => {
  const st = run({ fallback: 'fix', noDelete: true });
  const rep = await settle(st);
  assert.equal(rep.ans.снятие.сработало, false);
  assert.equal(rep.ans.откат_fallback.сработал, true);
  assert.equal(st.g[FB].now, 'DIRECT');
  assert.ok(st.done.content.indexOf('осталась закреплённой: DIRECT') >= 0, st.done.content);
  assert.ok(!rep.ans.ВНИМАНИЕ, rep.ans.ВНИМАНИЕ);
});

test('чтение после записи не удалось — откат обеих групп всё равно выполнен', async () => {
  const st = run({ fallback: 'fix', failReadAfterPut: true });
  const rep = await settle(st);
  assert.equal(rep.ans.выбор.сработал, false, 'непрочитанный выбор объявлен сработавшим');
  assert.equal(rep.ans.fallback.закрепился, false);
  assert.ok(writes(st).some((c) => c.name === FB && c.method === 'delete'), 'откат fallback не начат');
  assert.equal(st.g[SEL].now, 'DIRECT');
  assert.equal(st.g[FB].now, 'DIRECT');
  assert.equal(st.g[FB].fixed, '');
});

test('контроллер ответил 401 — вердикт про контроллер, а не про override', async () => {
  const st = run({ status: 401 });
  const rep = await settle(st);
  assert.equal(writes(st).length, 0);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('КОНТРОЛЛЕР НЕ ОТДАЛ ГРУППУ') === 0 && rep.ans.ВЕРДИКТ.indexOf('401') > 0,
    'вердикт: ' + rep.ans.ВЕРДИКТ);
});

test('fallback отвечает 400 — «не закрепляется», отката fallback нет', async () => {
  const st = run({ fallback: 'reject' });
  const rep = await settle(st);
  assert.equal(rep.ans.fallback.закрепился, false);
  assert.ok(st.done.content.indexOf('fallback: НЕ ЗАКРЕПЛЯЕТСЯ: PUT 400') >= 0, 'строка fallback: ' + st.done.content);
  assert.equal(writes(st).filter((c) => c.name === FB).length, 1, 'лишняя запись в fallback');
  assert.ok(!rep.ans.откат_fallback && !rep.ans.снятие);
});

test('fallback принимает 204, но выбор не меняет — это не «закрепляется»', async () => {
  const st = run({ fallback: 'ignore' });
  await settle(st);
  assert.ok(st.done.content.indexOf('но выбор не сменился') >= 0, 'строка fallback: ' + st.done.content);
});

test('fallback: выбор прежний, но поле fixed проставлено — закрепление всё равно снимается', async () => {
  const st = run({ fallback: 'pinOnly' });
  const rep = await settle(st);
  assert.equal(rep.ans.fallback.fixed, PIN);
  assert.ok(writes(st).some((c) => c.name === FB && c.method === 'delete'), 'закреплённую группу бросили');
  assert.equal(st.g[FB].fixed, '');
});

test('204 без смены выбора — вердикт «не переключает», а не «работает»', async () => {
  const st = run({ put204NoMove: true });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('НЕ ПЕРЕКЛЮЧАЕТ') === 0, 'вердикт по одному коду 204: ' + rep.ans.ВЕРДИКТ);
  assert.equal(st.done.backgroundColor, '#FF3B30');
});

test('тестовых групп нет — ни одной записи, вердикт называет причину', async () => {
  const st = run({ noGroups: true });
  const rep = await settle(st);
  assert.equal(writes(st).length, 0, 'проба писала, не найдя тестовой группы');
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('(404) — override ST18 не применился') > 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
});

test('время на исходе после первой записи — откат всё равно выполнен', async () => {
  // 5 с на ответ: три чтения (15 с), запись и чтение (25 с) — дальше бюджет
  // шагов не пускает, но откат обязан пройти.
  const st = run({ step: 5000, fallback: 'fix' });
  const rep = await settle(st);
  assert.equal(rep.ans.выбор.сработал, true);
  assert.ok(!rep.ans.чужое_имя, 'шаг начат без запаса времени');
  assert.equal(rep.ans.откат.сработал, true, 'откат пропущен из-за бюджета');
  assert.equal(st.g[SEL].now, 'DIRECT');
  assert.ok(rep.err.some((e) => e.indexOf('бюджет') === 0), 'пропуск шагов не объяснён');
});

test('контроллер молчит — сторож завершает пробу одним $done', async () => {
  const st = run({ hang: true });
  const rep = await settle(st, 3000);
  assert.ok(rep.err.some((e) => e.indexOf('сторож') === 0), 'сторож не сработал');
  assert.equal(writes(st).length, 0);
});

test('сторож позже худшего честного пути (дефект ST14)', () => {
  const num = (k) => Number(CODE.match(new RegExp('var ' + k + ' = (\\d+)'))[1]);
  const budget = num('BUDGET_MS'), guard = num('GUARD_MS'), sec = num('CTRL_SEC');
  // Шаг стартует, лишь если бюджета хватает на всю его цепочку по CTRL_SEC+1 с
  // на запрос, значит худший честный путь не длиннее бюджета (и трёх
  // начальных чтений, если бюджет вдруг меньше них).
  assert.ok(guard > Math.max(budget, 3 * sec * 1000) + sec * 1000, 'сторож раньше худшего честного пути');
});

test('override: тестовые группы без узлов и без правил на них', () => {
  const ov = fs.readFileSync(path.join(ROOT, 'plugins/RouteHub-Stash-ST18.stoverride'), 'utf8');
  const block = ov.slice(ov.indexOf('proxy-groups:'), ov.indexOf('script-providers:'));
  const members = [...block.matchAll(/^ {6}- (.+)$/gm)].map((m) => m[1].trim());
  assert.deepEqual([...new Set(members)].sort(), ['DIRECT', 'REJECT', FB, PIN].sort(), 'в тестовых группах посторонние члены');
  assert.ok(ov.indexOf(SEL) > 0 && ov.indexOf(FB) > 0 && ov.indexOf('- name: ' + PIN) > 0);
  // Сторож в фоне растягивается в 3–4 раза: 75 с → до 300 с.
  assert.match(ov, /timeout: 300\b/);
  assert.ok(!/^rules:/m.test(ov), 'override не должен добавлять правил');
  assert.match(ov, /probes\/routehub-probe-stash18\.js/);
});

test('бюджет жёсткий: при любом времени ответа до 6 с последний запрос кончается в пределах 45 с', async () => {
  // Проверка поведением, а не числами в room(n): сторож рассчитан на то, что
  // честный путь не длиннее бюджета.
  for (const step of [500, 2500, 4000, 5000, 6000]) {
    const st = run({ step, fallback: 'fix', noDelete: true });
    await settle(st);
    const last = Math.max(...st.calls.map((c) => c.end || 0));
    assert.ok(last - st.T0 <= 45000, 'шаг ' + step + ' мс: последний ответ на ' + (last - st.T0) + ' мс');
    assert.equal(st.g[SEL].now, 'DIRECT', 'шаг ' + step + ' мс: выбор не возвращён');
    assert.equal(st.g[FB].now, 'DIRECT', 'шаг ' + step + ' мс: fallback не возвращён');
  }
});

test('откат не удался — предупреждение, красный цвет, «откат: НЕТ»', async () => {
  // Две записи проходят (другой член, кириллица), дальше контроллер
  // отвечает 204 и выбор не меняет: откат не сработал.
  const st = run({ freezeSel: 2 });
  const rep = await settle(st);
  assert.equal(rep.ans.откат.сработал, false, 'откат объявлен сработавшим без сверки now');
  assert.ok(rep.ans.ВНИМАНИЕ && rep.ans.ВНИМАНИЕ.indexOf(SEL) >= 0, 'нет предупреждения: ' + rep.ans.ВНИМАНИЕ);
  assert.equal(st.done.backgroundColor, '#FF3B30');
  assert.ok(st.done.content.indexOf('откат: НЕТ') >= 0, st.done.content);
});

test('откат fallback не удался — предупреждение называет fallback', async () => {
  const st = run({ fallback: 'fix', noDelete: true, freezeFb: true });
  const rep = await settle(st);
  assert.equal(rep.ans.откат_fallback.сработал, false);
  assert.ok(rep.ans.ВНИМАНИЕ && rep.ans.ВНИМАНИЕ.indexOf(FB) >= 0, 'нет предупреждения: ' + rep.ans.ВНИМАНИЕ);
  assert.equal(st.done.backgroundColor, '#FF3B30');
});

// Запоздалый ответ в каждой фазе: чтения, первая запись, кириллица, снятие
// закрепления fallback. После сторожа допустим только откат SEL на DIRECT.
const LATE = {
  'начальное чтение': (c) => c.method === 'get',
  'первая запись': (c) => c.method === 'put',
  'запись кириллицы': (c) => c.method === 'put' && JSON.parse(c.body).name === FB,
  'снятие закрепления': (c) => c.method === 'delete',
  'чтение перед чужим именем': (() => { let n = 0; return (c) => c.method === 'get' && c.name === SEL && ++n === 4; })(),
  'закрепить fallback': (c) => c.method === 'put' && c.name === FB,
};
for (const [phase, late] of Object.entries(LATE)) {
  test('ответ пришёл после сторожа (' + phase + ') — один $done, только откат', async () => {
    const st = run({ late, fallback: 'fix' });
    const rep = await settle(st);
    await new Promise((r) => setTimeout(r, 450));   // запоздалый ответ и откат успеют
    assert.equal(st.doneCalls, 1, 'запоздалый ответ дал второй $done');
    assert.ok(rep.err.some((e) => e.indexOf('сторож') === 0), 'сторож не сработал');
    const after = st.calls.slice(st.lateIdx + 1).filter((c) => c.method !== 'get');
    for (const c of after) {
      const restore = (c.name === SEL && c.method === 'put' && JSON.parse(c.body).name === 'DIRECT') ||
        (c.name === FB && (phase === 'снятие закрепления' || phase === 'закрепить fallback'));
      assert.ok(restore, 'после сторожа новая запись: ' + c.method + ' ' + c.name + ' ' + c.body);
    }
    assert.equal(st.g[SEL].now, 'DIRECT', 'после сторожа выбор не возвращён');
    assert.equal(st.g[FB].now, 'DIRECT', 'после сторожа fallback не возвращён');
    assert.equal(st.g[FB].fixed, '', 'после сторожа fallback остался закреплённым');
  });
}

test('кириллица в адресе уходит закодированной', async () => {
  const st = run({ fallback: 'fix' });
  const rep = await settle(st);
  for (const c of st.calls) assert.ok(!/[^\x00-\x7F]/.test(c.url), 'незакодированный адрес: ' + c.url);
  assert.equal(rep.ans.выбор.сработал, true);
});

test('чужое имя сбило выбор — это видно в выводе', async () => {
  const st = run({ ghostShifts: true });
  const rep = await settle(st);
  assert.equal(rep.ans.чужое_имя.выбор_не_сбит, false);
  assert.ok(st.done.content.indexOf('ВЫБОР СБИТ: REJECT') >= 0, st.done.content);
  assert.equal(st.g[SEL].now, 'DIRECT', 'после сбоя выбор не возвращён');
});

test('в группе нет члена-кириллицы — шаг не делается, причина названа', async () => {
  const st = run({ noFbMember: true });
  const rep = await settle(st);
  assert.equal(typeof rep.ans.кириллица, 'string');
  assert.ok(!writes(st).some((c) => c.name === SEL && JSON.parse(c.body).name === FB), 'записан несуществующий член');
});

test('группы fallback нет — в неё не пишем, причина названа', async () => {
  const st = run({ noFb: true });
  await settle(st);
  assert.ok(!writes(st).some((c) => c.name === FB));
  assert.ok(st.done.content.indexOf('fallback: группы ' + FB + ' нет') >= 0, st.done.content);
});
