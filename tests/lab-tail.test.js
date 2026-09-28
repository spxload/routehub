// Живой журнал опыта (`.claude/tools/lab-tail.js`): автомат «событие хвоста →
// строки о переменах».
//
// ЗАЧЕМ. Каждая напечатанная строка будит сессию и тратит контекст; каждая
// пропущенная — упущенный вопрос Диане во время опыта. Тест держит обе
// стороны: лишнего не печатать, перемены не терять, адреса и токены из
// события наружу не выпускать.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../.claude/tools/lab-tail.js');

const W = 600000;
const K = 2984324; // чётное окно — «жизнь»
const at = (min, sec = 0) => K * W + min * 60000 + sec * 1000;
const pulse = (ms, t, dead = false) => ({ ms, j: { lab: 't24-pulse', t, 'мёртв': dead } });

test('labEntries берёт только JSON с полем lab и не несёт адрес запроса', () => {
  const ev = {
    eventTimestamp: at(0),
    event: { request: { url: 'https://x.workers.dev/t/SECRET/nodes' } },
    logs: [
      { message: ['{"lab":"t24-pulse","t":"t24na","ts":"2026-09-28T11:11:04.167Z"}'], timestamp: 1 },
      { message: ['обычная строка'], timestamp: 2 },
      { message: ['{"нет":"lab"}'], timestamp: 3 },
      { message: ['{битый'], timestamp: 4 },
    ],
  };
  const out = T.labEntries(ev);
  assert.equal(out.length, 1);
  assert.equal(out[0].j.t, 't24na');
  assert.equal(out[0].ms, Date.parse('2026-09-28T11:11:04.167Z'));
  assert.doesNotMatch(JSON.stringify(out), /SECRET/);
  assert.deepEqual(T.labEntries(null), []);
});

test('первая проверка метки — «ожила … впервые», повтор через минуту — тишина', () => {
  const st = T.createState();
  assert.deepEqual(T.feed(st, pulse(at(1), 't24na', true)), ['14:21 ожила na (впервые за сеанс)']);
  assert.deepEqual(T.feed(st, pulse(at(2), 't24na')), []);
});

test('метка молчала ≥ 5 мин — «ожила, молчала N мин»; 4 мин 59 с — нет', () => {
  const st = T.createState();
  T.feed(st, pulse(at(0), 't24la'));
  assert.deepEqual(T.feed(st, pulse(at(4, 59), 't24la')), []);
  assert.deepEqual(T.feed(st, pulse(at(9, 59), 't24la')), ['14:29 ожила la (молчала 5 мин)']);
});

test('метка «мёртв» и живая — одна метка для «ожила», разные для счёта окна', () => {
  const st = T.createState();
  T.feed(st, pulse(at(1), 't24ta', true));
  assert.deepEqual(T.feed(st, pulse(at(2), 't24ta')), []);
  assert.deepEqual(st.counts, { 'ta†': 1, ta: 1 });
});

test('итог окна печатается на первом событии следующего окна', () => {
  const st = T.createState();
  T.feed(st, pulse(at(1), 't24nb'));
  T.feed(st, pulse(at(2), 't24nb'));
  T.feed(st, { ms: at(3), j: { lab: 't24-nodes', g: 'n' } });
  const out = T.feed(st, pulse(at(11), 't24nb', true));
  assert.equal(out[0], '14:20 окно (жизнь) · проверки: nb×2 · скачано: n');
  assert.deepEqual(st.counts, { 'nb†': 1 }); // новое окно начато с этого события
  assert.equal(st.win, K + 1);
});

test('tick: итог закрытого окна без новых событий, затем тишина один раз', () => {
  const st = T.createState();
  T.feed(st, pulse(at(1), 't24ctl'));
  assert.deepEqual(T.tick(st, at(4, 59)), []);
  assert.deepEqual(T.tick(st, at(5)), ['14:25 тишина: событий нет 4 мин']);
  assert.deepEqual(T.tick(st, at(6)), []);
  const out = T.tick(st, at(10, 30));
  assert.deepEqual(out, ['14:20 окно (жизнь) · проверки: ctl×1 · скачано: нет']);
});

test('после тишины — «пауза кончилась» с длительностью', () => {
  const st = T.createState();
  T.feed(st, pulse(at(1), 't24ctl'));
  T.tick(st, at(6));
  const out = T.feed(st, pulse(at(8), 't24ctl'));
  assert.equal(out[0], '14:28 пауза кончилась: тишина 7 мин');
  assert.equal(st.quiet, false);
});

test('окно смерти помечено; отчёт пробы печатается сжатым и без поля lab', () => {
  const st = T.createState();
  const ms = (K + 1) * W + 60000;
  T.feed(st, pulse(ms, 't24na', true));
  const out = T.feed(st, { ms: ms + 1000, j: { lab: 'report', now: { N: 'B' } } });
  assert.deepEqual(out, ['14:31 отчёт {"now":{"N":"B"}}']);
  assert.match(T.winSummary(st), /окно \(смерть\)/);
});
