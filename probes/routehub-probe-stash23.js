/*
 * RouteHub — ПРОБА STASH ST23. Fallback на поставщике прокси: держит ли он
 * ПОРЯДОК ПОСТАВЩИКА и берёт ли ПЕРВЫЙ ЖИВОЙ. Только чтение, без трафика.
 * ===========================================================================
 * ЗАЧЕМ (путь А). Worker отдаёт узлы через proxy-provider уже в порядке
 * своего рейтинга; Stash скачивает поставщика в фоне (ST22: раз в ~4 мин);
 * fallback сам берёт лучший живой — без скриптов и без записи в контроллер
 * (в фоне контроллер отдаёт EOF). ST22 доказал порядок поставщика только
 * для select с use + filter. ST23 — для fallback с `use:`.
 *
 * СТЕНД (секции override Lab). Поставщик rh-t23 = /lab/t23-nodes стенда:
 * окно 10 мин по времени, чётное — A, B, C; нечётное — Муляж, C, B, A
 * (A/B/C — type direct, Муляж — socks5 TEST-NET, порт 1: мёртв по
 * устройству). Группы RH-Т23-F (fallback, use [rh-t23]) и RH-Т23-FF (то же
 * + filter '^RH-Т23-'). Ожидание пути А: `.all` — в порядке поставщика,
 * `now` — первый живой: A в чётном окне, C в нечётном (Муляж пропущен).
 *
 * ЧТО ПИШЕТ. На каждом удачном чтении — запись журнала: окно по времени,
 * ожидаемый первый по окну, версия поставщика в группе (чёт / нечёт — по
 * `.all`), now, совпадение. Совпадение по группе:
 *   «да»        — now = первый живой в `.all`;
 *   «муляж»     — now = Муляж (ядро ещё считает новый узел живым);
 *   «нет»       — now — живой узел, но не первый живой;
 *   «нет данных» — нет now или `.all` (отсутствие поля ≠ «жив»).
 * Живость узла: поле alive поставщика, если оно логическое; иначе — по
 * устройству стенда (Муляж мёртв, direct жив), с пометкой «по».
 * Переходы — смена версии поставщика между двумя удачными чтениями группы:
 * перешёл ли now на новый первый живой. Профиль и override проба не трогает.
 * Вывод: «now = первый живой в порядке поставщика: да / нет / не различить»,
 * число смен окна, увиденных без обновления профиля.
 *
 * ЗАПРОСЫ. ТОЛЬКО GET /proxies/RH-Т23-F, /proxies/RH-Т23-FF и
 * /providers/proxies/rh-t23. Ни PUT, ни /delay, ни боевых групп (правило 2),
 * обходных узлов у поставщика нет (правило 1).
 *
 * ВЫГРУЗКА — журнал скрипта одной строкой (console.log «[ST23] {…}»;
 * clipboard на устройстве не работает). Уведомление — короткий итог:
 * плитка — всегда, cron — первый запуск и первое «нет» по группе (не чаще
 * раза в 10 мин). EOF-окна в фоне по 30+ мин (ST21): прогон без ответа
 * журнал не трогает, вывод — по удачным чтениям, окно пишется отдельно.
 *
 * ВРЕМЯ. timeout $httpClient у Stash — в СЕКУНДАХ. Запрос начинается,
 * только если бюджета хватает (room); сторож 75 с позже бюджета 45 с
 * (setTimeout в фоне растягивается в 3–4 раза, ST14). Ровно один $done.
 * Замок RH_ST23_lock не даёт cron и плитке писать журнал одновременно.
 */

var REV = 'ST23';
var T0 = Date.now();

var BUDGET_MS = 45000;
var GUARD_MS = 75000;
var CTRL_SEC = 5;                    // Stash: секунды, не миллисекунды
var STEP_MS = (CTRL_SEC + 1) * 1000;
var LOCK_MS = 310000;                // дольше timeout cron (300 с)
var NOTE_GAP_MS = 10 * 60000;
var MISS_GAP_MS = 6 * 3600000;
var STALE_MS = 48 * 3600000;
var WIN_MS = 600000;                 // окно порядка стенда — 10 мин (/lab/t23-nodes)
var GAP_MS = 10 * 60000;             // пропуск удачных чтений — «после возврата»
var CAP = 60, TR_CAP = 20;
var KEY = 'RH_ST23', FAIL_KEY = 'RH_ST23_fail', LOCK_KEY = 'RH_ST23_lock', NOTE_KEY = 'RH_ST23_note';

var PROV = 'rh-t23';
var P = 'RH-Т23-';
var NA = P + 'A', NB = P + 'B', NC = P + 'C', DEAD = P + 'Муляж';
var F = P + 'F', FF = P + 'FF';
var GROUPS = [F, FF];
var EVEN = [NA, NB, NC];             // окно чётное
var ODD = [DEAD, NC, NB, NA];        // окно нечётное

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

// ── ЗАПРОСЫ (только чтение) ─────────────────────────────────────────────
function opts(path) {
  var o = { url: CTRL + path, timeout: CTRL_SEC, headers: {} };
  if (AUTH) o.headers.Authorization = AUTH;
  return o;
}

// Чтение с одним повтором при обрыве (EOF, ST18), если бюджет позволяет.
function get(path, cb) {
  var o = opts(path), done = false;
  function once(r) { if (done) return; done = true; cb(r); }
  function call(retry) {
    try {
      G.$httpClient.get(o, function (e, r, data) {
        var st = r ? (r.status || r.statusCode || null) : null;
        if (st === null && !retry && !FINISHED && room()) {
          return setTimeout(function () { call(true); }, 1000);
        }
        once({ status: st, error: e ? String(e).slice(0, 80) : null, body: data ? String(data) : '' });
      });
    } catch (e2) { once({ status: null, error: 'throw: ' + String(e2).slice(0, 80), body: '' }); }
  }
  call(false);
}

function gp(name) { return '/proxies/' + encodeURIComponent(name); }
function json(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function valid(v) { return typeof v === 'string' && v.length > 0; }
function iso(ms) { return new Date(ms).toISOString().slice(0, 19) + 'Z'; }
function cap(list, n) { if (list.length > n) list.splice(0, list.length - n); }
function same(a, b) { return !!a && !!b && a.length === b.length && a.every(function (x, i) { return x === b[i]; }); }
function short(n) { return valid(n) && n.indexOf(P) === 0 ? n.slice(P.length) : n; }

// Нет поля — null («нет данных»), 404 — «нет такой группы / поставщика».
function pickGroup(r) {
  if (r.status === 404) return { есть: false };
  var j = r.status === 200 ? json(r.body) : null;
  if (!j || typeof j !== 'object') return null;
  return { есть: true, now: valid(j.now) ? j.now : null, all: j.all instanceof Array ? j.all.filter(valid) : null };
}
function pickProv(r) {
  if (r.status === 404) return { есть: false };
  var j = r.status === 200 ? json(r.body) : null;
  if (!j || typeof j !== 'object') return null;
  var list = null, alive = {};
  if (j.proxies instanceof Array) {
    list = [];
    j.proxies.forEach(function (q) {
      var n = q && typeof q === 'object' ? q.name : q;
      if (!valid(n)) return;
      list.push(n);
      if (q && typeof q === 'object' && typeof q.alive === 'boolean') alive[n] = q.alive;
    });
  }
  return { есть: true, узлы: list, alive: alive, upd: valid(j.updatedAt) ? j.updatedAt : null,
           vt: valid(j.vehicleType) ? j.vehicleType : null };
}

// ── ХРАНИЛИЩЕ ───────────────────────────────────────────────────────────
function sread(k) { try { return G.$persistentStore.read(k); } catch (e) { return null; } }
function swrite(v, k) { try { return G.$persistentStore.write(v, k) !== false; } catch (e) { return false; } }

var LOCK_LEFT = 0;                   // с до истечения чужого замка (для плитки)
function lockTake() {
  var v = Number(String(sread(LOCK_KEY) || '').split(':')[0]) || 0, now = Date.now();
  if (v && now >= v && now - v < LOCK_MS) { LOCK_LEFT = Math.ceil((LOCK_MS - (now - v)) / 1000); return false; }
  OWN_VAL = now + ':' + Math.floor(Math.random() * 1e9);
  OWN_LOCK = swrite(OWN_VAL, LOCK_KEY);
  return true;
}
function lockMine() { return OWN_LOCK && sread(LOCK_KEY) === OWN_VAL; }

function counts() { return { да: 0, да_при_мёртвом_первом: 0, муляж: 0, нет: 0, нет_данных: 0, порядок_иной: 0 }; }
function fresh(ms) {
  var s = { v: 1, t0: ms, lastMs: 0, прогонов: 0, прев: {}, журнал: [], переходы: [], счёт: {},
            смен: {}, муляжПодряд: {}, муляжМакс: {}, ноты: { первая: false, ms: 0, нет: {} } };
  GROUPS.forEach(function (g) { s.счёт[g] = counts(); s.смен[g] = { увидено: 0, now_перешёл: 0 }; s.муляжПодряд[g] = 0; s.муляжМакс[g] = 0; });
  return s;
}
function load() {
  var s = json(sread(KEY));
  if (!s || s.v !== 1 || !s.t0 || !s.счёт || !s.прев || !(s.журнал instanceof Array) || !(s.переходы instanceof Array)) return null;
  if (Date.now() - (s.lastMs || s.t0) > STALE_MS) return null;
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
function parityOf(ms) { return winOf(ms) % 2 === 0 ? 'чёт' : 'нечёт'; }
// Версия выдачи стенда, которую держит список: чёт / нечёт / null (иной).
function versionOf(list) { return same(list, EVEN) ? 'чёт' : same(list, ODD) ? 'нечёт' : null; }
function expectedBy(parity) { return parity === 'чёт' ? NA : NC; }

// Живость: поле alive поставщика, если логическое; иначе по устройству стенда.
function aliveOf(n, prov) {
  if (prov && prov.alive && prov.alive.hasOwnProperty(n)) return { жив: prov.alive[n], по: 'полю alive' };
  if (n === DEAD) return { жив: false, по: 'устройству стенда' };
  return { жив: EVEN.indexOf(n) >= 0, по: 'устройству стенда' };
}
function firstAlive(list, prov) {
  for (var i = 0; i < list.length; i++) {
    var a = aliveOf(list[i], prov);
    if (a.жив) return { имя: list[i], по: a.по, i: i };
  }
  return null;
}

// Одна группа на одном чтении: совпадение и чей порядок.
function judge(x, prov) {
  var out = { версия: null, now: null, ок: 'нет_данных', порядок: 'нет данных' };
  if (!x || !x.есть) return out;
  out.now = x.now;
  if (!x.all) return out;
  out.версия = versionOf(x.all);
  if (prov && prov.есть && prov.узлы) out.порядок = same(x.all, prov.узлы) ? 'поставщика' : 'иной';
  else out.порядок = out.версия ? 'поставщика (по устройству стенда)' : 'иной';
  var fa = firstAlive(x.all, prov);
  if (!x.now || !fa) return out;
  out.первый_живой = fa.имя;
  out.живость_по = fa.по;
  out.мёртвый_первым = fa.i > 0;
  if (x.now === fa.имя) out.ок = 'да';
  else if (x.now === DEAD) out.ок = 'муляж';
  else out.ок = 'нет';
  return out;
}

function account(g, j, x, ms) {
  var C = S.счёт[g];
  C[j.ок]++;
  if (j.ок === 'да' && j.мёртвый_первым) C.да_при_мёртвом_первом++;
  if (j.порядок === 'иной') C.порядок_иной++;
  S.муляжПодряд[g] = j.ок === 'муляж' ? S.муляжПодряд[g] + 1 : 0;
  if (S.муляжПодряд[g] > S.муляжМакс[g]) S.муляжМакс[g] = S.муляжПодряд[g];
  if (j.ок === 'нет' && !S.ноты.нет[g]) { S.ноты.нет[g] = true; NOTE_WHY.push('нет: ' + short(g) + ' now ' + short(j.now) + ', первый живой ' + short(j.первый_живой)); }
  // Переход: версия поставщика в группе сменилась между удачными чтениями.
  var p = S.прев[g];
  if (j.версия) {
    if (p && p.версия && p.версия !== j.версия) {
      S.смен[g].увидено++;
      if (j.ок === 'да') S.смен[g].now_перешёл++;
      S.переходы.push({ г: short(g), t: iso(ms), было: p.версия, стало: j.версия, now_было: short(p.now), now_стало: short(j.now),
        первый_живой: short(j.первый_живой), перешёл: j.ок === 'да', пропуск_мин: Math.round((ms - p.ms) / 60000),
        all: x.all.map(short) });
      cap(S.переходы, TR_CAP);
    }
    S.прев[g] = { версия: j.версия, now: j.now, ms: ms };
  }
}

function groupVerdict(g) {
  var C = S.счёт[g];
  if (C.нет > 0) return 'нет';
  if (C.порядок_иной > 0) return 'не различить: порядок в группе не поставщика';
  if (C.да > 0) return 'да';
  return 'не различить';
}

function verdict() {
  var min = Math.round((S.lastMs - S.t0) / 6000) / 10, parts = [];
  GROUPS.forEach(function (g) {
    var C = S.счёт[g], M = S.смен[g];
    parts.push(short(g) + ' — ' + groupVerdict(g) + ' (да ' + C.да + ', при мёртвом первом ' + C.да_при_мёртвом_первом +
      ', муляж ' + C.муляж + ', нет ' + C.нет + '; смен окна ' + M.увидено + ', now перешёл ' + M.now_перешёл + ')');
  });
  return 'ST23 ' + min + ' мин: now = первый живой в порядке поставщика: ' + parts.join('; ');
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
      A.счёт = S.счёт;
      A.смен = S.смен;
      A.муляж_подряд_макс = S.муляжМакс;
      A.прогонов = S.прогонов;
      A.t0 = iso(S.t0);
      color = '#34C759';
    }
    lines = [A.ВЕРДИКТ || 'ST23: прогон прерван'];
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
        (TILE ? '\nполная выгрузка — журнал скрипта, строка [ST23]' : '');
      $notification.post('RouteHub ' + REV, lines[0].slice(0, 160), body);
    } catch (e3) {}
  }
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'), icon: 'eye', backgroundColor: color });
  } catch (e4) { try { $done(); } catch (e5) {} }
}

// cron: первый запуск и первое «нет» группы — не чаще раза в 10 мин; плитка — всегда.
function notePolicy() {
  var N = S.ноты, now = Date.now();
  if (!N.первая) { N.первая = true; NOTE_WHY.unshift('запуск'); return; }
  if (!NOTE_WHY.length) return;
  if (!TILE && now - (N.ms || 0) < NOTE_GAP_MS) NOTE_WHY = [];
  else N.ms = now;
}

function missNote() {
  if (TILE) return;
  var n = Number(sread(NOTE_KEY)) || 0;
  if (Date.now() - n >= MISS_GAP_MS) { NOTE_WHY.push('нет групп Т23'); swrite(String(Date.now()), NOTE_KEY); }
}

// ── ГЛАВНАЯ ЦЕПОЧКА ─────────────────────────────────────────────────────
function readAll(snap, cb) {
  var jobs = [['prov', '/providers/proxies/' + encodeURIComponent(PROV)]];
  GROUPS.forEach(function (g) { jobs.push([g, gp(g)]); });
  var i = 0;
  (function next() {
    if (FINISHED) return;
    if (i >= jobs.length) return cb();
    if (!room()) { rep.err.push('бюджет: не прочитано ' + (jobs.length - i)); return cb(); }
    var j = jobs[i++];
    get(j[1], function (r) {
      var v = j[0] === 'prov' ? pickProv(r) : pickGroup(r);
      if (j[0] === 'prov') snap.prov = v; else snap.g[j[0]] = v;
      if (!v) A.отказы = (A.отказы || []).concat([j[0] + ': ' + (r.status || r.error)]);
      next();
    });
  })();
}

function main() {
  if (!lockTake()) {
    A.ВЕРДИКТ = 'ЗАНЯТО: идёт другой прогон ST23' + (TILE ? ' — замок снимется не позже чем через ' + LOCK_LEFT + ' с' : '');
    A.замок_с = LOCK_LEFT;
    return finish();
  }
  var snap = { prov: undefined, g: {} };
  readAll(snap, function () {
    var got = GROUPS.filter(function (g) { return snap.g[g]; });
    if (!got.length && !snap.prov) { failRun('все чтения: ' + (A.отказы || []).slice(0, 2).join(', ')); return finish(); }
    var have = GROUPS.filter(function (g) { return snap.g[g] && snap.g[g].есть; });
    var miss = GROUPS.filter(function (g) { return snap.g[g] && !snap.g[g].есть; });
    if (snap.prov && !snap.prov.есть) miss.unshift('поставщик ' + PROV);
    if (miss.length) A.нет = miss;
    if (!have.length) {
      A.ВЕРДИКТ = 'НЕТ ГРУПП Т23 — override Lab не обновлён (нажать «обновить»). Журнал не тронут';
      missNote();
      return finish();
    }
    var ms = Date.now(), prov = snap.prov && snap.prov.есть ? snap.prov : null;
    S = load() || fresh(ms);
    markers(ms);
    var par = parityOf(ms), e = { вид: 'чтение', t: iso(ms), окно: winOf(ms), по_окну: par, ждём: short(expectedBy(par)) };
    if (prov) e.поставщик = prov.узлы ? (versionOf(prov.узлы) || prov.узлы.map(short).join(',')) : 'нет данных';
    A.сейчас = {};
    GROUPS.forEach(function (g) {
      var x = snap.g[g];
      if (!x) { e[short(g)] = 'не прочитано'; A.сейчас[g] = 'не прочитано'; return; }
      if (!x.есть) { e[short(g)] = 'нет группы'; A.сейчас[g] = 'нет'; return; }
      var j = judge(x, prov);
      account(g, j, x, ms);
      e[short(g)] = { v: j.версия || (x.all ? x.all.map(short).join(',') : 'нет данных'), now: short(j.now) || 'нет данных', ок: j.ок };
      A.сейчас[g] = { now: x.now, all: x.all, совпадение: j.ок, порядок: j.порядок, первый_живой: j.первый_живой || null,
                      живость_по: j.живость_по || null };
    });
    log(e);
    if (prov) A.поставщик = { узлы: prov.узлы || 'нет данных', alive: prov.alive, updatedAt: prov.upd || 'нет данных',
                              vehicleType: prov.vt || 'нет данных' };
    S.lastMs = ms;
    S.прогонов++;
    notePolicy();
    A.вывод = {};
    GROUPS.forEach(function (g) { A.вывод[g] = groupVerdict(g); });
    A.ВЕРДИКТ = verdict();
    SAVE = true;
    finish();
  });
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
