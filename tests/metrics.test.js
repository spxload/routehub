import test from 'node:test';
import assert from 'node:assert/strict';
import { T } from './harness.js';

// ── Отсечение сбойных замеров (v1.9.7) ──────────────────────────────────────
// Разбор среза 16.08 (ЗАМЕРЫ_И_ВЕСА.md): jit и bl дают около половины
// различий между узлами, и одиночный выброс отбрасывал быстрый узел на
// десятки позиций. Значение выше предела разумного — сбой замера, а не
// свойство узла, поэтому оно должно стать null и перестать наказывать.

test('metricOf: абсурдные jit и bl превращаются в null, нормальные проходят', () => {
  const ok = T.metricOf({ down: 20, rtt: 60, jit: 15, bl: 30, med: 61 });
  assert.equal(ok.jit, 15);
  assert.equal(ok.bl, 30);
  const badJit = T.metricOf({ down: 43, rtt: 93, jit: 23726, bl: 13 });
  assert.equal(badJit.jit, null, 'jit 23726 мс — это сбой пробы, не джиттер узла');
  assert.equal(badJit.bl, 13, 'исправное поле трогать нельзя');
  const badBl = T.metricOf({ down: 2, rtt: 96, jit: 11, bl: 8039 });
  assert.equal(badBl.bl, null);
  // на самой границе значение ещё считается настоящим
  const edge = T.metricOf({ down: 5, rtt: 60, jit: T.JIT_BAD, bl: T.BL_BAD });
  assert.equal(edge.jit, T.JIT_BAD);
  assert.equal(edge.bl, T.BL_BAD);
});

test('сбойный замер делает компонент нейтральным, а не худшим', () => {
  const fast = { down: 43, rtt: 93, med: 93, jit: null, bl: 13 };
  const slow = { down: 43, rtt: 93, med: 93, jit: 900, bl: 13 };
  assert.ok(T.scoreOf(fast, 70) > T.scoreOf(slow, 70),
    'узел со сбойным замером не должен проигрывать узлу с реально плохим джиттером');
  assert.equal(T.voiceOk({ down: 43, rtt: 93, med: 93, jit: null, bl: 13 }), false,
    'по сбойному замеру звонки обещать нельзя');
});
