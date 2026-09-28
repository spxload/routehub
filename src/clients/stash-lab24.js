// routehub — модуль clients/stash-lab24.js
// КЛИЕНТСКИЙ СЛОЙ STASH: СТЕНД ОПЫТА ST24 (путь А: замечает ли Stash в фоне
// смерть узла поставщика). Отдельно от stash-lab.js (12 КБ, лимит 15 КБ).
// Маршруты (routehub-worker.js, по строке, как /lab/t23-nodes):
//   GET /lab/t24-nodes?g=l|n|p|t — файл поставщика rh-t24<g> override Lab;
//   GET, HEAD /lab/t24-pulse?t=<метка> — адрес проверки узлов опыта;
//   POST /lab/t24-report — живой отчёт пробы ST25 (ниже, «ОТЧЁТ»).
// Касание группы RH-Т24-T идёт не сюда: проба шлёт GET на отдельный хост,
// который в T ведёт правило override Lab (ревью ST24) — маршрута касания нет.
// История — CHANGELOG.md (Worker «Без номера» и Пробы «ST24»).
//
// ЗАЧЕМ. ST23: в фоне узлы поставщика проверялись только при скачивании
// поставщика с ИЗМЕНЁННЫМ содержимым, по `interval: 60` группы — нет. ST24
// держит выдачу поставщика НЕИЗМЕННОЙ (иначе скачивание само запустит
// проверку) и «убивает» узел со стороны стенда: адрес проверки узлов *A
// в нечётные окна по 10 мин отвечает через 25 с — при benchmark-timeout 5
// ядро видит тайм-аут. Узлы *B живы всегда. Из журнала Worker'а видно, когда
// ядро проверяло каждый узел; проба ST24 видит, куда ушёл и когда вернулся
// `now` групп L / N / P / T.
//
// ПОЧЕМУ БЕЗ ТОКЕНА И КЛЮЧА (как /lab/t23-nodes). Узлы — `type: direct`
// с проверкой по адресу этого же стенда: трафик — ответ 204, обхода нет и
// быть не может (правило 1): имена фиксированы. Ни D1, ни подписки, ни env,
// кроме CLIENT (и LAB_STOP у отчёта). Отвечает только стенд Stash; боевой Loon — 404.
//
// ЖУРНАЛ. Только метка опыта, группа / метка, окно и время — ни IP, ни
// заголовков, ни User-Agent (как у /lab/pulse). Строка пульса пишется ДО
// ожидания: клиент рвёт соединение на 5-й секунде, после этого рантайм
// вправе отменить вызов, и строка, записанная после паузы, пропала бы.

// ОТЧЁТ ST25 (согласие Дианы 28.09: «Живой лог да», «стоп флаг делай»).
// Проба после прогона шлёт сюда только новое (строка чтения, новые переходы,
// seq); строка `{"lab":"report",…}` идёт в хвост Worker'а, сессия видит её
// почти сразу (.claude/tools/lab-tail.js). Без токена: в теле нет ничего,
// кроме меток опыта. Тело больше 2 КБ — 413 без журнала (журнал не
// раздувается чужими данными); в журнал — только ключи белого списка,
// строки обрезаны; ни IP, ни заголовков. Ответ `{"ok":1,"stop":…}`:
// stop — непустой секрет LAB_STOP (сессия ставит / снимает его через
// Cloudflare API) ИЛИ страна источника (request.cf.country) не RU: запрос
// дошёл не напрямую, то есть через обход — страховка правила 1 после
// факта (в журнал «обход: да»); страны нет — «нет данных», тоже stop:
// отсутствие данных не читается как «всё хорошо».

import { clientId } from './registry.js';
import { BENCH_TIMEOUT } from './stash-nodeset.js';
import { nodesToYaml } from './stash-yaml.js';

const T24_NODES_PATH = '/lab/t24-nodes';
const T24_PULSE_PATH = '/lab/t24-pulse';
const T24_STAND = 'https://routehub-stash.proton4iker.workers.dev';
const T24_PREFIX = 'RH-Т24-';
const T24_GROUPS = ['l', 'n', 'p', 't'];
const T24_WINDOW_MS = 600000;          // окно смерти — 10 мин (проба: WIN_MS)
const T24_DEAD_DELAY_MS = 25000;       // «мёртвый» ответ: 25 с при тайм-ауте ядра 5 с
// Белый список меток адреса проверки. *a — узлы, которые «умирают»;
// t24p-hc — health-check поставщика rh-t24p; t24ctl — контрольный пульс.
const T24_TAGS = ['t24la', 't24lb', 't24na', 't24nb', 't24pa', 't24pb', 't24p-hc', 't24ta', 't24tb', 't24ctl'];
const T24_DYING = /^t24[lnpt]a$/;
const T24_REPORT_PATH = '/lab/t24-report';
const T24_REPORT_MAX = 2048;           // байт тела отчёта
// Белый список ключей отчёта: предел длины строки (0 — число; tr — список строк).
const T24_REPORT_KEYS = { rev: 12, seq: 0, r: 220, tr: 80, пр: 0, стоп: 120, ит: 600 };
const T24_TR_MAX = 8;

function notFound() { return new Response('routehub-worker: not found', { status: 404 }); }
function labLog(log, rec) { try { (log || console.log)(JSON.stringify(rec)); } catch (e) { /* журнал не роняет ответ */ } }
function stash(env) { return clientId(env) === 'stash'; }
function param(url, k) { return url && url.searchParams ? url.searchParams.get(k) : null; }

function t24Window(ms) { return Math.floor(Number(ms) / T24_WINDOW_MS); }
// Мёртв ли узел с меткой tag в момент ms: только *a и только в нечётное окно.
function t24Dead(tag, ms) { return T24_DYING.test(String(tag)) && t24Window(ms) % 2 === 1; }

// Узлы поставщика группы g — чистая функция g: ни времени, ни окна в выдаче.
function t24Nodes(g) {
  const G = String(g).toUpperCase();
  return ['A', 'B'].map(function (x) {
    return { name: T24_PREFIX + G + x, type: 'direct',
      'benchmark-url': T24_STAND + T24_PULSE_PATH + '?t=t24' + g + x.toLowerCase(), 'benchmark-timeout': BENCH_TIMEOUT };
  });
}
function renderT24(g) {
  return '# RouteHub — узлы ST24, группа ' + String(g).toUpperCase() + ' (direct: трафика нет; выдача постоянна)\n' +
    nodesToYaml(t24Nodes(g));
}

function handleT24Nodes(url, env, ms, log) {
  if (!stash(env)) return notFound();
  const g = param(url, 'g');
  if (T24_GROUPS.indexOf(g) < 0) return notFound();
  const now = ms === undefined ? Date.now() : ms;
  labLog(log, { lab: 't24-nodes', g: g, ts: new Date(now).toISOString() });
  return new Response(renderT24(g), { headers: { 'Content-Type': 'text/yaml; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// Пауза «мёртвого» узла. setTimeout берётся в момент вызова — тесты
// подменяют его и не ждут 25 с.
function pause(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// GET и HEAD — одинаково: ядра Clash-семейства проверяют узел запросом HEAD,
// быстрый ответ на HEAD сделал бы узел вечно живым.
async function handleT24Pulse(url, env, ms, log) {
  if (!stash(env)) return notFound();
  const tag = param(url, 't');
  if (T24_TAGS.indexOf(tag) < 0) return notFound();
  const now = ms === undefined ? Date.now() : ms;
  const dead = t24Dead(tag, now);
  labLog(log, { lab: 't24-pulse', t: tag, окно: t24Window(now), мёртв: dead, ts: new Date(now).toISOString() });
  if (dead) await pause(T24_DEAD_DELAY_MS);
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

function bytes(s) { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xD800 && c < 0xDC00) ? (i++, 4) : 3; } return n; }
function clip(v, n) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : null; }
function reportJson(o, status) {
  return new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
// Чистка тела по белому списку. Не объект или ни одного ключа — null.
function reportClean(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const out = {};
  for (const k of Object.keys(T24_REPORT_KEYS)) {
    const v = j[k], n = T24_REPORT_KEYS[k];
    if (v === undefined || v === null) continue;
    if (k === 'tr') { if (Array.isArray(v)) out.tr = v.filter((x) => typeof x === 'string').slice(-T24_TR_MAX).map((x) => clip(x, n)); }
    else if (n === 0) { if (Number.isFinite(v)) out[k] = Math.trunc(v); }
    else { const c = clip(v, n); if (c !== null) out[k] = c; }
  }
  return Object.keys(out).length ? out : null;
}

async function handleT24Report(req, env, cf, ms, log) {
  if (!stash(env)) return notFound();
  const len = Number(req.headers.get('content-length'));
  if (len > T24_REPORT_MAX) return reportJson({ ok: 0 }, 413);
  let text = '';
  try { text = await req.text(); } catch (e) { return reportJson({ ok: 0 }, 400); }
  if (bytes(text) > T24_REPORT_MAX) return reportJson({ ok: 0 }, 413);
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* ниже — 400 */ }
  const body = reportClean(j);
  if (!body) return reportJson({ ok: 0 }, 400);
  const flag = typeof env.LAB_STOP === 'string' && env.LAB_STOP.trim() !== '';
  const country = cf && typeof cf.country === 'string' && cf.country ? cf.country : null;
  const now = ms === undefined ? Date.now() : ms;
  const rec = Object.assign({ lab: 'report', ts: new Date(now).toISOString() }, body);
  if (country !== 'RU') rec.обход = country ? 'да' : 'нет данных';
  if (flag) rec.флаг = 'стоп';
  labLog(log, rec);
  return reportJson({ ok: 1, stop: flag || country !== 'RU' });
}

export { T24_REPORT_KEYS, T24_REPORT_MAX, T24_REPORT_PATH, handleT24Report };
export { T24_DEAD_DELAY_MS, T24_GROUPS, T24_NODES_PATH, T24_PREFIX, T24_PULSE_PATH, T24_STAND, T24_TAGS, T24_WINDOW_MS };
export { handleT24Nodes, handleT24Pulse, renderT24, t24Dead, t24Nodes, t24Window };
