/*
 * RouteHub — ПРОБА STASH ST21. Почему DIRECT в RH-RU «тайм-аут». ТОЛЬКО ЧТЕНИЕ.
 * ===========================================================================
 * ЗАЧЕМ. Полевой факт 27.09: на сотовой без whitelist Ozon открывается раз,
 * затем RH-RU (fallback [DIRECT, RH-Обход], interval 600) уходит на обход, у
 * DIRECT в интерфейсе «тайм-аут»; ручной замер — DIRECT жив. Гипотеза
 * ideator (НЕ подтверждена, Stash — закрытый код): в ядре Clash неудачный
 * dial ставит узлу alive=false до следующего замера, а DIRECT — один объект
 * на все группы. ST21 пишет, КАК падает alive у DIRECT: вместе с новой
 * записью history (плановый замер) или без неё (событие — вероятно, dial).
 *
 * ЧТО ЧИТАЕТ. Раз в минуту (cron) GET /proxies/{имя} для DIRECT, RH-RU,
 * RH-Главный, «часов» RH-Часы (профиль S-draft-9) и пары RH-Тест-RU /
 * RH-Прямо-RU (override RouteHub-Stash-Watch; без него — «нет данных», не
 * ошибка): поля alive, now, последняя запись history (время, delay).
 * Плюс RH-Обход и его члены — тоже только GET /proxies/{имя}: живы ли
 * обходные узлы по оценке самого ядра (проверка резолва имён обходных
 * серверов под whitelist, S-draft-9). В журнал ($persistentStore, RH_ST21) —
 * только ПЕРЕХОДЫ: смена now у RH-RU / RH-Главный, смена alive у DIRECT /
 * RH-Прямо-RU (с отметкой, была ли новая запись history), новые записи
 * history (подряд идущие с тем же исходом склеиваются), смена числа живых
 * обходных узлов, окна недоступности контроллера.
 *
 * ПЛИТКА (панель Stash) — тот же скрипт: сводка JSON в буфер обмена и
 * уведомление. cron уведомляет только о первом запуске и об уходе RH-RU /
 * RH-Главный с DIRECT (не чаще раза в 10 мин).
 *
 * ЗАПРЕЩЕНО И НЕ ДЕЛАЕТСЯ: PUT / DELETE / POST / PATCH; вызовы /delay (замер
 * сам выставляет alive — это запись в маршрутизацию, правило 2); любой
 * трафик через обходные узлы (правило 1): их состояние только читается.
 * Отсутствие поля (alive, history) — «нет данных», а не «жив».
 *
 * ВРЕМЯ. timeout $httpClient у Stash — в СЕКУНДАХ. Запрос начинается, только
 * если бюджета хватает (room); сторож 75 с позже бюджета 45 с (setTimeout в
 * фоне растягивается в 3–4 раза, ST14). Ровно один $done. Замок RH_ST21_lock
 * не даёт cron и плитке писать журнал одновременно.
 */

var REV = 'ST21';
var T0 = Date.now();

var BUDGET_MS = 45000;
var GUARD_MS = 75000;
var CTRL_SEC = 5;                    // Stash: секунды, не миллисекунды
var STEP_MS = (CTRL_SEC + 1) * 1000;
var LOCK_MS = 310000;                // дольше timeout cron (300 с)
var NOTE_GAP_MS = 10 * 60000;
var MISS_GAP_MS = 6 * 3600000;
var STALE_MS = 48 * 3600000;
var CAP = 80;                        // записей журнала в состоянии
var BYP_MAX = 12;                    // членов RH-Обход читается не больше
var KEY = 'RH_ST21', FAIL_KEY = 'RH_ST21_fail', LOCK_KEY = 'RH_ST21_lock', NOTE_KEY = 'RH_ST21_note';

var DIRECT = 'DIRECT', RU = 'RH-RU', MAIN = 'RH-Главный', BYP = 'RH-Обход';
var CLOCK = 'RH-Часы', TEST = 'RH-Тест-RU', DRU = 'RH-Прямо-RU';
var TARGETS = [DIRECT, RU, MAIN, CLOCK, TEST, DRU];
var NOW_OF = [RU, MAIN];             // следим за now
var ALIVE_OF = [DIRECT, DRU];        // следим за alive
var PROFILE_NEW = [CLOCK];           // профиль S-draft-9
var WATCH_OV = [TEST, DRU];          // override RouteHub-Stash-Watch

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

// ── ЗАПРОСЫ: ТОЛЬКО GET /proxies/{имя} ─────────────────────────────────
// Другого метода и другого пути в пробе нет: /delay не строится вовсе.
function getProxy(name, cb) {
  var o = { url: CTRL + '/proxies/' + encodeURIComponent(name), timeout: CTRL_SEC, headers: {} };
  if (AUTH) o.headers.Authorization = AUTH;
  var done = false;
  function once(r) { if (done) return; done = true; cb(r); }
  function call(retry) {
    try {
      G.$httpClient.get(o, function (e, r, data) {
        var st = r ? (r.status || r.statusCode || null) : null;
        // Один повтор при обрыве (EOF, ST18), если бюджет позволяет.
        if (st === null && !retry && !FINISHED && room()) {
          return setTimeout(function () { call(true); }, 1000);
        }
        once({ status: st, error: e ? String(e).slice(0, 80) : null, body: data ? String(data) : '', повтор: retry });
      });
    } catch (e2) { once({ status: null, error: 'throw: ' + String(e2).slice(0, 80), body: '', повтор: retry }); }
  }
  call(false);
}

function json(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function valid(v) { return typeof v === 'string' && v.length > 0; }
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function iso(ms) { return new Date(ms).toISOString().slice(0, 19) + 'Z'; }
function cap(list, n) { if (list.length > n) list.splice(0, list.length - n); }

// Из ответа — только поля, нужные выводу. Нет поля — null («нет данных»).
function pick(r) {
  if (r.status === 404) return { есть: false };
  var j = r.status === 200 ? json(r.body) : null;
  if (!j || typeof j !== 'object') return null;
  var s = { есть: true, alive: typeof j.alive === 'boolean' ? j.alive : null, now: valid(j.now) ? j.now : null,
            h: null, hn: null };
  if (j.history instanceof Array) {
    s.hn = j.history.length;
    var L = j.history[j.history.length - 1];
    if (L && typeof L === 'object') s.h = { t: valid(L.time) ? L.time : null, d: num(L.delay) };
  }
  if (j.all instanceof Array) s.all = j.all.filter(valid);
  return s;
}

// ── ХРАНИЛИЩЕ ───────────────────────────────────────────────────────────
function sread(k) { try { return G.$persistentStore.read(k); } catch (e) { return null; } }
function swrite(v, k) { try { return G.$persistentStore.write(v, k) !== false; } catch (e) { return false; } }

function lockTake() {
  var v = Number(String(sread(LOCK_KEY) || '').split(':')[0]) || 0, now = Date.now();
  if (v && now >= v && now - v < LOCK_MS) return false;
  OWN_VAL = now + ':' + Math.floor(Math.random() * 1e9);
  OWN_LOCK = swrite(OWN_VAL, LOCK_KEY);
  return true;
}
function lockMine() { return OWN_LOCK && sread(LOCK_KEY) === OWN_VAL; }

function fresh(ms) {
  return { v: 1, t0: ms, lastMs: 0, прогонов: 0, прев: {}, обход: null, ушла: {}, журнал: [],
           счёт: { ушла: {}, вернулась: {}, наОбходеМакс: {}, падений: {}, подъёмов: {}, замеров: {} },
           ноты: { первая: false, ms: 0 } };
}
function load() {
  var s = json(sread(KEY));
  if (!s || s.v !== 1 || !s.t0 || !s.прев || !(s.журнал instanceof Array)) return null;
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

// ── ПЕРЕХОДЫ ────────────────────────────────────────────────────────────
function inc(o, k) { o[k] = (o[k] || 0) + 1; }
function log(e) { S.журнал.push(e); cap(S.журнал, CAP); }

// Новая запись history между двумя удачными чтениями: true / false / null.
// null — «нет данных»: поля history нет в одном из двух ответов.
function newHist(p, c) {
  if (!p || !c || p.hn === null || c.hn === null) return null;
  var pt = p.h && p.h.t, ct = c.h && c.h.t;
  if (ct && pt) return ct !== pt;
  if (c.h && !p.h) return true;          // появилась первая запись
  if (!c.h) return false;                // история пуста
  return c.hn !== p.hn ? true : null;    // времени в записи нет
}

// Подряд идущие замеры одной цели с тем же исходом — одной записью.
function logHist(g, c, ms) {
  var ok = c.h && c.h.d !== null ? c.h.d > 0 : null;
  for (var i = S.журнал.length - 1; i >= 0; i--) {
    var e = S.журнал[i];
    if (e.г !== g) continue;
    if (e.вид === 'замер' && e.ок === ok) { e.n++; e.до = iso(ms); e.d = c.h.d; e.t = c.h.t; return; }
    break;
  }
  log({ вид: 'замер', г: g, от: iso(ms), до: iso(ms), n: 1, ок: ok, d: c.h ? c.h.d : null, t: c.h ? c.h.t : null });
}

function compare(snap, ms) {
  var P = S.прев, C = S.счёт;
  TARGETS.forEach(function (g) {
    var c = snap[g], p = P[g];
    if (!c || !c.есть) return;
    var nh = p && p.есть ? newHist(p, c) : null;
    if (nh === true) { inc(C.замеров, g); logHist(g, c, ms); }
    if (!p || !p.есть) return;
    if (NOW_OF.indexOf(g) >= 0 && valid(p.now) && valid(c.now) && p.now !== c.now) {
      var e = { вид: 'выбор', г: g, t: iso(ms), было: p.now, стало: c.now, окно_с: Math.round((ms - S.lastMs) / 1000) };
      if (p.now === DIRECT) { S.ушла[g] = ms; inc(C.ушла, g); NOTE_WHY.push(g + ' ушла с DIRECT на ' + c.now); }
      if (c.now === DIRECT) {
        inc(C.вернулась, g);
        if (S.ушла[g]) {
          e.наОбходе_с = Math.round((ms - S.ушла[g]) / 1000);
          C.наОбходеМакс[g] = Math.max(C.наОбходеМакс[g] || 0, e.наОбходе_с);
          S.ушла[g] = 0;
        }
      }
      log(e);
    }
    if (ALIVE_OF.indexOf(g) >= 0 && typeof p.alive === 'boolean' && typeof c.alive === 'boolean' && p.alive !== c.alive) {
      var fall = !c.alive;
      var how = nh === true ? 'замер' : nh === false ? 'без замера' : 'нет данных';
      var sign = fall
        ? (nh === true ? 'плановый замер' : nh === false ? 'событие (dial?)' : 'не различить')
        : (nh === true ? 'замер' : nh === false ? 'без замера' : 'не различить');
      inc(fall ? C.падений : C.подъёмов, g + ': ' + how);
      log({ вид: 'alive', г: g, t: iso(ms), было: p.alive, стало: c.alive, history: how, признак: sign,
            d: c.h ? c.h.d : null });
    }
  });
}

function bypassSig(list) {
  var a = 0, d = 0, n = 0;
  list.forEach(function (x) { if (x.alive === true) a++; else if (x.alive === false) d++; else n++; });
  return { живы: a, мертвы: d, нет_данных: n, всего: list.length };
}

function markers(ms) {
  var f = json(sread(FAIL_KEY));
  if (f && f.n > 0) {
    if (S.lastMs) log({ вид: 'окно', от: iso(S.lastMs), до: iso(ms), прогонов: f.n });
    swrite('{}', FAIL_KEY);
  }
}

// ── ВЫВОД ───────────────────────────────────────────────────────────────
function cur(snap) {
  var o = {};
  TARGETS.forEach(function (g) {
    var c = snap[g];
    if (!c) { o[g] = 'не прочитано'; return; }
    if (!c.есть) { o[g] = WATCH_OV.indexOf(g) >= 0 ? 'нет данных (override Watch не стоит)' : 'нет в профиле'; return; }
    var x = { alive: c.alive === null ? 'нет данных' : c.alive };
    if (c.now) x.now = c.now;
    x.history = c.hn === null ? 'нет данных' : c.h ? { t: c.h.t, d: c.h.d, n: c.hn } : 'пусто';
    o[g] = x;
  });
  return o;
}

function verdict(snap) {
  var C = S.счёт, min = Math.round((S.lastMs - S.t0) / 6000) / 10;
  var ru = (C.ушла[RU] || 0), back = (C.вернулась[RU] || 0);
  var falls = 0, dial = 0;
  for (var k in C.падений) {
    if (k.indexOf(DIRECT + ':') !== 0) continue;
    falls += C.падений[k];
    if (k === DIRECT + ': без замера') dial += C.падений[k];
  }
  var s = 'ST21 ' + min + ' мин: RH-RU ушла ' + ru + ', вернулась ' + back;
  if (C.наОбходеМакс[RU]) s += ' (макс на обходе ' + C.наОбходеМакс[RU] + ' с)';
  s += '; DIRECT alive падал ' + falls + ' (без замера ' + dial + ')';
  if (snap[DIRECT] && snap[DIRECT].есть && snap[DIRECT].alive === null) s += '; alive у DIRECT: нет данных';
  return s;
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
      A.журнал = S.журнал.slice(-40);
      A.счёт = S.счёт;
      A.прогонов = S.прогонов;
      A.t0 = iso(S.t0);
      color = '#34C759';
    }
    lines = [A.ВЕРДИКТ || 'ST21: прогон прерван'];
    if (A.профиль) lines.push(A.профиль);
    if (A.watch) lines.push(A.watch);
    if (A.обход) lines.push('обход: живы ' + A.обход.живы + ', мертвы ' + A.обход.мертвы + ', нет данных ' + A.обход.нет_данных);
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
      var body = (NOTE_WHY.length ? 'повод: ' + NOTE_WHY.join('; ') + '\n' : '') + lines.slice(1).join('\n');
      $notification.post('RouteHub ' + REV, lines[0], body, { clipboard: JSON.stringify(rep) });
    } catch (e3) {}
  }
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'), icon: 'eye', backgroundColor: color });
  } catch (e4) { try { $done(); } catch (e5) {} }
}

// cron: первый запуск и уход с DIRECT — не чаще раза в 10 мин; плитка — всегда.
function notePolicy() {
  var N = S.ноты, now = Date.now();
  if (!N.первая) { N.первая = true; NOTE_WHY.unshift('запуск'); return; }
  // Окно 10 мин — между уведомлениями об уходе; «запуск» его не открывает.
  if (!NOTE_WHY.length) return;
  if (!TILE && now - (N.ms || 0) < NOTE_GAP_MS) NOTE_WHY = [];
  else N.ms = now;
}

function missNote() {
  if (TILE) return;
  var n = Number(sread(NOTE_KEY)) || 0;
  if (Date.now() - n >= MISS_GAP_MS) { NOTE_WHY.push('нет групп RouteHub'); swrite(String(Date.now()), NOTE_KEY); }
}

// ── ГЛАВНАЯ ЦЕПОЧКА ─────────────────────────────────────────────────────
function readAll(names, snap, cb) {
  var i = 0;
  (function next() {
    if (FINISHED) return;
    if (i >= names.length) return cb();
    if (!room()) { rep.err.push('бюджет: не прочитано ' + (names.length - i)); return cb(); }
    var n = names[i++];
    getProxy(n, function (r) {
      snap[n] = pick(r);
      if (!snap[n]) A.отказы = (A.отказы || []).concat([n + ': ' + (r.status || r.error)]);
      next();
    });
  })();
}

function main() {
  if (!lockTake()) {
    A.ВЕРДИКТ = 'ЗАНЯТО: идёт другой прогон ST21' + (TILE ? ' — нажмите через 10–20 с' : '');
    return finish();
  }
  var snap = {};
  readAll(TARGETS, snap, function () {
    var ok = TARGETS.filter(function (g) { return snap[g]; });
    if (!ok.length) { failRun('все чтения: ' + (A.отказы || []).slice(0, 2).join(', ')); return finish(); }
    if (!(snap[RU] && snap[RU].есть) && !(snap[MAIN] && snap[MAIN].есть)) {
      A.ВЕРДИКТ = 'НЕТ RH-RU И RH-Главный — активен не профиль стенда RouteHub. Журнал не тронут';
      missNote();
      return finish();
    }
    var miss = PROFILE_NEW.filter(function (g) { return snap[g] && !snap[g].есть; });
    if (miss.length) A.профиль = 'нет ' + miss.join(', ') + ' — профиль стенда не обновлён до S-draft-9';
    // Пара RH-Тест-RU / RH-Прямо-RU — из отдельного override: без него это не
    // сбой, а «нет данных» (override не поставлен или Stash его отверг).
    var noOv = WATCH_OV.filter(function (g) { return snap[g] && !snap[g].есть; });
    if (noOv.length) A.watch = 'нет ' + noOv.join(', ') + ' — override Watch не стоит: RH-Прямо-RU нет данных';
    var byp = {};
    readAll([BYP], byp, function () {
      // DIRECT в RH-Обход — заглушка профиля при подписке без обхода, не узел.
      var members = byp[BYP] && byp[BYP].all
        ? byp[BYP].all.filter(function (n) { return n !== DIRECT && n !== 'REJECT'; }).slice(0, BYP_MAX) : [];
      readAll(members, byp, function () {
        var ms = Date.now();
        S = load() || fresh(ms);
        markers(ms);
        compare(snap, ms);
        var list = members.filter(function (n) { return byp[n] && byp[n].есть; })
          .map(function (n) { return { имя: n, alive: byp[n].alive, d: byp[n].h ? byp[n].h.d : null, t: byp[n].h ? byp[n].h.t : null }; });
        if (members.length) {
          A.обход = bypassSig(list);
          A.обход.now = byp[BYP].now;
          A.обход.узлы = list;
          var sig = A.обход.живы + '/' + A.обход.мертвы + '/' + A.обход.нет_данных;
          if (S.обход !== null && S.обход !== sig) log({ вид: 'обход', t: iso(ms), было: S.обход, стало: sig });
          S.обход = sig;
        }
        TARGETS.forEach(function (g) { if (snap[g]) S.прев[g] = snap[g].есть ? { есть: true, alive: snap[g].alive, now: snap[g].now, h: snap[g].h, hn: snap[g].hn } : { есть: false }; });
        S.lastMs = ms;
        S.прогонов++;
        notePolicy();
        A.сейчас = cur(snap);
        A.ВЕРДИКТ = verdict(snap);
        SAVE = true;
        finish();
      });
    });
  });
}

GUARD = setTimeout(function () {
  if (FINISHED) return;
  rep.err.push('сторож: цепочка не завершилась');
  if (!SAVE && OWN_LOCK) failRun('сторож');
  finish();
}, GUARD_MS);

if (typeof G.$httpClient === 'undefined') {
  rep.err.push('нет $httpClient');
  finish();
} else {
  main();
}
// конец файла — хвостовой страж (вывод 49)
