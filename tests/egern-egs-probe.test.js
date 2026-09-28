// Сводная проба Egern EGS: скрипт probes/routehub-probe-egern-egs.js на
// подменном ctx (по образцу подменного контроллера Stash: всё, к чему скрипт
// обращается, записывается; сети нет; время — подменное).
//
// ЗАЧЕМ. Выводы пробы уходят в решение «переносить стенд на Egern». Ложное
// «да» (нет данных прочитано как успех) или «нет» без контроля в том же
// прогоне — хуже, чем отсутствие пробы. Скрипт ходит только на стенд и только
// через DIRECT и тестовые группы (правило 1), ничего не пишет в маршрутизацию
// (правило 2), timeout ctx.http — миллисекунды, в журнал не попадают SSID,
// BSSID, IP и оператор.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'probes/routehub-probe-egern-egs.js'), 'utf8');
// data: URL — мимо хука Text (tests/text-loader.mjs) и без записи на диск.
const MOD = await import('data:text/javascript;base64,' + Buffer.from(SRC).toString('base64'));
const STAND = 'https://routehub-stash.proton4iker.workers.dev';
const W = 600000;
const EVEN = 3000000 * W + 5 * 60000;        // чётное окно, 5-я минута
const ODD = EVEN + W;                         // нечётное окно, 5-я минута
const CRON = '5,15,25,35,45,55 * * * *';
const SCRIPT_POLICIES = ['DIRECT', 'EGS-ORD', 'EGS-REJ', 'EGS-DA', 'EGS-DB', 'EGS-SUBS', 'EGS-DIE-S', 'EGS-COND', 'EGS-GRP', 'EGS-N1', 'EGS-NOPE', 'EGS-DEAD-3'];
const BACKGROUND = ['EGS-F60', 'EGS-F60N', 'EGS-A30', 'EGS-SM', 'EGS-DG', 'EGS-SUB', 'EGS-NAT', 'EGS-DIE-R'];
const SECRETS = ['SECRET', '10.20.30', 'fe80', 'aa:bb:cc', 'Carrier'];

// Поведение стенда и групп по умолчанию — «всё как задумано» в данном окне.
function world(over) {
  return Object.assign({
    ctl: { status: 204, ms: 30 },
    'EGS-ORD': { status: 204, ms: 40 },
    'EGS-REJ': { throw: 'rejected', ms: 2 },          // REJECT считается живым и выбран
    'EGS-DA': { status: 204, ms: 40 },
    'EGS-DB': { throw: 'rejected', ms: 2 },           // B ушёл на REJECT
    'EGS-SUBS': { status: 204, ms: 40 },
    'EGS-DIE-S': { throw: 'rejected', ms: 2 },        // ушёл с DIRECT
    'EGS-COND': { status: 204, ms: 40 },
    'EGS-GRP': { status: 204, ms: 40 },               // группы находятся по имени
    'EGS-N1': { throw: 'connect timeout 192.0.2.71', ms: 5000 },
    'EGS-NOPE': { status: 404, ms: 3 },
    'EGS-DEAD-3': { throw: 'connect timeout 192.0.2.63', ms: 5000 },
    to: { throw: 'The request timed out', ms: 3004 },
  }, over || {});
}

function fakeCtx(o) {
  const clock = o.clock, pending = [], calls = [], notes = [], seen = new Set();
  const store = o.store || new Map();
  const net = o.net || 'wifi';
  const plain = {
    script: { name: o.cron ? 'EGS-cron' : 'EGS-net' },
    app: { version: '2.20.0', language: 'ru' },
    env: {},
    device: {
      wifi: { ssid: net === 'wifi' ? 'Home-SECRET-SSID' : null, bssid: net === 'wifi' ? 'aa:bb:cc:dd:ee:ff' : null },
      cellular: { carrier: 'SECRET-Carrier', radio: net === 'none' ? null : 'CTRadioAccessTechnologyLTE' },
      ipv4: { address: '10.20.30.40', gateway: '10.20.30.1', interface: 'en0' },
      ipv6: { address: 'fe80::1234:5678', interface: 'en0' },
      dnsServers: ['10.20.30.1'],
    },
    http: {
      get(url, opt) {
        calls.push({ url, opt });
        const b = o.respond(url, opt || {});
        return new Promise((res, rej) => pending.push({ at: clock.t + (b.ms || 1), settle: () => (b.throw
          ? rej(new Error(b.throw)) : res({ status: b.status, headers: {}, text: async () => '' })) }));
      },
    },
    storage: {
      getJSON(k) { if (o.storageThrows) throw new Error('storage'); return store.has(k) ? JSON.parse(store.get(k)) : null; },
      setJSON(k, v) { store.set(k, JSON.stringify(v)); },
    },
    notify(n) { if (o.notifyThrows) throw new Error('notify'); notes.push(n); },
  };
  if (o.cron) plain.cron = o.cron;
  Object.assign(plain, o.extra || {});
  const ctx = new Proxy(plain, { get(t, k) { if (typeof k === 'string') seen.add(k); return t[k]; } });
  return { ctx, calls, notes, store, seen, pending, clock };
}

// Прогон: время подменено; ответы выдаются по одному в порядке готовности,
// с продвижением часов — elapsed каждого запроса равен его задержке.
async function run(f) {
  const realNow = Date.now, realLog = console.log, logs = [];
  Date.now = () => f.clock.t;
  console.log = (...a) => { logs.push(a.map(String).join(' ')); };
  let done = false, err = null;
  const p = MOD.default(f.ctx).then(() => { done = true; }, (e) => { done = true; err = e; });
  try {
    for (let i = 0; !done; i++) {
      assert.ok(i < 5000, 'скрипт завис');
      await new Promise((r) => setImmediate(r));
      if (f.pending.length) {
        f.pending.sort((a, b) => a.at - b.at);
        const e = f.pending.shift();
        if (e.at > f.clock.t) f.clock.t = e.at;
        e.settle();
      }
    }
    await p;
  } finally { Date.now = realNow; console.log = realLog; }
  assert.equal(err, null, 'скрипт бросил исключение наружу');
  const lines = logs.filter((s) => s.indexOf('[EGS] ') === 0);
  return { logs, lines, dump: lines.length ? JSON.parse(lines[lines.length - 1].slice(6)) : null };
}

function responder(w) {
  return (url, opt) => {
    if (/\/lab\/pulse\?t=egs-(cron|net)-/.test(url)) return w.ctl;
    if (url.indexOf('/lab/t24-pulse?t=t24pa') > 0) return w.to;
    const b = w[opt.policy];
    assert.ok(b, 'неожиданная политика: ' + opt.policy + ' ' + url);
    return b;
  };
}

async function cron(t, over, store, net) {
  const f = fakeCtx({ cron: CRON, clock: { t }, respond: responder(world(over)), store, net });
  const r = await run(f);
  return Object.assign(r, { f });
}

test('контроль через DIRECT не прошёл — прогон не в итогах: ни одного «да» и «нет»', async () => {
  for (const over of [{ ctl: { throw: 'offline', ms: 5000 } }, { ctl: { status: 502, ms: 20 } }]) {
    const r = await cron(ODD, over);
    assert.equal(r.dump.в_итоги, false);
    assert.equal(r.dump.без_контроля, 1);
    for (const [k, v] of Object.entries(r.dump.итоги)) {
      if (k === 'cron') continue;
      assert.equal(v, 'нет данных', k + ': ' + v);
    }
  }
});

test('всё бросает (сети нет) — только «нет данных», скрипт завершается одной строкой', async () => {
  const f = fakeCtx({ cron: CRON, clock: { t: ODD }, respond: () => ({ throw: 'offline', ms: 5 }) });
  const r = await run(f);
  assert.equal(r.lines.length, 1);
  for (const [k, v] of Object.entries(r.dump.итоги)) if (k !== 'cron') assert.equal(v, 'нет данных', k);
});

test('задуманный мир, нечётное окно: все «да» и «замечает»', async () => {
  const r = await cron(ODD);
  const v = r.dump.итоги;
  assert.equal(r.dump.нечёт, true);
  assert.equal(r.dump.мин, 5);
  assert.equal(r.dump.в_итоги, true);
  assert.equal(r.dump.policy_не_соблюдён, 0);
  assert.equal(r.dump.группы_не_находятся, 0);
  assert.match(v.policy_ctx_http, /^да:/);
  assert.match(v.группы_по_имени, /^да:/);
  assert.match(v.fallback_первый_живой, /^да:/);
  assert.match(v.REJECT_в_fallback, /^считается живым/);
  assert.match(v.свой_адрес_DIRECT, /^да:/);
  assert.match(v.clash_direct_разобран, /^да:/);
  assert.match(v.подписка_первый_живой, /^да:/);
  assert.match(v.смерть_узла, /^замечает: ушёл с DIRECT к 5-й мин/);
  assert.match(v.timeout_мс, /^да: исключение через 3004 мс при timeout 3000$/);
  assert.match(v.имя_узла_подписки, /^да:/);
  assert.match(v.conditional, /^частично: видна только wifi/);
  assert.equal(v.возврат, 'нет данных', 'возврат без живого окна — нет данных');
});

test('«нет» — только при живом контроле, по каждому вопросу', async () => {
  // EGS-ORD отдельно: его отказ снимает подтверждение REJECT. «Нет» — при
  // контроле: EGS-GRP прошла, отказ ORD (муляж, долго) ≠ отказу несуществующего имени.
  const q = await cron(ODD, { 'EGS-ORD': { throw: 'connect timeout', ms: 5000 } });
  assert.match(q.dump.итоги.группы_по_имени, /^да:/);
  assert.match(q.dump.итоги.fallback_первый_живой, /^нет:/);
  const r = await cron(ODD, {
    'EGS-DA': { throw: 'connect timeout', ms: 5000 },
    'EGS-DIE-S': { status: 204, ms: 40 },
    'EGS-N1': { status: 404, ms: 3 },
    to: { throw: 'timed out', ms: 25010 },
  });
  const v = r.dump.итоги;
  assert.match(v.свой_адрес_DIRECT, /^нет:/);
  assert.match(v.смерть_узла, /^не замечает: на DIRECT на 5-й мин/);
  assert.match(v.имя_узла_подписки, /^нет:/);
  assert.match(v.timeout_мс, /^нет: ждал 25010 мс/);
  const e = await cron(EVEN, { 'EGS-SUBS': { throw: 'no proxy', ms: 3 } });
  assert.match(e.dump.итоги.clash_direct_разобран, /^нет:/);
  assert.equal(e.dump.итоги.подписка_первый_живой, 'нет данных', 'нечётных чтений не было');
  const o = await cron(ODD, { 'EGS-SUBS': { throw: 'no proxy', ms: 3 } });
  assert.equal(o.dump.итоги.clash_direct_разобран, 'нет данных', 'ошибка в нечётном окне — не про разбор');
  assert.equal(o.dump.итоги.подписка_первый_живой, 'нет данных', 'без разбора «нет» по порядку не выносится');
});

test('EGS-SUBS в чётном окне отказывает как несуществующее имя — «не различить», не «не разобран»', async () => {
  const r = await cron(EVEN, { 'EGS-SUBS': { status: 404, ms: 3 } });
  assert.equal(r.dump.в_итоги, true);
  assert.equal(r.dump.итоги.clash_direct_разобран, 'не различить: отказ EGS-SUBS как у несуществующего имени (1)');
  assert.equal(r.dump.итоги.подписка_первый_живой, 'нет данных');
});

test('EGS-GRP: отказ не как у несуществующего имени (таймаут, 5xx) — «сбой контроля», а не «группы не находятся»', async () => {
  for (const g of [{ throw: 'timed out', ms: 5000 }, { status: 502, ms: 20 }]) {
    const r = await cron(ODD, { 'EGS-GRP': g });
    const v = r.dump.итоги;
    assert.equal(r.dump.в_итоги, false);
    assert.equal(r.dump.группы_не_находятся, 0, JSON.stringify(g));
    assert.equal(r.dump.сбой_контроля_групп, 1);
    assert.equal(v.группы_по_имени, 'нет данных: сбой контроля — отказ EGS-GRP не как у несуществующего имени (1)');
    for (const k of BY_POLICY) if (k !== 'имя_узла_подписки') assert.equal(v[k], 'нет данных', k + ': ' + v[k]);
    assert.match(r.f.notes[0].body, /^сбой контроля EGS-GRP — группы не в итогах/);
  }
});

// Вердикты, которые опираются на выбор члена группы по policy.
const BY_POLICY = ['fallback_первый_живой', 'REJECT_в_fallback', 'свой_адрес_DIRECT', 'clash_direct_разобран',
  'подписка_первый_живой', 'смерть_узла', 'возврат', 'имя_узла_подписки', 'conditional'];
const OK = { status: 204, ms: 40 };

test('policy не соблюдён (муляж или несуществующее имя прошли) — группы «нет данных», отдельный счёт', async () => {
  const all = {};
  for (const k of Object.keys(world())) if (k !== 'ctl' && k !== 'to') all[k] = OK;
  // Egern игнорирует policy целиком; только муляж; только несуществующее имя (молча DIRECT).
  const cases = [[all, 1, 1], [{ 'EGS-DEAD-3': OK, 'EGS-N1': OK }, 1, 0], [{ 'EGS-NOPE': OK }, 0, 1]];
  for (const [over, dead, name] of cases) {
    const r = await cron(ODD, over);
    const v = r.dump.итоги;
    assert.equal(r.dump.в_итоги, false, JSON.stringify(over));
    assert.equal(r.dump.policy_не_соблюдён, 1);
    assert.equal(v.policy_ctx_http, 'нет: policy не соблюдён — муляж пропустил ' + dead + ', несуществующее имя ' + name
      + '; прогоны не в итогах групп (1)');
    for (const k of BY_POLICY) assert.equal(v[k], 'нет данных', k + ': ' + v[k]);
    assert.match(v.timeout_мс, /^да:/, 'timeout идёт через DIRECT и от policy не зависит');
    assert.match(r.f.notes[0].body, /^policy НЕ соблюдён — группы не в итогах/);
  }
  // Смешанный прогон: в итоги групп — только прогон с соблюдённым policy.
  const store = new Map();
  await cron(ODD, {}, store);
  const m = await cron(ODD + 2 * W, all, store);
  assert.match(m.dump.итоги.policy_ctx_http, /^не всегда: да 1, нет 1$/);
  assert.match(m.dump.итоги.fallback_первый_живой, /^да: .*\(1\)$/);
  assert.match(m.dump.итоги.REJECT_в_fallback, /\(1\)$/);
});

test('отказ REJECT неотличим от несуществующего имени или EGS-ORD не прошёл — REJECT-выводы «не различить»', async () => {
  const REJ = { throw: 'rejected', ms: 2 };
  for (const over of [{ 'EGS-NOPE': REJ }, { 'EGS-ORD': { throw: 'connect timeout', ms: 5000 } }]) {
    const r = await cron(ODD, over);
    const v = r.dump.итоги;
    assert.equal(r.dump.в_итоги, true, 'policy соблюдён: муляж не прошёл');
    assert.match(v.REJECT_в_fallback, /^не различить: отказ как у несуществующего имени/, JSON.stringify(over));
    assert.match(v.свой_адрес_DIRECT, /^не различить/);
    assert.match(v.смерть_узла, /^не различить/);
  }
  // REJECT подтверждён, но отказ B / EGS-DIE-S иного класса, чем у REJECT (например, «группа не найдена»).
  const r = await cron(ODD, { 'EGS-DB': { status: 404, ms: 3 }, 'EGS-DIE-S': { status: 404, ms: 3 } });
  assert.match(r.dump.итоги.REJECT_в_fallback, /^считается живым/);
  assert.match(r.dump.итоги.свой_адрес_DIRECT, /^не различить/);
  assert.match(r.dump.итоги.смерть_узла, /^не различить/);
  // EGS-REJ прошёл при соблюдённом policy — REJECT пропущен (группа есть: несуществующее имя отказало).
  const p = await cron(ODD, { 'EGS-REJ': OK, 'EGS-NOPE': REJ });
  assert.match(p.dump.итоги.REJECT_в_fallback, /^пропускается/);
});

test('группы по имени не находятся (узлы находятся, группы отказывают как NOPE) — ни одного группового «нет»', async () => {
  const NO = { status: 404, ms: 3 };                  // как EGS-NOPE в задуманном мире
  const over = {};
  for (const g of ['EGS-ORD', 'EGS-REJ', 'EGS-DA', 'EGS-DB', 'EGS-SUBS', 'EGS-DIE-S', 'EGS-COND', 'EGS-GRP']) over[g] = NO;
  const store = new Map();
  await cron(EVEN, over, store, 'wifi');
  const r = await cron(ODD, over, store, 'cell');
  const v = r.dump.итоги;
  assert.equal(r.dump.в_итоги, false);
  assert.equal(r.dump.policy_не_соблюдён, 0, 'policy соблюдён: муляж и NOPE отказали');
  assert.equal(r.dump.группы_не_находятся, 2);
  assert.match(v.группы_по_имени, /^нет: EGS-GRP не прошла/);
  for (const k of BY_POLICY) {
    if (k === 'имя_узла_подписки') continue;          // вывод об узлах, контроль — муляж ≠ NOPE
    assert.equal(v[k], 'нет данных', k + ': ' + v[k]);
  }
  assert.match(v.имя_узла_подписки, /^да:/);
  assert.match(r.f.notes[0].body, /^группы по имени не находятся — группы не в итогах/);
  // EGS-GRP прошла, но отказ ORD / A неотличим от несуществующего имени — «не различить», не «нет».
  const u = await cron(ODD, { 'EGS-ORD': NO, 'EGS-DA': NO });
  assert.match(u.dump.итоги.fallback_первый_живой, /^не различить: отказ EGS-ORD как у несуществующего имени/);
  assert.match(u.dump.итоги.свой_адрес_DIRECT, /^не различить: отказ A как у несуществующего имени/);
  // Смешанно: групповые итоги — только из прогона, где EGS-GRP прошла.
  const m = await cron(ODD + 2 * W, { 'EGS-ORD': { throw: 'connect timeout', ms: 5000 } }, store, 'wifi');
  assert.match(m.dump.итоги.группы_по_имени, /^не всегда: да 1, нет 2$/);
  assert.match(m.dump.итоги.fallback_первый_живой, /^нет: .*\(1\)$/);
});

test('граница окна (минута < 4) — прогон не в итогах; с 4-й минуты — в итогах', async () => {
  const e = await cron(ODD - 5 * 60000 + 30000);
  assert.equal(e.dump.мин, 0.5);
  assert.equal(e.dump.в_итоги, false);
  assert.equal(e.dump.на_границе, 1);
  for (const [k, v] of Object.entries(e.dump.итоги)) if (k !== 'cron') assert.equal(v, 'нет данных', k);
  assert.match(e.f.notes[0].body, /^граница окна/);
  const f = await cron(ODD - 60000);
  assert.equal(f.dump.мин, 4);
  assert.equal(f.dump.в_итоги, true);
  assert.match(f.dump.итоги.fallback_первый_живой, /^да:/);
});

test('REJECT не живой — смерть узла и свой адрес DIRECT «не различить», а не «да» или «нет»', async () => {
  const r = await cron(ODD, { 'EGS-REJ': { status: 204, ms: 40 } });
  const v = r.dump.итоги;
  assert.match(v.REJECT_в_fallback, /^пропускается как мёртвый/);
  assert.match(v.смерть_узла, /^не различить/);
  assert.match(v.свой_адрес_DIRECT, /^не различить/);
});

test('адрес «мёртвого» узла не молчал (ответил или отказал быстро) — смерть узла «не различить»', async () => {
  for (const to of [{ status: 204, ms: 40 }, { throw: 'refused', ms: 50 }]) {
    const r = await cron(ODD, { to });
    assert.match(r.dump.итоги.смерть_узла, /^не различить/, JSON.stringify(to));
    assert.ok(!/^да/.test(r.dump.итоги.timeout_мс), 'быстрый отказ или ответ — не «да» по timeout');
  }
  const r = await cron(ODD, { to: { throw: 'refused', ms: 50 } });
  assert.match(r.dump.итоги.timeout_мс, /^нет данных: быстрый отказ 50 мс/);
});

test('имена: статический муляж и несуществующее имя неразличимы — «не различить»', async () => {
  const r = await cron(ODD, { 'EGS-DEAD-3': { status: 404, ms: 3 } });
  assert.match(r.dump.итоги.имя_узла_подписки, /^не различить/);
  assert.equal(r.dump.имена['EGS-DEAD-3'], 'http404/быстро');
  assert.equal(r.dump.имена['EGS-N1'], 'искл/долго connect timeout 192.0.2.71');
  // Все три одинаковы: без контроля это читалось бы как «адресуется».
  const same = { status: 404, ms: 3 };
  const s = await cron(ODD, { 'EGS-DEAD-3': same, 'EGS-N1': same, 'EGS-NOPE': same });
  assert.match(s.dump.итоги.имя_узла_подписки, /^не различить/);
});

test('накопление: нечётное окно (ушёл), затем чётное (на DIRECT) — «возвращается»; промежутки cron', async () => {
  const store = new Map();
  await cron(ODD, {}, store);
  const r = await cron(ODD + W, { 'EGS-DIE-S': { status: 204, ms: 40 } }, store);
  assert.equal(r.dump.нечёт, false);
  assert.match(r.dump.итоги.возврат, /^возвращается: на DIRECT к 5-й мин/);
  assert.match(r.dump.итоги.cron, /^запусков 2, промежутки 10–10 мин, пропусков \(>15 мин\) 0$/);
  const r3 = await cron(ODD + 3 * W, { 'EGS-DIE-S': { throw: 'rejected', ms: 2 } }, store);
  assert.match(r3.dump.итоги.возврат, /^не всегда/);
  assert.match(r3.dump.итоги.cron, /пропусков \(>15 мин\) 1$/);
});

test('чётное окно без прошлого «ушёл» — возврат не засчитывается', async () => {
  const r = await cron(EVEN);
  assert.equal(r.dump.итоги.возврат, 'нет данных');
  assert.equal(r.dump.итоги.смерть_узла, 'нет данных');
});

test('conditional: Wi-Fi — DIRECT, сотовая — REJECT — «да»; одна ветка в обеих сетях — «нет»', async () => {
  const s1 = new Map();
  await cron(ODD, {}, s1, 'wifi');
  const a = await cron(ODD + W, { 'EGS-COND': { throw: 'rejected', ms: 2 } }, s1, 'cell');
  assert.match(a.dump.итоги.conditional, /^да:/);
  const s2 = new Map();
  await cron(ODD, {}, s2, 'wifi');
  const b = await cron(ODD + W, {}, s2, 'cell');
  assert.match(b.dump.итоги.conditional, /^нет:/);
});

test('conditional: EGS-GRP прошла, EGS-COND отказывает как несуществующее имя в обеих сетях — «не различить», не «нет»', async () => {
  // select EGS-GRP не доказывает, что conditional-группа находится по имени.
  const NO = { 'EGS-COND': { status: 404, ms: 3 } };  // как EGS-NOPE в задуманном мире
  const s = new Map();
  await cron(ODD, NO, s, 'wifi');
  const r = await cron(ODD + W, NO, s, 'cell');
  assert.match(r.dump.итоги.группы_по_имени, /^да:/);
  assert.equal(r.dump.итоги.conditional, 'не различить: отказ EGS-COND как у несуществующего имени (2)');
  // Одна сеть различима, другая нет — «частично», без вывода «ветка одна».
  const p = new Map();
  await cron(ODD, {}, p, 'wifi');
  const q = await cron(ODD + W, NO, p, 'cell');
  assert.match(q.dump.итоги.conditional, /^частично: видна только wifi/);
});

test('запросы: только стенд, timeout в МИЛЛИСЕКУНДАХ, политики — DIRECT и группы скрипта, не фоновые', async () => {
  const r = await cron(ODD);
  assert.equal(r.f.calls.length, 13);
  const via = new Set();
  for (const c of r.f.calls) {
    assert.ok(c.url.indexOf(STAND + '/lab/') === 0, c.url);
    assert.ok(Number.isInteger(c.opt.timeout) && c.opt.timeout >= 1000 && c.opt.timeout <= 10000, 'timeout не в мс: ' + c.opt.timeout);
    assert.ok(SCRIPT_POLICIES.includes(c.opt.policy), c.opt.policy);
    assert.ok(!BACKGROUND.includes(c.opt.policy), 'скрипт ходит через фоновую группу ' + c.opt.policy);
    const m = c.url.match(/[?&]t=([^&]+)$/);
    assert.ok(m && /^[a-z0-9-]{1,16}$/.test(m[1]), c.url);
    if (/^egs-via-/.test(m[1])) { assert.ok(!via.has(m[1]), 'метка повторяется: ' + m[1]); via.add(m[1]); }
  }
  const ctl = r.f.calls.filter((c) => c.url.indexOf('egs-cron-') > 0);
  assert.equal(ctl.length, 1);
  assert.equal(ctl[0].opt.policy, 'DIRECT', 'контроль — только напрямую, мимо тестовых групп');
  assert.equal(r.f.calls[0], ctl[0], 'контроль — первым, до запросов через группы');
  const to = r.f.calls.find((c) => c.url.indexOf('t24-pulse') > 0);
  assert.equal(to.url, STAND + '/lab/t24-pulse?t=t24pa');
  assert.equal(to.opt.timeout, 3000);
  assert.equal(to.opt.policy, 'DIRECT');
});

const PY = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
test('группы скрипта есть в профиле и не совпадают с фоновыми (у фоновых нет запросов скрипта)', { skip: PY.status !== 0 && 'нет python3 + PyYAML' }, () => {
  const r = spawnSync('python3', ['-c', 'import sys, json, yaml\nprint(json.dumps(yaml.safe_load(sys.stdin.read()), ensure_ascii=False))'],
    { input: fs.readFileSync(path.join(ROOT, 'plugins/RouteHub-Egern-EGS.yaml'), 'utf8'), encoding: 'utf8' });
  const P = JSON.parse(r.stdout);
  const names = P.policy_groups.map((g) => g[Object.keys(g)[0]].name);
  const proxies = P.proxies.map((p) => p.socks5.name);
  for (const p of SCRIPT_POLICIES) {
    if (p === 'DIRECT' || p === 'EGS-N1' || p === 'EGS-NOPE') continue;
    assert.ok(names.includes(p) || proxies.includes(p), p);
  }
  assert.ok(!names.includes('EGS-NOPE') && !proxies.includes('EGS-NOPE'), 'контрольное имя обязано отсутствовать');
  for (const b of BACKGROUND) assert.ok(names.includes(b), b);
  // Муляж контроля policy — вне всех групп: запросы скрипта по имени не трогают группы.
  for (const g of P.policy_groups) assert.ok(!(g[Object.keys(g)[0]].policies || []).includes('EGS-DEAD-3'), 'EGS-DEAD-3 в группе');
  assert.ok(proxies.includes('EGS-DEAD-3'));
  // Контроль «группы находятся по имени»: select [DIRECT], не фоновая и ни в чьём составе.
  const grp = P.policy_groups.find((g) => g[Object.keys(g)[0]].name === 'EGS-GRP');
  assert.ok(grp && grp.select, 'EGS-GRP — select');
  assert.deepEqual(grp.select.policies, ['DIRECT']);
  assert.ok(!BACKGROUND.includes('EGS-GRP'));
  for (const g of P.policy_groups) assert.ok(!(g[Object.keys(g)[0]].policies || []).includes('EGS-GRP'), 'EGS-GRP в составе группы');
  // Политики в коде скрипта — ровно список выше.
  const inSrc = [...SRC.matchAll(/'(EGS-[A-Z0-9-]+|DIRECT)', (?:HTTP_MS|TO_MS)\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(inSrc)].sort(), SCRIPT_POLICIES.slice().sort());
});

test('приватность: в журнале, уведомлении и хранилище нет SSID, BSSID, IP, оператора', async () => {
  const store = new Map();
  const outs = [];
  for (const net of ['wifi', 'cell', 'none']) {
    const r = await cron(ODD, { 'EGS-N1': { throw: 'connect 10.20.30.40:1 fe80::1234:5678 failed', ms: 5000 } }, store, net);
    outs.push(r.logs.join('\n'), JSON.stringify(r.f.notes));
    const f = fakeCtx({ clock: { t: ODD }, respond: responder(world()), store, net });
    const n = await run(f);
    outs.push(n.logs.join('\n'), JSON.stringify(f.notes));
  }
  outs.push(JSON.stringify([...store.entries()]));
  const all = outs.join('\n');
  for (const s of SECRETS) assert.ok(all.indexOf(s) < 0, 'в выводе: ' + s);
  assert.ok(!/\/t\/[A-Za-z0-9]{16,}/.test(all), 'токен в выводе');
  assert.match(all, /"радио":"LTE"/);
  assert.match(all, /<ip>/);
});

test('ровно одна строка [EGS] и одно уведомление на запуск; звук — только на первом; дамп — в буфер', async () => {
  const store = new Map();
  const a = await cron(ODD, {}, store);
  const b = await cron(ODD + W, {}, store);
  for (const r of [a, b]) {
    assert.equal(r.lines.length, 1);
    assert.equal(r.logs.length, 1);
    assert.equal(r.f.notes.length, 1);
    assert.equal(r.f.notes[0].action.type, 'clipboard');
    assert.deepEqual(JSON.parse(r.f.notes[0].action.text), r.dump);
  }
  assert.equal(a.f.notes[0].sound, true);
  assert.equal(b.f.notes[0].sound, false);
  // network: звук тоже только на первой смене сети.
  const ns = new Map();
  const n1 = fakeCtx({ clock: { t: ODD }, respond: responder(world()), store: ns });
  await run(n1);
  const n2 = fakeCtx({ clock: { t: ODD + W }, respond: responder(world()), store: ns, net: 'cell' });
  await run(n2);
  assert.equal(n1.notes[0].sound, true);
  assert.equal(n2.notes[0].sound, false);
});

test('сбой хранилища или уведомления не роняет прогон: одна строка [EGS]', async () => {
  for (const o of [{ storageThrows: true }, { notifyThrows: true }]) {
    const f = fakeCtx(Object.assign({ cron: CRON, clock: { t: ODD }, respond: responder(world()) }, o));
    const r = await run(f);
    assert.equal(r.lines.length, 1, JSON.stringify(o));
  }
});

test('network-запуск: один запрос через DIRECT, опись ctx без вызовов, отдельный ключ хранилища', async () => {
  let called = 0;
  const store = new Map();
  const f = fakeCtx({ clock: { t: ODD }, respond: responder(world()), store, net: 'cell',
    extra: { switchPolicy() { called++; } } });
  const r = await run(f);
  assert.equal(r.dump.вид, 'network');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, STAND + '/lab/pulse?t=egs-net-cell');
  assert.equal(f.calls[0].opt.policy, 'DIRECT');
  assert.equal(called, 0, 'найденный механизм не вызывается');
  assert.equal(r.dump.новое_в_ctx, 'ДА: switchPolicy');
  assert.deepEqual([...store.keys()], ['RH_EGS_NET']);
  const g = fakeCtx({ clock: { t: ODD }, respond: responder(world()), store: new Map() });
  assert.match((await run(g)).dump.новое_в_ctx, /^НЕТ/);
});

test('скрипт обращается только к cron, device, http.get, storage, notify; не пишет в маршрутизацию', async () => {
  const r = await cron(ODD);
  for (const k of r.f.seen) assert.ok(['cron', 'device', 'http', 'storage', 'notify'].includes(k), 'обращение к ctx.' + k);
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const bad of ['$done', 'setSelectPolicy', 'setRunningModel', 'policyDescriptor', 'http.post', 'http.put', '.ssh', 'respond(', 'abort(', 'lookupIP(', 'eval(', 'Function(', 'import(']) {
    assert.ok(code.indexOf(bad) < 0, 'в коде скрипта: ' + bad);
  }
  const urls = [...code.matchAll(/https?:\/\/[^'"\s]+/g)].map((m) => m[0]);
  assert.deepEqual(urls, [STAND], 'адреса в коде — только стенд');
});
