/*
 * RouteHub — ПРОБА STASH ST24. Замечает ли Stash В ФОНЕ смерть узла
 * поставщика прокси, за сколько, и возвращается ли на него после оживления.
 * Только чтение контроллера + одно касание группы T по правилу override Lab.
 * ===========================================================================
 * ЗАЧЕМ (путь А). Worker отдаёт узлы через proxy-provider в порядке
 * рейтинга, fallback сам берёт первый живой. ST23: в фоне узлы поставщика
 * проверялись только при скачивании поставщика с ИЗМЕНЁННЫМ содержимым, по
 * `interval: 60` группы — нет. Узел, умерший между скачиваниями, группа
 * может не заметить. ST24 проверяет это на четырёх группах.
 *
 * СТЕНД (секции override Lab). Поставщики rh-t24l|n|p|t = /lab/t24-nodes
 * стенда: по два узла type direct, RH-Т24-<G>A и RH-Т24-<G>B; выдача не
 * меняется никогда. Узлы *A «мертвы» в нечётные окна по 10 мин (адрес
 * проверки отвечает через 25 с при benchmark-timeout 5), *B живы всегда.
 * Группы (fallback, use, interval 60): L — lazy не задан; N — lazy: false;
 * P — health-check у поставщика; T — «с трафиком» (касание ниже).
 * Ожидание: в нечётном окне `now` уходит с A на B, в чётном — возвращается.
 *
 * ЧТО ПИШЕТ. На каждом удачном чтении — запись журнала RH_ST24: окно, по
 * группе now, alive узлов A/B и время их последней проверки глазами ядра
 * (history[].time поставщика, если поле есть), ожидание «A мёртв / A жив».
 * Переходы (по группе): «ушёл» — now сменился с A на B в мёртвом окне,
 * задержка = время чтения − начало окна (верхняя граница; нижняя — прошлое
 * чтение с A); «вернулся» — с B на A в следующем живом окне. Переход
 * засчитывается только при ОПОРЕ: прошлое чтение с другим now в этом или
 * соседнем окне. Без опоры — «нет данных», а не «замечает».
 * Вердикт по группе: «замечает за ≤ N мин» / «не заметил за окно» (мёртвое
 * окно закрыто, now = A и после MISS_MIN мин) / «нет данных».
 *
 * ЗАПРОСЫ. ТОЛЬКО GET: /proxies/RH-Т24-L|N|P|T, /providers/proxies/rh-t24l|n|p|t
 * и /rules контроллера; одно касание — GET https://connectivitycheck.android.com/generate_204
 * без каких-либо заголовков. Ни PUT, ни /delay, ни боевых групп (правило 2),
 * обходных узлов нет (правило 1).
 *
 * КАСАНИЕ И ПРАВИЛО 1 (ревью ST24, дважды). Касание идёт в группу T по
 * ПРАВИЛУ override Lab `DOMAIN,connectivitycheck.android.com,RH-Т24-T` (Stash вставляет
 * массивы override в НАЧАЛО массива профиля — stash.wiki/en/configuration/
 * override). Заголовок X-Stash-Selected-Proxy не используется: он в проекте
 * не подтверждён, а без него запрос ушёл бы по боевым правилам, где любой
 * путь может кончиться обходом. Касание разрешено, только если: группа T
 * прочитана, есть и now ∈ {TA, TB}; в /rules контроллера правило DOMAIN
 * хоста касания с прокси RH-Т24-T найдено и стоит РАНЬШЕ любого не-DOMAIN
 * правила (RULE-SET, GEOIP, MATCH …) и любого другого правила этого хоста.
 * Формат /rules не разобран или ответа нет — касание пропускается, никогда
 * «на всякий случай». В журнал — только код и время касания.
 *
 * ВЫГРУЗКА — журнал скрипта одной строкой (console.log «[ST24] {…}»).
 * Уведомление: плитка — всегда, cron — первый запуск и первое «не заметил»
 * по группе (не чаще раза в 10 мин). EOF-окна в фоне: прогон без ответа
 * журнал не трогает, окно пишется по следующему удачному чтению.
 *
 * ВРЕМЯ. timeout $httpClient у Stash — в СЕКУНДАХ. Запрос начинается,
 * только если бюджета хватает (room); сторож 75 с позже бюджета 45 с
 * (setTimeout в фоне растягивается в 3–4 раза, ST14). Ровно один $done.
 * Замок RH_ST24_lock не даёт cron и плитке писать журнал одновременно.
 */

var REV = 'ST24';
var T0 = Date.now();

var BUDGET_MS = 45000;
var GUARD_MS = 75000;
var CTRL_SEC = 5;                    // Stash: секунды, не миллисекунды
var STEP_MS = (CTRL_SEC + 1) * 1000;
var LOCK_MS = 310000;                // дольше timeout cron (300 с)
var NOTE_GAP_MS = 10 * 60000;
var MISS_GAP_MS = 6 * 3600000;
var STALE_MS = 48 * 3600000;
var WIN_MS = 600000;                 // окно смерти стенда — 10 мин (/lab/t24-pulse)
var MISS_MIN = 8;                    // now = A на этой минуте мёртвого окна и позже — «не заметил»
var CAP = 60, TR_CAP = 40, WIN_CAP = 24;
var KEY = 'RH_ST24', FAIL_KEY = 'RH_ST24_fail', LOCK_KEY = 'RH_ST24_lock', NOTE_KEY = 'RH_ST24_note';

var TOUCH_URL = 'https://connectivitycheck.android.com/generate_204';   // хост правила касания override Lab
var TOUCH_HOST = 'connectivitycheck.android.com';
var P = 'RH-Т24-';
var IDS = ['L', 'N', 'P', 'T'];
var GROUPS = IDS.map(function (x) { return P + x; });
var TOUCH_GROUP = P + 'T';
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
var NOTE_WHY = [];
function left() { return BUDGET_MS - (Date.now() - T0); }
function room() { return left() > STEP_MS; }

// ── ЗАПРОСЫ (только GET) ────────────────────────────────────────────────
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
        once({ status: st, error: e ? String(e).slice(0, 80) : null, body: data ? String(data) : '' });
      });
    } catch (e2) { once({ status: null, error: 'throw: ' + String(e2).slice(0, 80), body: '' }); }
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
// Касаться можно, только если группа T прочитана, есть и now — её узел.
function groupBlock(x) {
  if (!x) return 'группа T не прочитана';
  if (!x.есть) return 'нет группы T';
  if (x.now !== nodeA(TOUCH_GROUP) && x.now !== nodeB(TOUCH_GROUP)) return 'now T не TA/TB: ' + (short(x.now) || 'нет данных');
  return null;
}
// Сверка /rules: null — правило касания первое для хоста; иначе причина.
// Непонятный формат — «нет данных», касания нет.
function normType(t) { return String(t).toUpperCase().replace(/[-_ ]/g, ''); }
function isTouchRule(q) { return normType(q.type) === 'DOMAIN' && String(q.payload).toLowerCase() === TOUCH_HOST; }
function ruleGate(r) {
  if (r.status !== 200) return 'нет данных: /rules не прочитан';
  var j = json(r.body), list = j && typeof j === 'object' && j.rules instanceof Array ? j.rules : null;
  if (!list || !list.length) return 'нет данных: формат /rules не разобран';
  for (var i = 0; i < list.length; i++) {
    var q = list[i];
    if (!q || typeof q !== 'object' || !valid(q.type) || !valid(q.proxy)) return 'нет данных: формат /rules не разобран';
    if (normType(q.type) === 'DOMAIN') {
      if (typeof q.payload !== 'string') return 'нет данных: формат /rules не разобран';
      if (!isTouchRule(q)) continue;
      return q.proxy === TOUCH_GROUP ? null : 'правило хоста касания ведёт в ' + q.proxy;
    }
    var later = false;
    for (var k = i + 1; k < list.length; k++) if (list[k] && valid(list[k].type) && isTouchRule(list[k])) later = true;
    return later ? 'правило касания стоит после ' + normType(q.type) : 'нет правила касания в /rules';
  }
  return 'нет правила касания в /rules';
}

function gp(name) { return '/proxies/' + encodeURIComponent(name); }
function json(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function valid(v) { return typeof v === 'string' && v.length > 0; }
function iso(ms) { return new Date(ms).toISOString().slice(0, 19) + 'Z'; }
function cap(list, n) { if (list.length > n) list.splice(0, list.length - n); }
function short(n) { return valid(n) && n.indexOf(P) === 0 ? n.slice(P.length) : n; }
function min1(ms) { return Math.round(ms / 6000) / 10; }

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

function fresh(ms) {
  var s = { v: 1, t0: ms, lastMs: 0, прогонов: 0, прев: {}, окна: {}, журнал: [], переходы: [],
            касания: { сделано: 0, обрыв: 0, пропущено: 0 }, ноты: { первая: false, ms: 0, пропуск: {} } };
  GROUPS.forEach(function (g) { s.окна[g] = []; });
  return s;
}
function load() {
  var s = json(sread(KEY));
  if (!s || s.v !== 1 || !s.t0 || !s.прев || !s.окна || !(s.журнал instanceof Array) || !(s.переходы instanceof Array)) return null;
  if (Date.now() - (s.lastMs || s.t0) > STALE_MS) return null;
  GROUPS.forEach(function (g) { if (!(s.окна[g] instanceof Array)) s.окна[g] = []; });
  if (!s.касания || typeof s.касания.сделано !== 'number') s.касания = { сделано: 0, обрыв: 0, пропущено: 0 };
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

// Одно чтение группы: now ∈ {A, B} — иначе «нет данных» (прев не сдвигается).
function account(g, now, ms) {
  var a = nodeA(g), b = nodeB(g), k = winOf(ms);
  if (now !== a && now !== b) return 'нет данных';
  var p = S.прев[g];
  var near = p && (p.k === k || p.k === k - 1);      // опора — это или соседнее окно
  var r = winRec(g, k);
  r.чтений++;
  if (deadWin(k)) {
    if (now === a) r.на_A_мин = offMin(ms, k);
    if (now === b && r.ушёл_мин === undefined) {
      if (near && p.now === a) {
        r.ушёл_мин = offMin(ms, k);
        r.не_раньше_мин = p.k === k ? offMin(p.ms, k) : 0;
        S.переходы.push({ г: short(g), вид: 'ушёл', окно: k, t: iso(ms), мин: r.ушёл_мин, не_раньше_мин: r.не_раньше_мин });
        cap(S.переходы, TR_CAP);
      } else r.без_опоры = true;       // прошлое чтение не с A или далеко — «нет данных»
    }
  } else {
    if (now === b) r.на_B_мин = offMin(ms, k);
    if (now === a && r.вернулся_мин === undefined && near && p.now === b) {
      r.вернулся_мин = offMin(ms, k);
      r.не_раньше_мин = p.k === k ? offMin(p.ms, k) : 0;
      S.переходы.push({ г: short(g), вид: 'вернулся', окно: k, t: iso(ms), мин: r.вернулся_мин, не_раньше_мин: r.не_раньше_мин });
      cap(S.переходы, TR_CAP);
    }
  }
  S.прев[g] = { k: k, now: now, ms: ms };
  return now === a ? 'A' : 'B';
}

// Итог по окнам группы на момент ms (закрыто — окно раньше текущего).
function summary(g, ms) {
  var cur = winOf(ms), out = { заметил: [], не_заметил: 0, вернулся: [], не_вернулся: 0 };
  S.окна[g].forEach(function (r) {
    var closed = r.k < cur;
    if (r.вид === 'смерть') {
      if (r.ушёл_мин !== undefined) out.заметил.push(r.ушёл_мин);
      else if (closed && typeof r.на_A_мин === 'number' && r.на_A_мин >= MISS_MIN) out.не_заметил++;
    } else {
      if (r.вернулся_мин !== undefined) out.вернулся.push(r.вернулся_мин);
      else if (closed && typeof r.на_B_мин === 'number' && r.на_B_мин >= MISS_MIN) out.не_вернулся++;
    }
  });
  return out;
}
function maxUp(list) { return Math.ceil(Math.max.apply(null, list)); }

// Вердикт группы. Нет данных — никогда не «замечает».
function baseVerdict(g, ms) {
  var s = summary(g, ms), n = s.заметил.length, m = s.не_заметил;
  if (n && !m) return 'замечает за ≤ ' + maxUp(s.заметил) + ' мин';
  if (n && m) return 'замечает не всегда: за ≤ ' + maxUp(s.заметил) + ' мин в ' + n + ' окн., не заметил в ' + m;
  if (m) return 'не заметил за окно' + (m > 1 ? ' (' + m + ' окн.)' : '');
  return 'нет данных';
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
  var s = summary(g, ms);
  if (s.вернулся.length && !s.не_вернулся) return 'возвращается за ≤ ' + maxUp(s.вернулся) + ' мин';
  if (s.вернулся.length) return 'возвращается не всегда (' + s.вернулся.length + ' да, ' + s.не_вернулся + ' нет)';
  if (s.не_вернулся) return 'не вернулся за окно';
  return 'нет данных';
}

function verdict(ms) {
  var min = Math.round((S.lastMs - S.t0) / 6000) / 10;
  return 'ST24 ' + min + ' мин: ' + GROUPS.map(function (g) { return short(g) + ' — ' + groupVerdict(g, ms); }).join('; ');
}

// ── ВЫВОД ───────────────────────────────────────────────────────────────
function finish() {
  if (FINISHED) return;
  FINISHED = true;
  try { clearTimeout(GUARD); } catch (e) {}
  var lines, color = '#FF9F0A';
  try {
    if (S && SAVE) {
      if (OWN_LOCK && !lockMine()) { rep.err.push('замок перехвачен — журнал не сохранён'); NOTE_WHY = []; }
      else if (!swrite(JSON.stringify(S), KEY)) { rep.err.push('журнал не сохранён'); if (!TILE) NOTE_WHY = []; }
      A.журнал = S.журнал.slice(-30);
      A.переходы = S.переходы;
      A.окна = S.окна;
      A.прогонов = S.прогонов;
      A.t0 = iso(S.t0);
      color = '#34C759';
    }
    lines = [A.ВЕРДИКТ || 'ST24: прогон прерван'];
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
  try { console.log('[' + REV + '] ' + JSON.stringify(rep)); } catch (e2) {}
  if (TILE || NOTE_WHY.length) {
    try {
      var body = (NOTE_WHY.length ? 'повод: ' + NOTE_WHY.join('; ') + '\n' : '') + lines.slice(1).join('\n') +
        (TILE ? '\nполная выгрузка — журнал скрипта, строка [ST24]' : '');
      $notification.post('RouteHub ' + REV, lines[0].slice(0, 160), body);
    } catch (e3) {}
  }
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'), icon: 'eye', backgroundColor: color });
  } catch (e4) { try { $done(); } catch (e5) {} }
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
  var i = 0;
  (function next() {
    if (FINISHED) return;
    if (i >= jobs.length) return cb();
    if (!room()) { rep.err.push('бюджет: не прочитано ' + (jobs.length - i)); return cb(); }
    var j = jobs[i++];
    get(opts(j[2]), true, function (r) {
      var v = j[0] === 'p' ? pickProv(r) : pickGroup(r);
      (j[0] === 'p' ? snap.p : snap.g)[j[1]] = v;
      if (!v) A.отказы = (A.отказы || []).concat([(j[0] === 'p' ? provOf(j[1]) : short(j[1])) + ': ' + (r.status || r.error)]);
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
  if (!lockTake()) {
    A.ВЕРДИКТ = 'ЗАНЯТО: идёт другой прогон ST24' + (TILE ? ' — замок снимется не позже чем через ' + LOCK_LEFT + ' с' : '');
    A.замок_с = LOCK_LEFT;
    return finish();
  }
  var snap = { g: {}, p: {} };
  readAll(snap, function () {
    var why = groupBlock(snap.g[TOUCH_GROUP]);
    if (why) return after({ пропущено: why });
    if (!room()) return after({ пропущено: 'бюджет' });
    get(opts('/rules'), true, function (r) {
      var gate = ruleGate(r);
      A.правило_касания = gate || 'первое: DOMAIN,' + TOUCH_HOST + ',' + TOUCH_GROUP;
      if (gate) return after({ пропущено: gate });
      if (!room()) return after({ пропущено: 'бюджет' });
      touch(after);
    });
  });
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
    var e = { вид: 'чтение', t: iso(ms), окно: k, ждём: deadWin(k) ? 'A мёртв' : 'A жив', мин: offMin(ms, k),
              касание: t.пропущено ? 'пропущено: ' + t.пропущено : t.обрыв ? 'обрыв' : 'код ' + t.код };
    if (t.пропущено) S.касания.пропущено++; else if (t.обрыв) S.касания.обрыв++; else S.касания.сделано++;
    A.сейчас = {};
    GROUPS.forEach(function (g) {
      var x = snap.g[g], prov = snap.p[g];
      var na = nodeView(prov, nodeA(g)), nb = nodeView(prov, nodeB(g));
      var cur = { now: 'не прочитано', A: na, B: nb };
      if (x && !x.есть) cur.now = 'нет группы';
      else if (x) cur.now = x.now || 'нет данных';
      var ок = x && x.есть ? account(g, x.now, ms) : 'нет данных';
      e[short(g)] = { now: short(cur.now), по_now: ок, aA: na.alive, aB: nb.alive, пA: na.проверка, пB: nb.проверка };
      cur.вывод = groupVerdict(g, ms);
      cur.возврат = returnVerdict(g, ms);
      if (prov && prov.есть) cur.updatedAt = prov.upd || 'нет данных';
      A.сейчас[g] = cur;
    });
    log(e);
    S.lastMs = ms;
    S.прогонов++;
    notePolicy(ms);
    A.вывод = {};
    A.возврат = {};
    GROUPS.forEach(function (g) { A.вывод[g] = groupVerdict(g, ms); A.возврат[g] = returnVerdict(g, ms); });
    A.касания = S.касания;
    A.ВЕРДИКТ = verdict(ms);
    SAVE = true;
    finish();
  }
}

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
// конец файла — хвостовой страж
