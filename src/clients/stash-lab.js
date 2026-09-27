// routehub — модуль clients/stash-lab.js
// КЛИЕНТСКИЙ СЛОЙ STASH: МУЛЯЖИ ДЛЯ ОПЫТОВ ЛАБОРАТОРИИ (ST22, сейчас ST23).
// Маршруты (routehub-worker.js): GET /lab/t22-nodes, GET /lab/t23-nodes —
// файлы поставщиков прокси для тестовых групп override RouteHub-Stash-Lab;
// GET /lab/pulse — адрес проверки узла-«пульса». История — CHANGELOG.md.
//
// ЗАЧЕМ. Экран Stash «Ресурсы» (27.09): профиль обновляется только на
// переднем плане, в фоне при включённом VPN — только наборы правил и
// поставщики прокси. Проба ST22 проверяет на муляжах, (1) чей порядок
// держит группа `use:` + `filter` — поставщика или фильтра, (2) разбирается
// ли группа-слот (select с одним членом через filter), (3) обновляется ли
// поставщик в фоне и (4) сбрасывает ли его обновление выбор в группах.
//
// ЧТО ОТДАЁТ. Clash-YAML `proxies:` — три узла-слота RH-Т22-1..3 и узел-метку
// RH-Т22-Метка-<номер минуты>: имя метки меняется само (раз в минуту — по
// ревью: точность вывода «скачан в фоне» — минута, а не 10), и проба видит,
// перечитал ли Stash поставщика, не трогая профиль и override.
// Порядок в выдаче ОБРАТНЫЙ порядку в фильтре override (метка, 3, 2, 1) —
// иначе по `.all` не отличить порядок поставщика от порядка фильтра.
//
// ПОЧЕМУ БЕЗ ТОКЕНА И КЛЮЧА (как /version). Выдача — только муляжи: адреса
// TEST-NET 192.0.2.0/24 (RFC 5737, никуда не ведут), порт 1, без паролей.
// Ни данных D1, ни подписки, ни секретов: функция чистая от времени. Токен
// в адресе поставщика лёг бы в публичный override — как раз этого и не надо.
// Обходных узлов здесь нет и быть не может (правило 1): имена фиксированы.
// Отвечает только стенд Stash (CLIENT=stash): боевой Loon, собранный из этой
// ветки, маршрута не знает — 404, как на любой неизвестный путь.

import { clientId } from './registry.js';
import { BENCH_TIMEOUT } from './stash-nodeset.js';
import { nodesToYaml } from './stash-yaml.js';

const T22_PATH = '/lab/t22-nodes';
const T22_PREFIX = 'RH-Т22-';
const T22_WINDOW_MS = 60000;         // окно метки — минута (проба: WIN_MS)
// Слоты в порядке override (фильтр группы RH-Т22-Фильтр и fallback RH-Т22-F).
const T22_SLOTS = ['RH-Т22-1', 'RH-Т22-2', 'RH-Т22-3'];
const T22_MARK = 'RH-Т22-Метка-';
const T22_HOST = '192.0.2.';           // TEST-NET-1: трафика нет

function t22Window(ms) { return Math.floor(Number(ms) / T22_WINDOW_MS); }

// Узлы выдачи на момент ms: метка, затем слоты в обратном порядке.
function t22Nodes(ms) {
  const mark = { name: T22_MARK + t22Window(ms), type: 'socks5', server: T22_HOST + '14', port: 1 };
  const slots = T22_SLOTS.map(function (n, i) {
    return { name: n, type: 'socks5', server: T22_HOST + String(11 + i), port: 1 };
  });
  return [mark].concat(slots.reverse());
}

function renderT22(ms) {
  return '# RouteHub — муляжи ST22 (TEST-NET, порт 1: трафика нет), окно ' + t22Window(ms) + '\n' +
    nodesToYaml(t22Nodes(ms));
}

// ЖУРНАЛ ОПЫТА (решение Дианы 27.09). В фоне контроллер Stash отдаёт EOF
// окнами по 30+ мин (ST21), и проба не видит, проверяет ли ядро узлы и
// скачивает ли поставщика, пока приложение закрыто. Это видно с нашей
// стороны: каждый запрос ядра к /lab/pulse (адрес проверки узла-«пульса»)
// и к /lab/t22-nodes — строка в журнале Worker'а (Workers Logs, wrangler.toml
// [env.stash.observability]). В строке только метка опыта и время: ни IP, ни
// заголовков, ни User-Agent (служебные invocation-записи там же выключены).
const PULSE_PATH = '/lab/pulse';
const PULSE_TAG_RE = /^[a-z0-9-]{1,16}$/;

function labLog(log, rec) { try { (log || console.log)(JSON.stringify(rec)); } catch (e) { /* журнал не роняет ответ */ } }
function pulseTag(url) {
  const t = url && url.searchParams ? url.searchParams.get('t') : null;
  return typeof t === 'string' && PULSE_TAG_RE.test(t) ? t : 'bad';
}

// 204 без тела: ядру для проверки задержки нужен любой быстрый ответ.
function handlePulse(url, env, ms, log) {
  if (clientId(env) !== 'stash') return new Response('routehub-worker: not found', { status: 404 });
  const now = ms === undefined ? Date.now() : ms;
  labLog(log, { lab: 'pulse', t: pulseTag(url), ts: new Date(now).toISOString() });
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

// env нужен только для развилки клиента; в базу и в сеть обработчик не ходит.
function handleT22Nodes(env, ms, log) {
  if (clientId(env) !== 'stash') return new Response('routehub-worker: not found', { status: 404 });
  const now = ms === undefined ? Date.now() : ms;
  labLog(log, { lab: 't22-nodes', ts: new Date(now).toISOString(), окно: t22Window(now) });
  return new Response(renderT22(now), { headers: {
    'Content-Type': 'text/yaml; charset=utf-8',
    // Метка меняется раз в минуту; кэш (Cloudflare, Stash) спрятал бы смену.
    'Cache-Control': 'no-store',
  } });
}

// ── ST23: FALLBACK НА ПОСТАВЩИКЕ ДЕРЖИТ ПОРЯДОК ПОСТАВЩИКА (путь А) ──────
// ЗАЧЕМ. Путь А: Worker отдаёт узлы через proxy-provider уже в порядке своего
// рейтинга, Stash скачивает поставщика в фоне (ST22: раз в ~4 мин), fallback
// сам берёт лучший живой — без скриптов и записи в контроллер. ST22 доказал
// порядок поставщика только для select с use + filter; ST23 проверяет
// fallback с `use:` (группы RH-Т23-F / RH-Т23-FF override Lab).
// ЧТО ОТДАЁТ. Порядок меняется по окну 10 мин (детерминированно от времени):
// окно чётное — A, B, C; нечётное — Муляж, C, B, A. A/B/C — `type: direct`
// с проверкой по /lab/pulse?t=t23a|b|c: трафик — только ответ 204 стенда,
// журнал Worker'а показывает, какие узлы ядро проверяет. МУЛЯЖ первым в
// нечётном окне — чтобы «now = ПЕРВЫЙ ЖИВОЙ» отличался от «now = первый»:
// без него все узлы живы и оба ответа совпадают. Муляж — socks5 на TEST-NET
// 192.0.2.23 (RFC 5737), порт 1: соединения нет, трафика нет, обхода нет.
// Его адрес проверки /lab/pulse?t=t23d — КОНТРОЛЬ: через муляж запрос
// дойти не может, строка t23d в журнале значила бы, что ядро проверяет узел
// мимо самого узла, и строки t23a/b/c читать как «проверен узел» нельзя.
// Заодно видно, сколько ядро держит новый (ещё не проверенный) узел
// поставщика живым — для пути А это цена нового мёртвого узла в выдаче.
const T23_PATH = '/lab/t23-nodes';
const T23_PREFIX = 'RH-Т23-';
const T23_WINDOW_MS = 600000;          // окно порядка — 10 мин (проба: WIN_MS)
const T23_ALIVE = ['RH-Т23-A', 'RH-Т23-B', 'RH-Т23-C'];
const T23_DEAD = 'RH-Т23-Муляж';
const T23_STAND = 'https://routehub-stash.proton4iker.workers.dev';

function t23Window(ms) { return Math.floor(Number(ms) / T23_WINDOW_MS); }
function t23Order(ms) {
  return t23Window(ms) % 2 === 0 ? T23_ALIVE.slice() : [T23_DEAD].concat(T23_ALIVE.slice().reverse());
}
function t23Bench(name) { return T23_STAND + PULSE_PATH + '?t=t23' + name.slice(T23_PREFIX.length).toLowerCase(); }
function t23Nodes(ms) {
  return t23Order(ms).map(function (n) {
    const bench = { 'benchmark-url': t23Bench(n === T23_DEAD ? T23_PREFIX + 'D' : n), 'benchmark-timeout': BENCH_TIMEOUT };
    if (n === T23_DEAD) return Object.assign({ name: n, type: 'socks5', server: T22_HOST + '23', port: 1 }, bench);
    return Object.assign({ name: n, type: 'direct' }, bench);
  });
}
function renderT23(ms) {
  return '# RouteHub — узлы ST23 (direct + муляж TEST-NET: трафика нет), окно ' + t23Window(ms) + '\n' +
    nodesToYaml(t23Nodes(ms));
}

// СЕТЬ ИСТОЧНИКА (вопрос 3 ST23): откуда Stash скачивает поставщика —
// напрямую (оператор связи) или через узел (хостинг). От этого зависит идея
// «один поставщик, порядок под сеть». В журнал — ТОЛЬКО номер автономной
// системы и название её владельца (request.cf.asn / asOrganization): это
// сеть оператора или хостинга, общая для множества абонентов, а не адрес
// устройства. IP, заголовки, User-Agent не пишутся; значения только в
// журнале Cloudflare (доступ — владелец аккаунта), в репозитории их нет.
// Название — только буквы, цифры и « .,&()'-», до 64 знаков: чужой текст и
// переводы строк в журнал не попадают.
function cfAsn(cf) {
  const n = cf && cf.asn;
  return Number.isInteger(n) && n > 0 && n < 4294967296 ? n : null;
}
function cfOrg(cf) {
  const s = cf && typeof cf.asOrganization === 'string'
    ? cf.asOrganization.replace(/[^\p{L}\p{N} .,&()'-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 64) : '';
  return s || null;
}

function handleT23Nodes(env, ms, log, cf) {
  if (clientId(env) !== 'stash') return new Response('routehub-worker: not found', { status: 404 });
  const now = ms === undefined ? Date.now() : ms;
  labLog(log, { lab: 't23-nodes', ts: new Date(now).toISOString(), окно: t23Window(now),
    порядок: t23Order(now).map(function (n) { return n.slice(T23_PREFIX.length); }).join(','), asn: cfAsn(cf), org: cfOrg(cf) });
  return new Response(renderT23(now), { headers: { 'Content-Type': 'text/yaml; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export { PULSE_PATH, T22_MARK, T22_PATH, T22_PREFIX, T22_SLOTS, T22_WINDOW_MS, handlePulse, handleT22Nodes, pulseTag, renderT22, t22Nodes, t22Window };
export { T23_ALIVE, T23_DEAD, T23_PATH, T23_PREFIX, T23_STAND, T23_WINDOW_MS, cfAsn, cfOrg, handleT23Nodes, renderT23, t23Nodes, t23Order, t23Window };
