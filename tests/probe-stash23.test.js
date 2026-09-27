// Поведение пробы ST23 (fallback на поставщике: порядок поставщика, первый
// живой) в песочнице с подставным контроллером tests/fake-stash.js
// (+ fake-stash-use.js).
//
// ЗАЧЕМ. ST23 — только чтение: GET двух тестовых групп и поставщика. Тест
// сторожит, что других запросов нет, что вывод различает «now = первый
// живой» / «муляж» / «нет» / «нет данных», что смена окна между чтениями
// (поставщик перечитан в фоне) видна как переход, и что EOF-окна в фоне
// (30+ мин, ST21) не трогают журнал.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStash, sandbox, settle, SECRET } from './fake-stash.js';
import { T } from './harness.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = 'probes/routehub-probe-stash23.js';
const CODE = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
const BARE = CODE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // код без комментариев

const L = T.STASH_LAB;
const P = 'RH-Т23-', PROV = 'rh-t23', MIN = 60000, WIN = 600000;
const F = P + 'F', FF = P + 'FF', NA = P + 'A', NC = P + 'C', DEAD = P + 'Муляж';
const MS = 1_800_000_000_000;        // чётное окно; часы fake-stash стартуют здесь

// Поставщик так, как его отдал бы стенд в момент ms.
const provAt = (ms, o = {}) => ({ proxies: L.t23Nodes(ms).map((n) => ({ name: n.name, ...(o.alive && n.name in o.alive ? { alive: o.alive[n.name] } : {}) })) });

// Модель fallback: первый член, который ядро считает живым. dead — имена,
// которые ядро считает мёртвыми (по умолчанию муляж); stuck — «застрявший»
// now (модель несовпадения).
function world(o = {}) {
  const g = {
    [F]: { type: 'Fallback', use: [PROV] },
    [FF]: { type: 'Fallback', use: [PROV], filter: '^RH-Т23-' },
    'RH-RU': { type: 'Fallback', now: 'DIRECT', all: ['DIRECT', 'RH-Обход'] },
  };
  if (o.noGroups) { delete g[F]; delete g[FF]; }
  const w = createStash({ groups: g, providers: o.noProv ? {} : { [PROV]: provAt(o.at || MS, o) },
    nowOf: (n, x, ww) => {
      if (!x.use) return x.now;
      if (ww.stuck && ww.stuck[n]) return ww.stuck[n];
      const dead = ww.dead || [DEAD];
      return x.all.find((m) => dead.indexOf(m) < 0);
    }, ...(o.opts || {}) });
  return w;
}
const refetch = (w, ms = w.clock.t) => { w.providers[PROV] = provAt(ms); };
async function run(w, o = {}) {
  const s = sandbox(w, CODE, FILE, { extra: o.tile ? { $script: { type: 'tile' } } : {}, ...(o.sb || {}) });
  await settle(s, 5000, o.grace || 150);
  return s;
}
const state = (w) => JSON.parse(w.store.RH_ST23);
const journal = (w) => state(w).журнал;
const later = (w, ms = MIN) => { w.clock.t += ms; };
const dump = (s) => { const l = s.logs.find((x) => x.indexOf('[ST23] ') === 0); assert.ok(l, 'нет строки [ST23]'); return JSON.parse(l.slice(7)); };

test('запросы: только GET F, FF и поставщика; timeout в секундах; секрет; ни PUT, ни /delay, ни боевых групп', async () => {
  const w = world();
  const s = await run(w);
  const allowed = new Set(['/proxies/' + encodeURIComponent(F), '/proxies/' + encodeURIComponent(FF), '/providers/proxies/' + PROV]);
  assert.equal(w.calls.length, 3);
  for (const c of w.calls) {
    assert.equal(c.method, 'get');
    assert.equal(c.timeout, 5, 'timeout у Stash в секундах: ' + c.timeout);
    assert.equal(c.auth, SECRET);
    assert.ok(allowed.has(c.p), 'путь ' + c.p);
  }
  assert.deepEqual(w.writes(), []);
  assert.equal(s.done.content.indexOf('ST23'), 0);
  for (const x of ['$httpClient.put', '/delay', 'setSelectPolicy', 'setRunningModel', "'PUT'", "'POST'"]) {
    assert.ok(BARE.indexOf(x) < 0, 'в пробе ' + x);
  }
});

test('совпадение: чётное окно — now A («да»); нечётное — now C при муляже первым («да при мёртвом первом»)', async () => {
  const w = world();
  const d = dump(await run(w, { tile: true })).ans;
  assert.equal(d.сейчас[F].совпадение, 'да');
  assert.equal(d.сейчас[F].порядок, 'поставщика');
  assert.equal(d.сейчас[F].первый_живой, NA);
  assert.equal(d.сейчас[F].живость_по, 'устройству стенда');
  assert.deepEqual(d.вывод, { [F]: 'да', [FF]: 'да' });
  assert.equal(state(w).счёт[F].да_при_мёртвом_первом, 0);
  const w2 = world({ at: MS + WIN });
  w2.clock.t = MS + WIN;
  const d2 = dump(await run(w2, { tile: true })).ans;
  assert.equal(d2.сейчас[FF].now, NC);
  assert.equal(d2.сейчас[FF].совпадение, 'да');
  assert.equal(state(w2).счёт[FF].да_при_мёртвом_первом, 1);
  assert.equal(journal(w2)[0].ждём, 'C');
  assert.equal(journal(w2)[0].по_окну, 'нечёт');
  assert.match(d2 && dump(await run(w2, { tile: true })).ans.ВЕРДИКТ, /now = первый живой в порядке поставщика: F — да/);
});

test('несовпадение: now застрял на живом, но не первом живом — «нет», вывод «нет», уведомление', async () => {
  const w = world({ at: MS + WIN });
  w.clock.t = MS + WIN;
  assert.match((await run(w)).note.b, /запуск/);
  later(w);
  w.stuck = { [F]: NA };
  const s = await run(w);
  const d = dump(s).ans;
  assert.equal(d.сейчас[F].совпадение, 'нет');
  assert.equal(d.сейчас[FF].совпадение, 'да');
  assert.equal(d.вывод[F], 'нет');
  assert.match(s.note.b, /нет: F now A, первый живой C/);
  // Второе «нет» (другая группа) через минуту — cron молчит (пауза 10 мин).
  later(w);
  w.stuck = { [F]: NA, [FF]: NA };
  const s2 = await run(w);
  assert.equal(s2.note, null, 'уведомление чаще раза в 10 мин');
  assert.equal(dump(s2).ans.вывод[FF], 'нет');
});

test('муляж: now = Муляж — отдельный счёт и «подряд макс», не «нет»; поле alive поставщика главнее устройства стенда', async () => {
  const w = world({ at: MS + WIN });
  w.clock.t = MS + WIN;
  w.dead = [];                              // ядро ещё не проверило новый узел
  await run(w);
  later(w); await run(w);
  const st = state(w);
  assert.equal(st.счёт[F].муляж, 2);
  assert.equal(st.счёт[F].нет, 0);
  assert.equal(st.муляжМакс[F], 2);
  w.dead = [DEAD]; later(w); await run(w);
  assert.equal(state(w).муляжПодряд[F], 0);
  // alive: true у муляжа в поставщике — первый живой по полю, now = Муляж — «да».
  const w2 = world({ at: MS + WIN, alive: { [DEAD]: true } });
  w2.clock.t = MS + WIN;
  w2.dead = [];
  const d = dump(await run(w2, { tile: true })).ans;
  assert.equal(d.сейчас[F].совпадение, 'да');
  assert.equal(d.сейчас[F].живость_по, 'полю alive');
  // alive: false у A — первый живой B.
  const w3 = world({ alive: { [NA]: false } });
  w3.dead = [DEAD, NA];
  const d3 = dump(await run(w3, { tile: true })).ans;
  assert.equal(d3.сейчас[F].первый_живой, P + 'B');
  assert.equal(d3.сейчас[F].совпадение, 'да');
  // Не логическое alive (строка) — не поле: живость по устройству стенда.
  const w4 = world({ at: MS + WIN, alive: { [DEAD]: 'true' } });
  w4.clock.t = MS + WIN;
  w4.dead = [];
  const d4 = dump(await run(w4, { tile: true })).ans;
  assert.equal(d4.сейчас[F].совпадение, 'муляж');
  assert.equal(d4.сейчас[F].живость_по, 'устройству стенда');
});

test('смена окна между чтениями: переход записан, now перешёл на новый первый живой; без смены — перехода нет', async () => {
  const w = world();
  await run(w);
  later(w, 3 * MIN); await run(w);
  assert.equal(state(w).переходы.length, 0);
  later(w, 9 * MIN); refetch(w);            // окно нечётное, поставщик перечитан
  later(w, MIN);
  const d = dump(await run(w, { tile: true })).ans;
  const tr = state(w).переходы;
  assert.equal(tr.length, 2, 'по переходу на каждую группу');
  assert.deepEqual([tr[0].г, tr[0].было, tr[0].стало, tr[0].now_было, tr[0].now_стало, tr[0].перешёл, tr[0].пропуск_мин],
    ['F', 'чёт', 'нечёт', 'A', 'C', true, 10]);
  assert.deepEqual(tr[0].all, ['Муляж', 'C', 'B', 'A']);
  assert.deepEqual(d.смен[F], { увидено: 1, now_перешёл: 1 });
  // Застрял после смены — переход без «перешёл».
  later(w, 10 * MIN); refetch(w);
  w.stuck = { [FF]: NC };
  later(w, MIN); await run(w);
  assert.deepEqual(state(w).смен[FF], { увидено: 2, now_перешёл: 1 });
  assert.equal(state(w).переходы.slice(-1)[0].перешёл, false);
});

test('отставание поставщика: окно по времени сменилось, файл ещё старый — «ждём» по окну, совпадение по .all', async () => {
  const w = world();
  later(w, WIN + MIN);                     // нечётное окно, поставщик не перечитан
  const d = dump(await run(w, { tile: true })).ans;
  const e = journal(w)[0];
  assert.equal(e.ждём, 'C');
  assert.equal(e.поставщик, 'чёт');
  assert.deepEqual(e.F, { v: 'чёт', now: 'A', ок: 'да' });
  assert.equal(d.сейчас[F].совпадение, 'да');
});

test('порядок не поставщика (группа отдаёт иной порядок) — «не различить», а не «да»', async () => {
  const w = world({ opts: { entry: (n, x, ww) => (n === F
    ? { name: n, type: 'Fallback', now: NA, all: [P + 'C', P + 'B', NA] } : { name: n, type: x.type, now: ww.nowOf(n), all: x.all }) } });
  const d = dump(await run(w, { tile: true })).ans;
  assert.equal(d.сейчас[F].порядок, 'иной');
  assert.equal(d.сейчас[F].совпадение, 'нет');
  // Иной порядок при now = первый живой — всё равно «не различить», не «да».
  const wi = world({ opts: { entry: (n, x, ww) => (n === F
    ? { name: n, type: 'Fallback', now: NC, all: [NC, P + 'B', NA] } : { name: n, type: x.type, now: ww.nowOf(n), all: x.all }) } });
  const di = dump(await run(wi, { tile: true })).ans;
  assert.equal(di.сейчас[F].совпадение, 'да');
  assert.match(di.вывод[F], /^не различить: порядок в группе не поставщика/);
  const w2 = world({ opts: { useOrder: 'filter' } });
  w2.providers[PROV].proxies.reverse();     // поставщик C, B, A; группа — тоже
  const d2 = dump(await run(w2, { tile: true })).ans;
  assert.equal(d2.сейчас[F].порядок, 'поставщика');
  assert.equal(d2.вывод[F], 'да');
  // Нет now — «нет данных», отсутствие поля не «жив».
  const w3 = world({ opts: { entry: (n, x) => ({ name: n, type: x.type, all: x.all }) } });
  const d3 = dump(await run(w3, { tile: true })).ans;
  assert.equal(d3.сейчас[F].совпадение, 'нет_данных');
  assert.equal(d3.вывод[F], 'не различить');
});

test('EOF-окно в фоне: прогоны без ответа журнал не трогают; окно и переход — по следующему удачному чтению', async () => {
  const w = world();
  await run(w);
  const runs = state(w).прогонов;
  for (let i = 0; i < 20; i++) {
    later(w);
    if (i === 12) refetch(w);
    w.eofLeft = 100;
    const s = await run(w);
    assert.match(s.done.content, /КОНТРОЛЛЕР НЕ ОТВЕТИЛ/);
  }
  assert.equal(state(w).прогонов, runs, 'EOF-прогон тронул журнал');
  w.eofLeft = 0;
  later(w, 5 * MIN);
  await run(w);
  const J = journal(w);
  const win = J.find((e) => e.вид === 'окно');
  assert.ok(win && win.прогонов === 20, 'окно недоступности не записано');
  const tr = state(w).переходы[0];
  assert.equal(tr.перешёл, true);
  assert.ok(tr.пропуск_мин >= 25, 'пропуск от прошлого удачного чтения: ' + tr.пропуск_мин);
});

test('нет групп Т23: вердикт «override не обновлён», журнал не тронут, уведомление раз в 6 ч; нет поставщика — идёт', async () => {
  const w = world({ noGroups: true, noProv: true });
  const s = await run(w);
  assert.match(s.done.content, /НЕТ ГРУПП Т23/);
  assert.equal(w.store.RH_ST23, undefined);
  assert.match(s.note.b, /нет групп Т23/);
  later(w, 30 * MIN);
  assert.equal((await run(w)).note, null);
  const w2 = world({ noProv: true });
  const d = dump(await run(w2, { tile: true })).ans;
  assert.equal(d.нет[0], 'поставщик ' + PROV);
  assert.equal(d.поставщик, undefined);
  assert.equal(d.сейчас[F].совпадение, 'нет_данных', 'пустой состав — не «да»');
});

test('выгрузка — одна строка [ST23]; уведомление без clipboard, коротко; секрета и адреса контроллера нет', async () => {
  const w = world();
  const s = await run(w, { tile: true });
  assert.equal(s.note.o, null);
  assert.match(s.note.b, /журнал скрипта, строка \[ST23\]/);
  assert.ok(s.note.b.length < 400);
  const line = s.logs.find((x) => x.indexOf('[ST23] ') === 0);
  assert.equal(line.indexOf('\n'), -1);
  for (const x of [line, s.note.b, s.done.content]) assert.ok(x.indexOf('ОЧЕНЬ-СЕКРЕТНО') < 0 && x.indexOf('127.0.0.1') < 0);
  assert.ok(BARE.indexOf('clipboard') < 0);
  later(w);
  assert.equal((await run(w)).note, null, 'cron без событий — без уведомления');
});

test('замок, сторож, EOF с повтором: один $done, журнал целый', async () => {
  const w = world();
  w.store.RH_ST23_lock = String(w.clock.t - 1000) + ':1';
  const s = await run(w, { tile: true });
  assert.match(s.done.content, /^ЗАНЯТО: .* через 309 с/);
  assert.equal(w.calls.length, 0);
  const wh = world();
  wh.hang = true;
  const sh = await run(wh, { grace: 300 });
  assert.match(sh.done.content, /КОНТРОЛЛЕР НЕ ОТВЕТИЛ \(сторож\)/);
  assert.equal(wh.store.RH_ST23, undefined);
  assert.equal(wh.store.RH_ST23_lock, '');
  const we = world({ opts: { eof: 1 } });
  await run(we);
  assert.equal(we.calls[1].p, we.calls[0].p, 'нет повтора после EOF');
  assert.equal(state(we).прогонов, 1);
});

// ── СТОРОЖ И CRON (дефект ST14; как у ST21/ST22) ──
const numOf = (k) => Number(CODE.match(new RegExp('var ' + k + ' = (\\d+)'))[1]);

test('сторож позже худшего честного пути с повтором и растяжением фона (ST14)', () => {
  const worst = numOf('BUDGET_MS') + 2 * numOf('CTRL_SEC') * 1000 + 4 * 1000;
  assert.ok(numOf('GUARD_MS') > worst, 'сторож ' + numOf('GUARD_MS') + ' мс не позже худшего пути ' + worst + ' мс');
  assert.equal(numOf('WIN_MS'), L.T23_WINDOW_MS, 'окно пробы разошлось с окном стенда');
});

test('timeout задания cron в Lab не меньше сторожа и бюджета пробы', () => {
  const ov = fs.readFileSync(path.join(ROOT, 'plugins/RouteHub-Stash-Lab.stoverride'), 'utf8');
  const to = Number(/\n {6}timeout:\s*(\d+)/.exec(ov)[1]) * 1000;
  assert.ok(to >= numOf('GUARD_MS'), 'cron обрывает прогон (' + to + ' мс) раньше сторожа');
  assert.ok(to >= numOf('BUDGET_MS'));
  assert.ok(numOf('LOCK_MS') > to, 'замок короче timeout cron');
});
