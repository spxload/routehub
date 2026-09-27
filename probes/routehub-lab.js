/*
 * RouteHub — ПРОБА STASH ST22. Группы-слоты на поставщике прокси: порядок,
 * фоновое обновление узлов, сброс выбора. На МУЛЯЖАХ, без трафика.
 * ===========================================================================
 * ЗАЧЕМ. Экран Stash «Ресурсы» (27.09): интервал обновления профиля работает,
 * только пока Stash на переднем плане; в фоне при включённом VPN обновляются
 * лишь наборы правил и поставщики прокси. Узлы у нас вшиты в профиль
 * (S-draft-4): провайдер сменил узлы — вне дома интернета нет до ручного
 * открытия Stash. Идея «группа-слот»: на каждый узел — select `use:
 * [поставщик]` + `filter: '^<имя>$'`, а -W/-C — fallback из групп-слотов в
 * нужном порядке. Порядок держит профиль, узлы освежает поставщик в фоне.
 *
 * ЧТО ПРОВЕРЯЕТ (тестовые группы и поставщик — секции override Lab):
 *   п1. RH-Т22-Фильтр (select, use + filter по всем именам): чей порядок в
 *       `.all` — поставщика (стенд отдаёт метку, 3, 2, 1) или фильтра (1, 2, 3).
 *   п2. RH-Т22-С1..С3 (select, один член через filter): что в `.all`;
 *       RH-Т22-F (fallback [С1, С2, С3]): `.all` = порядок перечисления?
 *   п3. Обновляется ли поставщик rh-t22 в фоне: имя метки
 *       RH-Т22-Метка-<номер минуты> меняет стенд, то есть метка говорит, В
 *       КАКУЮ минуту Stash скачал файл. Чтений в фоне вывод НЕ требует:
 *       контроллер в фоне отдаёт EOF окнами до 30+ мин (ST20; ST21 —
 *       06:46–07:19 UTC, 33 мин). Вывод — по первому удачному чтению ПОСЛЕ
 *       пропуска ≥ 10 мин. Время скачивания берётся из updatedAt поставщика,
 *       если поле есть, иначе — из метки (конец её минуты): позже прошлого
 *       удачного чтения и раньше этого чтения больше чем на 2 мин (FG_MS) —
 *       «в фоне»; не позже прошлого чтения (или метка та же) — «не
 *       обновлялся»; свежее — «не различить» (могло обновиться при открытии
 *       Stash). Время прошлого удачного чтения поставщика — в состоянии.
 *   п4. Сбрасывает ли обновление поставщика выбор select (Фильтр → RH-Т22-2)
 *       и закрепление fallback (F → С2): оба — НЕ первый член ни в одном
 *       порядке, иначе закрепление неотличимо от умолчания. После сброса —
 *       закрепляет снова.
 *   п5. Что отдаёт GET /providers/proxies/rh-t22: состав, vehicleType,
 *       updatedAt (нет поля — «нет данных»).
 *
 * ЗАПРОСЫ. GET /proxies/{группа Т22} и GET /providers/proxies/rh-t22; PUT
 * /proxies/{группа} — ТОЛЬКО в RH-Т22-Фильтр и RH-Т22-F (WRITABLE, проверка
 * в write()). Боевые группы не читаются и не пишутся (правило 2). /delay,
 * DELETE, POST, PATCH нет. Узлы поставщика — муляжи TEST-NET (192.0.2.x,
 * порт 1): обходных узлов в нём нет (правило 1).
 *
 * ЖУРНАЛ ($persistentStore, RH_ST22) — только переходы: смена метки /
 * updatedAt поставщика, сброс и закрепление, отказ записи, окна
 * недоступности контроллера. ВЫГРУЗКА — в журнал скрипта одной строкой JSON
 * (console.log «[ST22] {…}»); опция clipboard у $notification.post на
 * устройстве не работает (27.09, в stash.wiki у post только title, subtitle,
 * body) и не используется. Уведомление — короткий итог: плитка — всегда,
 * cron — о первом запуске и первом сбросе каждой группы (не чаще раза в
 * 10 мин).
 *
 * ВРЕМЯ. timeout $httpClient у Stash — в СЕКУНДАХ. Запрос начинается, только
 * если бюджета хватает (room); сторож 75 с позже бюджета 45 с (setTimeout в
 * фоне растягивается в 3–4 раза, ST14). Ровно один $done. Замок RH_ST22_lock
 * не даёт cron и плитке писать журнал одновременно.
 */

var REV = 'ST22';
var T0 = Date.now();

var BUDGET_MS = 45000;
var GUARD_MS = 75000;
var CTRL_SEC = 5;                    // Stash: секунды, не миллисекунды
var STEP_MS = (CTRL_SEC + 1) * 1000;
var LOCK_MS = 310000;                // дольше timeout cron (300 с)
var NOTE_GAP_MS = 10 * 60000;
var MISS_GAP_MS = 6 * 3600000;
var STALE_MS = 48 * 3600000;
var WIN_MS = 60000;                  // окно метки стенда — минута (/lab/t22-nodes)
var GAP_MS = 10 * 60000;             // пропуск удачных чтений поставщика — «после возврата»
var FG_MS = 2 * 60000;               // файл скачан раньше чтения больше чем на столько — «в фоне»
var BG_KEEP = 10;                    // выводов о пропусках в состоянии
var CAP = 80;                        // записей журнала в состоянии
var KEY = 'RH_ST22', FAIL_KEY = 'RH_ST22_fail', LOCK_KEY = 'RH_ST22_lock', NOTE_KEY = 'RH_ST22_note';

var PROV = 'rh-t22';
var P = 'RH-Т22-';
var N1 = P + '1', N2 = P + '2', N3 = P + '3';
var MARK = P + 'Метка-';
var FILT = P + 'Фильтр', S1 = P + 'С1', S2 = P + 'С2', S3 = P + 'С3', FB = P + 'F';
var SLOTS = [S1, S2, S3];
var SLOT_NODE = {};
SLOT_NODE[S1] = N1; SLOT_NODE[S2] = N2; SLOT_NODE[S3] = N3;
var GROUPS = [FILT, S1, S2, S3, FB];
var BY_FILTER = [N1, N2, N3];        // порядок альтернатив в filter override
var BY_PROVIDER = [N3, N2, N1];      // порядок выдачи стенда
var PIN = {};
PIN[FILT] = N2;
PIN[FB] = S2;
var WRITABLE = {};
WRITABLE[FILT] = 1;
WRITABLE[FB] = 1;

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

// ── ЗАПРОСЫ ─────────────────────────────────────────────────────────────
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

// Единственная запись пробы. Вне WRITABLE (тестовые группы Т22) — отказ без
// запроса. Запись не повторяется.
function write(group, name, cb) {
  if (!WRITABLE.hasOwnProperty(group)) {
    rep.err.push('запись вне тестовых групп запрещена: ' + group);
    return cb({ status: null, error: 'отказ пробы' });
  }
  var o = opts(gp(group)), done = false;
  o.headers['Content-Type'] = 'application/json';
  o.body = JSON.stringify({ name: name });
  function once(r) { if (done) return; done = true; cb(r); }
  try {
    G.$httpClient.put(o, function (e, r) {
      once({ status: r ? (r.status || r.statusCode || null) : null, error: e ? String(e).slice(0, 80) : null });
    });
  } catch (e2) { once({ status: null, error: 'throw: ' + String(e2).slice(0, 80) }); }
}

function gp(name) { return '/proxies/' + encodeURIComponent(name); }
function json(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function valid(v) { return typeof v === 'string' && v.length > 0; }
function iso(ms) { return new Date(ms).toISOString().slice(0, 19) + 'Z'; }
function cap(list, n) { if (list.length > n) list.splice(0, list.length - n); }
function same(a, b) { return a.length === b.length && a.every(function (x, i) { return x === b[i]; }); }
function stable(list) { return list.filter(function (n) { return BY_FILTER.indexOf(n) >= 0; }); }
function markOf(list) {
  for (var i = 0; i < list.length; i++) if (list[i].indexOf(MARK) === 0) return list[i];
  return null;
}
function winOf(mark) {
  var m = mark ? /^(\d+)$/.exec(mark.slice(MARK.length)) : null;
  return m ? Number(m[1]) : null;
}

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
  var list = j.proxies instanceof Array ? j.proxies.map(function (q) {
    return q && typeof q === 'object' ? q.name : q;
  }).filter(valid) : null;
  var mark = list ? markOf(list) : null;
  return { есть: true, узлы: list, метка: mark, окно: winOf(mark),
           upd: valid(j.updatedAt) ? j.updatedAt : null, vt: valid(j.vehicleType) ? j.vehicleType : null };
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

function fresh(ms) {
  return { v: 1, t0: ms, lastMs: 0, прогонов: 0, прев: null, pin: {}, журнал: [], отставаниеМакс: null,
           счёт: { обновлений: 0, закреплений: {}, сбросов: {}, пережило: {} },
           фон: [], фонСчёт: { в_фоне: 0, не_обновлялся: 0, не_различить: 0 },
           ноты: { первая: false, ms: 0, сброс: {} } };
}
function load() {
  var s = json(sread(KEY));
  if (!s || s.v !== 1 || !s.t0 || !s.pin || !(s.журнал instanceof Array) || !(s.фон instanceof Array)) return null;
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

function inc(o, k) { o[k] = (o[k] || 0) + 1; }
function log(e) { S.журнал.push(e); cap(S.журнал, CAP); }

function markers(ms) {
  var f = json(sread(FAIL_KEY));
  if (f && f.n > 0) {
    if (S.lastMs) log({ вид: 'окно', от: iso(S.lastMs), до: iso(ms), прогонов: f.n });
    swrite('{}', FAIL_KEY);
  }
}

// ── РАЗБОР ──────────────────────────────────────────────────────────────
// п1: чей порядок в группе use + filter. Опора — порядок, который отдал сам
// поставщик (если прочитан), иначе ожидаемый порядок стенда.
function orderOf(list, prov) {
  if (!list) return 'нет данных';
  var s = stable(list), q = prov && prov.узлы ? stable(prov.узлы) : BY_PROVIDER;
  if (s.length < BY_FILTER.length) return 'неполный состав: ' + (s.join(', ') || 'пусто');
  if (same(q, BY_FILTER)) return 'не различить: поставщик отдал порядок фильтра';
  if (same(s, q)) return 'поставщика';
  if (same(s, BY_FILTER)) return 'фильтра';
  return 'иной: ' + s.join(', ');
}

// Отставание метки: сколько минут назад она уже устарела (0 — свежая).
function lagMin(prov, ms) {
  if (!prov || prov.окно === null) return null;
  return Math.max(0, Math.floor((ms - (prov.окно + 1) * WIN_MS) / 60000));
}

function answers(snap, ms) {
  var g = snap.g, prov = snap.prov, o = {};
  var f = g[FILT];
  o.п1_порядок = f && f.есть ? orderOf(f.all, prov) : 'нет группы ' + FILT;
  if (f && f.есть && f.all) {
    var gm = markOf(f.all);
    o.п1_метка_в_группе = !gm ? 'нет' : prov && prov.метка ? (gm === prov.метка ? 'та же, что у поставщика' : 'другая: ' + gm) : gm;
  }
  o.п2_слоты = {};
  SLOTS.forEach(function (s) {
    var x = g[s];
    if (!x || !x.есть) { o.п2_слоты[s] = x ? 'нет группы' : 'не прочитано'; return; }
    if (!x.all) { o.п2_слоты[s] = 'нет данных'; return; }
    o.п2_слоты[s] = same(x.all, [SLOT_NODE[s]]) ? 'один член, now ' + (x.now || 'нет данных')
      : (x.all.length ? 'состав: ' + x.all.join(', ') : 'пусто');
  });
  var fb = g[FB];
  o.п2_fallback = !fb || !fb.есть ? 'нет группы' : !fb.all ? 'нет данных'
    : same(fb.all, SLOTS) ? 'порядок перечисления' : 'иной: ' + fb.all.join(', ');
  if (!prov || !prov.есть) o.п5_поставщик = prov ? 'нет поставщика ' + PROV : 'не прочитано';
  else o.п5_поставщик = { узлы: prov.узлы || 'нет данных', updatedAt: prov.upd || 'нет данных',
                         vehicleType: prov.vt || 'нет данных', отстаёт_мин: lagMin(prov, ms) };
  return o;
}

// п3 после пропуска: скачан ли файл, пока удачных чтений не было.
// p — прошлое удачное чтение поставщика. null — вывода нет (пропуска нет или
// метки нет в одном из чтений).
// Источник времени скачивания: updatedAt (точное), иначе конец минуты метки
// (скачан не позже). Метка та же — «не обновлялся» без расчёта.
function gapVerdict(p, prov, ms) {
  if (!p || ms - p.ms < GAP_MS) return null;
  var u = prov.upd ? Date.parse(prov.upd) : NaN, by, at, v;
  if (isFinite(u)) { by = 'updatedAt'; at = u; }
  else if (valid(p.метка) && prov.окно !== null) { by = 'метке'; at = (prov.окно + 1) * WIN_MS; }
  else return null;
  if (by === 'метке' && prov.метка === p.метка) v = 'не_обновлялся';
  else if (at <= p.ms) v = 'не_обновлялся';
  else v = at <= ms - FG_MS ? 'в_фоне' : 'не_различить';
  return { вывод: v, по: by, t: iso(ms), пропуск_мин: Math.round((ms - p.ms) / 60000), прошлое_чтение: iso(p.ms),
           было: p.метка, стало: prov.метка, скачан_мин_назад: Math.round((ms - at) / 60000),
           upd: prov.upd || 'нет данных' };
}

// п3: смена метки или updatedAt между двумя удачными чтениями — обновление.
// Неудачное чтение (EOF) — не чтение: S.прев не трогается.
function provUpdate(prov, ms) {
  if (!prov || !prov.есть) return false;
  var p = S.прев, lag = lagMin(prov, ms);
  if (lag !== null && (S.отставаниеМакс === null || lag > S.отставаниеМакс)) S.отставаниеМакс = lag;
  var cur = { метка: prov.метка, upd: prov.upd, ms: ms };
  S.прев = cur;
  if (!p) return false;
  var gv = gapVerdict(p, prov, ms);
  if (gv) {
    S.фонСчёт[gv.вывод]++;
    S.фон.push(gv);
    cap(S.фон, BG_KEEP);
    log({ вид: 'пропуск', t: gv.t, вывод: gv.вывод, по: gv.по, пропуск_мин: gv.пропуск_мин, было: gv.было, стало: gv.стало });
  }
  var byMark = valid(p.метка) && valid(prov.метка) && p.метка !== prov.метка;
  var byUpd = valid(p.upd) && valid(prov.upd) && p.upd !== prov.upd;
  if (!byMark && !byUpd) return false;
  S.счёт.обновлений++;
  log({ вид: 'поставщик', t: iso(ms), было: p.метка, стало: prov.метка, upd: prov.upd || 'нет данных',
        по: byMark ? 'метке' : 'updatedAt', отстаёт_мин: lag, с_прошлого_с: Math.round((ms - p.ms) / 1000) });
  for (var k in S.pin) if (S.pin[k]) S.pin[k].обн++;
  return true;
}

// п4: держится ли закрепление; сброс — с обновлением поставщика или без.
// Возвращает список групп, которые надо закрепить (заново).
function checkPins(snap, upd, ms) {
  var need = [];
  [FILT, FB].forEach(function (g) {
    var x = snap.g[g];
    if (!x || !x.есть) return;
    var pin = S.pin[g];
    if (pin && valid(x.now) && x.now !== pin.to) {
      inc(S.счёт.сбросов, g + (upd === null ? ': поставщик не прочитан' : upd ? ': с обновлением поставщика' : ': без обновления поставщика'));
      log({ вид: 'сброс', г: g, t: iso(ms), было: pin.to, стало: x.now, держалось_с: Math.round((ms - pin.ms) / 1000),
            обновлений_за_время: pin.обн, в_этом_окне: upd });
      if (!S.ноты.сброс[g]) { S.ноты.сброс[g] = true; NOTE_WHY.push('сброс ' + g + ' → ' + x.now); }
      S.pin[g] = null;
      pin = null;
    } else if (pin && x.now === pin.to && upd) inc(S.счёт.пережило, g);
    if (!pin) need.push(g);
  });
  return need;
}

function pinAll(list, snap, cb) {
  var i = 0;
  (function next() {
    if (FINISHED) return;
    if (i >= list.length) return cb();
    var g = list[i++], to = PIN[g], x = snap.g[g];
    if (!x.all || x.all.indexOf(to) < 0) { A.не_закреплено = (A.не_закреплено || []).concat([g + ': нет ' + to + ' в составе']); return next(); }
    if (!room()) { rep.err.push('бюджет: не закреплено ' + g); return next(); }
    write(g, to, function (r) {
      var ms = Date.now();
      if (r.status === 204 || r.status === 200) {
        S.pin[g] = { to: to, ms: ms, обн: 0 };
        inc(S.счёт.закреплений, g);
        log({ вид: 'закреплено', г: g, t: iso(ms), на: to });
      } else log({ вид: 'запись', г: g, t: iso(ms), статус: r.status, ошибка: r.error });
      next();
    });
  })();
}

// ── ВЫВОД ───────────────────────────────────────────────────────────────
function verdict(o) {
  var C = S.счёт, min = Math.round((S.lastMs - S.t0) / 6000) / 10;
  var s = 'ST22 ' + min + ' мин: порядок — ' + o.п1_порядок + '; F — ' + o.п2_fallback;
  s += '; поставщик обновлялся ' + C.обновлений;
  if (S.отставаниеМакс !== null) s += ' (метка отставала до ' + S.отставаниеМакс + ' мин)';
  var F = S.фонСчёт;
  s += '; после пропусков: в фоне ' + F.в_фоне + ', не обновлялся ' + F.не_обновлялся + ', не различить ' + F.не_различить;
  var r = [];
  for (var k in C.сбросов) r.push(k.replace(P, '') + ' ' + C.сбросов[k]);
  s += '; сбросы: ' + (r.length ? r.join(', ') : 'нет');
  var h = [];
  for (var q in C.пережило) h.push(q.replace(P, '') + ' ' + C.пережило[q]);
  if (h.length) s += '; пережило обновлений: ' + h.join(', ');
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
    lines = [A.ВЕРДИКТ || 'ST22: прогон прерван'];
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
        (TILE ? '\nполная выгрузка — журнал скрипта, строка [ST22]' : '');
      $notification.post('RouteHub ' + REV, lines[0], body);
    } catch (e3) {}
  }
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'), icon: 'eye', backgroundColor: color });
  } catch (e4) { try { $done(); } catch (e5) {} }
}

// cron: первый запуск и первый сброс группы — не чаще раза в 10 мин; плитка — всегда.
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
  if (Date.now() - n >= MISS_GAP_MS) { NOTE_WHY.push('нет групп Т22'); swrite(String(Date.now()), NOTE_KEY); }
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
    // Замок снимается в конце прогона; LOCK_LEFT — худший срок (истечение).
    A.ВЕРДИКТ = 'ЗАНЯТО: идёт другой прогон ST22' + (TILE ? ' — замок снимется не позже чем через ' + LOCK_LEFT + ' с' : '');
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
    if (!have.length && !(snap.prov && snap.prov.есть)) {
      A.ВЕРДИКТ = 'НЕТ ГРУПП Т22 И ПОСТАВЩИКА — override Lab не обновлён (нажать «обновить»). Журнал не тронут';
      missNote();
      return finish();
    }
    var ms = Date.now();
    S = load() || fresh(ms);
    markers(ms);
    // null — поставщик в этом прогоне не прочитан (EOF): сброс не приписываем.
    var upd = snap.prov && snap.prov.есть ? provUpdate(snap.prov, ms) : null;
    var need = checkPins(snap, upd, ms);
    A.ответы = answers(snap, ms);
    A.сейчас = {};
    GROUPS.forEach(function (g) { var x = snap.g[g]; A.сейчас[g] = !x ? 'не прочитано' : !x.есть ? 'нет' : { now: x.now, all: x.all }; });
    pinAll(need, snap, function () {
      S.lastMs = ms;
      S.прогонов++;
      notePolicy();
      A.ответы.п4_закрепление = { закреплений: S.счёт.закреплений, сбросов: S.счёт.сбросов, пережило_обновлений: S.счёт.пережило };
      A.ответы.п3_фон = { обновлений: S.счёт.обновлений, отставание_макс_мин: S.отставаниеМакс,
        после_пропусков: S.фонСчёт, последний: S.фон.length ? S.фон[S.фон.length - 1] : 'пропусков ≥ 10 мин не было',
        прошлое_чтение: S.прев ? iso(S.прев.ms) : 'нет данных' };
      A.ВЕРДИКТ = verdict(A.ответы);
      SAVE = true;
      finish();
    });
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
