/*
 * RouteHub — ПРОБА EGERN EG5. Один вопрос, восемь секунд.
 * ===========================================================================
 * ВОПРОС, И ТОЛЬКО ОН: есть ли в окружении `network`-скрипта то, чего нет в
 * окружении `schedule`-скрипта — прежде всего механизм смены политики.
 *
 * ПОЧЕМУ ЭТОТ ВОПРОС ЕЩЁ ОТКРЫТ.
 *   1. Документация Egern про `network`-скрипты говорит, что они годятся
 *      «for automatically switching proxy nodes», тогда как в справочнике
 *      JS API метода смены политики нет. Расхождение зафиксировано в
 *      `ЭТАП_K_EGERN_СПРАВОЧНИК.md` (раздел 6) и там же помечено:
 *      «Кандидат на поиск лазейки». Ни в одном документе ветки оно не закрыто.
 *   2. Сплошная опись 959 глобальных имён (ревизия k4-11) закрыла вопрос об
 *      управлении политиками — но снята она в скрипте `RH-K4-Проба`, у
 *      которого `__context.type: "schedule"` (`ЭТАП_K_ШАГ_4.4_РЕЗУЛЬТАТЫ.md`,
 *      раздел 3-бис). Другого контекста опись не видела.
 *   3. Состав окружения у Egern ЗАВИСИТ ОТ ТИПА скрипта: `ctx.cron` есть
 *      только в `schedule`, `ctx.widgetFamily` — только в `generic`,
 *      `ctx.request`/`ctx.response` — только в http-скриптах (справочник,
 *      раздел 7). Значит доказательство, снятое в `schedule`, на `network`
 *      не распространяется.
 * Это тот же ход, что вывел ST7 на Stash: прежний вывод был снят методикой,
 * которая до искомого места не доставала.
 *
 * ЧТО ЗНАЧИТ ОТВЕТ. «НЕТ» — вывод 44 закрыт окончательно, для всех типов
 * скриптов, и фраза документации признаётся рекламной. «ДА» — найдено имя,
 * которого нет в описи `schedule`; тогда пересматривается решение по миграции.
 *
 * ЧЕГО ПРОБА НЕ ДЕЛАЕТ. Не пишет в маршрутизацию: найденный механизм только
 * называется в отчёте, вызывать его EG5 не будет. Не ходит через обходные
 * узлы: единственный запрос — 300-байтный GET к своему же стенду. Не зовёт
 * `$httpClient.request` (роняет прогон у Egern) и не трогает `crypto.subtle`
 * (у Egern отсутствует).
 *
 * ФОРМА ФАЙЛА. Тело классическое, без `export` — так проба живёт и в
 * прослойке Surge, и в песочнице `node:vm` (тест `probes-smoke`). Для
 * нативного скрипта Egern тело оборачивается двумя строками (см. хвост
 * файла); никаких обращений к `ctx` в теле нет, поэтому обёртка ничего не
 * меняет — `ctx` берётся только через `__EG5_CTX`, если обёртка его положит.
 */

var REV = 'EG5';
var T0 = Date.now();
var BUDGET_MS = 8000;             // таймаут скрипта Egern по умолчанию 10 с
var G = (typeof globalThis !== 'undefined') ? globalThis : this;
var CTX = null;
try { CTX = G.__EG5_CTX || null; } catch (e) { }
var rep = { rev: REV, ts: new Date().toISOString(), ans: {}, err: [] };

// Опись `schedule` (k4-11): девять нестандартных глобалов и три служебных имени.
var BASE = ['$httpClient', '$persistentStore', '$utils', '$network', '$script',
            '$notification', '$environment', '$done', '$cronexp',
            '__context', '_tickTimers', 'Egern'];
// Состав `ctx` по справочнику, раздел 7 (вместе с полями чужих типов).
var CTXBASE = ['abort', 'app', 'compress', 'cron', 'device', 'env', 'http',
               'lookupIP', 'notify', 'request', 'respond', 'response', 'script',
               'ssh', 'storage', 'widgetFamily'];
// Слова, по которым ищется механизм смены политики. `node` и `route` не взяты
// намеренно: в WebKit есть Node, NodeList, NodeFilter — это был бы шум.
var WORDS = ['policy', 'proxy', 'select', 'switch', 'group'];

function inList(a, v) { for (var i = 0; i < a.length; i++) if (a[i] === v) return true; return false; }

// Имена собственные плюс один уровень прототипа — так же, как в k4.
function names(obj) {
  var out = [];
  if (!obj) return out;
  try { out = Object.getOwnPropertyNames(obj); } catch (e) { return out; }
  try {
    var p = Object.getPrototypeOf(obj);
    if (p && p !== Object.prototype) out = out.concat(Object.getOwnPropertyNames(p));
  } catch (e2) { }
  var seen = {}, uniq = [];
  for (var i = 0; i < out.length; i++) if (!seen[out[i]]) { seen[out[i]] = 1; uniq.push(out[i]); }
  return uniq;
}

function stepScope() {
  var all = names(G);
  rep.ans.всего_имён = all.length;
  rep.ans.тип = '?';
  try { rep.ans.тип = (G.__context && G.__context.type) || (G.$script && G.$script.type) || '?'; } catch (e) { }

  var odd = [], nov = [], susp = [];
  for (var i = 0; i < all.length; i++) {
    var n = all[i];
    if (n.charAt(0) === '$' || n === '__context' || n === '_tickTimers' || n === 'Egern') {
      odd.push(n);
      if (!inList(BASE, n)) nov.push(n);
    }
    if (n === 'Proxy') continue;                 // штатный JS, не механизм Egern
    var low = n.toLowerCase();
    for (var w = 0; w < WORDS.length; w++) {
      if (low.indexOf(WORDS[w]) >= 0) { if (susp.length < 12) susp.push(n); break; }
    }
  }
  rep.ans.нестандартные = odd;
  rep.ans.ключи_Egern = names(G.Egern);
  rep.ans.ключи___context = names(G.__context);

  if (CTX) {
    var ck = names(CTX);
    rep.ans.ключи_ctx = ck;
    for (var j = 0; j < ck.length; j++) {
      if (!inList(CTXBASE, ck[j]) && ck[j].charAt(0) !== '_') nov.push('ctx.' + ck[j]);
    }
  } else {
    rep.ans.ключи_ctx = 'ctx не передан (классическая форма без обёртки)';
  }

  rep.ans.подозрительные = susp;                 // в список может попасть имя DOM
  rep.ans.НОВОЕ = nov.length ? ('ДА: ' + nov.join(', ')) : 'НЕТ — то же, что в schedule';
}

// Единственный запрос: открытый `/health` стенда, без токена. Нужен, чтобы
// отчёт был датирован сборкой стенда, а не только часами телефона.
var STAND = 'https://routehub-egern.proton4iker.workers.dev/health';
function stepStand(next) {
  var done = false;
  function once(body, e) {
    if (done) return;
    done = true;
    if (e || !body) { rep.ans.стенд = 'не ответил: ' + (e || 'пусто'); next(); return; }
    var d = null;
    try { d = JSON.parse(body); } catch (e2) { rep.ans.стенд = 'не разобрался: ' + String(body).slice(0, 60); next(); return; }
    rep.ans.стенд = (d.worker || '?') + ' / ' + (d.script || '?') + ', ' + (d.now || '?');
    next();
  }
  try {
    G.$httpClient.get({ url: STAND, timeout: 3 }, function (e, r, body) {
      once(e ? null : body, e ? String(e) : (r && r.status >= 400 ? 'HTTP ' + r.status : null));
    });
  } catch (e3) { once(null, String(e3)); }
}

var FINISHED = false;
function finish() {
  if (FINISHED) return;
  FINISHED = true;
  rep.ms = Date.now() - T0;
  var a = rep.ans;
  var lines = [
    'новое в окружении: ' + (a.НОВОЕ || '?'),
    'тип скрипта: ' + (a.тип || '?') + ', имён ' + (a.всего_имён != null ? a.всего_имён : '?'),
    'подозрительные: ' + ((a.подозрительные && a.подозрительные.length) ? a.подозрительные.join(' ') : 'нет'),
    'стенд: ' + (a.стенд || '?') + ', ' + rep.ms + ' мс'
  ];
  var dump = JSON.stringify(rep);
  try { console.log('[' + REV + '] ' + dump); } catch (e0) { }
  var posted = false;
  try {
    G.$notification.post('RouteHub ' + REV, lines[0], lines.slice(1).join('\n'),
      { clipboard: dump });
    posted = true;
  } catch (e) { }
  if (!posted && CTX) {
    try {
      CTX.notify({ title: 'RouteHub ' + REV, body: lines.join('\n'),
                   action: { type: 'clipboard', text: dump } });
    } catch (e2) { }
  }
  try { G.$done({}); } catch (e3) { try { G.$done(); } catch (e4) { } }
}

// Сторож. У Egern `setTimeout` точен (1207 мс на 1200, замер k4), поэтому
// бюджет берётся как есть, без поправочного множителя, как было на Stash.
setTimeout(function () {
  if (!FINISHED) { rep.err.push('сторож: бюджет ' + BUDGET_MS + ' мс исчерпан'); finish(); }
}, BUDGET_MS);

try { stepScope(); } catch (e) { rep.err.push('опись: ' + String(e)); }
stepStand(finish);

// ОБЁРТКА ДЛЯ НАТИВНОГО СКРИПТА EGERN (если клиент не примет файл без
// `export default`): завести файл из двух строк —
//   export default async function (ctx) { globalThis.__EG5_CTX = ctx;
//     await import('<ссылка на этот файл>'); }
// Тело пробы обращений к `ctx` не содержит, поэтому обёртка ничего не меняет.