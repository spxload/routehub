import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, nodeLine } from './mock-d1.js';
import { T, worker, req, post, DE } from './harness.js';

const NAME = '[VPN] ' + DE + ' Германия #1';
const SUB_TS = { ts: Date.now(), n: 1, text: nodeLine(NAME), meta: {} };

function speed(env, slot, m) {
  const body = { key: 'k1', nonce: 'n-1', wifi: [], cell: [] };
  body[slot === 'w' ? 'wifi' : 'cell'] = [Object.assign({ name: NAME }, m)];
  return worker.fetch(post('https://w.invalid/speed', body), env);
}
function slotOf(env, slot) {
  const st = env.RH_DB.get('metrics:k1');
  assert.ok(st, 'метрики не записались');
  const rec = st[Object.keys(st)[0]];
  return rec[slot];
}

// ── Винзоризация при приёме (v1.10.2) ───────────────────────────────────────
// Разбор среза 16.08 (ЗАМЕРЫ_И_ВЕСА.md, предложение 2): jit и bl дают около
// половины различий между узлами, и одиночный выброс отбрасывал быстрый узел
// на десятки позиций. Значение выше потолка — сбой замера, а не свойство
// узла, поэтому оно ОБРЕЗАЕТСЯ потолком.
// Почему не null, как делала v1.9.7: null в scoreOf означает нейтральный
// компонент (лучший из возможных), и на пороге возникал обрыв — чуть более
// испорченный замер вознаграждался. Это проверяется отдельным тестом ниже.

test('metricOf: jit и bl обрезаются потолком, нормальные значения проходят', () => {
  const ok = T.metricOf({ down: 20, rtt: 60, jit: 15, bl: 30, med: 61 });
  assert.equal(ok.jit, 15);
  assert.equal(ok.bl, 30);
  const wild = T.metricOf({ down: 43, rtt: 93, jit: 23726, bl: 8039 });
  assert.equal(wild.jit, T.JIT_CAP, 'jit 23726 мс обрезается до потолка');
  assert.equal(wild.bl, T.BL_CAP, 'bl 8039 мс обрезается до потолка');
  assert.notEqual(wild.jit, null, 'выброс обрезается, а не отбрасывается');
  assert.notEqual(wild.bl, null);
  const mixed = T.metricOf({ down: 43, rtt: 93, jit: 23726, bl: 13 });
  assert.equal(mixed.bl, 13, 'исправное поле трогать нельзя');
  // на самом потолке и под ним значение проходит как есть
  const edge = T.metricOf({ down: 5, rtt: 60, jit: T.JIT_CAP, bl: T.BL_CAP });
  assert.equal(edge.jit, T.JIT_CAP);
  assert.equal(edge.bl, T.BL_CAP);
  const near = T.metricOf({ down: 5, rtt: 60, jit: T.JIT_CAP - 1, bl: T.BL_CAP - 1 });
  assert.equal(near.jit, T.JIT_CAP - 1);
  assert.equal(near.bl, T.BL_CAP - 1);
  // отсутствующий буфер — это не выброс, он обязан остаться null
  assert.equal(T.metricOf({ down: 5, rtt: 60, jit: 5 }).bl, null);
});

test('потолок стоит там, где его поставил разбор замеров', () => {
  // Значения не произвольные: ЗАМЕРЫ_И_ВЕСА.md, предложение 2 — «порядка
  // 300 и 500 мс». Тест держит их на месте: молчаливый откат к прежним
  // JIT_BAD 1000 / BL_BAD 2000 вернул бы в рейтинг замеры, которые документ
  // считает не состоявшимися.
  assert.equal(T.JIT_CAP, 300);
  assert.equal(T.BL_CAP, 500);
  // Потолок обязан лежать ВЫШЕ порогов голосовой пригодности, иначе
  // обрезанный (то есть сбойный) замер начнёт обещать звонки.
  assert.ok(T.JIT_CAP > T.VOICE_JIT, 'обрезанный jit должен оставаться отказом для ☎');
  assert.ok(T.BL_CAP > T.VOICE_BL, 'обрезанный bl должен оставаться отказом для ☎');
  assert.equal(T.voiceOk(T.metricOf({ down: 43, rtt: 93, med: 93, jit: 23726, bl: 13 })), false,
    'по сбойному замеру звонки обещать нельзя');
});

test('балл по джиттеру нигде не растёт: обрыва на потолке нет', () => {
  // Главная причина, по которой null заменён потолком. При обнулении в null
  // (v1.9.7) последовательность была немонотонной: jit 999 -> худший балл,
  // jit 1001 -> лучший. Проверяем по всей шкале, включая обе прежние границы.
  const at = (jit) => T.scoreOf(T.metricOf({ down: 43, rtt: 93, med: 93, jit: jit, bl: 13 }), 70);
  const seq = [0, 5, 50, 299, 300, 301, 999, 1000, 1001, 23726];
  for (let i = 1; i < seq.length; i++) {
    assert.ok(at(seq[i]) <= at(seq[i - 1]),
      'балл вырос при росте джиттера: ' + seq[i - 1] + ' -> ' + seq[i]);
  }
  assert.ok(at(23726) < at(5), 'сбойный замер не должен идти наравне с чистым');
  assert.ok(at(23726) > -1, 'узел с диким джиттером не выбывает из рейтинга (-1 = мёртвый)');

  // То же самое для буфера. Тут обрыв был ещё заметнее: bl выше порога
  // становился null, а null в scoreOf выбрасывает слагаемое буфера целиком
  // и делит остаток на 0.9 — то есть сбойный замер получал ПРЕМИЮ.
  const bat = (bl) => T.scoreOf(T.metricOf({ down: 43, rtt: 93, med: 93, jit: 9, bl: bl }), 70);
  const bseq = [0, 20, 499, 500, 501, 1999, 2000, 2001, 8039];
  for (let i = 1; i < bseq.length; i++) {
    assert.ok(bat(bseq[i]) <= bat(bseq[i - 1]),
      'балл вырос при росте буфера: ' + bseq[i - 1] + ' -> ' + bseq[i]);
  }
});

test('scoreOf по-прежнему понимает jit === null: так лежат записи v1.9.7', () => {
  // Старые слоты в D1 никто не переписывает, и до следующего замера они
  // приходят в scoreOf как есть.
  const old = { down: 43, rtt: 93, med: 93, jit: null, bl: 13 };
  assert.ok(T.scoreOf(old, 70) > 0, 'запись с jit null не должна ломать балл');
  assert.equal(T.voiceOk(old), false, 'по записи без джиттера звонки обещать нельзя');
});

// ── Отметка времени на слот (v1.10.0) ───────────────────────────────────────
// Устройство переотправляет оба своих кэша при каждом свипе, поэтому по
// факту прихода нельзя судить о свежести. Признак настоящего замера —
// изменение значений. Проверяется через POST /speed целиком: логика живёт
// в handleSpeed, а не в чистой функции.

test('первый замер получает отметку времени', async () => {
  const env = makeEnv({ sub_cache: SUB_TS });
  await speed(env, 'w', { down: 20, rtt: 60, jit: 5, bl: 10 });
  assert.ok(slotOf(env, 'w').ts > 0, 'отметки времени нет');
});

test('переотправка тех же значений НЕ обновляет отметку — замороженный кэш виден', async () => {
  const env = makeEnv({ sub_cache: SUB_TS });
  const m = { down: 7, rtt: 96, jit: 8, bl: 53 };
  await speed(env, 'c', m);
  const first = slotOf(env, 'c').ts;
  await new Promise(function (r) { setTimeout(r, 5); });
  await speed(env, 'c', m);
  assert.equal(slotOf(env, 'c').ts, first,
    'значения не изменились — значит замера не было, отметка должна остаться прежней');
});

test('изменение хотя бы одного поля обновляет отметку', async () => {
  const env = makeEnv({ sub_cache: SUB_TS });
  await speed(env, 'w', { down: 20, rtt: 60, jit: 5, bl: 10 });
  const first = slotOf(env, 'w').ts;
  await new Promise(function (r) { setTimeout(r, 5); });
  await speed(env, 'w', { down: 20, rtt: 61, jit: 5, bl: 10 });
  assert.ok(slotOf(env, 'w').ts > first, 'rtt изменился — отметка обязана обновиться');
});

test('дашборд отдаёт возраст замера по каждому узлу', async () => {
  const env = makeEnv({ sub_cache: SUB_TS });
  await speed(env, 'w', { down: 20, rtt: 60, jit: 5, bl: 10 });
  const tok = env.RH_DB.get('devices').k1.token;
  const r = await worker.fetch(req('https://w.invalid/t/' + tok + '/dashboard?key=k1'), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.nodes.wifi) && j.nodes.wifi.length, 'в дашборде нет узлов Wi-Fi');
  assert.equal(j.nodes.wifi[0].age_min, 0, 'только что записанный замер должен быть нулевого возраста');
});

test('запись без отметки (до v1.10.0) при тех же значениях остаётся без отметки', async () => {
  const env = makeEnv({ sub_cache: SUB_TS });
  await speed(env, 'c', { down: 7, rtt: 96, jit: 8, bl: 53 });
  // имитируем старую запись: отметку убираем, значения оставляем
  const st = env.RH_DB.get('metrics:k1');
  const k = Object.keys(st)[0];
  delete st[k].c.ts;
  env.RH_DB.set('metrics:k1', st);
  await speed(env, 'c', { down: 7, rtt: 96, jit: 8, bl: 53 });
  assert.equal(slotOf(env, 'c').ts, null,
    'возраст неизвестен — null честнее, чем «только что»');
});

test('отметка устройства важнее серверной догадки', async () => {
  const env = makeEnv({ sub_cache: SUB_TS });
  const dev = Date.now() - 3 * 3600 * 1000;   // замер трёхчасовой давности
  await speed(env, 'w', { down: 20, rtt: 60, jit: 5, bl: 10, ts: dev, tsp: dev + 60000 });
  const m = slotOf(env, 'w');
  assert.equal(m.ts, dev, 'сервер обязан взять время замера с устройства');
  assert.equal(m.tsp, dev + 60000, 'пинг имеет собственную отметку');
});

test('отметка устройства из будущего или из прошлого века отбрасывается', async () => {
  const env = makeEnv({ sub_cache: SUB_TS });
  await speed(env, 'w', { down: 20, rtt: 60, jit: 5, bl: 10, ts: Date.now() + 86400000 });
  const t1 = slotOf(env, 'w').ts;
  assert.ok(t1 <= Date.now() + 1000, 'время из будущего принимать нельзя');
  const env2 = makeEnv({ sub_cache: SUB_TS });
  await speed(env2, 'w', { down: 20, rtt: 60, jit: 5, bl: 10, ts: 1 });
  assert.ok(slotOf(env2, 'w').ts > Date.now() - 60000, 'абсурдно старое время тоже отбрасывается');
});

test('дашборд различает возраст замера скорости и возраст пинга', async () => {
  const env = makeEnv({ sub_cache: SUB_TS });
  const now = Date.now();
  await speed(env, 'w', { down: 20, rtt: 60, jit: 5, bl: 10, ts: now - 120 * 60000, tsp: now - 10 * 60000 });
  const tok = env.RH_DB.get('devices').k1.token;
  const j = await (await worker.fetch(req('https://w.invalid/t/' + tok + '/dashboard?key=k1'), env)).json();
  const n = j.nodes.wifi[0];
  assert.equal(n.age_min, 120, 'возраст балла считается по замеру скорости');
  assert.equal(n.ping_age_min, 10, 'пинг свежее — и это должно быть видно');
});

// ── Сводка по возрасту в админ-панели (v1.10.1) ─────────────────────────────
// Замороженный слот виден только при разглядывании всего списка узлов.
// Сводка сводит это к одной строке: «0 из N с отметкой» = слот не мерялся.

test('/admin/state отдаёт сводку по возрасту замеров, по слоту', async () => {
  const env = makeEnv({ sub_cache: SUB_TS });
  const now = Date.now();
  await speed(env, 'w', { down: 20, rtt: 60, jit: 5, bl: 10, ts: now - 30 * 60000 });
  const r = await worker.fetch(req('https://w.invalid/admin/state?key=' + env.ADMIN_KEY), env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.metrics_age, 'сводки по возрасту нет');
  assert.equal(j.metrics_age.w.with_ts, 1);
  assert.equal(j.metrics_age.w.no_ts, 0);
  assert.equal(j.metrics_age.w.oldest_min, 30);
  assert.equal(j.metrics_age.c.total, 0, 'сотовых замеров не было вовсе');
});

test('слот без отметок виден в сводке как no_ts', async () => {
  const env = makeEnv({ sub_cache: SUB_TS });
  const m = { down: 7, rtt: 96, jit: 8, bl: 53 };
  await speed(env, 'c', m);
  // убираем отметку, как у записи до v1.10.0, и шлём те же значения
  const st = env.RH_DB.get('metrics:k1');
  delete st[Object.keys(st)[0]].c.ts;
  env.RH_DB.set('metrics:k1', st);
  await speed(env, 'c', m);
  const j = await (await worker.fetch(req('https://w.invalid/admin/state?key=' + env.ADMIN_KEY), env)).json();
  assert.equal(j.metrics_age.c.total, 1);
  assert.equal(j.metrics_age.c.with_ts, 0, 'слот переотправлен из кэша — отметки быть не должно');
  assert.equal(j.metrics_age.c.no_ts, 1);
  assert.equal(j.metrics_age.c.oldest_min, null);
});
