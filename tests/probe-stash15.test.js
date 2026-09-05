// Поведение пробы ST15 в песочнице с подставным контроллером.
//
// ЗАЧЕМ СВЕРХ probes-smoke. Смоук проверяет одно: проба доживает до `$done`.
// У ST15 цена ошибки в трёх местах, и все три уже сработали в первой
// редакции (ревью 05.09).
//
// ПЕРВОЕ — ПРАВИЛО 1. Каскад RH-AI заканчивается обходом, то есть обходные
// узлы лежат прямо в проверяемом списке. Сломается фильтр — проба начнёт
// гонять по платному трафику шесть запросов на узел, и в выгрузке это будет
// выглядеть обычной строкой. Тест ловит обращение к обходному узлу по
// ЗАГОЛОВКУ запроса, а не по внутренним переменным пробы. Второй рубеж —
// отказ начинать, когда группа сейчас на обходе, — проверяется отдельно.
//
// ВТОРОЕ — НЕПОЛНЫЙ ПРОГОН НЕ ДОЛЖЕН ВЫГЛЯДЕТЬ ШТАТНЫМ. В первой редакции
// знаменатель считался по ПРИШЕДШИМ ответам: узел, у которого пропал ровно
// тот сервис, ради которого проба и написана, получал «4 из 4» и уходил в
// чистые. Знаменатель обязан быть заявленным.
//
// ТРЕТЬЕ — РАЗЛИЧЕНИЕ ОТКАЗОВ. Весь смысл пробы в том, чтобы «не работает»
// распалось на «не дошли» (про узел), «запрет» (про адрес) и «временно» (ни
// о чём). Слипнутся — вердикт укажет чинить не то. Проект это уже проходил
// на ST14, где собственный тайм-аут пробы объявлялся молчанием узла.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = 'probes/routehub-probe-stash15.js';
const CODE = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
const num = (name) => Number(new RegExp('var ' + name + ' = (\\d+)').exec(CODE)[1]);
const NODES_N = num('NODES_N');
const SERVICES_N = (CODE.match(/\{ id: '/g) || []).length;

const SECRET = 'Bearer ОЧЕНЬ-СЕКРЕТНО';
// Имена в боевой форме: с хвостом метрик, который навешивает рендерер.
const N1 = '🇩🇪 ⭐ 🟢 Германия [VPN] · 37↓202 / 7↓96';
const N2 = '🇳🇱 ⭐ 🚀 Нидерланды [VPN] · 28↓166 / 7↓96';
const N3 = '🇹🇷 ⭐ 🟢 Турция [VPN] · 25↓267 / 7↓96';
const BYP = '🇫🇮 Финляндия [Обход] 03 · 21↓68 / 7↓96';
const S1 = '🇩🇪 ⭐ 🟢 Германия [VPN]';
const S2 = '🇳🇱 ⭐ 🚀 Нидерланды [VPN]';
const S3 = '🇹🇷 ⭐ 🟢 Турция [VPN]';

// Родители RH-AI / RH-АВТО / RH-Звонки: по хвосту их выбора проба читает,
// какую сеть выбрало ядро по ssid-policy. Это НЕ декорация: на устройстве
// группы -W и -C существуют одновременно.
function parents(net) {
  const suffix = net === 'cell' ? '-C' : '-W';
  const m = {};
  for (const g of ['RH-AI', 'RH-АВТО', 'RH-Звонки']) m[g] = { type: 'Selector', now: g + suffix };
  return m;
}

const TRACE = 'fl=12a34\nh=www.cloudflare.com\nip=203.0.113.77\nts=1.0\nloc=DE\nwarp=off\n';
const ROBOTS = 'User-agent: *\nDisallow: /api\n';

// svc/geo: (url, node) -> {status, body} | {status:0} | {silent:true}
function run(opts = {}) {
  const {
    members = [N1, N2, N3, BYP],
    now = N1,
    net = 'wifi',
    pool = 'RH-AI-W',
    proxies = null,
    svc = () => ({ status: 200, body: ROBOTS }),
    geo = () => ({ status: 200, body: TRACE }),
    controller = null,
  } = opts;
  const state = { done: null, note: null, ctl: [], pinned: [], late: 0 };

  function respond(o, cb) {
    const url = String(o.url || '');
    const pin = o.headers && o.headers['X-Stash-Selected-Proxy'];
    const node = pin ? decodeURIComponent(pin) : null;
    const ok = (status, body) => setTimeout(() => cb(null, { status, headers: {} }, body), 1);

    if (url.indexOf('127.0.0.1') >= 0) {
      state.ctl.push({ url, auth: (o.headers && o.headers.Authorization) || null });
      if (controller) return controller(url, ok, cb);
      if (url.indexOf('/proxies') >= 0) {
        const p = proxies || (() => {
          const m = parents(net);
          m[pool] = { type: 'Fallback', now, all: members };
          for (const x of members) m[x] = { type: 'Vless', alive: true, delay: 120 };
          return m;
        })();
        return ok(200, JSON.stringify({ proxies: p }));
      }
      return ok(200, '{}');
    }

    state.pinned.push({ url, node, pin, headers: o.headers || {} });
    const r = (url.indexOf('cdn-cgi/trace') >= 0) ? geo(url, node) : svc(url, node);
    if (r.silent) { state.late++; return; }        // обратный вызов не придёт никогда
    if (r.status === 0) return setTimeout(() => cb('обрыв, выдуман тестом', null, null), 1);
    return ok(r.status, r.body);
  }

  const sandbox = {
    console: { log: () => {} },
    JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, isFinite, encodeURIComponent, decodeURIComponent,
    // Все паузы ускоряем, включая сторожа: иначе тест на «обратный вызов не
    // придёт» упирался бы в 40 с настоящего ожидания. Пропорции сохраняем —
    // предохранитель узла (9 с) остаётся раньше сторожа (40 с).
    setTimeout: (fn, ms) => setTimeout(fn, Math.max(1, Math.round((ms || 0) / 400))),
    clearTimeout,
    $environment: {
      'controller-url': 'http://127.0.0.1:9090',
      'controller-authorization': SECRET,
      'stash-version': '3.4.1',
    },
    $notification: { post: (t, s, b, o) => { state.note = { t, s, b, clip: (o && o.clipboard) || null }; } },
    $httpClient: {
      get: respond,
      head: respond,
      // Любая запись в маршрутизацию обязана уронить прогон, а не пройти тихо.
      post: () => { throw new Error('проба не должна писать в маршрутизацию'); },
      put: () => { throw new Error('проба не должна писать в маршрутизацию'); },
      patch: () => { throw new Error('проба не должна писать в маршрутизацию'); },
      delete: () => { throw new Error('проба не должна писать в маршрутизацию'); },
    },
    $done: (v) => { state.done = v || {}; },
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(CODE, vm.createContext(sandbox), { filename: FILE });
  return state;
}

async function settle(state, ms = 8000) {
  const until = Date.now() + ms;
  while (!state.done && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  assert.ok(state.done, 'проба не дошла до $done — цепочка оборвалась');
  assert.ok(state.note && state.note.clip, 'отчёт не попал в буфер обмена');
  return JSON.parse(state.note.clip);
}

// ── СООТНОШЕНИЯ КОНСТАНТ ─────────────────────────────────────────────
// Песочница не моделирует клиентский тайм-аут: подставной $httpClient
// отвечает через миллисекунду независимо от SVC_SEC. Значит поведенческим
// тестом дефект «предохранитель раньше собственного тайм-аута» (он же дефект
// ST14, он же первая редакция ST15) не ловится ВООБЩЕ — его держал бы только
// комментарий. Поэтому соотношения проверяются по тексту файла.

test('предохранитель узла стоит позже клиентского тайм-аута', () => {
  const watch = num('NODE_WATCH_MS'), svc = num('SVC_SEC');
  assert.ok(watch > svc * 1000 * 1.25,
    'предохранитель ' + watch + ' мс режет собственный живой запрос (' + svc + ' с): ' +
    'измеряется терпение пробы, а не узел');
});

test('сторож срабатывает позже худшего честного прогона и раньше бюджета', () => {
  const guard = num('GUARD_MS'), budget = num('BUDGET_MS');
  const worst = (num('CTRL_SEC') + num('NODES_N') * num('SVC_SEC')) * 1000;
  assert.ok(guard > worst, 'сторож ' + guard + ' мс рубит штатный прогон (' + worst + ' мс)');
  assert.ok(budget > guard, 'бюджет меньше сторожа — сторож станет основным путём выхода');
});

test('резерв на узел покрывает растянутый предохранитель', () => {
  // setTimeout у Stash в фоне растягивается втрое-вчетверо (ST5). Резерв,
  // посчитанный по честным секундам, пустил бы пробу в последний узел, на
  // который у неё нет времени, и прогон умер бы по timeout задания cron.
  assert.ok(num('NODE_COST_MS') >= num('NODE_WATCH_MS') * 2,
    'резерв на узел меньше удвоенного предохранителя');
});

// ── ПРАВИЛО 1 ────────────────────────────────────────────────────────

test('правило 1, первый рубеж: обходной узел не получает ни одного запроса', async () => {
  const st = run();
  const rep = await settle(st);
  const touched = st.pinned.filter((p) => p.node && p.node.indexOf('Обход') >= 0);
  assert.equal(touched.length, 0,
    'через обходной узел ушли запросы: ' + touched.map((p) => p.url).join(', '));
  assert.equal(rep.ans.обходных_пропущено, 1, 'обходной узел не посчитан пропущенным');
  assert.ok(JSON.stringify(rep.ans.узлы).indexOf('Обход') < 0, 'обход попал в выгрузку');
});

test('правило 1, второй рубеж: группа сейчас на обходе — прогон не начинается', async () => {
  const st = run({ now: BYP });
  const rep = await settle(st);
  assert.equal(st.pinned.length, 0, 'при обходном текущем выборе всё равно ушли запросы');
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('НЕ НАЧАЛИ') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('платному трафику') >= 0, 'вердикт не назвал причину отказа');
});

test('вложенная группа и служебный член узлами не считаются', async () => {
  const members = ['DIRECT', 'RH-Обход', N1, N2];
  const st = run({
    members,
    proxies: Object.assign(parents('wifi'), {
      'RH-AI-W': { type: 'Fallback', now: N1, all: members },
      DIRECT: { type: 'Direct' },
      'RH-Обход': { type: 'Fallback', now: BYP, all: [BYP] },
      [N1]: { type: 'Vless', alive: true }, [N2]: { type: 'Vless', alive: true },
    }),
  });
  const rep = await settle(st);
  const bad = st.pinned.filter((p) => p.node === 'DIRECT' || p.node === 'RH-Обход');
  assert.equal(bad.length, 0, 'запрос ушёл через группу или служебный член: пиновка отдала бы его обходу');
  assert.equal(rep.ans.взято, 2, 'взято не два узла: ' + rep.ans.взято);
  assert.ok(rep.ans.не_узлы >= 1, 'отброшенные члены не посчитаны — разницу в отчёте объяснить нечем');
});

// ── ПРАВИЛО 2 И СЕКРЕТ ───────────────────────────────────────────────

test('правило 2: к контроллеру только GET и только чтение /proxies', async () => {
  const st = run();
  await settle(st);
  assert.ok(st.ctl.length > 0, 'контроллер не опрашивался вовсе');
  for (const c of st.ctl) {
    assert.ok(c.url.indexOf('/proxies') >= 0, 'лишний путь у контроллера: ' + c.url);
    assert.equal(c.auth, SECRET, 'запрос к контроллеру ушёл без ключа');
  }
});

test('секрет контроллера не утекает ни в отчёт, ни в видимый текст', async () => {
  const st = run();
  const rep = await settle(st);
  const all = JSON.stringify(rep) + JSON.stringify(st.note) + JSON.stringify(st.done);
  assert.ok(all.indexOf('ОЧЕНЬ-СЕКРЕТНО') < 0, 'ключ контроллера виден пользователю или в отчёте');
});

test('запрос к сервису идёт с User-Agent — иначе 403 бот-защиты неотличим от странового', async () => {
  const st = run();
  await settle(st);
  const h = st.pinned[0].headers;
  assert.ok(h['User-Agent'] && h['User-Agent'].indexOf('Mozilla') === 0,
    'нет User-Agent: край ответит бот-защитой на ровном месте');
  assert.ok(h.Accept, 'нет Accept');
});

test('имя узла уходит полным и закодированным', async () => {
  const st = run();
  await settle(st);
  const p = st.pinned[0];
  assert.notEqual(p.pin, p.node, 'имя не закодировано: encodeURIComponent пропущен');
  assert.equal(p.node, N1, 'пиновка ушла на короткое имя — ядро сопоставляет строкой и не найдёт узел');
});

// ── КЛАССИФИКАЦИЯ ────────────────────────────────────────────────────

test('все сервисы отвечают — узлы чистые, страна и отпечаток тела на месте', async () => {
  const st = run();
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('ЧИСТЫ ВСЕ') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.equal(rep.ans.сеть, 'Wi-Fi', 'сеть прочитана неверно');
  const first = rep.ans.узлы[S1];
  assert.equal(first.страна, 'DE', 'страна выхода не разобрана из trace');
  assert.equal(Object.keys(first.сервисы).length, SERVICES_N, 'проверены не все сервисы');
  assert.ok(first.сервисы.ChatGPT.байт > 0, 'у ответа нет отпечатка — «ОТВЕТИЛ» нечем перепроверить');
  assert.ok(first.сервисы.ChatGPT.начало.indexOf('User-agent') >= 0, 'отпечаток тела пуст');
  assert.ok(String(first.выход).indexOf('203.0.113') >= 0, 'адрес выхода не записан');
});

test('запрет, обрыв и временный отказ — три разных исхода', async () => {
  const st = run({
    svc: (url, node) => {
      if (node === N3) return { status: 403, body: 'Access denied: unsupported_country' };
      if (node === N2 && url.indexOf('chatgpt') >= 0) return { status: 0 };
      if (node === N2 && url.indexOf('grok') >= 0) return { status: 503, body: 'oops' };
      return { status: 200, body: ROBOTS };
    },
  });
  const rep = await settle(st);
  const тур = rep.ans.узлы[S3], нид = rep.ans.узлы[S2];
  assert.equal(тур.сервисы.ChatGPT.итог, 'ЗАПРЕТ', '403 не опознан как запрет');
  assert.equal(тур.сервисы.ChatGPT.вид, 'страна', 'страновой запрет не отличён от бот-защиты');
  assert.ok(тур.сервисы.ChatGPT.ответ.indexOf('unsupported_country') >= 0, 'причина запрета не сохранена');
  assert.equal(нид.сервисы.ChatGPT.итог, 'НЕ ДОШЛИ', 'обрыв не отличён от запрета');
  assert.equal(нид.сервисы.Grok.итог, 'ВРЕМЕННО', '503 засчитан как отказ узла');
  assert.equal(нид.сервисы.Claude.итог, 'ОТВЕТИЛ', 'отказ одного сервиса задел соседний');
  assert.ok(rep.ans.частично.indexOf(S2) >= 0, 'узел с одним отказом объявлен негодным целиком');
  assert.ok(rep.ans.мимо.indexOf(S3) >= 0, 'узел, где отказали все сервисы, не отнесён к негодным');
});

test('403 от бот-защиты помечается как бот-защита, а не как страна', async () => {
  const st = run({ svc: () => ({ status: 403, body: '<title>Just a moment...</title>' }) });
  const rep = await settle(st);
  assert.equal(rep.ans.узлы[S1].сервисы.ChatGPT.вид, 'бот-защита',
    'бот-защита выдана за страновой запрет — вердикт отправит менять узел зря');
});

test('редирект — это «ОТВЕТИЛ», а не отказ', async () => {
  const st = run({ svc: () => ({ status: 301, body: '' }) });
  const rep = await settle(st);
  assert.equal(rep.ans.узлы[S1].сервисы.Claude.итог, 'ОТВЕТИЛ', '3xx засчитан как отказ');
});

test('только временные отказы — узел не порочится, вердикт не зовёт чинить туннель', async () => {
  const st = run({ svc: () => ({ status: 429, body: 'slow down' }) });
  const rep = await settle(st);
  assert.ok(rep.ans.узлы[S1].сводка.indexOf('временных отказов ' + SERVICES_N) >= 0,
    'сводка не отличает временный отказ: ' + rep.ans.узлы[S1].сводка);
  assert.ok((rep.ans.только_временные || []).indexOf(S1) >= 0, 'узел не отнесён к «только временные»');
  assert.ok((rep.ans.мимо || []).indexOf(S1) < 0, 'перегрузка края засчитана узлу как отказ');
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('НЕ ПРОВЕРЕНО') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('туннель') < 0, 'вердикт советует чинить исправный туннель');
  assert.notEqual(st.done.backgroundColor, '#34C759', 'непроверенный прогон окрашен как успех');
});

test('один временный отказ не даёт назвать узел чистым', async () => {
  const st = run({
    svc: (url) => (url.indexOf('grok') >= 0 ? { status: 503, body: '' } : { status: 200, body: ROBOTS }),
  });
  const rep = await settle(st);
  assert.ok((rep.ans.чистых || []).indexOf(S1) < 0,
    'узел с непроверенным сервисом объявлен чистым: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('ЧИСТЫ ВСЕ') !== 0, 'заголовок сильнее замера: ' + rep.ans.ВЕРДИКТ);
});

test('один сервис молчит на всех узлах — подозревается наш адрес, а не узлы', async () => {
  const st = run({
    svc: (url) => (url.indexOf('grok') >= 0 ? { status: 404, body: 'not found' } : { status: 200, body: ROBOTS }),
  });
  const rep = await settle(st);
  assert.deepEqual(rep.ans.проверить_адрес, ['Grok'], 'подозрение на список адресов не выставлено');
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('проверить адрес') >= 0,
    'подсказку видно только в JSON, а не в вердикте: ' + rep.ans.ВЕРДИКТ);
  assert.ok(st.done.content.indexOf('проверить адрес') >= 0, 'подсказки нет в видимом тексте');
});

test('страна не прочиталась — это видно, а не подставляется молча', async () => {
  const st = run({ geo: () => ({ status: 403, body: 'no' }) });
  const rep = await settle(st);
  assert.ok(String(rep.ans.узлы[S1].страна).indexOf('403') >= 0,
    'вместо честного «статус 403» подставлено другое: ' + rep.ans.узлы[S1].страна);
});

// ── НЕПОЛНЫЙ ПРОГОН ──────────────────────────────────────────────────

test('пропавший сервис не делает узел чистым — знаменатель заявленный', async () => {
  const st = run({
    svc: (url) => (url.indexOf('chatgpt') >= 0 ? { silent: true } : { status: 200, body: ROBOTS }),
  });
  const rep = await settle(st, 12000);
  const rec = rep.ans.узлы[S1];
  assert.ok(rec.неполно, 'неполный опрос не помечен');
  assert.equal(rec.сервисы.ChatGPT.итог, 'НЕТ ОТВЕТА', 'пропавший сервис исчез из выгрузки');
  assert.ok(rec.сводка.indexOf('из ' + SERVICES_N) >= 0, 'знаменатель посчитан по пришедшим: ' + rec.сводка);
  assert.ok(!rep.ans.чистых || rep.ans.чистых.indexOf(S1) < 0,
    'узел с пропавшим сервисом объявлен чистым');
  assert.ok((rep.ans.неполные || []).indexOf(S1) >= 0, 'узел не отнесён к неполным');
  // И это обязано быть видно в тексте, а не только в буфере обмена.
  assert.ok(st.done.content.indexOf('неполно опрошено') >= 0,
    'срезанный прогон выглядит штатным: ' + st.done.content.slice(0, 200));
});

test('полное молчание сети — проба всё равно доходит до вывода', async () => {
  const st = run({ svc: () => ({ silent: true }), geo: () => ({ silent: true }) });
  const rep = await settle(st, 12000);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('НЕПОЛНО') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.notEqual(st.done.backgroundColor, '#34C759', 'молчание сети окрашено как успех');
});

// ── ГРАНИЦЫ И ОТКАЗЫ КОНТРОЛЛЕРА ─────────────────────────────────────

test('дубликаты коротких имён не опрашиваются дважды и не затирают друг друга', async () => {
  const many = [N1, N2, N3, N1 + ' (2)', N2 + ' (2)'];
  const st = run({ members: many });
  const rep = await settle(st);
  assert.equal(Object.keys(rep.ans.узлы).length, rep.ans.взято,
    'ключей в отчёте меньше, чем опрошено узлов: результат затёрт');
  assert.ok(rep.ans.дубликаты_имён >= 2, 'дубликаты не посчитаны');
  assert.ok(st.pinned.length <= NODES_N * (SERVICES_N + 1), 'запросов больше, чем узлов на сервисы');
});

test('число проверенных узлов не превышает объявленного предела', async () => {
  const many = [];
  for (let i = 0; i < 9; i++) many.push('🇩🇪 узел ' + i + ' [VPN] · 1↓2 / 3↓4');
  const st = run({ members: many });
  const rep = await settle(st);
  assert.equal(Object.keys(rep.ans.узлы).length, NODES_N, 'проверено не ' + NODES_N + ' узлов');
  assert.equal(st.pinned.length, NODES_N * (SERVICES_N + 1), 'лишние запросы');
});

test('контроллер молчит — вердикт называет причину', async () => {
  const st = run({ controller: (url, ok, cb) => setTimeout(() => cb('нет связи', null, null), 1) });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('контроллер не ответил') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.equal(st.pinned.length, 0);
});

test('ответ контроллера не разобран — вердикт называет причину', async () => {
  const st = run({ controller: (url, ok) => ok(200, 'не json') });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('не разобран') >= 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
});

test('группы RH-AI нет в ответе — вердикт называет причину', async () => {
  const st = run({
    controller: (url, ok) => ok(200, JSON.stringify({
      proxies: Object.assign(parents('wifi'), { 'RH-RU': { type: 'Fallback' } }),
    })),
  });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('нет в /proxies') >= 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.equal(st.pinned.length, 0);
});

// На устройстве -W и -C существуют ОДНОВРЕМЕННО, и «W, а если нет — C»
// проверяло бы на сотовой не ту группу, не тот набор узлов и не ту политику
// во втором рубеже правила 1.
test('сотовая сеть: берётся RH-AI-C, хотя RH-AI-W тоже есть', async () => {
  const st = run({
    controller: (url, ok) => ok(200, JSON.stringify({
      proxies: Object.assign(parents('cell'), {
        'RH-AI-W': { type: 'Fallback', now: N1, all: [N1, N2] },
        'RH-AI-C': { type: 'Fallback', now: N3, all: [N3] },
        [N1]: { type: 'Vless', alive: true }, [N2]: { type: 'Vless', alive: true },
        [N3]: { type: 'Vless', alive: true },
      }),
    })),
  });
  const rep = await settle(st);
  assert.equal(rep.ans.группа, 'RH-AI-C', 'на сотовой проверена группа Wi-Fi');
  assert.equal(rep.ans.сеть, 'сотовая');
  assert.equal(rep.ans.взято, 1, 'взят набор узлов не из той группы');
  assert.ok(st.pinned.every((p) => p.node === N3), 'запросы ушли через узлы группы Wi-Fi');
});

test('сотовая: второй рубеж смотрит на выбор ИМЕННО RH-AI-C', async () => {
  const st = run({
    controller: (url, ok) => ok(200, JSON.stringify({
      proxies: Object.assign(parents('cell'), {
        'RH-AI-W': { type: 'Fallback', now: N1, all: [N1] },   // Wi-Fi на обычном узле
        'RH-AI-C': { type: 'Fallback', now: BYP, all: [N2] },  // сотовая — на обходе
        [N1]: { type: 'Vless', alive: true }, [N2]: { type: 'Vless', alive: true },
      }),
    })),
  });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('НЕ НАЧАЛИ') === 0,
    'обходной выбор сотовой группы не остановил прогон: ' + rep.ans.ВЕРДИКТ);
  assert.equal(st.pinned.length, 0);
});

test('родители расходятся или молчат — прогон не начинается наугад', async () => {
  const mixed = { 'RH-AI': { type: 'Selector', now: 'RH-AI-W' },
                  'RH-АВТО': { type: 'Selector', now: 'RH-АВТО-C' } };
  const st = run({
    controller: (url, ok) => ok(200, JSON.stringify({
      proxies: Object.assign(mixed, { 'RH-AI-W': { type: 'Fallback', now: N1, all: [N1] },
                                      [N1]: { type: 'Vless', alive: true } }),
    })),
  });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('СЕТЬ НЕ ОПРЕДЕЛЕНА') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.equal(st.pinned.length, 0, 'при неопределённой сети всё равно ушли запросы');
});

test('второй рубеж закрыт по умолчанию: пустое now не открывает прогон', async () => {
  const st = run({ now: '' });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('НЕ НАЧАЛИ') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.equal(st.pinned.length, 0, 'при неизвестном текущем выборе ушли запросы по платному риску');
});

test('в группе нет ни одного рабочего узла — проба говорит это прямо', async () => {
  const st = run({ members: [BYP] });
  const rep = await settle(st);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('НЕПОЛНО') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.equal(st.pinned.length, 0, 'при пустом списке всё равно ушли запросы');
});
