// Собственные тесты общего подставного контроллера Stash (tests/fake-stash.js).
//
// ЗАЧЕМ. На этой модели держатся тесты проб ST18–ST20 и будущих; если модель
// тихо разойдётся с поведением Stash, установленным пробами (CHANGELOG
// ST18–ST20), тесты проб станут зелёными на неверном коде. Здесь сторожатся
// именно те свойства, на которых ловятся ловушки проекта: timeout пишется как
// есть (секунды против миллисекунд), второй $done виден, не-ASCII путь — 400.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createStash, sandbox, settle, SECRET, T0, BYPASS_WORD } from './fake-stash.js';

const BASE = 'http://127.0.0.1:9090';
const FB = 'RH-Тест-Резерв';

function groups() {
  return {
    Выбор: { type: 'Selector', now: 'DIRECT', all: ['DIRECT', 'REJECT'] },
    [FB]: { type: 'Fallback', now: 'DIRECT', fixed: '', all: ['DIRECT', 'Прямо'] },
    Скорость: { type: 'URLTest', now: 'DIRECT', all: ['DIRECT', 'Прямо'] },
    Баланс: { type: 'LoadBalance', now: 'DIRECT', all: ['DIRECT', 'Прямо'] },
  };
}

// Запрос в контроллер напрямую, без песочника: { err, status, body, json }.
function ask(w, method, pathOrUrl, { body, timeout = 5, raw = false } = {}) {
  const url = raw ? pathOrUrl : BASE + pathOrUrl;
  const o = { url, headers: { Authorization: SECRET }, timeout };
  if (body !== undefined) o.body = JSON.stringify(body);
  return new Promise((res) => w.handle(method, o, (err, resp, data) => {
    let json = null;
    try { json = JSON.parse(data); } catch (e) { /* не JSON */ }
    res({ err, status: resp && resp.status, body: data, json });
  }));
}
// Объект из vm-контекста — с чужим прототипом; сравнение по значению.
const plain = (v) => JSON.parse(JSON.stringify(v));
const gp = (n) => '/proxies/' + encodeURIComponent(n);
const put = (w, n, want, o = {}) => ask(w, 'put', gp(n), { body: { name: want }, ...o });

test('не-ASCII путь без encodeURIComponent — 400, закодированный — 200', async () => {
  const w = createStash({ groups: groups() });
  const bad = await ask(w, 'get', '/proxies/' + FB);
  assert.equal(bad.status, 400);
  const good = await ask(w, 'get', gp(FB));
  assert.equal(good.status, 200);
  assert.equal(good.json.name, FB);
  assert.equal(w.calls[1].name, FB, 'имя в журнале не раскодировано');
});

test('журнал: timeout как есть (ловушка «секунды против миллисекунд»), метод, путь, секрет, тело, время', async () => {
  const w = createStash({ groups: groups() });
  await ask(w, 'get', gp('Выбор'), { timeout: 5000 });
  await put(w, 'Выбор', 'REJECT', { timeout: 5 });
  assert.equal(w.calls[0].timeout, 5000, 'миллисекунды должны остаться видны тесту пробы');
  assert.equal(w.calls[1].timeout, 5);
  assert.deepEqual([w.calls[0].method, w.calls[1].method], ['get', 'put']);
  assert.equal(w.calls[1].p, gp('Выбор'));
  assert.equal(w.calls[1].auth, SECRET);
  assert.equal(JSON.parse(w.calls[1].body).name, 'REJECT');
  assert.equal(w.calls[0].t, T0);
  assert.equal(w.calls[1].t, T0 + 30, 'время запроса не по подставным часам');
  assert.equal(w.writes().length, 1);
});

test('часы: каждый ответ сдвигает на step; Date и Date.now в песочнике — подставные', async () => {
  const w = createStash({ groups: groups(), step: 700 });
  await ask(w, 'get', gp('Выбор'));
  await ask(w, 'get', gp('Выбор'));
  assert.equal(w.clock.t, T0 + 1400);
  const code = 'var a = Date.now(), b = new Date().getTime(), c = new Date(0).getTime(); $done({ a: a, b: b, c: c });';
  const st = await settle(sandbox(w, code, 'clock.js'), 1000, 5);
  assert.deepEqual(plain(st.done), { a: T0 + 1400, b: T0 + 1400, c: 0 });
});

test('группа: неизвестная — 404; неизвестный член — 400 «proxy not exist», выбор не сбит', async () => {
  const seen = [];
  const w = createStash({ groups: groups(), onUnknown: (n, want) => seen.push(n + ':' + want) });
  assert.equal((await ask(w, 'get', gp('Нет-такой'))).status, 404);
  const r = await put(w, 'Выбор', 'Призрак');
  assert.equal(r.status, 400);
  assert.match(r.json.message, /Selector update error: proxy not exist/);
  assert.equal(w.g.Выбор.now, 'DIRECT');
  assert.deepEqual(seen, ['Выбор:Призрак']);
  assert.equal((await put(w, 'Выбор', 'REJECT')).status, 204);
  assert.equal((await ask(w, 'get', gp('Выбор'))).json.now, 'REJECT');
});

test('Fallback по умолчанию закрепляется (ST18): now меняется, поля fixed в ответе нет', async () => {
  const w = createStash({ groups: groups() });
  assert.equal((await put(w, FB, 'Прямо')).status, 204);
  const r = await ask(w, 'get', gp(FB));
  assert.equal(r.json.now, 'Прямо');
  assert.ok(!('fixed' in r.json), 'у Stash поля fixed в ответе нет');
  assert.equal(w.g[FB].fixedAt, T0, 'время закрепления не записано');
  const wf = createStash({ groups: groups(), fixedField: true });
  await put(wf, FB, 'Прямо');
  assert.equal((await ask(wf, 'get', gp(FB))).json.fixed, 'Прямо');
});

test('Fallback по опции: reject — 400; ignore — 204 без перемен; pinOnly — только fixed', async () => {
  const wr = createStash({ groups: groups(), fallback: 'reject' });
  assert.equal((await put(wr, FB, 'Прямо')).status, 400);
  assert.equal(wr.g[FB].now, 'DIRECT');
  const wi = createStash({ groups: groups(), fallback: 'ignore', fixedField: true });
  assert.equal((await put(wi, FB, 'Прямо')).status, 204);
  assert.deepEqual([wi.g[FB].now, wi.g[FB].fixed], ['DIRECT', '']);
  const wp = createStash({ groups: groups(), fallback: 'pinOnly', fixedField: true });
  assert.equal((await put(wp, FB, 'Прямо')).status, 204);
  const r = await ask(wp, 'get', gp(FB));
  assert.deepEqual([r.json.now, r.json.fixed], ['DIRECT', 'Прямо']);
});

test('URLTest закрепляется, по опции — 400; LoadBalance — 400 (ST19)', async () => {
  const w = createStash({ groups: groups() });
  assert.equal((await put(w, 'Скорость', 'Прямо')).status, 204);
  assert.equal(w.nowOf('Скорость'), 'Прямо');
  const lb = await put(w, 'Баланс', 'Прямо');
  assert.equal(lb.status, 400);
  assert.match(lb.json.message, /must be one of Selector \/ URLTest \/ Fallback/);
  assert.equal(w.g.Баланс.now, 'DIRECT');
  const wr = createStash({ groups: groups(), urltest: 'reject' });
  assert.equal((await put(wr, 'Скорость', 'Прямо')).status, 400);
  assert.equal(wr.g.Скорость.now, 'DIRECT');
});

test('DELETE по умолчанию — 405 и закрепление остаётся (ST18); unfix — как mihomo', async () => {
  const w = createStash({ groups: groups(), fixedField: true });
  await put(w, FB, 'Прямо');
  assert.equal((await ask(w, 'delete', gp(FB))).status, 405);
  assert.deepEqual([w.g[FB].now, w.g[FB].fixed], ['Прямо', 'Прямо']);
  const wu = createStash({ groups: groups(), fixedField: true, del: 'unfix' });
  await put(wu, FB, 'Прямо');
  assert.equal((await ask(wu, 'delete', gp(FB))).status, 204);
  assert.deepEqual([wu.g[FB].now, wu.g[FB].fixed], ['DIRECT', '']);
  assert.equal((await ask(wu, 'delete', gp('Выбор'))).status, 404, 'select снимать нечего');
  const w4 = createStash({ groups: groups(), del: '404' });
  assert.equal((await ask(w4, 'delete', gp(FB))).status, 404);
});

test('EOF: первые eof запросов; eofStep: false — без траты времени; eofWhen тратит', async () => {
  const w = createStash({ groups: groups(), eof: 1, eofStep: false });
  const r = await ask(w, 'get', '/');
  assert.match(String(r.err), /EOF/);
  assert.equal(w.clock.t, T0, 'мгновенный EOF потратил время');
  assert.equal((await ask(w, 'get', '/')).status, 200);
  const w2 = createStash({ groups: groups(), eof: 1 });
  await ask(w2, 'get', '/');
  assert.equal(w2.clock.t, T0 + 30, 'EOF по тайм-ауту не потратил времени');
  const w3 = createStash({ groups: groups(), eofWhen: (m, p) => p === '/proxies/Выбор' });
  assert.match(String((await ask(w3, 'get', gp('Выбор'))).err), /EOF/);
  assert.equal(w3.clock.t, T0 + 30);
  assert.equal((await ask(w3, 'get', gp(FB))).status, 200);
});

test('fail: true — 500, число — код, объект — как задан; путь раскодирован', async () => {
  const w = createStash({ groups: groups() });
  const seen = [];
  w.fail = (m, p) => { seen.push(p); return p === '/proxies/Выбор' ? true : p === '/' ? 401 : { status: 503, body: 'x' }; };
  assert.deepEqual([(await ask(w, 'get', gp('Выбор'))).status, (await ask(w, 'get', gp('Выбор'))).body], [500, 'oops']);
  assert.equal((await ask(w, 'get', '/')).status, 401);
  const r = await ask(w, 'get', '/configs');
  assert.deepEqual([r.status, r.body], [503, 'x']);
  assert.equal(seen[0], '/proxies/Выбор');
});

test('hang — ответа нет; late — один запрос отвечает позже, индекс записан', async () => {
  const w = createStash({ groups: groups(), hang: true });
  let got = false;
  w.handle('get', { url: BASE + '/' }, () => { got = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(got, false);
  const wl = createStash({ groups: groups(), late: (c) => c.method === 'put', lateMs: 80 });
  const t = Date.now();
  await ask(wl, 'get', gp('Выбор'));
  assert.ok(Date.now() - t < 60);
  await put(wl, 'Выбор', 'REJECT');
  assert.ok(Date.now() - t >= 75, 'запоздалый ответ пришёл вовремя');
  assert.equal(wl.lateIdx, 1);
});

test('обходной узел: PUT и /delay отвечают как устройство, но пишутся в w.bypass; settle их не пропускает', async () => {
  const node = 'DE ' + BYPASS_WORD + ' VPN';
  const w = createStash({ groups: { Р: { type: 'Selector', now: 'DIRECT', all: ['DIRECT', node] },
    А: { type: 'Fallback', all: [node, 'DIRECT'] }, В: { type: 'Selector', now: 'Р', all: ['Р'] } } });
  assert.equal(w.nowOf('А'), 'DIRECT');
  assert.equal((await ask(w, 'get', gp('В') + '/delay')).status, 200);
  assert.deepEqual(w.bypass, []);
  assert.equal((await put(w, 'Р', node)).status, 204);
  assert.equal(w.g.Р.now, node);
  assert.equal((await ask(w, 'get', gp('В') + '/delay')).status, 200);
  assert.deepEqual(w.bypass, [{ group: 'Р', want: node }, { delay: 'В', leaf: node }]);
  const code = 'var c = $environment["controller-url"];' +
    '$httpClient.get({ url: c + "/proxies/" + encodeURIComponent("Р") + "/delay", timeout: 5 }, function () { $done({}); });';
  const st = sandbox(w, code, 'bypass.js');
  await assert.rejects(settle(st), /правило 1/);
  const w2 = createStash({ groups: { Р: { type: 'Selector', now: node, all: [node] } } });
  await settle(sandbox(w2, code, 'bypass.js'), 5000, 150, { allowBypass: true });
  assert.deepEqual(w2.bypass, [{ delay: 'Р', leaf: node }]);
});

test('маршруты: свой route раньше общего; /proxies — список; DIRECT встроен, builtins: false — нет', async () => {
  const w = createStash({ groups: groups(), route: (m, p, o, reply) => (p === '/configs' ? reply(200, '{"mode":"rule"}') : undefined) });
  assert.equal((await ask(w, 'get', '/configs')).json.mode, 'rule');
  const list = await ask(w, 'get', '/proxies');
  assert.deepEqual(Object.keys(list.json.proxies).sort(), Object.keys(groups()).sort());
  assert.equal((await ask(w, 'get', '/proxies/DIRECT')).status, 200);
  assert.equal((await ask(w, 'get', '/proxies/DIRECT/delay')).json.delay, 42);
  assert.equal((await ask(w, 'get', '/nope')).status, 404);
  const wb = createStash({ groups: groups(), builtins: false });
  assert.equal((await ask(wb, 'get', '/proxies/DIRECT')).status, 404);
});

test('putReject и noMove: 400 до проверок; 204 без смены выбора', async () => {
  const w = createStash({ groups: groups(), putReject: (n) => n === 'Выбор' && '{"message":"нет"}' });
  const r = await put(w, 'Выбор', 'REJECT');
  assert.deepEqual([r.status, r.json.message, w.g.Выбор.now], [400, 'нет', 'DIRECT']);
  const wn = createStash({ groups: groups(), noMove: (n, ww) => ww.puts[n] > 1 });
  assert.equal((await put(wn, 'Выбор', 'REJECT')).status, 204);
  assert.equal((await put(wn, 'Выбор', 'DIRECT')).status, 204);
  assert.equal(wn.g.Выбор.now, 'REJECT', 'noMove не удержал выбор');
});

test('песочник: $environment, уведомление с буфером, хранилище, запреты методов', async () => {
  const w = createStash({ groups: groups() });
  const code = [
    'var e = $environment["controller-url"] + "|" + $environment["controller-authorization"];',
    '$persistentStore.write("v1", "K");',
    'var thrown = []; ["post", "patch", "delete"].forEach(function (m) { try { $httpClient[m]({ url: "x" }, function () {}); } catch (x) { thrown.push(m); } });',
    '$notification.post("T", "S", "B", { clipboard: "буфер" });',
    '$httpClient.get({ url: "http://127.0.0.1:9090/", timeout: 5 }, function (err, r) { $done({ e: e, s: r.status, thrown: thrown, k: $persistentStore.read("K") }); });',
  ].join('\n');
  const st = await settle(sandbox(w, code, 'sb.js', { forbid: ['post', 'patch', 'delete'], noteTag: { tile: true } }), 1000, 5);
  assert.deepEqual(plain(st.done), { e: BASE + '|' + SECRET, s: 200, thrown: ['post', 'patch', 'delete'], k: 'v1' });
  assert.equal(st.note.clip, 'буфер');
  assert.deepEqual(w.notes, [{ at: T0, t: 'T', s: 'S', b: 'B', tile: true }]);
  assert.equal(w.store.K, 'v1');
  const st2 = sandbox(createStash(), '$httpClient.delete({ url: "http://127.0.0.1:9090/x" }, function (e, r) { $done({ s: r.status }); });', 'd.js');
  assert.equal((await settle(st2, 1000, 5)).done.s, 404, 'DELETE по умолчанию разрешён');
});

test('таймеры: по умолчанию ms/1000; stretch растягивает до timer (дефект ST14)', async () => {
  const seen = [];
  const w = createStash();
  const code = 'setTimeout(function () { $done({}); }, 75000);';
  await settle(sandbox(w, code, 't.js', { stretch: 4, timer: (ms) => { seen.push(ms); return 1; } }), 1000, 5);
  assert.deepEqual(seen, [300000], 'сторож 75 с в фоне растягивается до 300 с');
  const t = Date.now();
  await settle(sandbox(w, code, 't2.js'), 1000, 5);
  assert.ok(Date.now() - t >= 70, 'по умолчанию 75 с → 75 мс настоящего времени');
});

test('settle: второй $done ловится, даже запоздалый; без $done — отказ', async () => {
  const w = createStash();
  const twice = '$done({}); setTimeout(function () { $done({}); }, 50000);';
  await assert.rejects(settle(sandbox(w, twice, 'x.js'), 1000, 150), /ровно один \$done/);
  const sync = '$done({}); $done({});';
  await assert.rejects(settle(sandbox(w, sync, 'y.js'), 1000, 5), /ровно один \$done/);
  await assert.rejects(settle(sandbox(w, '1;', 'z.js'), 50, 5), /не дошла до \$done/);
  const one = await settle(sandbox(w, '$done({ ok: 1 });', 'o.js'), 1000, 5);
  assert.equal(one.doneCalls, 1);
});
