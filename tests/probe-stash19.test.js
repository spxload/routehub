// Поведение пробы ST19 (закрепление во времени, обёртка, карта рычагов) и её
// перехватчика ссылок — в песочнице с подставным контроллером.
//
// ЗАЧЕМ. ST19 идёт несколько прогонов подряд и помнит фазу в $persistentStore,
// то есть проверять надо ЦЕПОЧКУ прогонов, а не один. Подставной контроллер
// умеет три модели поведения fallback — ровно те исходы, между которыми проба
// должна различать на устройстве:
//   'sticky'   — закрепление держится всегда, даже на мёртвом члене;
//   'reset'    — ближайшая проверка здоровья (60 с) снимает закрепление;
//   'deadskip' — на живом держится, с мёртвого группа уходит сама.
// Если вердикт пробы не различает эти модели, на устройстве он тоже соврёт.
//
// ЧАСЫ ПОДСТАВНЫЕ: между прогонами cron проходит 5 минут, в песочнице — миг.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = 'probes/routehub-probe-stash19.js';
const CMD_FILE = 'probes/routehub-probe-stash19-cmd.js';
const CODE = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
const CMD_CODE = fs.readFileSync(path.join(ROOT, CMD_FILE), 'utf8');

const SECRET = 'Bearer ОЧЕНЬ-СЕКРЕТНО';
const PRIVATE_HOST = 'очень-личный-сайт.example';
const P = 'RH-Т19-';
const DUMMY = P + 'Муляж', ALIAS = P + 'Прямо';
const TEST_GROUPS = ['Здоров', 'Мёртв', 'Ручной', 'Обёртка', 'Скорость', 'Баланс', 'Сеть', 'Команда'].map((x) => P + x);
const CRON_WRITABLE = ['Здоров', 'Мёртв', 'Ручной', 'Скорость', 'Баланс', 'Сеть'].map((x) => P + x);

// ── ПОДСТАВНОЙ КОНТРОЛЛЕР ────────────────────────────────────────────────
function world(opts = {}) {
  const clock = { t: 1_800_000_000_000 };
  const model = opts.model || 'sticky';
  const g = {
    [ALIAS]: { type: 'Selector', now: 'DIRECT', all: ['DIRECT'] },
    [P + 'Здоров']: { type: 'Fallback', all: [DUMMY, ALIAS, 'DIRECT'] },
    [P + 'Мёртв']: { type: 'Fallback', all: [ALIAS, DUMMY, 'DIRECT'] },
    [P + 'Ручной']: { type: 'Selector', now: 'DIRECT', all: ['DIRECT', DUMMY] },
    [P + 'Обёртка']: { type: 'Fallback', all: [P + 'Ручной', ALIAS] },
    [P + 'Скорость']: { type: 'URLTest', now: ALIAS, all: [ALIAS, 'DIRECT'] },
    [P + 'Баланс']: { type: 'LoadBalance', now: ALIAS, all: [ALIAS, 'DIRECT'] },
    [P + 'Сеть']: { type: 'Selector', now: 'DIRECT', all: [ALIAS, 'DIRECT'] },
    [P + 'Команда']: { type: 'Selector', now: ALIAS, all: [ALIAS, 'DIRECT'] },
    'RH-AI': { type: 'Selector', now: 'RH-AI-W', all: ['RH-AI-W', 'RH-AI-C'] },
  };
  if (opts.noGroups) for (const k of Object.keys(g)) if (k.startsWith(P)) delete g[k];
  const w = { clock, g, calls: [], store: {}, model, eofLeft: opts.eof || 0, hang: !!opts.hang, step: opts.step || 30,
    fail: opts.fail || null, manualStart: opts.manualStart || null, eofWhen: opts.eofWhen || null,
    wrapNoSkip: !!opts.wrapNoSkip };
  if (w.manualStart) g[P + 'Ручной'].now = w.manualStart;

  function alive(n) {
    if (n === DUMMY) return false;
    if (n === 'DIRECT') return true;
    const x = g[n];
    if (!x) return false;
    if (x.type === 'Fallback') return x.all.some(alive);
    if (w.wrapNoSkip && n === P + 'Ручной') return true;   // ядро не смотрит внутрь select
    return alive(nowOf(n));
  }
  function nowOf(n) {
    const x = g[n];
    if (x.type !== 'Fallback') return x.now;
    if (x.pin) {
      const expired = model === 'reset' && clock.t - x.pinAt >= 60000;
      const dead = model === 'deadskip' && !alive(x.pin);
      if (!expired && !dead) return x.pin;
      if (expired) x.pin = null;
    }
    return x.all.find(alive);
  }
  w.nowOf = nowOf;

  w.handle = (method, o, cb) => {
    const url = String(o.url || '');
    const p = url.replace(/^http:\/\/127\.0\.0\.1:9090/, '');
    w.calls.push({ method, p, auth: o.headers && o.headers.Authorization, body: o.body || null, timeout: o.timeout });
    if (w.hang) return;
    const reply = (st, body) => setTimeout(() => { clock.t += w.step; cb(null, { status: st, headers: {} }, body); }, 1);
    if (w.eofLeft > 0) { w.eofLeft--; return setTimeout(() => cb('Get "' + url + '": EOF', null, null), 1); }
    // Обрыв, на который уходит время ответа (как настоящий EOF по тайм-ауту).
    if (w.eofWhen && w.eofWhen(method, decodeURIComponent(p), w.calls.length)) {
      return setTimeout(() => { clock.t += w.step; cb('Get "' + url + '": EOF', null, null); }, 1);
    }
    if (/[^\x00-\x7F]/.test(url)) return reply(400, 'bad path');
    // Точечный сбой: предикат по методу, пути и номеру вызова.
    if (w.fail && w.fail(method, decodeURIComponent(p), w.calls.length, o)) return reply(500, 'oops');
    const m = p.match(/^\/proxies\/([^/?]+)(\/delay)?/);
    if (m && !m[2]) {
      const name = decodeURIComponent(m[1]);
      if (name === DUMMY) return reply(200, JSON.stringify({ name, type: 'Socks5', alive: false, delay: 0, history: [] }));
      const x = g[name];
      if (!x) return reply(404, '{"message":"Resource not found"}');
      if (method === 'get') return reply(200, JSON.stringify({ alive: alive(name), all: x.all, delay: 0, name, now: nowOf(name), type: x.type }));
      if (method === 'put') {
        const want = JSON.parse(o.body).name;
        if (x.all.indexOf(want) < 0) return reply(400, '{"message":"Selector update error: proxy not exist"}');
        if (x.type === 'URLTest' || x.type === 'LoadBalance') return reply(400, '{"message":"Must be a Selector"}');
        if (x.type === 'Fallback') { x.pin = want; x.pinAt = clock.t; } else x.now = want;
        return reply(204, '');
      }
      return reply(405, 'Method Not Allowed');
    }
    if (m && m[2]) return reply(200, '{"delay":42}');
    if (p === '/') return reply(200, '{"hello":"stash","mixed-port":7890}');
    if (p === '/configs') return reply(200, '{"mode":"rule","mixed-port":7890}');
    if (p === '/providers/proxies') return reply(200, '{"providers":{"RH-Lastdep":{"vehicleType":"HTTP","proxies":[1,2,3]}}}');
    if (p === '/connections') {
      return reply(200, JSON.stringify({ connections: [{ id: '1', chains: ['узел', 'RH-AI-W'], upload: 1, download: 2,
        metadata: { host: PRIVATE_HOST, network: 'tcp' } }] }));
    }
    if (p.startsWith('/connections/')) return reply(405, 'Method Not Allowed');
    if (p.startsWith('/providers/proxies/')) return reply(404, '{"message":"Resource not found"}');
    if (p.startsWith('/group')) return reply(404, '404 page not found');
    if (p.startsWith('/cache/')) return reply(405, 'Method Not Allowed');
    if (p.startsWith('/rules') || p.startsWith('/providers/rules')) return reply(200, '{"rules":[1,2],"providers":{}}');
    return reply(404, '404 page not found');
  };
  return w;
}

function sandboxFor(w, code, file, extra = {}) {
  const state = { done: null, doneCalls: 0, note: null };
  const RealDate = Date;
  function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(w.clock.t); }
  FakeDate.now = () => w.clock.t;
  const sb = Object.assign({
    console: { log: () => {} },
    JSON, Math, Date: FakeDate, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, isFinite, encodeURIComponent, decodeURIComponent,
    setTimeout: (fn, ms) => setTimeout(fn, Math.max(1, Math.round((ms || 0) / 1000))),
    clearTimeout,
    $environment: { 'controller-url': 'http://127.0.0.1:9090', 'controller-authorization': SECRET, 'stash-version': '3.4.1' },
    $notification: { post: (t, s, b, o) => { state.note = { t, s, b, o: o || null }; } },
    $persistentStore: { read: (k) => (k in w.store ? w.store[k] : null), write: (v, k) => { w.store[k] = v; return true; } },
    $httpClient: {
      get: (o, cb) => w.handle('get', o, cb),
      put: (o, cb) => w.handle('put', o, cb),
      post: () => { throw new Error('проба не должна слать POST'); },
      patch: () => { throw new Error('проба не должна менять настройки'); },
      delete: () => { throw new Error('проба не должна удалять'); },
    },
    $done: (v) => { state.doneCalls++; state.done = v || {}; },
  }, extra);
  sb.globalThis = sb;
  vm.runInContext(code, vm.createContext(sb), { filename: file });
  return state;
}

async function settle(state, ms = 5000) {
  const until = Date.now() + ms;
  while (!state.done && Date.now() < until) await new Promise((r) => setTimeout(r, 3));
  assert.ok(state.done, 'проба не дошла до $done');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(state.doneCalls, 1, 'ровно один $done на любой ветви');
  return state;
}

async function runOnce(w) {
  const st = await settle(sandboxFor(w, CODE, FILE));
  return { st, rep: JSON.parse(st.note.o.clipboard) };
}

// Прогоны cron раз в 5 минут, пока не «итог» или не кончится лимит.
async function cycle(w, max = 10) {
  const reps = [];
  for (let i = 0; i < max; i++) {
    const r = await runOnce(w);
    reps.push(r);
    if (r.rep.ans.фаза === 'итог') break;
    w.clock.t += 5 * 60000;
  }
  return reps;
}

const writes = (w) => w.calls.filter((c) => c.method !== 'get');

// ── ЦЕПОЧКА ФАЗ И ВЕРДИКТЫ ПО МОДЕЛЯМ ─────────────────────────────────────
test('модель «закрепление вечное»: держится, застревает на мёртвом, обёртка пропускает и возвращается', async () => {
  const w = world({ model: 'sticky' });
  const reps = await cycle(w);
  const last = reps[reps.length - 1];
  assert.equal(last.rep.ans.фаза, 'итог', 'цепочка фаз не дошла до итога за ' + reps.length + ' прогонов');
  assert.deepEqual(reps.map((r) => r.rep.ans.фаза_до).slice(0, 2), ['старт', 'наблюдение']);
  const V = last.rep.ans.вердикты;
  assert.match(V.здоровый, /^ДЕРЖИТСЯ/);
  assert.match(V.мёртвый, /^ЗАСТРЕВАЕТ/);
  // Обёртка — fallback над select: select с мёртвым выбором в модели мёртв.
  assert.match(V.обёртка, /^ПРОПУСКАЕТ/);
  assert.match(V.обёртка_возврат, /^ВОЗВРАЩАЕТСЯ/);
  assert.match(V.url_test, /^PUT 400/);
  assert.match(V.load_balance, /^PUT 400/);
  assert.match(last.rep.ans.ВЕРДИКТ, /ГОТОВО/);
  assert.equal(last.st.done.backgroundColor, '#34C759');
});

test('модель «проверка здоровья снимает»: здоровый сбрасывается, с мёртвого уходит', async () => {
  const w = world({ model: 'reset' });
  const V = (await cycle(w)).pop().rep.ans.вердикты;
  assert.match(V.здоровый, /^СБРАСЫВАЕТСЯ/);
  assert.match(V.мёртвый, /^УХОДИТ САМ/);
});

test('модель «на живом держится, с мёртвого уходит»: вердикты различают её с двумя другими', async () => {
  // Здоровье в модели считается мгновенно, поэтому с мёртвого она уходит уже к
  // чтению сразу после записи — проба обязана назвать это отдельно от «reset».
  const w = world({ model: 'deadskip' });
  const V = (await cycle(w)).pop().rep.ans.вердикты;
  assert.match(V.здоровый, /^ДЕРЖИТСЯ/);
  assert.match(V.мёртвый, /^НА МЁРТВЫЙ НЕ ЗАКРЕПЛЯЕТСЯ/);
});

test('после «итог» проба только читает', async () => {
  const w = world();
  await cycle(w);
  const before = writes(w).length;
  w.clock.t += 5 * 60000;
  const { rep } = await runOnce(w);
  assert.equal(rep.ans.фаза, 'итог');
  assert.equal(writes(w).length, before, 'проба писала в фазе «итог»');
});

// ── ГРАНИЦЫ ЗАПИСИ, СЕКРЕТ, ПРИВАТНОСТЬ ───────────────────────────────────
test('cron пишет только в свои тестовые группы; Команда, RH-AI и боевые не трогаются', async () => {
  const w = world();
  await cycle(w);
  for (const c of writes(w)) {
    if (c.p.startsWith('/providers/proxies/')) {
      assert.equal(decodeURIComponent(c.p.split('/')[3]), P + 'нет-такого', 'запись в настоящего поставщика');
      continue;
    }
    const name = decodeURIComponent(c.p.replace(/^\/proxies\//, ''));
    assert.ok(CRON_WRITABLE.includes(name), 'запись вне тестовых групп: ' + c.method + ' ' + name);
  }
  for (const c of w.calls) {
    assert.ok(!/\/group\/RH-AI|healthcheck/.test(c.p) || c.p.includes(encodeURIComponent(P)), 'замер боевой группы: ' + c.p);
    assert.ok(!/[^\x00-\x7F]/.test(c.p), 'незакодированный адрес: ' + c.p);
    assert.equal(c.auth, SECRET);
    assert.equal(c.timeout === 5 || c.timeout === 3, true, 'timeout не в секундах: ' + c.timeout);
  }
});

test('в выгрузке нет секрета, значений $environment и хостов соединений', async () => {
  const w = world();
  const { st, rep } = await runOnce(w);
  const dump = JSON.stringify(rep) + JSON.stringify(st.done) + JSON.stringify(st.note) + JSON.stringify(w.store);
  assert.ok(dump.indexOf('ОЧЕНЬ-СЕКРЕТНО') < 0, 'секрет в выгрузке');
  assert.ok(dump.indexOf(PRIVATE_HOST) < 0, 'хост соединения в выгрузке');
  assert.deepEqual(rep.ans.среда.$environment, ['controller-authorization', 'controller-url', 'stash-version']);
  const conns = rep.ans.карта.find((r) => r.путь === '/connections');
  assert.equal(conns.число, 1);
  assert.deepEqual(conns.метаданные, ['host', 'network']);
});

test('карта рычагов: 405, текстовый 404 и 404 в JSON различаются', async () => {
  const w = world();
  const { rep } = await runOnce(w);
  const by = (p) => rep.ans.карта.find((r) => r.путь === p);
  assert.equal(by('/connections/00000000-0000-0000-0000-000000000000').итог, 'есть (другой метод)');
  assert.equal(by('/group').итог, 'маршрута нет');
  assert.equal(by('/providers/proxies/' + encodeURIComponent(P + 'нет-такого')).итог, 'маршрут есть, имени нет');
  assert.ok(rep.ans.карта.length >= 14, 'карта неполная: ' + rep.ans.карта.length);
  assert.ok(!w.calls.some((c) => c.p.startsWith('/cache/')), 'проба трогала сброс кэша');
});

test('уведомление несёт ссылку на перехватчик и полную выгрузку', async () => {
  const w = world();
  const { st } = await runOnce(w);
  assert.equal(st.note.o.url, 'http://rh-cmd.example.net/st19');
  assert.ok(st.note.o.clipboard.length > 100);
});

// ── ОТКАЗЫ ───────────────────────────────────────────────────────────────
test('override не применился — ни одной записи, вердикт называет причину', async () => {
  const w = world({ noGroups: true });
  const { rep } = await runOnce(w);
  assert.equal(writes(w).length, 0);
  assert.match(rep.ans.ВЕРДИКТ, /override не применился/);
});

test('EOF на прогреве: один повтор спасает прогон', async () => {
  const w = world({ eof: 1 });
  const { rep } = await runOnce(w);
  assert.equal(rep.ans.прогрев.код, 200);
  assert.equal(rep.ans.прогрев.повтор, true);
  assert.equal(rep.ans.фаза, 'наблюдение');
});

test('EOF дважды — ничего не записано, фаза не сдвинута', async () => {
  const w = world({ eof: 2 });
  const { rep } = await runOnce(w);
  assert.equal(writes(w).length, 0);
  assert.match(rep.ans.ВЕРДИКТ, /КОНТРОЛЛЕР НЕ ОТВЕТИЛ/);
  assert.equal(w.store.RH_ST19, undefined, 'состояние записано без чтения');
});

test('контроллер молчит — сторож, один $done, записей нет', async () => {
  const w = world({ hang: true });
  const st = await settle(sandboxFor(w, CODE, FILE), 3000);
  const rep = JSON.parse(st.note.o.clipboard);
  assert.ok(rep.err.some((e) => e.indexOf('сторож') === 0));
  assert.equal(writes(w).length, 0);
});

test('медленный контроллер: закрепления переносятся на следующий прогон, а не делаются наполовину', async () => {
  const w = world({ step: 2500 });
  const { rep } = await runOnce(w);
  assert.equal(rep.ans.фаза, 'старт', 'фаза сдвинута без закреплений');
  assert.ok(!rep.ans.закрепления, 'закрепления начаты без запаса времени');
  assert.ok(rep.err.some((e) => /бюджет/.test(e)));
  assert.ok(w.clock.t - 1_800_000_000_000 <= 45000, 'прогон вышел за бюджет: ' + (w.clock.t - 1_800_000_000_000));
  w.step = 30; w.clock.t += 5 * 60000;
  const r2 = await runOnce(w);
  assert.equal(r2.rep.ans.фаза, 'наблюдение', 'следующий прогон не продолжил');
});

test('сторож позже худшего честного пути (дефект ST14)', () => {
  const num = (k) => Number(CODE.match(new RegExp('var ' + k + ' = (\\d+)'))[1]);
  assert.ok(num('GUARD_MS') > num('BUDGET_MS') + num('CTRL_SEC') * 1000);
});

// ── ПЕРЕХВАТЧИК ССЫЛОК ────────────────────────────────────────────────────
async function cmd(w, url) {
  const extra = url === null ? {} : { $request: { url, method: 'GET', headers: {} } };
  const st = await settle(sandboxFor(w, CMD_CODE, CMD_FILE, extra));
  return st;
}

test('перехватчик: страница без команды только читает и отдаёт HTML с кодом 200', async () => {
  const w = world();
  const st = await cmd(w, 'http://rh-cmd.example.net/st19');
  assert.equal(writes(w).length, 0);
  const r = st.done.response;
  assert.equal(r.status, 200); assert.equal(r.statusCode, 200);
  assert.match(r.headers['Content-Type'], /text\/html/);
  assert.match(r.body, /Перехват сработал/);
  assert.match(r.body, /RH-Т19-Прямо/);
  assert.ok(r.body.indexOf('ОЧЕНЬ-СЕКРЕТНО') < 0);
});

test('перехватчик: ?n=DIRECT переключает только RH-Т19-Команда и пишет итог в хранилище', async () => {
  const w = world();
  const st = await cmd(w, 'http://rh-cmd.example.net/st19?n=DIRECT');
  const wr = writes(w);
  assert.equal(wr.length, 1);
  assert.equal(decodeURIComponent(wr[0].p), '/proxies/' + P + 'Команда');
  assert.equal(w.g[P + 'Команда'].now, 'DIRECT');
  assert.match(st.done.response.body, /переключено/);
  const saved = JSON.parse(w.store.RH_ST19_cmd);
  assert.equal(saved.команда.сработала, true);
  // cron-часть выводит результат перехвата.
  const { rep } = await runOnce(w);
  assert.equal(rep.ans.перехват.команда.сработала, true);
});

test('перехватчик: имя вне белого списка и чужой HTML — отказ без записи, разметка экранирована', async () => {
  const w = world();
  const st = await cmd(w, 'http://rh-cmd.example.net/st19?n=' + encodeURIComponent('RH-AI<script>'));
  assert.equal(writes(w).length, 0);
  assert.ok(st.done.response.body.indexOf('<script>') < 0, 'разметка из адреса не экранирована');
  assert.match(st.done.response.body, /вне белого списка/);
});

test('перехватчик без $request — один $done, ничего не пишет', async () => {
  const w = world();
  await cmd(w, null);
  assert.equal(writes(w).length, 0);
});

// ── OVERRIDE ─────────────────────────────────────────────────────────────
test('override: муляж на TEST-NET, группы без узлов, одно правило, перехват без MITM', () => {
  const ov = fs.readFileSync(path.join(ROOT, 'plugins/RouteHub-Stash-ST19.stoverride'), 'utf8');
  assert.match(ov, /server: 192\.0\.2\.1\n/);
  assert.equal((ov.match(/^ {2}- name: /gm) || []).length, 10, 'муляж + 9 групп');
  const members = [...ov.matchAll(/^ {6}- (.+)$/gm)].map((m) => m[1].trim());
  for (const m of members) assert.ok(m === 'DIRECT' || m.startsWith(P), 'посторонний член группы: ' + m);
  const rules = ov.slice(ov.indexOf('\nrules:'), ov.indexOf('\nhttp:'));
  assert.deepEqual([...rules.matchAll(/^ {2}- (.+)$/gm)].map((m) => m[1]), ['DOMAIN,rh-cmd.example.net,DIRECT']);
  assert.ok(!/mitm/i.test(ov.replace(/^#.*$/gm, '')), 'override включает MITM');
  assert.match(ov, /force-http-engine:\n {4}- rh-cmd\.example\.net:80\n/);
  for (const t of TEST_GROUPS) assert.ok(ov.indexOf('- name: ' + t) > 0, 'нет группы ' + t);
  assert.match(ov, /timeout: 300\b/);
});

test('карта уже снята, бюджета на закрепления нет — их не начинают, прогон укладывается в бюджет', async () => {
  // 3 с на ответ: прогрев и 10 чтений наблюдения — 33 с, на пару «запись +
  // чтение» с повтором (18 с) бюджета 45 с уже не хватает.
  const w = world({ step: 3000 });
  const t0 = w.clock.t;
  w.store.RH_ST19 = JSON.stringify({ v: 1, t0, фаза: 'старт', hist: [], карта: [], картаГотова: true });
  const { rep } = await runOnce(w);
  assert.equal(writes(w).length, 0, 'закрепления начаты без запаса времени');
  assert.ok(w.clock.t - t0 <= 45000, 'прогон вышел за бюджет: ' + (w.clock.t - t0));
  assert.ok(rep.err.some((e) => /закрепления — продолжение/.test(e)));
});

// ── ПОПРАВКИ РЕВЬЮ 24.09 ──────────────────────────────────────────────────
test('сбой чтения посреди наблюдения — не «сбрасывается»', async () => {
  const w = world({ model: 'sticky' });
  let runNo = 0;
  const reads = {};
  w.fail = (m, p) => {
    if (m !== 'get' || p !== '/proxies/' + P + 'Здоров') return false;
    reads[runNo] = (reads[runNo] || 0) + 1;
    return runNo === 2 && reads[runNo] === 1;          // первое чтение третьего прогона
  };
  const reps = [];
  for (let i = 0; i < 10; i++) {
    runNo = i;
    const r = await runOnce(w);
    reps.push(r);
    if (r.rep.ans.фаза === 'итог') break;
    w.clock.t += 5 * 60000;
  }
  const V = reps.pop().rep.ans.вердикты;
  assert.match(V.здоровый, /^ДЕРЖИТСЯ/, 'неудачное чтение принято за сброс: ' + V.здоровый);
  assert.match(V.мёртвый, /^ЗАСТРЕВАЕТ/);
});

test('чтение сразу после записи не удалось — вывод по следующему удачному, а не «не закрепился»', async () => {
  const w = world({ model: 'sticky' });
  let afterPut = false;
  w.fail = (m, p) => {
    if (m === 'put' && p === '/proxies/' + P + 'Здоров') { afterPut = true; return false; }
    if (afterPut && m === 'get' && p === '/proxies/' + P + 'Здоров') { afterPut = false; return true; }
    return false;
  };
  const V = (await cycle(w)).pop().rep.ans.вердикты;
  assert.match(V.здоровый, /^ДЕРЖИТСЯ/, V.здоровый);
});

test('журнал /logs — только код и длина, без содержимого', async () => {
  const w = world();
  const { rep } = await runOnce(w);
  const row = rep.ans.карта.find((r) => r.путь === '/logs');
  assert.ok(row && typeof row.длина === 'number', 'нет длины журнала');
  assert.ok(!('ответ' in row), 'содержимое журнала в выгрузке');
});

test('обёртка не стояла на ручной группе до закрепления — вывода нет', async () => {
  const w = world({ manualStart: DUMMY });              // Ручной мёртв с самого начала
  const V = (await cycle(w)).pop().rep.ans.вердикты;
  assert.match(V.обёртка, /^вывод невозможен/, V.обёртка);
});

test('возврат Ручного не прошёл — «не выполнен», а не «не возвращается»', async () => {
  const w = world();
  let puts = 0;
  w.fail = (m, p) => m === 'put' && p === '/proxies/' + P + 'Ручной' && ++puts === 2;
  const V = (await cycle(w)).pop().rep.ans.вердикты;
  assert.match(V.обёртка_возврат, /^возврат не выполнен: PUT 500/, V.обёртка_возврат);
});

test('после «итог» цикл не начинается заново и через 7 часов', async () => {
  const w = world();
  await cycle(w);
  const before = writes(w).length;
  w.clock.t += 7 * 3600000;
  const { rep } = await runOnce(w);
  assert.equal(rep.ans.фаза, 'итог');
  assert.equal(writes(w).length, before);
});

test('перехватчик: контроллер молчит — сторож, одна страница «не успел»', async () => {
  const w = world({ hang: true });
  const st = await cmd(w, 'http://rh-cmd.example.net/st19?n=DIRECT');
  assert.match(st.done.response.body, /не успел/);
  assert.equal(JSON.parse(w.store.RH_ST19_cmd).ошибка, 'сторож 8 с');
});

test('перехватчик: сторож позже трёх запросов подряд (ловушка ST14)', () => {
  const sec = Number(CMD_CODE.match(/var CTRL_SEC = (\d+)/)[1]);
  const guard = Number(CMD_CODE.match(/setTimeout\(function \(\) \{ out\.ошибка = 'сторож 8 с'[\s\S]*?\}, (\d+)\)/)[1]);
  assert.ok(guard > 3 * sec * 1000, 'сторож ' + guard + ' мс раньше худшего пути ' + 3 * sec * 1000 + ' мс');
});

// ── ПОПРАВКИ ТЕСТИРОВЩИКА 24.09 ───────────────────────────────────────────
test('фазы идут по времени: возврат не раньше 12 минут, итог не раньше 5 минут после возврата', async () => {
  const w = world();
  const phases = [];
  for (let i = 0; i < 8; i++) {
    const { rep } = await runOnce(w);
    phases.push(rep.ans.фаза);
    if (rep.ans.фаза === 'итог') break;
    w.clock.t += 5 * 60000;
  }
  // 0 мин — закрепления; 5, 10 — наблюдение; 15 — возврат; 20 — итог.
  assert.deepEqual(phases, ['наблюдение', 'наблюдение', 'наблюдение', 'возврат', 'итог']);
});

test('закрепления сделаны не все — фаза остаётся «старт», следующий прогон доделывает', async () => {
  // 2 с на ответ: прогрев и наблюдение — 22 с, дальше две пары «запись +
  // чтение», и бюджет кончается.
  const w = world({ step: 2000 });
  w.store.RH_ST19 = JSON.stringify({ v: 1, t0: w.clock.t, фаза: 'старт', hist: [], карта: [], картаГотова: true });
  const { rep } = await runOnce(w);
  const n = Object.keys(rep.ans.закрепления || {}).length;
  assert.ok(n > 0 && n < 6, 'ожидались частичные закрепления, сделано ' + n);
  assert.equal(rep.ans.фаза, 'старт', 'фаза сдвинута при частичных закреплениях');
  w.step = 30; w.clock.t += 5 * 60000;
  const r2 = await runOnce(w);
  assert.equal(Object.keys(r2.rep.ans.закрепления).length, 6);
  assert.equal(r2.rep.ans.фаза, 'наблюдение');
});

test('возврат: снимок того же прогона не попадает в ряд «после возврата»', async () => {
  const w = world({ model: 'sticky' });
  const V = (await cycle(w)).pop().rep.ans.вердикты;
  const st = JSON.parse(w.store.RH_ST19);
  const backSnaps = st.hist.filter((h) => h.фаза === 'возврат' || h.фаза === 'итог');
  assert.ok(backSnaps.every((h) => h.t >= st.tback), 'снимок до возврата помечен как «после»');
  assert.match(V.обёртка_возврат, /^ВОЗВРАЩАЕТСЯ к ручной группе через [1-9]\d* с/, V.обёртка_возврат);
});

test('перехватчик: timeout в секундах; PUT без смены выбора — «не сработала»', async () => {
  const w = world();
  w.fail = (m) => m === 'put';
  const st = await cmd(w, 'http://rh-cmd.example.net/st19?n=DIRECT');
  for (const c of w.calls) assert.equal(c.timeout, 2, 'timeout перехватчика не в секундах: ' + c.timeout);
  assert.equal(JSON.parse(w.store.RH_ST19_cmd).команда.сработала, false);
  assert.match(st.done.response.body, /не переключено/);
});

test('перехватчик без $request называет причину', async () => {
  const w = world();
  await cmd(w, null);
  assert.equal(JSON.parse(w.store.RH_ST19_cmd).ошибка, 'нет $request');
});

test('прогоны раз в минуту: возврат не раньше 12 минут, итог не раньше 5 минут после него', async () => {
  const w = world();
  const log = [];
  for (let i = 0; i < 30; i++) {
    const { rep } = await runOnce(w);
    log.push([i, rep.ans.фаза]);
    if (rep.ans.фаза === 'итог') break;
    w.clock.t += 60000;
  }
  const back = log.find((x) => x[1] === 'возврат');
  const fin = log.find((x) => x[1] === 'итог');
  assert.ok(back && back[0] >= 12, 'возврат на ' + (back && back[0]) + '-й минуте');
  assert.ok(fin && fin[0] - back[0] >= 5, 'итог через ' + (fin && fin[0] - back[0]) + ' мин после возврата');
});

test('карта рычагов на границе бюджета: пункт не начинается без запаса', async () => {
  // 2,2 с на ответ: прогрев и наблюдение — 24,2 с; пункты карты по 2,2 с
  // идут, пока до конца бюджета больше 12 с.
  const w = world({ step: 2200 });
  const t0 = w.clock.t;
  await runOnce(w);
  assert.ok(w.clock.t - t0 <= 45000, 'прогон вышел за бюджет: ' + (w.clock.t - t0));
});

test('повтор чтения после обрыва не выходит за бюджет', async () => {
  // 7 с на ответ, все чтения наблюдения обрываются: повтор допустим, только
  // пока на него есть время.
  const w = world({ step: 7000 });
  let n = 0;
  w.eofWhen = (m) => m === 'get' && ++n > 1;              // прогрев проходит
  const t0 = w.clock.t;
  await runOnce(w);
  assert.ok(w.clock.t - t0 <= 45000, 'прогон вышел за бюджет: ' + (w.clock.t - t0));
});

test('обёртка не уходит с ручной группы — возврат «не применимо», а не «возвращается»', async () => {
  const w = world({ wrapNoSkip: true });
  const V = (await cycle(w)).pop().rep.ans.вердикты;
  assert.match(V.обёртка, /^НЕ ПРОПУСКАЕТ/);
  assert.match(V.обёртка_возврат, /^не применимо/);
});

test('E1: все чтения после закрепления неудачны — не «держится», не «застревает», фаза не идёт дальше', async () => {
  const w = world({ model: 'reset' });
  let runNo = 0;
  w.fail = (m, p) => runNo >= 1 && m === 'get' && (p === '/proxies/' + P + 'Здоров' || p === '/proxies/' + P + 'Мёртв');
  let last;
  for (let i = 0; i < 6; i++) { runNo = i; last = await runOnce(w); w.clock.t += 5 * 60000; }
  const V = last.rep.ans.вердикты;
  assert.ok(!/^ДЕРЖИТСЯ/.test(V.здоровый), 'неудачные чтения продлили «держится»: ' + V.здоровый);
  assert.ok(!/^ЗАСТРЕВАЕТ/.test(V.мёртвый), 'неудачные чтения дали «застревает»: ' + V.мёртвый);
  assert.equal(last.rep.ans.фаза, 'наблюдение', 'переход к возврату без удачных снимков');
});

test('E2: чтение обёртки после возврата не удалось — не «не возвращается» и не «итог»', async () => {
  const w = world({ model: 'sticky' });
  let back = false;
  w.fail = (m, p) => {
    if (m === 'put' && p === '/proxies/' + P + 'Ручной' && w.g[P + 'Ручной'].now === DUMMY) back = true;
    return back && m === 'get' && p === '/proxies/' + P + 'Обёртка';
  };
  const reps = [];
  for (let i = 0; i < 7; i++) { reps.push(await runOnce(w)); w.clock.t += 5 * 60000; }
  const last = reps[reps.length - 1].rep.ans;
  assert.notEqual(last.фаза, 'итог', 'итог без удачного чтения обёртки после возврата');
  assert.ok(!/НЕ ВОЗВРАЩАЕТСЯ/.test(last.вердикты.обёртка_возврат || ''), last.вердикты.обёртка_возврат);
});

test('чтения обёртки до возврата неудачны — не «не пропускает», а «рано судить»', async () => {
  const w = world({ wrapNoSkip: true });
  let pinned = false;
  w.fail = (m, p) => {
    if (m === 'put' && p === '/proxies/' + P + 'Ручной') pinned = true;
    return pinned && m === 'get' && p === '/proxies/' + P + 'Обёртка';
  };
  let last;
  for (let i = 0; i < 5; i++) { last = await runOnce(w); w.clock.t += 5 * 60000; }
  assert.ok(!/^НЕ ПРОПУСКАЕТ/.test(last.rep.ans.вердикты.обёртка || ''), last.rep.ans.вердикты.обёртка);
});
