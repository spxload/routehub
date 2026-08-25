// routehub — модуль api/speed.js
// Эндпоинт /speed: приём метрик устройства, привязка ключа, конфликт nonce.
// Выделен из src/api.js 2026-08-25 (ветка stash-client): файл перешагнул
// порог 15 КБ. Логика НЕ менялась — только раскладка по файлам.
// История версий — CHANGELOG.md в корне репозитория.

import { KEY_RE } from '../const.js';
import { ensureFlags, ensureFreeSpare, kvGetJSON, kvPutJSON, kvPutManyJSON, loadRegistry, tokenGate } from '../store.js';
import { decodeName, fragOf, jsonResp, matchKey, metricOf } from '../util.js';

async function handleSpeed(req, env, tok) {
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }

  const key = (data && data.key) || '';
  const nonce = String((data && data.nonce) || '');
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  if (!nonce) return jsonResp({ error: 'no nonce' }, 400);

  const reg = await loadRegistry(env);
  if (!reg[key]) return jsonResp({ error: 'unknown key' }, 403);
  const badT = await tokenGate(env, reg, key, tok, false); if (badT) return badT;
  ensureFlags(reg);

  const now = new Date().toISOString();
  const e = reg[key];
  if (e.status === 'free') {
    e.status = 'bound'; e.nonce = nonce; e.first_seen = now; e.last_seen = now;
    ensureFreeSpare(reg); ensureFlags(reg);
  } else if (e.status === 'bound') {
    if (e.nonce !== nonce) {
      e.status = 'conflict';
      await kvPutJSON(env, 'devices', reg);
      return jsonResp({ error: 'nonce conflict' }, 409);
    }
    e.last_seen = now;
  } else {
    return jsonResp({ error: 'key in conflict' }, 409);
  }

  const state = (await kvGetJSON(env, 'metrics:' + key)) || {};
  let sentW = 0, sentC = 0;

  // v1.10.0: ОТМЕТКА ВРЕМЕНИ НА СЛОТ, а не одна на всю запись.
  // Устройство переотправляет оба своих кэша (rh_speed_wifi и rh_speed_cell)
  // при КАЖДОМ свипе, независимо от текущей сети — см. функцию send в
  // routehub-speedtest.js. Поэтому «пришло» не равно «измерено»: слот,
  // который телефон не мерил ни разу, приезжает снова и снова и выглядит
  // вечно свежим. Именно так замороженный сотовый кэш k2 (техдолг 11)
  // неотличим от настоящего замера.
  //
  // Признак настоящего замера — ИЗМЕНЕНИЕ значений. Совпало до последнего
  // поля — замера не было, прежняя отметка сохраняется. Совпадение всех
  // пяти чисел у живого узла между свипами практически невозможно;
  // у переотправленного кэша оно точное. Стороны ошибки неравноценны:
  // ложно «старое» безобидно, ложно «свежее» — то, ради чего это и делается.
  const nowMs = Date.now();

  // Часы телефона недоверенные: значение зажимается окном
  // [сейчас − 30 суток, сейчас + 5 минут]. Всё за его пределами — 0,
  // то есть «отметки нет», и дальше работает запасной путь.
  function clampTs(v) {
    const t = +v || 0;
    if (!t) return 0;
    if (t > nowMs + 5 * 60000) return 0;
    if (t < nowMs - 30 * 86400000) return 0;
    return t;
  }

  // ЗАПАСНОЙ ПУТЬ для устройств до speedtest v0.6.4, которые отметок не шлют.
  // Признак настоящего замера — изменение значений: совпало до последнего
  // поля, значит слот переотправлен из кэша и замера не было.
  // Оговорка: два разных сбойных jit оба схлопываются в null (v1.9.7) и
  // выглядят одинаковыми — ошибка в сторону «старо», она безобидна.
  function sameMetric(a, b) {
    if (!a || !b) return false;
    if (a.dead || b.dead) return !!a.dead === !!b.dead;
    return a.down === b.down && a.rtt === b.rtt && a.jit === b.jit &&
      a.bl === b.bl && a.med === b.med;
  }

  function apply(arr, slot) {
    if (!Array.isArray(arr)) return;
    for (const s of arr) {
      if (!s || !s.name) continue;
      const k = matchKey(String(s.name));
      if (!state[k]) state[k] = {};
      const prev = state[k][slot];
      const next = metricOf(s);
      // ОТМЕТКА ВРЕМЕНИ НА СЛОТ (v1.10.0).
      // Устройство переотправляет ОБА своих кэша при каждом свипе,
      // независимо от текущей сети (функция send в routehub-speedtest.js).
      // Поэтому «пришло» не равно «измерено»: слот, который телефон не мерил
      // ни разу, приезжает снова и снова и выглядит вечно свежим — именно так
      // замороженный сотовый кэш k2 неотличим от настоящего замера
      // (техдолг 11).
      // Приоритет — отметке САМОГО устройства: только оно знает, когда узел
      // мерили. `ts` — полный замер скорости, `tsp` — последний пинг; они
      // расходятся, потому что лёгкий пинг-свип обновляет rtt/jit, не трогая
      // down. Возраст балла определяется именно `ts`: на down приходится
      // 0.40 веса.
      const devTs = clampTs(s.ts);
      const devTsp = clampTs(s.tsp);
      if (devTs || devTsp) {
        next.ts = devTs || devTsp;
        if (devTsp) next.tsp = devTsp;
      } else if (sameMetric(prev, next)) {
        // Значения не изменились. Если у прежней записи отметки не было
        // (запись сделана до v1.10.0), возраст неизвестен — честнее null,
        // чем «только что»: иначе замороженный слот показал бы нулевой
        // возраст ровно в тот момент, ради которого всё и делалось.
        next.ts = (prev && prev.ts) || null;
        if (prev && prev.tsp) next.tsp = prev.tsp;
      } else {
        next.ts = nowMs;
      }
      state[k][slot] = next;
      if (slot === 'w') sentW++; else sentC++;
    }
  }
  apply(data.wifi, 'w');
  apply(data.cell, 'c');

  // v1.9.0: отсечение МЁРТВЫХ МЕТРИК — ключей, которых нет в текущей подписке.
  // Критерий один: фактический состав sub_cache (без порогов по возрасту).
  // ПРЕДОХРАНИТЕЛЬ: подписка недоступна, не распарсилась или дала 0 строк ->
  // чистка пропускается целиком. Иначе один сбой Lastdep стёр бы накопленное.
  let pruned = 0;
  try {
    const sub = await kvGetJSON(env, 'sub_cache');
    const lines = (sub && sub.text) ? sub.text.split('\n').filter(Boolean) : [];
    if (lines.length) {
      const live = {};
      for (const line of lines) live[matchKey(decodeName(fragOf(line)))] = 1;
      for (const k in state) if (!(k in live)) { delete state[k]; pruned++; }
    }
  } catch (e) { pruned = 0; }

  let labeled = 0;
  for (const k in state) if (state[k] && (state[k].w || state[k].c)) labeled++;

  // Парная запись одним обращением к D1 (атомарно): метрики + реестр.
  await kvPutManyJSON(env, [['metrics:' + key, state], ['devices', reg]]);

  return jsonResp({ ok: true, key: key, status: e.status, labeled: labeled, pruned: pruned, sent_wifi: sentW, sent_cell: sentC });
}

export { handleSpeed };
