/*
 * RouteHub — ПРОБА STASH ST25 (ревизия опыта ST24 под живой опыт). Замечает
 * ли Stash В ФОНЕ смерть узла поставщика; живой отчёт на стенд, стоп-флаг,
 * автостоп. Только чтение контроллера + касание группы T + POST отчёта.
 * ===========================================================================
 * ЗАЧЕМ. Стенд и группы — те же, что у ST24 (узлы *A «мертвы» в нечётные окна
 * по 10 мин, *B живы всегда; группы RH-Т24-L|N|P|T, контроль RH-Т24-К).
 * Прогон ST24 28.09 показал три беды: (1) сессия видела только пульс ядра,
 * не выбор групп; (2) каждая строка журнала несла всю историю (17 КБ, лог
 * 3,9 МБ); (3) опыт не останавливался. И дефект вердикта: переход, который
 * сделала плитка (открытие Stash проверяет все группы), шёл за «фоновый».
 * Ключи хранилища — RH_ST25*: данные ST24 с новыми не смешиваются.
 * Согласие Дианы 28.09: «Живой лог да», «стоп флаг делай» (правило 5).
 *
 * ОТЧЁТ. После прогона — POST на стенд /lab/t24-report, тело ≤ 2 КБ и
 * только новое: строка чтения (время, окно, now L/N/P/T/К, alive A, тип
 * запуска, касание), переходы с seq больше указателя, seq. Указатель
 * «отправлено до seq» сдвигается только после ответа 200. Без повтора при
 * ошибке: неотправленные переходы уйдут со следующим отчётом.
 *
 * ПРАВИЛО 1 ДЛЯ ОТЧЁТА. $httpClient скрипта идёт по правилам профиля (MATCH →
 * RH-Главный → может уйти на платный обход). Первое правило override Lab —
 * `DOMAIN,<хост стенда>,DIRECT`; отчёт уходит, только если /rules
 * контроллера подтверждает: это правило стоит раньше любого не-DOMAIN
 * правила и любого другого правила этого хоста, а GET /configs — режим
 * rule (в global / direct правила не действуют: global ведёт через селектор
 * GLOBAL, возможно на обход). Та же сверка — для касания T (gates: modeGate
 * + ruleGate). /rules или /configs не прочитан, не разобран — не отправлять.
 * Стенд ответит stop, если запрос пришёл не из RU (дошёл через обход).
 *
 * СТОП. Ответ стенда stop:true (секрет LAB_STOP или обход), срок 6 ч от t0
 * или «данных достаточно» (по каждой группе L/N/P/T ≥ 6 закрытых окон смерти
 * с исходом «заметил в фоне» / «не заметил» / «застрял на B») → итог в
 * хранилище и ХОЛОСТОЙ режим: дальше каждый запуск — чтение хранилища и сразу
 * $done, без контроллера и сети; плитка показывает итог. Возобновление —
 * только новой ревизией (новый ключ хранилища), не плиткой.
 *
 * ПЕРЕХОДЫ И ВЕРДИКТ. «ушёл» — now сменился с A на B в мёртвом окне,
 * «вернулся» — с B на A в живом; только при опоре (прошлое чтение с другим
 * now в этом или соседнем окне). Переход НЕ фоновый, если он или его опорное
 * чтение пришлись на плитку либо между ними (и за TILE_PAD_MS до опоры) была
 * плитка — время плиток в RH_ST25_tiles пишет каждый запуск плитки, даже
 * занятый замком. «Замечает» — только при ≥ 2 фоновых окнах; одно — «1 окно —
 * не вывод». «Застрял на B» — закрытое мёртвое окно целиком на B (с начала
 * окна до MISS_MIN): смерть A увидеть было нельзя. Нет данных — никогда не
 * «замечает».
 *
 * ЗАПРОСЫ. К контроллеру — только GET: /proxies/RH-Т24-L|N|P|T|К,
 * /providers/proxies/rh-t24l|n|p|t, /rules, /configs. Наружу — касание (GET без
 * заголовков на хост правила касания) и отчёт (POST на стенд, без ключа
 * контроллера). Ни PUT, ни /delay, ни боевых групп (правило 2).
 *
 * ВЫГРУЗКА. Строка журнала скрипта «[ST25] {…}»: на cron — короткая (≤ 2 КБ
 * при любом хвосте), полный дамп — только по плитке.
 *
 * ВРЕМЯ. timeout $httpClient у Stash — в СЕКУНДАХ. Запрос начинается,
 * только если бюджета хватает (room); худший честный путь ≈ 48 с (последний
 * запрос с 39-й с, повтор EOF через растянутые 4 с, 5 с тайм-аута), сторож
 * 75 с. Ровно один $done. Замок RH_ST25_lock — cron и плитка не пишут вместе.
 */

var REV = 'ST25';
var T0 = Date.now();

var BUDGET_MS = 45000;
var GUARD_MS = 75000;
var CTRL_SEC = 5;                    // Stash: секунды, не миллисекунды
var STAND_SEC = 5;                   // timeout отчёта, тоже секунды
var STEP_MS = (CTRL_SEC + 1) * 1000;
var LOCK_MS = 310000;                // дольше timeout cron (300 с)
var NOTE_GAP_MS = 10 * 60000;
var MISS_GAP_MS = 6 * 3600000;
var WIN_MS = 600000;                 // окно смерти стенда — 10 мин (/lab/t24-pulse)
var MISS_MIN = 8;                    // now = A (или B) на этой минуте окна и позже — «не заметил» («не вернулся», «застрял»)
var STUCK_MIN = 2;                   // «застрял на B»: первое чтение окна — B не позже этой минуты
var TILE_PAD_MS = 30000;             // плитка за 30 с до опорного чтения — тоже не фон
var STOP_AFTER_MS = 6 * 3600000;     // автостоп: срок опыта
var ENOUGH = 6;                      // автостоп: закрытых окон смерти с исходом по каждой группе
var CAP = 60, TR_CAP = 60, WIN_CAP = 40, TILE_CAP = 30, TR_SEND = 8;
var REPORT_MAX = 1900;               // байт тела отчёта (стенд: 2048)
var LINE_MAX = 2000;                 // байт строки журнала на cron
var KEY = 'RH_ST25', FAIL_KEY = 'RH_ST25_fail', LOCK_KEY = 'RH_ST25_lock', NOTE_KEY = 'RH_ST25_note', TILES_KEY = 'RH_ST25_tiles';

var TOUCH_URL = 'https://connectivitycheck.android.com/generate_204';   // хост правила касания override Lab
var TOUCH_HOST = 'connectivitycheck.android.com';
var REPORT_URL = 'https://routehub-stash.proton4iker.workers.dev/lab/t24-report';
var STAND_HOST = 'routehub-stash.proton4iker.workers.dev';               // первое правило override Lab — DIRECT
var P = 'RH-Т24-';
var IDS = ['L', 'N', 'P', 'T'];
var GROUPS = IDS.map(function (x) { return P + x; });
var TOUCH_GROUP = P + 'T';
var CTL = P + 'К';
function provOf(g) { return 'rh-t24' + g.slice(P.length).toLowerCase(); }
function nodeA(g) { return g + 'A'; }
function nodeB(g) { return g + 'B'; }

var rep = { rev: REV, ts: new Date().toISOString(), ans: {}, err: [] };
var A = rep.ans;
var G = (typeof globalThis !== 'undefined') ? globalThis : this;

var CTRL = 'http://127.0.0.1:9090', AUTH = '', TILE = false;
try {
  CTRL = ($environment && $environment['controller-url']) || CTRL;
  AUTH = ($environment && $environment['controller-authorization']) || '';
  A.stash = ($environment && $environment['stash-version']) || '?';
} catch (e) { rep.err.push('нет $environment'); }
try { TILE = !!(G.$script && G.$script.type === 'tile'); } catch (e) {}
CTRL = String(CTRL).replace(/\/+$/, '');
A.тип = TILE ? 'плитка' : 'cron';

var FINISHED = false, GUARD = null, OWN_LOCK = false, OWN_VAL = '', S = null, SAVE = false;
var NOTE_WHY = [], TILES = [], REPORT_GATE = 'нет данных: /rules не прочитан';
function left() { return BUDGET_MS - (Date.now() - T0); }
function room() { return left() > STEP_MS; }

// ── ЗАПРОСЫ ─────────────────────────────────────────────────────────────
function opts(path) {
  var o = { url: CTRL + path, timeout: CTRL_SEC, headers: {} };
  if (AUTH) o.headers.Authorization = AUTH;
  return o;
}

// Чтение с одним повтором при обрыве (EOF, ST18), если бюджет позволяет.
function get(o, retryOk, cb) {
  var done = false;
  function once(r) { if (done) return; done = true; cb(r); }
  function call(retry) {
    try {
      G.$httpClient.get(o, function (e, r, data) {
        var st = r ? (r.status || r.statusCode || null) : null;
        if (st === null && retryOk && !retry && !FINISHED && room()) {
          return setTimeout(function () { call(true); }, 1000);
        }
        once({ status: st, error: e ? String(e).slice(0, 40) : null, body: data ? String(data) : '' });
      });
    } catch (e2) { once({ status: null, error: 'throw: ' + String(e2).slice(0, 40), body: '' }); }
  }
  call(false);
}

// Касание группы T: один запрос наружу, в T его ведёт правило override Lab.
// Без заголовков, без повтора, без ключа контроллера; из ответа — только код.
function touch(cb) {
  var t = Date.now();
  get({ url: TOUCH_URL, timeout: CTRL_SEC }, false, function (r) {
    cb({ код: r.status, мс: Date.now() - t, обрыв: r.status === null });
  });
}

// Отчёт на стенд: один POST, без повтора и без ключа контроллера. Разрешён,
// только если сверка /rules подтвердила DIRECT для хоста стенда (REPORT_GATE).
// Из ответа — только код и stop.
function sendReport(body, cb) {
  if (REPORT_GATE) return cb({ пропущено: REPORT_GATE });
  if (!room()) return cb({ пропущено: 'бюджет' });
  var t = Date.now(), done = false;
  function once(r) { if (done || FINISHED) return; done = true; cb(r); }
  try {
    G.$httpClient.post({ url: REPORT_URL, timeout: STAND_SEC, headers: { 'Content-Type': 'application/json' }, body: body }, function (e, r, data) {
      var st = r ? (r.status || r.statusCode || null) : null;
      var j = st === 200 ? json(data ? String(data) : '') : null;
      once({ код: st, мс: Date.now() - t, stop: !!(j && typeof j === 'object' && j.stop === true) });
    });
  } catch (e2) { once({ код: null, мс: Date.now() - t, stop: false }); }
}

// Касаться можно, только если группа T прочитана, есть и now — её узел.
function groupBlock(x) {
  if (!x) return 'группа T не прочитана';
  if (!x.есть) return 'нет группы T';
  if (x.now !== nodeA(TOUCH_GROUP) && x.now !== nodeB(TOUCH_GROUP)) return 'now T не TA/TB: ' + (short(x.now) || 'нет данных');
  return null;
}
// Разбор /rules: массив правил или причина «нет данных».
function normType(t) { return String(t).toUpperCase().replace(/[-_ ]/g, ''); }
function rulesList(r) {
  if (r.status !== 200) return 'нет данных: /rules не прочитан';
  var j = json(r.body), list = j && typeof j === 'object' && j.rules instanceof Array ? j.rules : null;
  if (!list || !list.length) return 'нет данных: формат /rules не разобран';
  for (var i = 0; i < list.length; i++) {
    var q = list[i];
    if (!q || typeof q !== 'object' || !valid(q.type) || !valid(q.proxy)) return 'нет данных: формат /rules не разобран';
    if (normType(q.type) === 'DOMAIN' && typeof q.payload !== 'string') return 'нет данных: формат /rules не разобран';
  }
  return list;
}
// Сверка: null — правило DOMAIN хоста host с прокси proxy стоит раньше любого
// не-DOMAIN правила и любого другого правила этого хоста; иначе причина.
// Режим ядра (GET /configs): правила действуют только в режиме rule; в global /
// direct отчёт и касание ушли бы мимо них (global — через селектор GLOBAL,
// возможно на обход). null — rule; иначе причина. Не прочитан / не разобран —
// «нет данных», никогда «на всякий случай».
function modeGate(r) {
  if (r.status !== 200) return 'режим: нет данных — /configs не прочитан';
  var j = json(r.body);
  if (!j || typeof j !== 'object' || !valid(j.mode)) return 'режим: нет данных — формат /configs не разобран';
  var m = j.mode.toLowerCase();
  return m === 'rule' ? null : 'режим ' + m.slice(0, 16) + ' — правила не действуют';
}
function isHostRule(q, host) { return normType(q.type) === 'DOMAIN' && String(q.payload).toLowerCase() === host; }
function ruleGate(list, host, proxy, what) {
  if (typeof list === 'string') return list;
  for (var i = 0; i < list.length; i++) {
    var q = list[i];
    if (normType(q.type) === 'DOMAIN') {
      if (!isHostRule(q, host)) continue;
      return q.proxy === proxy ? null : 'правило хоста ' + what + ' ведёт в ' + q.proxy;
    }
    var later = false;
    for (var k = i + 1; k < list.length; k++) if (isHostRule(list[k], host)) later = true;
    return later ? 'правило ' + what + ' стоит после ' + normType(q.type) : 'нет правила ' + what + ' в /rules';
  }
  return 'нет правила ' + what + ' в /rules';
}

function gp(name) { return '/proxies/' + encodeURIComponent(name); }
function json(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function valid(v) { return typeof v === 'string' && v.length > 0; }
function iso(ms) { return new Date(ms).toISOString().slice(0, 19) + 'Z'; }
function cap(list, n) { if (list.length > n) list.splice(0, list.length - n); }
function short(n) { return valid(n) && n.indexOf(P) === 0 ? n.slice(P.length) : n; }
function min1(ms) { return Math.round(ms / 6000) / 10; }
// Длина в байтах UTF-8 (лимиты стенда и журнала — в байтах).
function utf8(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1; else if (c < 0x800) n += 2; else if (c >= 0xD800 && c < 0xDC00) { n += 4; i++; } else n += 3;
  }
  return n;
}

// Нет поля — null («нет данных»), 404 — «нет такой группы / поставщика».
function pickGroup(r) {
  if (r.status === 404) return { есть: false };
  var j = r.status === 200 ? json(r.body) : null;
  if (!j || typeof j !== 'object') return null;
  return { есть: true, now: valid(j.now) ? j.now : null, all: j.all instanceof Array ? j.all.filter(valid) : null };
}
// Узлы поставщика: alive (только логическое) и последняя проверка из history.
function pickProv(r) {
  if (r.status === 404) return { есть: false };
  var j = r.status === 200 ? json(r.body) : null;
  if (!j || typeof j !== 'object') return null;
  var nodes = {};
  if (j.proxies instanceof Array) {
    j.proxies.forEach(function (q) {
      if (!q || typeof q !== 'object' || !valid(q.name)) return;
      var h = q.history instanceof Array && q.history.length ? q.history[q.history.length - 1] : null;
      nodes[q.name] = { alive: typeof q.alive === 'boolean' ? q.alive : null,
        проверка: h && valid(h.time) ? h.time : null, delay: h && typeof h.delay === 'number' ? h.delay : null };
    });
  }
  return { есть: true, узлы: nodes, upd: valid(j.updatedAt) ? j.updatedAt : null };
}

// ── ХРАНИЛИЩЕ ───────────────────────────────────────────────────────────
function sread(k) { try { return G.$persistentStore.read(k); } catch (e) { return null; } }
function swrite(v, k) { try { return G.$persistentStore.write(v, k) !== false; } catch (e) { return false; } }

var LOCK_LEFT = 0;
function lockTake() {
  var v = Number(String(sread(LOCK_KEY) || '').split(':')[0]) || 0, now = Date.now();
  if (v && now >= v && now - v < LOCK_MS) { LOCK_LEFT = Math.ceil((LOCK_MS - (now - v)) / 1000); return false; }
  OWN_VAL = now + ':' + Math.floor(Math.random() * 1e9);
  OWN_LOCK = swrite(OWN_VAL, LOCK_KEY);
  return true;
}
function lockMine() { return OWN_LOCK && sread(LOCK_KEY) === OWN_VAL; }

// Время плиток — отдельный ключ: пишется и занятым замком прогоном плитки.
function tilesLoad() {
  var t = json(sread(TILES_KEY));
  return t instanceof Array ? t.filter(function (x) { return typeof x === 'number'; }) : [];
}
function tileMark() {
  var t = tilesLoad();
  t.push(T0);
  cap(t, TILE_CAP);
  swrite(JSON.stringify(t), TILES_KEY);
}

function fresh(ms) {
  var s = { v: 1, rev: REV, t0: ms, lastMs: 0, прогонов: 0, отпр: 0, прев: {}, окна: {}, журнал: [], переходы: [],
            касания: { сделано: 0, обрыв: 0, пропущено: 0 }, отчёты: { ok: 0, нет: 0, пропущено: 0 },
            ноты: { первая: false, ms: 0, пропуск: {} } };
  GROUPS.forEach(function (g) { s.окна[g] = []; });
  return s;
}
// Без срока давности: старый опыт кончается автостопом по сроку, а не сбросом.
function load() {
  var s = json(sread(KEY));
  if (!s || s.v !== 1 || !s.t0 || !s.прев || !s.окна || !(s.журнал instanceof Array) || !(s.переходы instanceof Array)) return null;
  GROUPS.forEach(function (g) { if (!(s.окна[g] instanceof Array)) s.окна[g] = []; });
  if (!s.касания || typeof s.касания.сделано !== 'number') s.касания = { сделано: 0, обрыв: 0, пропущено: 0 };
  if (!s.отчёты || typeof s.отчёты.ok !== 'number') s.отчёты = { ok: 0, нет: 0, пропущено: 0 };
  if (typeof s.отпр !== 'number') s.отпр = 0;
  return s;
}

function failRun(why) {
  var f = json(sread(FAIL_KEY)) || {};
  f.n = (f.n || 0) + 1;
  f.first = f.first || Date.now();
  f.last = Date.now();
  swrite(JSON.stringify(f), FAIL_KEY);
  A.ВЕРДИКТ = 'КОНТРОЛЛЕР НЕ ОТВЕТИЛ (' + why + '). Журнал не тронут';
}

function log(e) { S.журнал.push(e); cap(S.журнал, CAP); }
function markers(ms) {
  var f = json(sread(FAIL_KEY));
  if (f && f.n > 0) {
    if (S.lastMs) log({ вид: 'окно', от: iso(S.lastMs), до: iso(ms), прогонов: f.n });
    swrite('{}', FAIL_KEY);
  }
}

// ── РАЗБОР ──────────────────────────────────────────────────────────────
function winOf(ms) { return Math.floor(ms / WIN_MS); }
function deadWin(k) { return k % 2 === 1; }
function offMin(ms, k) { return min1(ms - k * WIN_MS); }

// Запись окна группы (создаётся по первому чтению в окне).
function winRec(g, k) {
  var L = S.окна[g];
  for (var i = 0; i < L.length; i++) if (L[i].k === k) return L[i];
  var r = { k: k, вид: deadWin(k) ? 'смерть' : 'жизнь', чтений: 0 };
  L.push(r);
  cap(L, WIN_CAP);
  return r;
}

// Фоновый ли переход с опорой p на чтение в ms: нет, если сам прогон — плитка,
// опорное чтение — плитка или плитка была между ними (и за TILE_PAD_MS до опоры).
function byTile(p, ms) {
  if (TILE || p.pl) return true;
  for (var i = 0; i < TILES.length; i++) if (TILES[i] > p.ms - TILE_PAD_MS && TILES[i] <= ms) return true;
  return false;
}
function transit(g, r, k, ms, p, вид, seq) {
  var tile = byTile(p, ms), m = offMin(ms, k), lo = p.k === k ? offMin(p.ms, k) : 0;
  if (вид === 'ушёл') r.ушёл_мин = m; else r.вернулся_мин = m;
  r.не_раньше_мин = lo;
  if (tile) r.плитка = true;
  S.переходы.push({ seq: seq, г: short(g), вид: вид, окно: k, t: iso(ms), мин: m, не_раньше_мин: lo, фон: !tile });
  cap(S.переходы, TR_CAP);
}

// Одно чтение группы: now ∈ {A, B} — иначе «нет данных» (прев не сдвигается).
function account(g, now, ms, seq) {
  var a = nodeA(g), b = nodeB(g), k = winOf(ms);
  if (now !== a && now !== b) return 'нет данных';
  var p = S.прев[g];
  var near = p && (p.k === k || p.k === k - 1);      // опора — это или соседнее окно
  var r = winRec(g, k);
  r.чтений++;
  if (r.чтений === 1) r.от_мин = offMin(ms, k);
  if (deadWin(k)) {
    if (now === a) r.на_A_мин = offMin(ms, k);
    if (now === b) r.на_B_мин = offMin(ms, k);
    if (now === b && r.ушёл_мин === undefined) {
      if (near && p.now === a) transit(g, r, k, ms, p, 'ушёл', seq);
      else r.без_опоры = true;       // прошлое чтение не с A или далеко — «нет данных»
    }
  } else {
    if (now === b) r.на_B_мин = offMin(ms, k);
    if (now === a && r.вернулся_мин === undefined && near && p.now === b) transit(g, r, k, ms, p, 'вернулся', seq);
  }
  S.прев[g] = { k: k, now: now, ms: ms, pl: TILE ? 1 : 0 };
  return now === a ? 'A' : 'B';
}

// Итог по окнам группы на момент ms (закрыто — окно раньше текущего).
// Исход закрытого окна смерти: заметил в фоне / не заметил / застрял на B.
function summary(g, ms) {
  var cur = winOf(ms);
  var out = { заметил: [], по_плитке: 0, не_заметил: 0, застрял: 0, исходов: 0, вернулся: [], возврат_по_плитке: 0, не_вернулся: 0 };
  S.окна[g].forEach(function (r) {
    var closed = r.k < cur;
    if (r.вид === 'смерть') {
      if (r.ушёл_мин !== undefined) {
        if (r.плитка) out.по_плитке++;
        else { out.заметил.push(r.ушёл_мин); if (closed) out.исходов++; }
      } else if (closed && typeof r.на_A_мин === 'number' && r.на_A_мин >= MISS_MIN) { out.не_заметил++; out.исходов++; }
      else if (closed && r.на_A_мин === undefined && typeof r.от_мин === 'number' && r.от_мин <= STUCK_MIN &&
               typeof r.на_B_мин === 'number' && r.на_B_мин >= MISS_MIN) { out.застрял++; out.исходов++; }
    } else {
      if (r.вернулся_мин !== undefined) { if (r.плитка) out.возврат_по_плитке++; else out.вернулся.push(r.вернулся_мин); }
      else if (closed && typeof r.на_B_мин === 'number' && r.на_B_мин >= MISS_MIN) out.не_вернулся++;
    }
  });
  return out;
}
function maxUp(list) { return Math.ceil(Math.max.apply(null, list)); }

// Вердикт группы. Нет данных — никогда не «замечает»; одно окно — не вывод.
function baseVerdict(g, ms) {
  var s = summary(g, ms), n = s.заметил.length, m = s.не_заметил, z = s.застрял, v;
  if (n >= 2 && !m) v = 'замечает за ≤ ' + maxUp(s.заметил) + ' мин';
  else if (n >= 2) v = 'замечает не всегда: за ≤ ' + maxUp(s.заметил) + ' мин в ' + n + ' окн., не заметил в ' + m;
  else if (n === 1) v = '1 окно — не вывод (заметил за ≤ ' + maxUp(s.заметил) + ' мин' + (m ? ', не заметил в ' + m : '') + ')';
  else if (m) v = 'не заметил за окно' + (m > 1 ? ' (' + m + ' окн.)' : '');
  else if (z) v = 'застрял на B' + (z > 1 ? ' (' + z + ' окн.)' : '');
  else v = 'нет данных';
  if (z && (n || m)) v += '; застрял на B в ' + z;
  if (s.по_плитке) v += '; по плитке ' + s.по_плитке;
  return v;
}
// У T вывод о «трафике» верен, только если касания были: без них T — та же L.
function groupVerdict(g, ms) {
  var v = baseVerdict(g, ms);
  if (g !== TOUCH_GROUP) return v;
  var K = S.касания;
  if (!K.сделано) return 'T не касались — итог как у L: ' + v;
  if (K.обрыв || K.пропущено) return v + ' (касаний ' + K.сделано + ', обрывов ' + K.обрыв + ', пропущено ' + K.пропущено + ')';
  return v;
}
function returnVerdict(g, ms) {
  var s = summary(g, ms), n = s.вернулся.length, m = s.не_вернулся, v;
  if (n >= 2 && !m) v = 'возвращается за ≤ ' + maxUp(s.вернулся) + ' мин';
  else if (n >= 2) v = 'возвращается не всегда (' + n + ' да, ' + m + ' нет)';
  else if (n === 1) v = '1 окно — не вывод (вернулся за ≤ ' + maxUp(s.вернулся) + ' мин' + (m ? ', не вернулся в ' + m : '') + ')';
  else if (m) v = 'не вернулся за окно' + (m > 1 ? ' (' + m + ' окн.)' : '');
  else v = 'нет данных';
  if (s.возврат_по_плитке) v += '; по плитке ' + s.возврат_по_плитке;
  return v;
}

function verdict(ms) {
  var min = Math.round((S.lastMs - S.t0) / 6000) / 10;
  return REV + ' ' + min + ' мин: ' + GROUPS.map(function (g) { return short(g) + ' — ' + groupVerdict(g, ms); }).join('; ');
}
// Автостоп: срок или «данных достаточно» по всем четырём группам.
function autoStop(ms) {
  if (ms - S.t0 >= STOP_AFTER_MS) return 'срок 6 ч';
  if (GROUPS.every(function (g) { return summary(g, ms).исходов >= ENOUGH; })) return 'данных достаточно';
  return null;
}

// ── СТРОКА ЧТЕНИЯ И ОТЧЁТ ───────────────────────────────────────────────
function nowCode(g, x) {
  if (!x) return '?';
  if (!x.есть) return '-';
  if (x.now === nodeA(g)) return 'A';
  if (x.now === nodeB(g)) return 'B';
  return String(short(x.now) || 'нет').slice(0, 12);
}
function aliveCode(prov, g) {
  var x = prov && prov.есть && prov.узлы[nodeA(g)];
  return !x || x.alive === null ? '?' : x.alive ? '1' : '0';
}
function touchCode(t) {
  if (t.пропущено) return '-' + String(t.пропущено).slice(0, 28);
  return t.обрыв ? 'обрыв' : String(t.код);
}
function readLine(snap, t, ms) {
  var k = winOf(ms), out = [iso(ms).slice(11, 19), 'w' + k + (deadWin(k) ? '†' : '') + ' ' + offMin(ms, k) + 'м', A.тип];
  GROUPS.forEach(function (g) { out.push(short(g) + ':' + nowCode(g, snap.g[g])); });
  out.push('К:' + (snap.к === undefined ? '?' : nowCode(CTL, snap.к)));
  out.push('aA:' + GROUPS.map(function (g) { return aliveCode(snap.p[g], g); }).join(''));
  out.push('кас:' + touchCode(t));
  return out.join(' ');
}
function trLine(x) {
  return x.г + ' ' + x.вид + ' ' + x.мин + 'м (≥' + x.не_раньше_мин + ') ' + (x.фон ? 'фон' : 'плитка') + ' #' + x.seq;
}
function shortVerdicts(ms) {
  return GROUPS.map(function (g) { return short(g) + ' — ' + groupVerdict(g, ms); }).join('; ');
}
// Тело отчёта: только новое, ≤ REPORT_MAX байт (лишние старые переходы — счётчиком «пр»).
function reportBody(e, stopWhy, ms) {
  var tr = S.переходы.filter(function (x) { return x.seq > S.отпр; }).map(trLine);
  var o = { rev: REV, seq: e.seq, r: e.r, tr: tr };
  if (tr.length > TR_SEND) { o.пр = tr.length - TR_SEND; o.tr = tr.slice(-TR_SEND); }
  if (stopWhy) { o.стоп = stopWhy; o.ит = shortVerdicts(ms).slice(0, 500); }
  var s = JSON.stringify(o);
  while (utf8(s) > REPORT_MAX && o.tr.length) { o.tr.shift(); o.пр = (o.пр || 0) + 1; s = JSON.stringify(o); }
  if (utf8(s) > REPORT_MAX && o.ит) { o.ит = o.ит.slice(0, 150); s = JSON.stringify(o); }
  return s;
}

// ── ВЫВОД ───────────────────────────────────────────────────────────────
// cron — короткая строка (≤ LINE_MAX байт при любом хвосте); плитка — полный дамп.
function logLine() {
  var s = '[' + REV + '] ' + JSON.stringify(rep);
  if (TILE || utf8(s) <= LINE_MAX) return s;
  var a = { stash: A.stash, тип: A.тип, r: A.r, отчёт: A.отчёт, СТОП: A.СТОП, ВЕРДИКТ: String(A.ВЕРДИКТ || '').slice(0, 300), обрезано: true };
  return '[' + REV + '] ' + JSON.stringify({ rev: REV, ts: rep.ts, ans: a, err: rep.err.slice(0, 3).map(function (x) { return String(x).slice(0, 60); }), ms: rep.ms });
}

function finish() {
  if (FINISHED) return;
  FINISHED = true;
  try { clearTimeout(GUARD); } catch (e) {}
  var lines, color = '#FF9F0A';
  try {
    if (S && SAVE) {
      if (OWN_LOCK && !lockMine()) { rep.err.push('замок перехвачен — журнал не сохранён'); NOTE_WHY = []; }
      else if (!swrite(JSON.stringify(S), KEY)) { rep.err.push('журнал не сохранён'); if (!TILE) NOTE_WHY = []; }
      if (TILE) {
        A.журнал = S.журнал.slice(-30);
        A.переходы = S.переходы;
        A.окна = S.окна;
        A.t0 = iso(S.t0);
        A.отчёты = S.отчёты;
      }
      A.прогонов = S.прогонов;
      color = '#34C759';
    }
    lines = [A.СТОП || A.ВЕРДИКТ || REV + ': прогон прерван'];
    if (A.СТОП && A.ВЕРДИКТ) lines.push(A.ВЕРДИКТ);
    if (A.нет) lines.push('нет: ' + A.нет.join(', '));
    lines.push('Stash ' + (A.stash || '?') + ', ' + (Date.now() - T0) + ' мс' + (rep.err.length ? ' · ' + rep.err.join('; ') : ''));
  } catch (e0) {
    rep.err.push('сборка вывода упала: ' + String(e0));
    lines = ['СБОЙ ПРОБЫ: ' + String(e0)];
    color = '#FF3B30';
  }
  if (lockMine()) swrite('', LOCK_KEY);
  rep.ms = Date.now() - T0;
  rep.почему = NOTE_WHY;
  try { console.log(logLine()); } catch (e2) {}
  if (TILE || NOTE_WHY.length) {
    try {
      var body = (NOTE_WHY.length ? 'повод: ' + NOTE_WHY.join('; ') + '\n' : '') + lines.slice(1).join('\n') +
        (TILE ? '\nполная выгрузка — журнал скрипта, строка [' + REV + ']' : '');
      $notification.post('RouteHub ' + REV, lines[0].slice(0, 160), body);
    } catch (e3) {}
  }
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'), icon: 'eye', backgroundColor: color });
  } catch (e4) { try { $done(); } catch (e5) {} }
}

// Холостой режим после стопа: только чтение хранилища и сразу $done — ни
// контроллера, ни сети. Плитка показывает итог и выгружает журнал опыта.
function idle(s) {
  FINISHED = true;
  var st = s.стоп || {};
  var head = REV + ' остановлен: ' + (st.почему || '?') + ' (' + (st.t || '?') + ')';
  if (TILE) {
    try {
      console.log('[' + REV + '] ' + JSON.stringify({ rev: REV, ts: rep.ts, холостой: true, стоп: st, итог: s.итог, прогонов: s.прогонов,
        t0: iso(s.t0), касания: s.касания, отчёты: s.отчёты, журнал: (s.журнал || []).slice(-30), переходы: s.переходы, окна: s.окна }));
    } catch (e) {}
    try { $notification.post('RouteHub ' + REV, head, String(s.итог || '').slice(0, 300)); } catch (e2) {}
  }
  try {
    $done({ title: 'RouteHub ' + REV, content: head + '\n' + (s.итог || ''), icon: 'eye', backgroundColor: '#8E8E93' });
  } catch (e3) { try { $done(); } catch (e4) {} }
}

// cron: первый запуск и первое «не заметил» группы — не чаще раза в 10 мин.
function notePolicy(ms) {
  var N = S.ноты, now = Date.now();
  GROUPS.forEach(function (g) {
    if (!N.пропуск[g] && summary(g, ms).не_заметил > 0) { N.пропуск[g] = true; NOTE_WHY.push('не заметил: ' + short(g)); }
  });
  if (!N.первая) { N.первая = true; NOTE_WHY.unshift('запуск'); return; }
  if (!NOTE_WHY.length) return;
  if (!TILE && now - (N.ms || 0) < NOTE_GAP_MS) NOTE_WHY = [];
  else N.ms = now;
}

function missNote() {
  if (TILE) return;
  var n = Number(sread(NOTE_KEY)) || 0;
  if (Date.now() - n >= MISS_GAP_MS) { NOTE_WHY.push('нет групп Т24'); swrite(String(Date.now()), NOTE_KEY); }
}

// ── ГЛАВНАЯ ЦЕПОЧКА ─────────────────────────────────────────────────────
function readAll(snap, cb) {
  var jobs = [];
  GROUPS.forEach(function (g) { jobs.push(['g', g, gp(g)]); jobs.push(['p', g, '/providers/proxies/' + encodeURIComponent(provOf(g))]); });
  jobs.push(['к', CTL, gp(CTL)]);                      // контроль — последним: не отнимает бюджет у опыта
  var i = 0;
  (function next() {
    if (FINISHED) return;
    if (i >= jobs.length) return cb();
    if (!room()) { rep.err.push('бюджет: не прочитано ' + (jobs.length - i)); return cb(); }
    var j = jobs[i++];
    get(opts(j[2]), true, function (r) {
      var v = j[0] === 'p' ? pickProv(r) : pickGroup(r);
      if (j[0] === 'к') snap.к = v; else (j[0] === 'p' ? snap.p : snap.g)[j[1]] = v;
      if (!v && (A.отказы || []).length < 4) A.отказы = (A.отказы || []).concat([(j[0] === 'p' ? provOf(j[1]) : short(j[1])) + ': ' + (r.status || r.error)]);
      next();
    });
  })();
}

function nodeView(prov, n) {
  var x = prov && prov.есть && prov.узлы[n];
  if (!x) return { alive: 'нет данных', проверка: 'нет данных' };
  return { alive: x.alive === null ? 'нет данных' : x.alive, проверка: x.проверка || 'нет данных', delay: x.delay };
}

function main() {
  if (TILE) tileMark();
  if (!lockTake()) {
    A.ВЕРДИКТ = 'ЗАНЯТО: идёт другой прогон ' + REV + (TILE ? ' — замок снимется не позже чем через ' + LOCK_LEFT + ' с' : '');
    A.замок_с = LOCK_LEFT;
    return finish();
  }
  TILES = tilesLoad();
  var snap = { g: {}, p: {}, к: undefined };
  readAll(snap, function () {
    var any = GROUPS.some(function (g) { return snap.g[g] || snap.p[g]; });
    if (!any) return after({ пропущено: 'контроллер молчит' });
    if (!room()) return after({ пропущено: 'бюджет' });
    get(opts('/rules'), true, function (r) {
      var list = rulesList(r);
      if (!room()) return gates(list, 'режим: нет данных — бюджет');
      get(opts('/configs'), true, function (c) { gates(list, modeGate(c)); });
    });
  });
  // Общая сверка правила 1 для отчёта и касания: режим rule И правило хоста первым.
  function gates(list, mode) {
    A.режим = mode || 'rule';
    var stand = ruleGate(list, STAND_HOST, 'DIRECT', 'стенда');
    A.правило_стенда = stand || 'первое: DOMAIN,' + STAND_HOST + ',DIRECT';
    REPORT_GATE = mode || stand;
    var why = groupBlock(snap.g[TOUCH_GROUP]);
    if (why) return after({ пропущено: why });
    var rule = ruleGate(list, TOUCH_HOST, TOUCH_GROUP, 'касания');
    A.правило_касания = rule || 'первое: DOMAIN,' + TOUCH_HOST + ',' + TOUCH_GROUP;
    var gate = mode || rule;
    if (gate) return after({ пропущено: gate });
    if (!room()) return after({ пропущено: 'бюджет' });
    touch(after);
  }
  function after(t) {
    if (FINISHED) return;
    A.касание = t;
    var got = GROUPS.filter(function (g) { return snap.g[g] || snap.p[g]; });
    if (!got.length) { failRun('все чтения: ' + (A.отказы || []).slice(0, 2).join(', ')); return finish(); }
    var have = GROUPS.filter(function (g) { return snap.g[g] && snap.g[g].есть; });
    var miss = GROUPS.filter(function (g) { return snap.g[g] && !snap.g[g].есть; }).map(short);
    GROUPS.forEach(function (g) { if (snap.p[g] && !snap.p[g].есть) miss.push('поставщик ' + provOf(g)); });
    if (miss.length) A.нет = miss;
    if (!have.length) {
      A.ВЕРДИКТ = 'НЕТ ГРУПП Т24 — override Lab не обновлён (нажать «обновить»). Журнал не тронут';
      missNote();
      return finish();
    }
    var ms = Date.now(), k = winOf(ms);
    S = load() || fresh(ms);
    markers(ms);
    var seq = S.прогонов + 1;
    if (t.пропущено) S.касания.пропущено++; else if (t.обрыв) S.касания.обрыв++; else S.касания.сделано++;
    var nt = S.переходы.length ? S.переходы[S.переходы.length - 1].seq : 0;
    GROUPS.forEach(function (g) { if (snap.g[g] && snap.g[g].есть) account(g, snap.g[g].now, ms, seq); });
    var e = { вид: 'чтение', seq: seq, t: iso(ms), r: readLine(snap, t, ms) };
    A.r = e.r;
    A.новые = S.переходы.filter(function (x) { return x.seq > nt; }).map(trLine);
    log(e);
    S.lastMs = ms;
    S.прогонов = seq;
    notePolicy(ms);
    if (TILE) {
      A.сейчас = {};
      GROUPS.forEach(function (g) {
        var x = snap.g[g], prov = snap.p[g], cur = { now: 'не прочитано', A: nodeView(prov, nodeA(g)), B: nodeView(prov, nodeB(g)) };
        if (x && !x.есть) cur.now = 'нет группы';
        else if (x) cur.now = x.now || 'нет данных';
        cur.вывод = groupVerdict(g, ms);
        cur.возврат = returnVerdict(g, ms);
        cur.исходов = summary(g, ms).исходов;
        if (prov && prov.есть) cur.updatedAt = prov.upd || 'нет данных';
        A.сейчас[g] = cur;
      });
      A.сейчас[CTL] = snap.к === undefined ? 'не прочитано' : !snap.к ? 'нет данных' : !snap.к.есть ? 'нет группы' : (snap.к.now || 'нет данных');
      A.касания = S.касания;
    }
    A.ВЕРДИКТ = verdict(ms);
    var stopWhy = autoStop(ms);
    SAVE = true;
    sendReport(reportBody(e, stopWhy, ms), function (res) {
      A.отчёт = res;
      if (res.пропущено) { e.отчёт = 'пропущено: ' + res.пропущено; S.отчёты.пропущено++; }
      else {
        e.отчёт = res.код === null ? 'обрыв' : 'код ' + res.код;
        if (res.код === 200) { S.отпр = seq; S.отчёты.ok++; } else S.отчёты.нет++;
        if (res.stop && !stopWhy) stopWhy = 'стоп от стенда';
      }
      if (stopWhy) {
        S.стоп = { почему: stopWhy, t: iso(ms), seq: seq };
        S.итог = verdict(ms) + ' · возврат: ' + GROUPS.map(function (g) { return short(g) + ' — ' + returnVerdict(g, ms); }).join('; ');
        A.СТОП = REV + ' ОСТАНОВЛЕН: ' + stopWhy + ' — дальше холостой режим';
        NOTE_WHY.push('стоп: ' + stopWhy);
      }
      finish();
    });
  }
}

var STOPPED = (function () { var s = json(sread(KEY)); return s && typeof s === 'object' && s.стоп ? s : null; })();
if (STOPPED) {
  idle(STOPPED);
} else {
  GUARD = setTimeout(function () {
    if (FINISHED) return;
    rep.err.push('сторож: цепочка не завершилась');
    if (!SAVE && OWN_LOCK && !S) failRun('сторож');
    finish();
  }, GUARD_MS);
  if (typeof G.$httpClient === 'undefined') {
    rep.err.push('нет $httpClient');
    finish();
  } else {
    main();
  }
}
// конец файла — хвостовой страж
