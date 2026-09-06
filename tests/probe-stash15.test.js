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

const trace = (loc, ip) => 'fl=12a34\nh=www.cloudflare.com\nip=' + (ip || '203.0.113.77') +
  '\nts=1.0\nloc=' + (loc || 'DE') + '\nwarp=off\n';
const TRACE = trace('DE', '203.0.113.77');
// Разные выходы у разных узлов — так и есть на устройстве, и на этом стоит
// проверка «работает ли пиновка вообще».
const GEO_BY_NODE = (url, node) => ({
  status: 200,
  body: trace(node === N3 ? 'TR' : 'DE',
    node === N1 ? '203.0.113.7' : node === N2 ? '198.51.100.7' : '192.0.2.7'),
});
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
    geo = GEO_BY_NODE,
    controller = null,
    store = {},
    noStore = false,
  } = opts;
  const state = { done: null, note: null, ctl: [], pinned: [], late: 0, store: store };

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
    $persistentStore: noStore ? {
      read: () => { throw new Error('хранилище недоступно'); },
      write: () => { throw new Error('хранилище недоступно'); },
    } : {
      read: (k) => (store.hasOwnProperty(k) ? store[k] : null),
      write: (v, k) => { store[k] = v; return true; },
    },
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

test('сторож срабатывает позже худшего ПАТОЛОГИЧЕСКОГО пути и раньше бюджета', () => {
  const guard = num('GUARD_MS'), budget = num('BUDGET_MS');
  // Считать надо не по честным ответам, а по предохранителям: именно этот
  // путь длиннее, и именно его сторож не должен рубить.
  const worst = num('CTRL_SEC') * 1000 + num('NODES_N') * num('NODE_WATCH_MS');
  assert.ok(guard > worst,
    'сторож ' + guard + ' мс рубит прогон, идущий по предохранителям (' + worst + ' мс): ' +
    'усечение не попадёт даже в «не успели»');
  assert.ok(budget > guard, 'бюджет меньше сторожа — сторож станет основным путём выхода');
});

test('резерв на узел покрывает предохранитель, растянутый втрое', () => {
  // setTimeout у Stash в фоне растягивается втрое-вчетверо (ST5), и в фоне
  // проба как раз и работает.
  assert.ok(num('NODE_COST_MS') >= num('NODE_WATCH_MS') * 3,
    'резерв ' + num('NODE_COST_MS') + ' меньше утроенного предохранителя');
});

test('все адреса пробы покрыты правилом AI — иначе второй рубеж дырявый', async () => {
  // ⛔ Прежде адрес страны стоял на нейтральном хосте «чтобы сервис не отказал
  // по стране». Такой хост не ловится ни одним правилом AI, доезжает до
  // MATCH,RH-Главный, а тот через RH-АВТО заканчивается ОБХОДНЫМИ узлами.
  // То есть при молча отвалившейся пиновке один из шести запросов уходил бы
  // по платному трафику мимо рубежа, который смотрит на RH-AI.
  const { AI_SUFFIX } = await import('../src/clients/stash-rules.js');
  const urls = [];
  const re = /url: '([^']+)'|var GEO_URL = '([^']+)'/g;
  let m;
  while ((m = re.exec(CODE))) urls.push(m[1] || m[2]);
  assert.ok(urls.length >= 6, 'адреса пробы не найдены в исходнике: ' + urls.join(', '));
  for (const u of urls) {
    const host = new URL(u).hostname;
    const covered = AI_SUFFIX.some((d) => host === d || host.endsWith('.' + d));
    assert.ok(covered, 'хост ' + host + ' не покрыт ни одним правилом AI: при отказе пиновки ' +
      'запрос уйдёт по RH-Главный и может попасть на обходной узел');
  }
});

test('timeout задания cron не меньше бюджета пробы', () => {
  const yaml = fs.readFileSync(path.join(ROOT, 'plugins/RouteHub-Stash-ST15.stoverride'), 'utf8');
  const to = Number(/timeout:\s*(\d+)/.exec(yaml)[1]) * 1000;
  assert.ok(to >= num('BUDGET_MS'),
    'cron обрывает прогон (' + to + ' мс) раньше собственного бюджета пробы (' + num('BUDGET_MS') + ' мс) — вывода не будет');
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

test('редирект — это «ОТВЕТИЛ», даже когда у него есть тело', async () => {
  // ⛔ Проверка правдоподобия, применённая к 3xx, объявляла подменой обычный
  // редирект CDN со страницей nginx — а прогон, где так ответил один адрес на
  // всех узлах, звал чинить исправный туннель.
  const st = run({ svc: () => ({ status: 301, body: '<html><head><title>301 Moved Permanently</title></head></html>' }) });
  const rep = await settle(st);
  assert.equal(rep.ans.узлы[S1].сервисы.Claude.итог, 'ОТВЕТИЛ', '3xx с телом засчитан как подмена');
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('ЧИСТЫ ВСЕ') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
});

test('200 с пустым телом — не robots.txt', async () => {
  const st = run({ svc: () => ({ status: 200, body: '' }) });
  const rep = await settle(st);
  const r = rep.ans.узлы[S1].сервисы.ChatGPT;
  assert.equal(r.итог, 'ПОДМЕНА', 'пустой ответ засчитан успехом: ' + r.итог);
  assert.ok(String(r.вид).indexOf('пустое тело') >= 0, 'причина не названа: ' + r.вид);
});

test('200 с капчей помечается бот-защитой, а не «не опознан»', async () => {
  const st = run({ svc: () => ({ status: 200, body: '<title>Just a moment...</title>' }) });
  const rep = await settle(st);
  const r = rep.ans.узлы[S1].сервисы.ChatGPT;
  assert.equal(r.итог, 'ПОДМЕНА');
  assert.equal(r.вид, 'бот-защита', 'капча в 200 не опознана: ' + r.вид);
});

test('200 со страновой заглушкой помечается страной', async () => {
  const st = run({ svc: () => ({ status: 200, body: '<p>This service is not available in your region.</p>' }) });
  const rep = await settle(st);
  assert.equal(rep.ans.узлы[S1].сервисы.ChatGPT.вид, 'страна');
});

test('настоящий большой robots.txt — это ответ с пометкой размера, не подмена', async () => {
  const bigReal = 'User-agent: *\n' + 'Disallow: /a\n'.repeat(3000);
  const st = run({ svc: () => ({ status: 200, body: bigReal }) });
  const rep = await settle(st);
  const r = rep.ans.узлы[S1].сервисы.ChatGPT;
  assert.equal(r.итог, 'ОТВЕТИЛ', 'длинный, но настоящий robots.txt объявлен подменой');
  assert.ok(r.крупно > 20000, 'размер не помечен');
});

test('временный отказ с текстом причины сохраняет вид', async () => {
  const st = run({ svc: () => ({ status: 503, body: 'unsupported_country' }) });
  const rep = await settle(st);
  assert.equal(rep.ans.узлы[S1].сервисы.ChatGPT.итог, 'ВРЕМЕННО');
  assert.equal(rep.ans.узлы[S1].сервисы.ChatGPT.вид, 'страна');
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

// ── ЧТО ПОКАЗАЛИ ОДИННАДЦАТЬ ПРОГОНОВ 06.09 ──────────────────────────
// Каждая проверка ниже заведена по конкретной строке из выгрузки, а не
// придумана: так требование остаётся привязанным к наблюдению.

test('«not available in your region» опознаётся как страновой запрет', async () => {
  // grok.com, 06.09 09:21, дословное тело ответа. Прежний список маркеров
  // его не знал, и исход был помечен «не опознан».
  const st = run({
    svc: (url) => (url.indexOf('grok') >= 0
      ? { status: 403, body: '<!doctype html>\n<html>\n<body>\n<p>This service is not available in your region.</p>\n</body>\n</html>' }
      : { status: 200, body: ROBOTS }),
  });
  const rep = await settle(st);
  assert.equal(rep.ans.узлы[S1].сервисы.Grok.вид, 'страна',
    'страновой запрет по-прежнему «не опознан»');
});

test('вместо robots.txt приехала страница — это ПОДМЕНА, а не успех', async () => {
  // claude.ai, 06.09 09:21: статус 200, 434 666 байт, «<!DOCTYPE html>».
  const big = '<!DOCTYPE html><!-- Last Published: Thu --><div>' + 'x'.repeat(500000) + '</div>';
  const st = run({
    svc: (url) => (url.indexOf('claude') >= 0 ? { status: 200, body: big } : { status: 200, body: ROBOTS }),
  });
  const rep = await settle(st);
  const r = rep.ans.узлы[S1].сервисы.Claude;
  assert.equal(r.итог, 'ПОДМЕНА', '200 с чужим телом засчитан как ответ: ' + r.итог);
  assert.ok(String(r.вид).indexOf('не похоже на robots.txt') >= 0, 'причина подмены не названа: ' + r.вид);
  assert.ok((rep.ans.чистых || []).indexOf(S1) < 0, 'узел с подменённым ответом объявлен чистым');
});

test('короткий, но настоящий robots.txt подменой не считается', async () => {
  // gemini.google.com отдаёт 116 байт — граница не должна ловить его.
  const st = run({ svc: () => ({ status: 200, body: 'User-agent: *\nAllow: /app/download\nDisallow: /\n' }) });
  const rep = await settle(st);
  assert.equal(rep.ans.узлы[S1].сервисы.Gemini.итог, 'ОТВЕТИЛ', 'настоящий robots.txt принят за подмену');
});

test('выход не совпал с флагом в имени — это видно в тексте', async () => {
  // 06.09 10:00: узел с флагом 🇩🇪 показал выход RU, и в том же прогоне два
  // сервиса до него не дошли.
  const st = run({
    geo: (url, node) => ({ status: 200,
      body: trace(node === N1 ? 'RU' : 'DE', node === N1 ? '111.88.96.7' : '203.0.113.' + (node === N2 ? '7' : '8')) }),
  });
  const rep = await settle(st);
  assert.equal(rep.ans.узлы[S1].флаг_vs_выход, 'DE→RU', 'расхождение флага и выхода не зафиксировано');
  assert.ok((rep.ans.флаг_не_совпал || []).indexOf(S1) >= 0);
  assert.ok(st.done.content.indexOf('выход не совпал с флагом') >= 0,
    'расхождение видно только в JSON: ' + st.done.content.slice(0, 300));
});

test('один выход у всех узлов — предупреждение приставкой, разбор не выбрасывается', async () => {
  // Так выглядела бы молча отвалившаяся пиновка: проба бодро отчитывается
  // про четыре узла, а запросы шли через один. Но подозрение может быть и
  // ложным (узлы одного поставщика), поэтому оно приставка, а не приговор.
  const st = run({ geo: () => ({ status: 200, body: trace('DE', '203.0.113.7') }) });
  const rep = await settle(st);
  assert.ok(rep.ans.пиновка, 'подозрение на пиновку не выставлено');
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('ПРОВЕРИТЬ ПИНОВКУ') === 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('ЧИСТЫ ВСЕ') > 0, 'разбор по узлам выброшен: ' + rep.ans.ВЕРДИКТ);
  assert.ok(rep.ans.чистых.length > 0, 'корзины не заполнены');
  assert.notEqual(st.done.backgroundColor, '#34C759', 'подозрительный прогон окрашен как успех');
});

test('выход прочитан только у двух узлов — тревога не поднимается', async () => {
  // trace — один из шести параллельных запросов, и он теряется. По двум
  // ответам из четырёх судить о пиновке нельзя.
  const st = run({
    geo: (url, node) => (node === N1 || node === N2
      ? { status: 200, body: trace('DE', '203.0.113.7') }
      : { status: 0 }),
  });
  const rep = await settle(st);
  assert.ok(!rep.ans.пиновка, 'тревога поднята по двум узлам из четырёх');
});

test('разные выходы у узлов — пиновка под вопрос не ставится', async () => {
  const st = run();
  const rep = await settle(st);
  assert.ok(!rep.ans.пиновка, 'ложная тревога по пиновке при разных выходах');
});

test('узлы одной подсети не считаются одним выходом', async () => {
  // Маскировка прячет последнюю группу адреса — сравнивать надо ПОЛНЫЙ, иначе
  // два узла одного провайдера дают ложную тревогу «пиновка не работает».
  const st = run({
    geo: (url, node) => ({ status: 200,
      body: trace('DE', '203.0.113.' + (node === N1 ? '11' : node === N2 ? '12' : '13')) }),
  });
  const rep = await settle(st);
  assert.ok(!rep.ans.пиновка, 'ложная тревога: сравнивались замаскированные адреса');
  assert.ok(rep.ans.ВЕРДИКТ.indexOf('НЕДОСТОВЕРНО') !== 0, 'вердикт: ' + rep.ans.ВЕРДИКТ);
  // И при этом сам маскированный вид в отчёте остаётся.
  assert.ok(String(rep.ans.узлы[S1].выход).indexOf('.x') > 0, 'адрес выхода не замаскирован');
});

test('окно сдвигается: следующий прогон берёт следующие узлы', async () => {
  // Одиннадцать прогонов 06.09 проверили одну и ту же четвёрку — верх
  // каскада, — тогда как вопрос был про «многие узлы».
  const many = [];
  for (let i = 0; i < 9; i++) many.push('🇩🇪 узел ' + i + ' [VPN] · 1↓2 / 3↓4');
  const store = {};
  const first = await settle(run({ members: many, store }));
  const second = await settle(run({ members: many, store }));
  const a = Object.keys(first.ans.узлы), b = Object.keys(second.ans.узлы);
  assert.equal(a.length, NODES_N);
  assert.equal(b.length, NODES_N);
  assert.equal(a.filter((x) => b.indexOf(x) >= 0).length, 0,
    'второй прогон повторил ту же четвёрку: ' + b.join(', '));
  assert.ok(first.ans.окно.indexOf('1…4 из 9') === 0, 'окно первого прогона: ' + first.ans.окно);
  assert.ok(second.ans.окно.indexOf('5…8 из 9') === 0, 'окно второго прогона: ' + second.ans.окно);
});

test('окно заворачивается по кругу, и строка окна не врёт', async () => {
  const many = [];
  for (let i = 0; i < 5; i++) many.push('🇩🇪 узел ' + i + ' [VPN] · 1↓2 / 3↓4');
  const rep = await settle(run({ members: many, store: { rh_st15_off: '3' } }));
  assert.equal(Object.keys(rep.ans.узлы).length, NODES_N, 'на границе пула взято не ' + NODES_N);
  assert.equal(rep.ans.пригодных, 5);
  // Границы считаются по модулю: «4…7 из 5» — число, которого не бывает, а по
  // нему судят о покрытии пула.
  assert.equal(rep.ans.окно, '4…2 из 5', 'строка окна: ' + rep.ans.окно);
});

test('пул меньше окна — строка окна остаётся осмысленной', async () => {
  const rep = await settle(run({ members: [N1, N2] }));
  assert.equal(rep.ans.окно, '1…2 из 2', 'строка окна: ' + rep.ans.окно);
  assert.equal(rep.ans.взято, 2);
});

test('испорченное смещение в хранилище не ломает прогон', async () => {
  for (const bad of ['мусор', '-4', '9999999', '']) {
    const rep = await settle(run({ store: { rh_st15_off: bad } }));
    assert.equal(rep.ans.взято, 3, 'смещение «' + bad + '» сломало отбор');
  }
});

test('хранилище недоступно — прогон идёт, но сбой записан', async () => {
  const st = run({ noStore: true });
  const rep = await settle(st);
  assert.equal(rep.ans.взято, 3, 'без хранилища узлы не отобрались');
  assert.ok(rep.err.some((e) => e.indexOf('смещение') >= 0), 'отказ записи не отмечен: ' + JSON.stringify(rep.err));
});

test('член с неизвестным типом группы узлом не считается', async () => {
  // Белый список типов открыт снизу; группу выдаёт наличие состава и выбора.
  const members = ['🤖 Хитрая [VPN]', N1, N2];
  const st = run({
    members,
    proxies: Object.assign(parents('wifi'), {
      'RH-AI-W': { type: 'Fallback', now: N1, all: members },
      '🤖 Хитрая [VPN]': { type: 'Smart', now: BYP, all: [BYP] },
      [N1]: { type: 'Vless', alive: true }, [N2]: { type: 'Vless', alive: true },
    }),
  });
  const rep = await settle(st);
  assert.equal(st.pinned.filter((p) => p.node === '🤖 Хитрая [VPN]').length, 0,
    'запрос пиннут на имя группы — он ушёл бы тому, кого группа выбрала, вплоть до обхода');
  assert.equal(rep.ans.пригодных, 2);
});

test('обходные считаются по ВСЕМУ списку, а не до набора четвёрки', async () => {
  // ⛔ Прежняя редакция обрывала цикл на четвёртом узле, и счётчик показывал
  // 0 обходных при одиннадцати прогонах подряд — хотя обход в каскаде есть,
  // рангом последний. Счётчик выглядел доказательством, что правило 1
  // соблюдено, ничего не доказывая.
  const members = [N1, N2, N3, '🇱🇻 Латвия [VPN] · 1↓2 / 3↓4', BYP, BYP.replace('03', '04')];
  const st = run({ members });
  const rep = await settle(st);
  assert.equal(rep.ans.обходных_пропущено, 2, 'обходные посчитаны не по всему списку');
  assert.equal(rep.ans.пригодных, 4);
  assert.equal(st.pinned.filter((p) => p.node && p.node.indexOf('Обход') >= 0).length, 0);
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
