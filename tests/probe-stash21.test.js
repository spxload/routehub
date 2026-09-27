// Поведение пробы ST21 (почему DIRECT в RH-RU «тайм-аут»), только чтение, в
// песочнице с общим подставным контроллером tests/fake-stash.js.
//
// ЗАЧЕМ. ST21 обязана отличать падение alive у DIRECT вместе с новой записью
// history (плановый замер) от падения без неё (событие — вероятно, dial), и
// не выдавать отсутствие поля за «жив». И — ничего не писать: ни PUT, ни
// /delay (замер сам выставляет alive — это запись в маршрутизацию).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStash, sandbox, settle, SECRET } from './fake-stash.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = 'probes/routehub-probe-stash21.js';
const CODE = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
const OV = fs.readFileSync(path.join(ROOT, 'plugins/RouteHub-Stash-ST21.stoverride'), 'utf8');

const RU = 'RH-RU', MAIN = 'RH-Главный', BYP = 'RH-Обход';
const CLOCK = 'RH-Часы', TEST = 'RH-Тест-RU', DRU = 'RH-Прямо-RU';
const B1 = '🇩🇪 Узел [Обход - МТС]', B2 = '🇫🇮 Узел [Обход]';
const TARGETS = ['DIRECT', RU, MAIN, CLOCK, TEST, DRU];
const MIN = 60000;

function world(o = {}) {
  const g = {
    DIRECT: { type: 'Direct', alive: true, history: [] },
    [RU]: { type: 'Fallback', now: 'DIRECT', all: ['DIRECT', BYP] },
    [MAIN]: { type: 'Fallback', now: 'DIRECT', all: ['DIRECT', 'RH-АВТО'] },
    [CLOCK]: { type: 'URLTest', now: 'DIRECT', all: ['DIRECT'], history: [] },
    [TEST]: { type: 'URLTest', now: DRU, all: [DRU], history: [] },
    [DRU]: { type: 'Direct', alive: true, history: [] },
    [BYP]: { type: 'Fallback', now: B1, all: [B1, B2] },
    [B1]: { type: 'Vless', alive: true, history: [] },
    [B2]: { type: 'Vless', alive: false, history: [] },
    'RH-АВТО': { type: 'Fallback', now: 'X', all: ['X'] },
  };
  if (o.noClock) delete g[CLOCK];
  if (o.noWatchOv) { delete g[TEST]; delete g[DRU]; }
  if (o.noRu) { delete g[RU]; delete g[MAIN]; }
  return createStash({ groups: g, aliveField: o.fields !== false, historyField: o.fields !== false, ...(o.opts || {}) });
}
// Новая запись history — как плановый замер ядра: время — часы контроллера.
function measure(w, name, delay) {
  const h = w.g[name].history;
  h.push({ time: new Date(w.clock.t).toISOString(), delay });
  if (h.length > 10) h.shift();
}
async function run(w, o = {}) {
  const s = sandbox(w, CODE, FILE, { extra: o.tile ? { $script: { type: 'tile' } } : {}, ...(o.sb || {}) });
  await settle(s, 5000, o.grace || 150);
  return s;
}
const state = (w) => JSON.parse(w.store.RH_ST21);
const journal = (w) => state(w).журнал;
const later = (w, ms = MIN) => { w.clock.t += ms; };
const clip = (s) => JSON.parse(s.note.clip);

test('только GET /proxies/{имя}: цели, RH-Обход и его члены; timeout в секундах; секрет; без /delay', async () => {
  const w = world();
  const s = await run(w);
  assert.ok(w.calls.length > 0);
  for (const c of w.calls) {
    assert.equal(c.method, 'get', 'метод ' + c.method);
    assert.match(c.p, /^\/proxies\/[^/?]+$/, 'путь ' + c.p);
    assert.equal(c.timeout, 5, 'timeout у Stash в секундах: ' + c.timeout);
    assert.equal(c.auth, SECRET);
  }
  const names = new Set(w.calls.map((c) => c.name));
  assert.deepEqual([...names].sort(), [...TARGETS, BYP, B1, B2].sort());
  assert.deepEqual(w.writes(), []);
  assert.deepEqual(w.puts, {});
  assert.equal(s.done.content.split('\n')[0].indexOf('ST21'), 0);
});

test('alive DIRECT падает БЕЗ новой записи history — «событие (dial?)»', async () => {
  const w = world();
  await run(w);
  later(w);
  w.g.DIRECT.alive = false;
  await run(w);
  const e = journal(w).filter((x) => x.вид === 'alive');
  assert.equal(e.length, 1);
  assert.equal(e[0].г, 'DIRECT');
  assert.equal(e[0].было, true);
  assert.equal(e[0].стало, false);
  assert.equal(e[0].history, 'без замера');
  assert.equal(e[0].признак, 'событие (dial?)');
  assert.equal(state(w).счёт.падений['DIRECT: без замера'], 1);
});

test('alive DIRECT падает С новой записью history — «плановый замер»; подъём тоже различается', async () => {
  const w = world();
  measure(w, 'DIRECT', 90);
  await run(w);
  later(w);
  w.g.DIRECT.alive = false;
  measure(w, 'DIRECT', 0);
  await run(w);
  later(w);
  w.g.DIRECT.alive = true;
  const s = await run(w);
  const e = journal(w).filter((x) => x.вид === 'alive');
  assert.equal(e.length, 2);
  assert.equal(e[0].признак, 'плановый замер');
  assert.equal(e[0].history, 'замер');
  assert.equal(e[0].d, 0);
  assert.equal(e[1].стало, true);
  assert.equal(e[1].признак, 'без замера');
  const C = state(w).счёт;
  assert.equal(C.падений['DIRECT: замер'], 1);
  assert.equal(C.подъёмов['DIRECT: без замера'], 1);
  assert.match(s.done.content, /DIRECT alive падал 1 \(без замера 0\)/);
});

test('RH-Прямо-RU: переход alive журналируется так же, как у DIRECT', async () => {
  const w = world();
  await run(w);
  later(w);
  w.g[DRU].alive = false;
  measure(w, DRU, 0);
  await run(w);
  const e = journal(w).filter((x) => x.вид === 'alive');
  assert.equal(e.length, 1);
  assert.equal(e[0].г, DRU);
  assert.equal(e[0].признак, 'плановый замер');
});

test('RH-RU уходит на обход и возвращается: переходы, время на обходе, уведомление cron об уходе', async () => {
  const w = world();
  const s1 = await run(w);
  assert.ok(s1.note, 'первый запуск уведомляет');
  assert.deepEqual(clip(s1).почему, ['запуск']);
  later(w);
  const s2 = await run(w);
  assert.equal(s2.note, null, 'обычный прогон cron молчит');
  later(w);
  w.g[RU].now = BYP;
  const s3 = await run(w);
  assert.ok(s3.note, 'уход с DIRECT — уведомление');
  assert.match(s3.note.b, /RH-RU ушла с DIRECT на RH-Обход/);
  later(w, 7 * MIN);
  w.g[RU].now = 'DIRECT';
  const s4 = await run(w);
  assert.equal(s4.note, null, 'возврат не уведомляет');
  const e = journal(w).filter((x) => x.вид === 'выбор');
  assert.equal(e.length, 2);
  assert.deepEqual([e[0].было, e[0].стало], ['DIRECT', BYP]);
  assert.deepEqual([e[1].было, e[1].стало], [BYP, 'DIRECT']);
  assert.ok(e[1].наОбходе_с >= 420 && e[1].наОбходе_с < 430, 'время на обходе: ' + e[1].наОбходе_с);
  const C = state(w).счёт;
  assert.equal(C.ушла[RU], 1);
  assert.equal(C.вернулась[RU], 1);
  assert.equal(C.наОбходеМакс[RU], e[1].наОбходе_с);
  assert.match(s4.done.content, /RH-RU ушла 1, вернулась 1 \(макс на обходе \d+ с\)/);
  // Второй уход в пределах 10 мин от уведомления — в журнал, но без уведомления.
  later(w);
  w.g[RU].now = BYP;
  const s5 = await run(w);
  assert.equal(s5.note, null, 'уведомление чаще раза в 10 мин');
  assert.equal(journal(w).filter((x) => x.вид === 'выбор').length, 3);
  // RH-Главный — так же.
  later(w, 11 * MIN);
  w.g[MAIN].now = 'RH-АВТО';
  const s6 = await run(w);
  assert.ok(s6.note);
  assert.match(s6.note.b, /RH-Главный ушла с DIRECT/);
});

test('поля alive и history нет — «нет данных», а не «жив»; переходов alive не выдумывает', async () => {
  const w = world({ fields: false });
  await run(w);
  later(w);
  w.g.DIRECT.alive = false;
  const s = await run(w, { tile: true });
  assert.equal(journal(w).filter((x) => x.вид === 'alive').length, 0);
  const c = clip(s);
  assert.equal(c.ans.сейчас.DIRECT.alive, 'нет данных');
  assert.equal(c.ans.сейчас.DIRECT.history, 'нет данных');
  assert.equal(c.ans.обход.нет_данных, 2);
  assert.equal(c.ans.обход.живы, 0);
  assert.match(s.done.content, /alive у DIRECT: нет данных/);
});

test('history без новой записи против «нет поля» в прошлом ответе: не различить', async () => {
  const w = world({ fields: false });
  await run(w);
  later(w);
  // Stash начал отдавать поля (например, после обновления) — сравнивать не с чем.
  w.g.DIRECT.alive = false;
  const w2 = world();
  w2.store = w.store; w2.clock.t = w.clock.t; w2.g.DIRECT.alive = false;
  await run(w2);
  assert.equal(JSON.parse(w2.store.RH_ST21).журнал.filter((x) => x.вид === 'alive').length, 0,
    'переход alive из «нет данных» — не переход');
  later(w2);
  w2.g.DIRECT.alive = true;
  await run(w2);
  const e = JSON.parse(w2.store.RH_ST21).журнал.filter((x) => x.вид === 'alive');
  assert.equal(e.length, 1);
  assert.equal(e[0].признак, 'без замера');
});

test('замеры с тем же исходом склеиваются; смена исхода — новая запись', async () => {
  const w = world();
  await run(w);
  for (let i = 0; i < 3; i++) { later(w); measure(w, CLOCK, 80 + i); await run(w); }
  later(w); measure(w, CLOCK, 0); await run(w);
  const e = journal(w).filter((x) => x.вид === 'замер' && x.г === CLOCK);
  assert.equal(e.length, 2);
  assert.equal(e[0].n, 3);
  assert.equal(e[0].ок, true);
  assert.equal(e[0].d, 82);
  assert.equal(e[1].ок, false);
  assert.equal(state(w).счёт.замеров[CLOCK], 4);
});

test('обходные узлы: только чтение, счёт живых, смена счёта — в журнал', async () => {
  const w = world();
  const s1 = await run(w, { tile: true });
  assert.deepEqual(
    { живы: clip(s1).ans.обход.живы, мертвы: clip(s1).ans.обход.мертвы, всего: clip(s1).ans.обход.всего },
    { живы: 1, мертвы: 1, всего: 2 });
  later(w);
  w.g[B2].alive = true;
  await run(w);
  const e = journal(w).filter((x) => x.вид === 'обход');
  assert.equal(e.length, 1);
  assert.deepEqual([e[0].было, e[0].стало], ['1/1/0', '2/0/0']);
  assert.deepEqual(w.bypass, []);
  assert.deepEqual(w.writes(), []);
});

test('RH-Обход с заглушкой DIRECT — DIRECT не считается обходным узлом', async () => {
  const w = world();
  w.g[BYP].all = ['DIRECT']; w.g[BYP].now = 'DIRECT';
  const s = await run(w, { tile: true });
  assert.equal(clip(s).ans.обход, undefined);
});

test('профиль без S-draft-9 (нет RH-Часы): сказано, DIRECT и RH-RU всё равно пишутся', async () => {
  const w = world({ noClock: true });
  const s = await run(w, { tile: true });
  assert.match(s.done.content, /нет RH-Часы — профиль стенда не обновлён до S-draft-9/);
  assert.ok(s.done.content.indexOf('override Watch') < 0, 'Watch стоит — о нём молчать');
  const c = clip(s);
  assert.equal(c.ans.сейчас[CLOCK], 'нет в профиле');
  assert.equal(c.ans.сейчас[RU].now, 'DIRECT');
  assert.ok(w.store.RH_ST21);
});

test('без override Watch: RH-Прямо-RU / RH-Тест-RU — «нет данных», не ошибка; журнал ведётся', async () => {
  const w = world({ noWatchOv: true });
  await run(w);
  later(w);
  w.g.DIRECT.alive = false;
  const s = await run(w, { tile: true });
  assert.match(s.done.content, /нет RH-Тест-RU, RH-Прямо-RU — override Watch не стоит: RH-Прямо-RU нет данных/);
  assert.ok(s.done.content.indexOf('профиль стенда не обновлён') < 0, 'отсутствие override — не «профиль не обновлён»');
  const c = clip(s);
  assert.equal(c.ans.сейчас[DRU], 'нет данных (override Watch не стоит)');
  assert.equal(c.ans.сейчас[TEST], 'нет данных (override Watch не стоит)');
  assert.equal(c.ans.сейчас[CLOCK].alive, 'нет данных');
  assert.deepEqual(c.err, []);
  assert.equal(c.ans.отказы, undefined, '404 override — не отказ чтения');
  assert.equal(journal(w).filter((x) => x.вид === 'alive' && x.г === 'DIRECT').length, 1);
  assert.equal(journal(w).filter((x) => x.г === DRU).length, 0);
});

test('не профиль стенда (нет RH-RU и RH-Главный): журнал не тронут', async () => {
  const w = world({ noRu: true });
  const s = await run(w);
  assert.match(s.done.content, /НЕТ RH-RU И RH-Главный/);
  assert.equal(w.store.RH_ST21, undefined);
  assert.ok(s.note, 'первый раз — уведомление «нет групп»');
  const s2 = await run(w);
  assert.equal(s2.note, null, 'повтор — не чаще раза в 6 ч');
});

test('контроллер молчит: сторож, один $done, журнал не тронут; следующий удачный прогон пишет окно', async () => {
  const w = world();
  await run(w);
  const before = w.store.RH_ST21;
  later(w);
  w.hang = true;
  const s = await run(w);
  assert.match(s.done.content, /КОНТРОЛЛЕР НЕ ОТВЕТИЛ \(сторож\)/);
  assert.equal(w.store.RH_ST21, before);
  assert.equal(JSON.parse(w.store.RH_ST21_fail).n, 1);
  assert.equal(w.store.RH_ST21_lock, '', 'замок снят');
  w.hang = false;
  later(w, 5 * MIN);
  await run(w);
  const e = journal(w).filter((x) => x.вид === 'окно');
  assert.equal(e.length, 1);
  assert.equal(e[0].прогонов, 1);
});

test('EOF: одно — повтор и нормальный прогон; все — отказ без записи журнала', async () => {
  const w = world({ opts: { eof: 1 } });
  await run(w);
  assert.ok(w.store.RH_ST21, 'после одного EOF прогон удачен');
  assert.equal(w.calls[0].name, w.calls[1].name, 'повтор того же чтения');
  const w2 = world({ opts: { eofWhen: () => true } });
  const s2 = await run(w2);
  assert.match(s2.done.content, /КОНТРОЛЛЕР НЕ ОТВЕТИЛ \(все чтения/);
  assert.equal(w2.store.RH_ST21, undefined);
});

test('запоздалый ответ после сторожа не даёт второго $done', async () => {
  const w = world({ opts: { late: () => true, lateMs: 300 } });
  const s = await run(w, { grace: 450 });
  assert.equal(s.doneCalls, 1);
  assert.match(s.done.content, /сторож/);
});

// В Stash таймер сторожа может не сняться (clearTimeout — не гарантия
// рантайма): сторож после обычного $done не должен дать второй.
test('clearTimeout не работает — сторож после $done второго $done не даёт', async () => {
  const w = world();
  const s = await run(w, { sb: { extra: { clearTimeout: () => {} } }, grace: 300 });
  assert.equal(s.doneCalls, 1);
  assert.ok(w.store.RH_ST21, 'обычный прогон сохранён');
  assert.equal(JSON.parse(w.store.RH_ST21_fail || '{}').n, undefined, 'сторож после $done записал отказ');
});

test('замок занят: cron молчит и ничего не читает; плитка говорит «ЗАНЯТО»', async () => {
  const w = world();
  w.store.RH_ST21_lock = String(w.clock.t - 1000) + ':1';
  const s = await run(w);
  assert.equal(w.calls.length, 0);
  assert.equal(s.note, null);
  const s2 = await run(w, { tile: true });
  assert.match(s2.note.t + s2.note.s, /ЗАНЯТО/);
});

test('плитка: сводка в буфер обмена — сейчас, журнал, счёт; без хостов и секретов', async () => {
  const w = world();
  await run(w);
  later(w);
  w.g.DIRECT.alive = false;
  const s = await run(w, { tile: true });
  const c = clip(s);
  assert.equal(c.rev, 'ST21');
  assert.equal(c.ans.тип, 'плитка');
  assert.ok(Array.isArray(c.ans.журнал) && c.ans.журнал.length >= 1);
  assert.equal(c.ans.сейчас.DIRECT.alive, false);
  assert.ok(c.ans.счёт);
  assert.ok(s.note.clip.indexOf(SECRET) < 0, 'секрет контроллера в выгрузке');
  assert.ok(s.note.clip.indexOf('127.0.0.1') < 0, 'адрес контроллера в выгрузке');
});

test('миллисекунды вместо секунд ловятся: timeout каждого запроса ≤ 30', async () => {
  const w = world();
  await run(w);
  assert.ok(w.calls.every((c) => typeof c.timeout === 'number' && c.timeout > 0 && c.timeout <= 30));
});

test('override ST21: только cron, плитка и скрипт; ни групп, ни правил, ни MITM', () => {
  assert.match(OV, /cron: '\* \* \* \* \*'/);
  assert.match(OV, /probes\/routehub-probe-stash21\.js/);
  assert.match(OV, /timeout: 300/, 'timeout cron — дольше растянутого сторожа, как у ST20');
  for (const k of ['proxy-groups:', 'proxies:', 'rules:', 'mitm', 'hostname']) {
    assert.ok(OV.indexOf(k) < 0, 'в override ST21 есть ' + k);
  }
  const code = CODE.replace(/\/\*[\s\S]*?\*\//, '').replace(/\/\/.*$/gm, '');
  assert.ok(code.indexOf('/delay') < 0, 'в коде пробы (без комментариев) — /delay');
  const used = [...code.matchAll(/\$httpClient\s*(?:\.\s*(\w+)|\[)/g)].map((m) => m[1] || '[');
  assert.ok(used.length > 0);
  assert.deepEqual([...new Set(used)], ['get'], 'у $httpClient вызывается не только get: ' + used.join(','));
});

// ── СТОРОЖ И CRON (дефект ST14) ──────────────────────────────────────
// Худший честный путь: последний запрос стартует у края бюджета, ждёт
// CTRL_SEC, повтор после обрыва — 1 с, растянутая фоном Stash до 4 с, и ещё
// CTRL_SEC. Сторож считается без растяжения — так граница строже.
const numOf = (k) => Number(CODE.match(new RegExp('var ' + k + ' = (\\d+)'))[1]);

test('сторож позже худшего честного пути с повтором и растяжением фона (ST14)', () => {
  const worst = numOf('BUDGET_MS') + 2 * numOf('CTRL_SEC') * 1000 + 4 * 1000;
  assert.ok(numOf('GUARD_MS') > worst, 'сторож ' + numOf('GUARD_MS') + ' мс не позже худшего пути ' + worst + ' мс');
});

test('timeout задания cron не меньше сторожа пробы', () => {
  const to = Number(/timeout:\s*(\d+)/.exec(OV)[1]) * 1000;
  assert.ok(to >= numOf('GUARD_MS'), 'cron обрывает прогон (' + to + ' мс) раньше сторожа (' + numOf('GUARD_MS') + ' мс)');
  assert.ok(to >= numOf('BUDGET_MS'), 'cron обрывает прогон раньше бюджета');
});
