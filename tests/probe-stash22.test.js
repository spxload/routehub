// Поведение пробы ST22 (группы-слоты на поставщике прокси) в песочнице с
// общим подставным контроллером tests/fake-stash.js (+ fake-stash-use.js).
//
// ЗАЧЕМ. ST22 — первая проба Lab, которая ПИШЕТ: PUT в тестовые группы
// RH-Т22-Фильтр и RH-Т22-F. Тест сторожит, что запись только туда, что
// выводы п1–п5 различают то, ради чего опыт (порядок поставщика против
// порядка фильтра, обновление в фоне против «не различить», сброс с
// обновлением поставщика против без него), и что окна EOF контроллера в фоне
// (до 30+ мин: ST21 — 33 мин) не ломают вывод о фоновом обновлении: он
// строится по первому удачному чтению после пропуска.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createStash, sandbox, settle, SECRET } from './fake-stash.js';
import { T } from './harness.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = 'probes/routehub-probe-stash22.js';
const CODE = fs.readFileSync(path.join(ROOT, FILE), 'utf8');

const P = 'RH-Т22-', PROV = 'rh-t22', MIN = 60000;
const FILT = P + 'Фильтр', FB = P + 'F', S1 = P + 'С1', S2 = P + 'С2', S3 = P + 'С3';
const N1 = P + '1', N2 = P + '2', N3 = P + '3';
const GROUPS = [FILT, S1, S2, S3, FB];
const FILTER = '^(?:RH-Т22-1|RH-Т22-2|RH-Т22-3|RH-Т22-Метка-\\d+)$';

// Поставщик так, как его отдал бы стенд в момент ms (скачан в ms).
const provAt = (ms, o = {}) => ({ proxies: T.STASH_LAB.t22Nodes(ms).filter((n) => !(o.drop || []).includes(n.name)),
  ...(o.upd ? { updatedAt: o.upd } : {}) });

function world(o = {}) {
  const g = {
    [FILT]: { type: 'Selector', use: [PROV], filter: FILTER },
    [S1]: { type: 'Selector', use: [PROV], filter: '^RH-Т22-1$' },
    [S2]: { type: 'Selector', use: [PROV], filter: '^RH-Т22-2$' },
    [S3]: { type: 'Selector', use: [PROV], filter: '^RH-Т22-3$' },
    [FB]: { type: 'Fallback', all: [S1, S2, S3] },
    'RH-RU': { type: 'Fallback', now: 'DIRECT', all: ['DIRECT', 'RH-Обход'] },
  };
  if (o.noGroups) for (const n of GROUPS) delete g[n];
  const w = createStash({ groups: g, providers: o.noProv ? {} : { [PROV]: provAt(1_800_000_000_000, o) }, ...(o.opts || {}) });
  return w;
}
// Stash перечитал поставщика в момент ms (по умолчанию — сейчас).
const refetch = (w, ms = w.clock.t, o = {}) => { w.providers[PROV] = provAt(ms, o); };
async function run(w, o = {}) {
  const s = sandbox(w, CODE, FILE, { extra: o.tile ? { $script: { type: 'tile' } } : {}, ...(o.sb || {}) });
  await settle(s, 5000, o.grace || 150);
  return s;
}
const state = (w) => JSON.parse(w.store.RH_ST22);
const journal = (w) => state(w).журнал;
const later = (w, ms = MIN) => { w.clock.t += ms; };
const dump = (s) => { const l = s.logs.find((x) => x.indexOf('[ST22] ') === 0); assert.ok(l, 'нет строки [ST22] в журнале'); return JSON.parse(l.slice(7)); };

test('запросы: GET групп Т22 и поставщика, PUT только в Фильтр и F (не первый член), секунды, секрет, без /delay', async () => {
  const w = world();
  const s = await run(w);
  const allowed = new Set([...GROUPS.map((g) => '/proxies/' + encodeURIComponent(g)), '/providers/proxies/' + PROV]);
  for (const c of w.calls) {
    assert.equal(c.timeout, 5, 'timeout у Stash в секундах: ' + c.timeout);
    assert.equal(c.auth, SECRET);
    assert.ok(allowed.has(c.p), 'путь ' + c.p);
    assert.ok(c.method === 'get' || c.method === 'put', c.method);
  }
  assert.deepEqual(w.writes().map((c) => [c.name, JSON.parse(c.body).name]), [[FILT, N2], [FB, S2]]);
  assert.equal(w.g[FILT].now, N2);
  assert.equal(w.g[FB].now, S2);
  assert.equal(w.calls.filter((c) => c.name === 'RH-RU').length, 0, 'боевая группа прочитана');
  assert.equal(s.done.content.indexOf('ST22'), 0);
  // Второй прогон без событий — закрепления держатся, записи нет.
  later(w);
  const n = w.writes().length;
  await run(w);
  assert.equal(w.writes().length, n, 'перезакрепление без сброса');
});

test('п1: порядок поставщика против порядка фильтра; метка в группе — та же, что у поставщика', async () => {
  const w = world();
  const a = dump(await run(w, { tile: true })).ans.ответы;
  assert.equal(a.п1_порядок, 'поставщика');
  assert.equal(a.п1_метка_в_группе, 'та же, что у поставщика');
  const wf = world({ opts: { useOrder: 'filter' } });
  assert.equal(dump(await run(wf, { tile: true })).ans.ответы.п1_порядок, 'фильтра');
  // Поставщик сам отдал порядок фильтра — вывод невозможен, а не «фильтра».
  const wq = world();
  wq.providers[PROV].proxies.reverse();
  assert.match(dump(await run(wq, { tile: true })).ans.ответы.п1_порядок, /^не различить/);
  // Ни то, ни другое — «иной» с составом, а не подгонка под одну из гипотез.
  const wi = world({ opts: { entry: (n, x, ww) => (n === FILT
    ? { name: n, type: 'Selector', now: N2, all: [N2, N1, N3] } : { name: n, type: x.type, now: ww.nowOf(n), all: x.all }) } });
  assert.equal(dump(await run(wi, { tile: true })).ans.ответы.п1_порядок, 'иной: ' + [N2, N1, N3].join(', '));
});

test('п2: группы-слоты — по одному члену; F — порядок перечисления; нет узла — «пусто», закрепления Фильтра нет', async () => {
  const a = dump(await run(world(), { tile: true })).ans.ответы;
  for (const sl of [S1, S2, S3]) assert.match(a.п2_слоты[sl], /^один член, now RH-Т22-\d$/);
  assert.equal(a.п2_fallback, 'порядок перечисления');
  const w = world({ drop: [N2] });
  const d = dump(await run(w, { tile: true })).ans;
  assert.equal(d.ответы.п2_слоты[S2], 'пусто');
  assert.match(d.ответы.п1_порядок, /^неполный состав/);
  assert.deepEqual(d.не_закреплено, [FILT + ': нет ' + N2 + ' в составе']);
  assert.deepEqual(w.writes().map((c) => c.name), [FB]);
});

test('п3: после пропуска метка сменилась, её окно кончилось раньше чтения — «в фоне»', async () => {
  const w = world();
  await run(w);
  const t1 = w.clock.t;
  later(w, 12 * MIN); refetch(w);          // Stash скачал файл в фоне, чтений нет
  later(w, 13 * MIN);                      // Диана открыла Stash через 25 мин
  const s = await run(w, { tile: true });
  const g = journal(w).filter((e) => e.вид === 'пропуск');
  assert.equal(g.length, 1);
  assert.equal(g[0].вывод, 'в_фоне');
  assert.equal(g[0].пропуск_мин, 25);
  assert.equal(state(w).фон[0].прошлое_чтение, new Date(t1).toISOString().slice(0, 19) + 'Z');
  const f = dump(s).ans.ответы.п3_фон;
  assert.deepEqual(f.после_пропусков, { в_фоне: 1, не_обновлялся: 0, не_различить: 0 });
  assert.equal(f.последний.вывод, 'в_фоне');
  assert.equal(f.последний.по, 'метке');
  assert.equal(f.последний.скачан_мин_назад, 12, 'конец минуты метки: скачан ≈ 12 мин назад');
  assert.equal(state(w).счёт.обновлений, 1);
});

test('п3: метка та же после пропуска — «не обновлялся»; метка текущего окна — «не различить»; пропуск < 10 мин — вывода нет', async () => {
  const w = world();
  await run(w);
  later(w, 30 * MIN);
  await run(w);
  assert.deepEqual(state(w).фонСчёт, { в_фоне: 0, не_обновлялся: 1, не_различить: 0 });
  later(w, 25 * MIN); refetch(w);          // скачан только что — при открытии?
  await run(w);
  assert.deepEqual(state(w).фонСчёт, { в_фоне: 0, не_обновлялся: 1, не_различить: 1 });
  later(w, 9 * MIN); refetch(w);
  await run(w);
  assert.equal(state(w).фон.length, 2, 'пропуск 9 мин дал вывод');
  assert.equal(state(w).счёт.обновлений, 2, 'смена метки без пропуска — обычное обновление');
});

test('п3 по метке: граница FG_MS — скачан за 2 мин до чтения «в фоне», позже — «не различить» (метка поминутная)', async () => {
  for (const [ago, want] of [[3, 'в_фоне'], [2, 'не_различить'], [1, 'не_различить']]) {
    const w = world();
    await run(w);
    later(w, 20 * MIN - ago * MIN); refetch(w);   // конец минуты метки — за (ago − 1) мин до чтения
    later(w, ago * MIN);
    await run(w);
    assert.equal(state(w).фон[0].вывод, want, 'скачан ' + ago + ' мин назад');
  }
});

test('п3 по updatedAt, если поле есть: оно главнее метки в обе стороны', async () => {
  const iso = (ms) => new Date(ms).toISOString();
  // Метка свежая (текущая минута), но updatedAt — середина пропуска → «в фоне».
  const w = world({ upd: iso(1_800_000_000_000) });
  await run(w);
  later(w, 25 * MIN); refetch(w, w.clock.t, { upd: iso(w.clock.t - 12 * MIN) });
  await run(w);
  assert.deepEqual([state(w).фон[0].вывод, state(w).фон[0].по], ['в_фоне', 'updatedAt']);
  // Метка давняя, но updatedAt — только что (скачан при открытии) → «не различить».
  const w2 = world({ upd: iso(1_800_000_000_000) });
  await run(w2);
  later(w2, 25 * MIN); refetch(w2, w2.clock.t - 12 * MIN, { upd: iso(w2.clock.t - 30000) });
  await run(w2);
  assert.deepEqual([state(w2).фон[0].вывод, state(w2).фон[0].по], ['не_различить', 'updatedAt']);
  // updatedAt не позже прошлого чтения — «не обновлялся», даже если метка другая.
  const w3 = world({ upd: iso(1_800_000_000_000 - MIN) });
  await run(w3);
  later(w3, 25 * MIN); refetch(w3, w3.clock.t - 12 * MIN, { upd: iso(1_800_000_000_000 - MIN) });
  await run(w3);
  assert.deepEqual([state(w3).фон[0].вывод, state(w3).фон[0].по], ['не_обновлялся', 'updatedAt']);
  // Метка та же, updatedAt новее прошлого чтения — решает updatedAt (метка не проверяется).
  const w5 = world({ upd: iso(1_800_000_000_000) });
  await run(w5);
  later(w5, 25 * MIN); w5.providers[PROV].updatedAt = iso(w5.clock.t - 12 * MIN);
  await run(w5);
  assert.deepEqual([state(w5).фон[0].вывод, state(w5).фон[0].по], ['в_фоне', 'updatedAt']);
  // Нечитаемый updatedAt — решение по метке.
  const w4 = world({ upd: 'вчера' });
  await run(w4);
  later(w4, 25 * MIN); refetch(w4, w4.clock.t - 12 * MIN, { upd: 'сегодня' });
  await run(w4);
  assert.deepEqual([state(w4).фон[0].вывод, state(w4).фон[0].по], ['в_фоне', 'метке']);
});

test('окна EOF в фоне: прогоны без ответа не трогают журнал; вывод — по первому удачному чтению, от прошлого удачного', async () => {
  const w = world();
  await run(w);
  const t1 = w.clock.t;
  for (let i = 0; i < 18; i++) {            // 18 мин EOF, как ST20–ST21
    later(w);
    if (i === 12) refetch(w);              // скачан на 13-й мин пропуска
    w.eofLeft = 100;
    const s = await run(w);
    assert.match(s.done.content, /КОНТРОЛЛЕР НЕ ОТВЕТИЛ/);
  }
  w.eofLeft = 0;
  later(w, 6 * MIN);
  await run(w);
  const J = journal(w);
  const win = J.find((e) => e.вид === 'окно');
  assert.ok(win && win.прогонов === 18, 'окно недоступности не записано');
  const g = J.find((e) => e.вид === 'пропуск');
  assert.equal(g.вывод, 'в_фоне');
  assert.ok(g.пропуск_мин >= 21, 'пропуск считается от прошлого удачного чтения: ' + g.пропуск_мин);
  assert.equal(state(w).фон[0].прошлое_чтение, new Date(t1).toISOString().slice(0, 19) + 'Z');
});

test('поставщик не прочитан (EOF только на нём): прошлое чтение не сдвигается, сброс не приписывается обновлению', async () => {
  const w = world({ opts: { eofWhen: (m, p, ww) => ww.eofProv && p.indexOf('/providers/') === 0 } });
  await run(w);
  const prev = state(w).прев.ms;
  later(w, 15 * MIN);
  w.eofProv = true;
  w.g[FILT].now = undefined;               // выбор сброшен
  await run(w);
  assert.equal(state(w).прев.ms, prev);
  assert.deepEqual(state(w).счёт.сбросов, { [FILT + ': поставщик не прочитан']: 1 });
  assert.equal(state(w).фон.length, 0);
});

test('п4: обновление поставщика сбросило выбор — сброс «с обновлением», перезакрепление, уведомление; держится — «пережило»', async () => {
  const w = world();
  await run(w);
  later(w, 11 * MIN); refetch(w);
  w.g[FILT].now = undefined;               // модель: select сброшен пересборкой
  const s = await run(w);
  const r = journal(w).find((e) => e.вид === 'сброс');
  assert.equal(r.г, FILT);
  assert.equal(r.было, N2);
  assert.match(r.стало, /^RH-Т22-Метка-\d+$/, 'после сброса — первый член в порядке поставщика (метка)');
  assert.equal(r.в_этом_окне, true);
  assert.equal(r.обновлений_за_время, 1);
  const C = state(w).счёт;
  assert.deepEqual(C.сбросов, { [FILT + ': с обновлением поставщика']: 1 });
  assert.deepEqual(C.пережило, { [FB]: 1 });
  assert.equal(C.закреплений[FILT], 2);
  assert.equal(w.g[FILT].now, N2, 'не закреплено снова');
  assert.match(s.note.b, new RegExp('сброс ' + FILT));
  // Сброс без обновления поставщика — отдельный счёт; уведомление о группе — один раз.
  later(w, 11 * MIN);
  w.g[FB].now = S1;
  const s2 = await run(w);
  assert.equal(state(w).счёт.сбросов[FB + ': без обновления поставщика'], 1);
  assert.match(s2.note.b, new RegExp('сброс ' + FB));
  later(w, 11 * MIN);
  w.g[FB].now = S1;
  const s3 = await run(w);
  assert.equal(s3.note, null, 'повторное уведомление о сбросе той же группы');
  assert.match(s3.done.content, /F: без обновления поставщика 2/);
});

test('п5: updatedAt нет — «нет данных»; есть — выгружается, и смена updatedAt — тоже обновление', async () => {
  const w = world();
  const a = dump(await run(w, { tile: true })).ans.ответы;
  assert.equal(a.п5_поставщик.updatedAt, 'нет данных');
  assert.equal(a.п5_поставщик.vehicleType, 'HTTP');
  assert.deepEqual(a.п5_поставщик.узлы.slice(1), [N3, N2, N1]);
  const w2 = world({ upd: '2026-09-27T10:00:00Z' });
  await run(w2);
  later(w2, 2 * MIN);
  w2.providers[PROV].updatedAt = '2026-09-27T10:05:00Z';
  const b = dump(await run(w2, { tile: true })).ans.ответы;
  assert.equal(b.п5_поставщик.updatedAt, '2026-09-27T10:05:00Z');
  assert.equal(journal(w2).find((e) => e.вид === 'поставщик').по, 'updatedAt');
});

test('нет групп Т22 и поставщика: вердикт «override не обновлён», ни записи, ни журнала; уведомление раз в 6 ч', async () => {
  const w = world({ noGroups: true, noProv: true });
  const s = await run(w);
  assert.match(s.done.content, /НЕТ ГРУПП Т22 И ПОСТАВЩИКА/);
  assert.deepEqual(w.writes(), []);
  assert.equal(w.store.RH_ST22, undefined);
  assert.match(s.note.b, /нет групп Т22/);
  later(w, 30 * MIN);
  assert.equal((await run(w)).note, null);
  // Только поставщика нет — прогон идёт, в выводе «нет».
  const w2 = world({ noProv: true });
  const d = dump(await run(w2, { tile: true })).ans;
  assert.equal(d.нет[0], 'поставщик ' + PROV);
  assert.equal(d.ответы.п5_поставщик, 'нет поставщика ' + PROV);
});

test('выгрузка — журнал скрипта одной строкой JSON; уведомление без clipboard, коротко; секрета и адреса контроллера нет', async () => {
  const w = world();
  const s = await run(w, { tile: true });
  assert.equal(s.note.o, null, 'опция уведомления (clipboard на устройстве не работает)');
  assert.equal(s.note.clip, null);
  assert.match(s.note.b, /журнал скрипта, строка \[ST22\]/);
  assert.ok(s.note.b.length < 400, 'уведомление не короткое');
  const line = s.logs.find((x) => x.indexOf('[ST22] ') === 0);
  assert.equal(line.indexOf('\n'), -1, 'выгрузка не одной строкой');
  for (const x of [line, s.note.b, s.done.content]) {
    assert.ok(x.indexOf('ОЧЕНЬ-СЕКРЕТНО') < 0 && x.indexOf('127.0.0.1') < 0);
  }
  assert.ok(CODE.indexOf('clipboard:') < 0, 'clipboard вернулся в код');
  // cron без событий — без уведомления.
  later(w);
  assert.equal((await run(w)).note, null);
});

test('замок, сторож, EOF с повтором, отказ записи: один $done, журнал целый', async () => {
  const w = world();
  w.store.RH_ST22_lock = String(w.clock.t - 1000) + ':1';
  const s = await run(w, { tile: true });
  assert.match(s.done.content, /^ЗАНЯТО: .* замок снимется не позже чем через 309 с/);
  assert.equal(dump(s).ans.замок_с, 309, 'срок — из значения замка: 310 с − 1 с');
  assert.equal(w.calls.length, 0);
  w.store.RH_ST22_lock = String(w.clock.t - 200500) + ':1';
  assert.match((await run(w, { tile: true })).done.content, /через 110 с/);
  w.store.RH_ST22_lock = '';
  const wh = world();
  wh.hang = true;
  const sh = await run(wh, { grace: 300 });
  assert.match(sh.done.content, /КОНТРОЛЛЕР НЕ ОТВЕТИЛ \(сторож\)/);
  assert.equal(wh.store.RH_ST22, undefined);
  assert.equal(wh.store.RH_ST22_lock, '');
  const we = world({ opts: { eof: 1 } });
  await run(we);
  assert.equal(we.calls[1].p, we.calls[0].p, 'нет повтора после EOF');
  assert.equal(state(we).прогонов, 1);
  const wr = world({ opts: { putReject: (n) => n === FB } });
  await run(wr);
  const e = journal(wr).find((x) => x.вид === 'запись');
  assert.equal(e.г, FB);
  assert.equal(e.статус, 400);
  assert.equal(state(wr).pin[FB], undefined);
  later(wr);
  await run(wr);
  assert.equal(wr.writes().filter((c) => c.name === FB).length, 2, 'после отказа — попытка в следующем прогоне');
});
