/*
 * RouteHub — ПРОБА STASH ST20. Почему сбрасывается закрепление fallback/url-test.
 * ===========================================================================
 * ЗАЧЕМ. ST19 (25.09): `PUT /proxies/{группа}` закрепил член fallback и
 * url-test, но к следующему удачному чтению (~25 мин) закрепление снято. В том
 * же окне сменилась сеть и ~20 мин молчал контроллер, а у групп был interval
 * 60 — причин-кандидатов несколько, опыт их не различал. ST20 различает:
 *   1. периодическая проверка здоровья (interval) — пара F30 / F3600: одна и
 *      та же fallback [Прямо1, Прямо2], закрепление на Прямо2 (не первый член,
 *      иначе закрепление неотличимо от автовыбора), interval 30 и 3600 с;
 *      U30 — то же для url-test;
 *   2. смена сети — метка по `now` боевой RH-AI (только чтение);
 *   3. перезапуск ядра / VPN — падение uploadTotal/downloadTotal из
 *      /connections и смена history[].time муляжа-«часов» (группа с interval
 *      86400 проверяется лишь при старте ядра), если Stash эти поля отдаёт;
 *   4. новое соединение через группу — Связь (fallback, interval 3600) в
 *      каждом прогоне: GET /proxies/Связь/delay и чтение `now` до и после;
 *   6. один провал закреплённого члена (так в mihomo findAliveProxy) —
 *      W = fallback [Прямо1, Ручной], закреплён на Ручном; проба на ~3 мин
 *      ставит Ручной на муляж и возвращает: вернулся ли W к Ручному.
 *      Контроль W0 = fallback [Прямо1, Прямо2] закрепляется в том же прогоне
 *      и не болеет: «не вернулся» засчитывается, только если W0 за то же окно
 *      не сброшен (иначе закрепление просто истекает — «не различить»);
 *   8. пересборка групп при обновлении профиля — «канарейка» select Метка,
 *      выставленная на второй член: откат на первый без падения счётчиков.
 * Окна недоступности контроллера — отдельная метка (прогоны с отказом).
 *
 * ОДИН СНИМОК ЗА ПРОГОН. cron раз в минуту; длинных таймеров нет. Выводы не
 * зависят от частоты: каждое удачное чтение сравнивается с предыдущим
 * удачным, метки собираются по окну между ними — при прогонах раз в 5 мин
 * окна шире, но смысл тот же. Время — Date.now(), состояние —
 * $persistentStore (RH_ST20). После каждого сброса группа закрепляется снова.
 * Неудачное чтение — не смена и не подтверждение; вывод только по удачным.
 *
 * ПЛИТКА — тот же скрипт: снимок + отметка «ручная точка». Stash запускает
 * плитку и сам (interval), признака нажатия в вики нет, поэтому точку
 * подтверждает второе нажатие в пределах минуты: только оно даёт уведомление
 * с полной выгрузкой в буфер. Ручная точка — своя причина-кандидат окна, не
 * «без меток». Ручные шаги Дианы видны по номеру точки и меткам её окна.
 *
 * УВЕДОМЛЕНИЯ cron — только при событии: первый запуск, первый сброс каждой
 * пары «группа — причина», «автоматическая часть готова» (когда решено всё
 * достижимое или не позже 1,5 ч), «сутки прошли». Не чаще раза в 10 мин.
 *
 * ПРАВИЛО 1. Узлов в тестовых группах нет: DIRECT, select-обёртки над DIRECT
 * и муляжи на адреса TEST-NET (192.0.2.1 / 192.0.2.2 — никуда не ведут).
 * Замер задержки — только через группу Связь (DIRECT).
 * ПРАВИЛО 2. Пишет только в RH-Т20-* из WRITABLE (проверка в write()).
 * RH-AI — только чтение. Из /proxies и /connections в выгрузку не идёт ничего,
 * кроме `now` тестовых групп, RH-AI и двух счётчиков байт.
 *
 * ВРЕМЯ. timeout $httpClient у Stash — в секундах. Шаг начинается, только
 * если бюджета хватает на всю его цепочку (room(n)); сторож 75 с позже
 * бюджета 45 с. Прогревочный GET / с одним повтором. Два прогона одновременно
 * (cron и плитка) не идут: замок RH_ST20_lock живёт дольше timeout cron;
 * прогон, чей замок истёк и перехвачен, состояние не сохраняет и чужой замок
 * не снимает.
 */

var REV = 'ST20';
var T0 = Date.now();

var BUDGET_MS = 45000;
var GUARD_MS = 75000;
var CTRL_SEC = 5;                    // Stash: секунды, не миллисекунды
var STEP_MS = (CTRL_SEC + 1) * 1000;
var HOLD_MS = 150000;                // W держит Ручной до болезни: ≥ 5 проверок по 30 с
var SICK_MS = 150000;                // Ручной на муляже: ≥ 5 проверок W
var REC_MS = 270000;                 // после выздоровления: ≥ 9 проверок W
var EXPO_MS = 20 * 60000;            // наблюдение закрепления для вывода об interval
var GAP_MS = 12 * 60000;             // пропуск между удачными снимками — метка
// Замок живёт дольше timeout cron (300 с): растянутый в фоне сторож (до 3–4×
// от 75 с) не должен отпустить замок, пока зависший прогон ещё жив.
var LOCK_MS = 310000;
var NOTE_GAP_MS = 10 * 60000;
var MISS_GAP_MS = 6 * 3600000;
var MAX_MS = 24 * 3600000;           // сутки — дальше только чтение
var STALE_MS = 48 * 3600000;         // старое состояние — начать заново
var ROUNDS = 2;                      // раундов опыта с провалом (одиночный — не вывод)
var CONN_MIN = 3;                    // соединений через Связь для вывода
var FAIL_LIMIT = 5;                  // подряд неудачных закреплений — группа «отказ»
var CAP = 25;                        // событий и меток в состоянии (RH_ST20 < 16 КБ за сутки)
var READY_MAX_MS = 90 * 60000;       // «автоматическая часть» закрывается не позже 1,5 ч
var TILE_PAIR_MS = 60000;            // второе нажатие плитки в пределах минуты — подтверждение
var KEY = 'RH_ST20';
var FAIL_KEY = 'RH_ST20_fail';
var LOCK_KEY = 'RH_ST20_lock';
var NOTE_KEY = 'RH_ST20_note';
var TEST_URL = 'http://www.gstatic.com/generate_204';

var P = 'RH-Т20-';
var D1 = P + 'Прямо1';               // select: [DIRECT] — автовыбор fallback
var D2 = P + 'Прямо2';               // select: [DIRECT] — цель закрепления
var DUMMY = P + 'Муляж';             // socks5 192.0.2.1:1 — мёртв
var CLOCKD = P + 'Муляж2';           // socks5 192.0.2.2:1 — только в «Часах»
var F30 = P + 'F30';                 // fallback [Прямо1, Прямо2], interval 30
var F3600 = P + 'F3600';             // fallback [Прямо1, Прямо2], interval 3600
var U30 = P + 'U30';                 // url-test [Прямо1, Прямо2], interval 30
var CONN = P + 'Связь';              // fallback [Прямо1, Прямо2], interval 3600 + соединения
var W = P + 'W';                     // fallback [Прямо1, Ручной], interval 30
var W0 = P + 'W0';                   // fallback [Прямо1, Прямо2], interval 30 — контроль к W
var MANUAL = P + 'Ручной';           // select [DIRECT, Муляж]
var CANARY = P + 'Метка';            // select [Прямо1, Прямо2] — канарейка пересборки
var CLOCK = P + 'Часы';              // fallback [Муляж2], interval 86400
var REAL = 'RH-AI';                  // боевая — только чтение (метка сети)

var PINS = [F30, F3600, U30, CONN];
var ALL = [D1, D2, DUMMY, CLOCKD, F30, F3600, U30, CONN, W, W0, MANUAL, CANARY, CLOCK];
var TRACKED = [F30, F3600, U30, CONN, W, W0, MANUAL, CANARY];
var WRITABLE = {};
[F30, F3600, U30, CONN, W, W0, MANUAL, CANARY].forEach(function (g) { WRITABLE[g] = 1; });
var SHORT = {};
SHORT[F30] = 'F30'; SHORT[F3600] = 'F3600'; SHORT[U30] = 'U30'; SHORT[CONN] = 'Связь';
SHORT[W] = 'W'; SHORT[W0] = 'W0'; SHORT[MANUAL] = 'Ручной'; SHORT[CANARY] = 'Метка';
SHORT[D1] = 'Прямо1'; SHORT[D2] = 'Прямо2'; SHORT[DUMMY] = 'Муляж';

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
// Признак нажатия против автообновления плитки в вики Stash не описан:
// выгружаем, чем Stash запустил скрипт, — опыт покажет.
try {
  A.запуск = { тип: G.$script ? String(G.$script.type) : null,
    trigger: typeof G.$trigger === 'undefined' ? null : String(G.$trigger).slice(0, 40) };
} catch (e) {}
CTRL = String(CTRL).replace(/\/+$/, '');
A.тип = TILE ? 'плитка' : 'cron';

var LOCK_LEFT = 0, FINISHED = false, GUARD = null, OWN_LOCK = false, OWN_VAL = '', S = null, SNAPPED = false, PAIRED = false;
var RUN_EV = [], NOTE_WHY = [];
function left() { return BUDGET_MS - (Date.now() - T0); }
function room(n) { return left() > STEP_MS * n; }

// ── ЗАПРОСЫ ─────────────────────────────────────────────────────────────
function raw(method, path, body, cb) {
  var o = { url: CTRL + path, timeout: CTRL_SEC, headers: {} };
  if (AUTH) o.headers.Authorization = AUTH;
  if (body !== null && body !== undefined) {
    o.headers['Content-Type'] = 'application/json';
    o.body = JSON.stringify(body);
  }
  var t = Date.now(), done = false;
  function once(r) { if (done) return; done = true; r.ms = Date.now() - t; cb(r); }
  try {
    G.$httpClient[method](o, function (e, r, data) {
      once({ status: r ? (r.status || r.statusCode || null) : null, error: e ? String(e) : null,
             body: data ? String(data) : '' });
    });
  } catch (e2) { once({ status: null, error: 'throw: ' + String(e2), body: '' }); }
}

// Чтение с одним повтором при обрыве (EOF, ST18). Запись не повторяется.
function get(path, cb) {
  raw('get', path, null, function (r) {
    if (r.status !== null || FINISHED || !room(1)) return cb(r);
    setTimeout(function () {
      raw('get', path, null, function (r2) { r2.повтор = true; cb(r2); });
    }, 1000);
  });
}

function write(group, name, cb) {
  if (!WRITABLE.hasOwnProperty(group)) {
    rep.err.push('запись вне тестовых групп запрещена: ' + group);
    return cb({ status: null, error: 'отказ пробы', body: '' });
  }
  raw('put', gp(group), { name: name }, cb);
}

function gp(name) { return '/proxies/' + encodeURIComponent(name); }
function json(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function valid(v) { return typeof v === 'string' && v.length > 0; }
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function short(v) { return SHORT.hasOwnProperty(v) ? SHORT[v] : v; }
function sec(ms) { return Math.round((ms - S.t0) / 1000); }
function iso(ms) { return new Date(ms).toISOString().slice(0, 19) + 'Z'; }
function cap(list, n) { if (list.length > n) list.splice(0, list.length - n); }

function readNow(g, cb) {
  get(gp(g), function (r) {
    var j = r.status === 200 ? json(r.body) : null;
    cb(j && valid(j.now) ? j.now : null, Date.now());
  });
}

// ── ХРАНИЛИЩЕ ───────────────────────────────────────────────────────────
function sread(k) { try { return G.$persistentStore.read(k); } catch (e) { return null; } }
function swrite(v, k) { try { return G.$persistentStore.write(v, k) !== false; } catch (e) { return false; } }

function lockTake() {
  var v = Number(String(sread(LOCK_KEY) || '').split(':')[0]) || 0, now = Date.now();
  if (v && now >= v && now - v < LOCK_MS) {
    // Замок моложе минуты — живой прогон, освободится за секунды; старше —
    // прогон убит (например, перезапуском VPN), ждать до истечения замка.
    LOCK_LEFT = now - v < 60000 ? 0 : LOCK_MS - (now - v);
    return false;
  }
  OWN_VAL = now + ':' + Math.floor(Math.random() * 1e9);
  OWN_LOCK = swrite(OWN_VAL, LOCK_KEY);
  return true;
}
// Замок всё ещё наш: не истёк и не перехвачен другим прогоном.
function lockMine() { return OWN_LOCK && sread(LOCK_KEY) === OWN_VAL; }

// Прогон без удачного снимка ничего не решает, но оставляет след: следующий
// удачный прогон превратит его в метку «окно недоступности».
function failRun(why) {
  var f = json(sread(FAIL_KEY)) || {};
  f.n = (f.n || 0) + 1;
  f.first = f.first || Date.now();
  f.last = Date.now();
  swrite(JSON.stringify(f), FAIL_KEY);
  A.ВЕРДИКТ = 'КОНТРОЛЛЕР НЕ ОТВЕТИЛ (' + why + '). Ничего не записано';
}

function grp(target) {
  return { цель: target, стат: 'нов', было: null, посл: null, E: 0, H: 0, сбросов: 0, безМеток: 0,
           закреплений: 0, неВстало: 0, подряд: 0, окна: {} };
}
function fresh(ms) {
  var s = { v: 1, t0: ms, lastMs: 0, гр: {}, глоб: {}, марки: [], события: [], ручные: [], hist: [],
            W: { раунд: 1, фаза: 'закреп', раунды: [], болезнь: [], записи: [] },
            связь: { n: 0, сброс: 0, держит: 0, неясно: 0, ошибок: 0, тесты: [] },
            ноты: { первая: false, готово: false, итог: false, ms: 0, пары: {}, ждут: [] }, готово: false };
  PINS.forEach(function (g) { s.гр[g] = grp(D2); });
  s.гр[CANARY] = grp(D2);
  s.гр[W] = grp(MANUAL);
  s.гр[W0] = grp(D2);
  return s;
}
function load() {
  var s = json(sread(KEY));
  if (!s || s.v !== 1 || !s.t0 || !s.гр) return null;
  // Новый цикл — только если удачных прогонов не было двое суток (override
  // выключали). Пока override стоит, «итог» не сменяется новым циклом.
  if (Date.now() - (s.lastMs || s.t0) > STALE_MS) return null;
  return s;
}

// ── СНИМОК ──────────────────────────────────────────────────────────────
function snapOf(px) {
  var s = { now: {}, net: null, часы: null };
  TRACKED.forEach(function (g) { s.now[g] = px[g] && valid(px[g].now) ? px[g].now : null; });
  s.net = px[REAL] && valid(px[REAL].now) ? px[REAL].now : null;
  // «Часы ядра»: самое раннее history[].time муляжа, который проверяется лишь
  // при старте ядра. Нет истории — нет метки (не «перезапуска не было»).
  [CLOCKD, CLOCK].forEach(function (n) {
    if (s.часы) return;
    var h = px[n] && px[n].history;
    if (!(h instanceof Array)) return;
    var ts = [];
    for (var i = 0; i < h.length; i++) if (h[i] && valid(h[i].time)) ts.push(h[i].time);
    ts.sort();
    if (ts.length) s.часы = ts[0];
  });
  return s;
}

function totals(cb) {
  if (FINISHED || !room(1)) return cb(null, null);
  // Из /connections — только два счётчика; хосты соединений не читаются.
  get('/connections', function (r) {
    var j = r.status === 200 ? json(r.body) : null;
    cb(j ? num(j.uploadTotal) : null, j ? num(j.downloadTotal) : null);
  });
}

// ── МЕТКИ ОКНА ──────────────────────────────────────────────────────────
function mark(m) { S.марки.push(m); cap(S.марки, CAP); }

function markers(snap, ms, prev) {
  var f = json(sread(FAIL_KEY));
  if (f && f.n > 0) {
    if (prev) mark({ вид: 'окно', от: prev, до: ms, прогонов: f.n });
    swrite('{}', FAIL_KEY);
  } else if (prev && ms - prev > GAP_MS) {
    mark({ вид: 'пропуск', от: prev, до: ms });
  }
  var g = S.глоб;
  if (valid(snap.net)) {
    if (g.сеть && g.сеть.v !== snap.net) mark({ вид: 'сеть', от: g.сеть.ms, до: ms, было: g.сеть.v, стало: snap.net });
    g.сеть = { v: snap.net, ms: ms };
  }
  if (snap.up !== null && snap.down !== null) {
    var t = g.итоги;
    if (t && (snap.up < t.up || snap.down < t.down)) mark({ вид: 'перезапуск', по: 'итоги', от: t.ms, до: ms });
    g.итоги = { up: snap.up, down: snap.down, ms: ms };
  }
  if (valid(snap.часы)) {
    if (g.часы && g.часы.v !== snap.часы) mark({ вид: 'перезапуск', по: 'часы', от: g.часы.ms, до: ms });
    g.часы = { v: snap.часы, ms: ms };
  }
  var c = S.гр[CANARY], cv = snap.now[CANARY];
  if (valid(cv)) {
    if (c.стат === 'держит' && cv !== c.цель) {
      mark({ вид: 'канарейка', от: c.посл.ms, до: ms, стало: short(cv) });
      c.стат = 'снято'; c.сбросов++;
    } else if (c.стат === 'ждём') {
      c.стат = cv === c.цель ? 'держит' : 'снято';
    }
    c.посл = { ms: ms, v: cv };
  }
  if (TILE && !PAIRED) mark({ вид: 'ручная', от: prev || ms, до: ms, n: S.ручные.length + 1 });
}

// Причина-кандидат окна (a, b]: по меткам, чьё окно с ним пересекается.
function cause(a, b) {
  var kinds = [], tile = 0;
  for (var i = 0; i < S.марки.length; i++) {
    var m = S.марки[i], k = m.вид;
    if (!(m.до > a && m.от < b)) continue;
    // Неподтверждённый запуск плитки (возможно, автообновление) — не причина:
    // окно остаётся «без меток», пока второе нажатие не подтвердит точку.
    if (k === 'ручная' && !confirmed(m.n)) { k = 'ручная?'; tile = m.n; }
    if (kinds.indexOf(k) < 0) kinds.push(k);
  }
  function has(k) { return kinds.indexOf(k) >= 0; }
  var c = 'без меток';
  if (has('перезапуск')) c = 'перезапуск';
  else if (has('канарейка')) c = 'пересборка?';
  else if (has('сеть')) c = 'сеть';
  else if (has('окно') || has('пропуск')) c = 'окно недоступности';
  // Ручная точка (смена сети, перезапуск VPN Дианой) — не «без меток», даже
  // если счётчиков и history нет: иначе шаг в) испортил бы вывод об interval.
  else if (has('ручная')) c = 'ручная точка';
  return { метки: kinds, кандидат: c, плитка: c === 'без меток' ? tile : 0 };
}
function confirmed(n) {
  for (var i = 0; i < S.ручные.length; i++) if (S.ручные[i].n === n) return !!S.ручные[i].подтв;
  return false;
}
// Второе нажатие подтвердило точку n: окна, отнесённые при первом нажатии к
// «без меток», переходят в «ручная точка».
function confirmTile(n) {
  var p = S.ждёт;
  S.ждёт = null;
  if (!p || p.n !== n) return;
  p.окна.forEach(function (x) {
    var st = S.гр[x[0]], o = st.окна['без меток'];
    if (o) o[x[1]]--;
    if (!st.окна['ручная точка']) st.окна['ручная точка'] = [0, 0];
    st.окна['ручная точка'][x[1]]++;
    if (!x[1]) { st.безМеток--; st.плиткаБМ--; }
  });
  S.события.forEach(function (e) {
    if (e.плитка !== n || e.кандидат !== 'без меток') return;
    e.кандидат = 'ручная точка';
    e.метки = e.метки.map(function (k) { return k === 'ручная?' ? 'ручная' : k; });
  });
}

// ── СЛЕЖЕНИЕ ЗА ЗАКРЕПЛЕНИЕМ ────────────────────────────────────────────
// Окно между двумя удачными чтениями, в начале которого закрепление было
// подтверждено: держалось оно или сброшено. Неудачное чтение окна не
// закрывает — следующее удачное сравнивается с последним удачным.
function track(g, v, ms) {
  var st = S.гр[g];
  if (!valid(v)) return null;
  if (st.стат === 'ждём') {
    st.стат = v === st.цель ? 'держит' : 'снято';
    st.посл = { ms: ms, v: v };
    return null;
  }
  if (st.стат !== 'держит') { st.посл = { ms: ms, v: v }; return null; }
  var a = st.посл.ms, held = v === st.цель;
  st.E += ms - a;
  if (held) {
    st.H += ms - a;
    if (st.tConf) st.жизнь = Math.max(st.жизнь || 0, ms - st.tConf);
  }
  else { st.сбросов++; st.стат = 'снято'; }
  st.посл = { ms: ms, v: v };
  var c = cause(a, ms);
  if (!st.окна[c.кандидат]) st.окна[c.кандидат] = [0, 0];
  st.окна[c.кандидат][held ? 1 : 0]++;
  if (c.плитка) {
    if (!S.ждёт || S.ждёт.n !== c.плитка) S.ждёт = { n: c.плитка, окна: [] };
    S.ждёт.окна.push([g, held ? 1 : 0]);
  }
  if (held) return null;
  if (c.кандидат === 'без меток') {
    st.безМеток++;
    if (c.плитка) st.плиткаБМ = (st.плиткаБМ || 0) + 1;
  }
  var ev = { гр: short(g), от: sec(a), до: sec(ms), utc: iso(ms), стало: short(v), метки: c.метки, кандидат: c.кандидат };
  if (c.плитка) ev.плитка = c.плитка;
  S.события.push(ev); cap(S.события, CAP);
  RUN_EV.push(ev);
  return ev;
}

// ── ОПЫТ С ПРОВАЛОМ (W) ─────────────────────────────────────────────────
function roundDone(res) {
  var X = S.W;
  res.раунд = X.раунд;
  X.раунды.push(res);
  X.раунд++;
  X.болезнь = [];
  X.фаза = X.раунды.length >= ROUNDS ? 'готово' : 'закреп';
  if (S.гр[W].стат === 'держит') S.гр[W].стат = 'снято';
  if (S.гр[W0].стат === 'держит') S.гр[W0].стат = 'снято';
}
// Контроль W0 закреплён в том же прогоне, что и W, и не болеет: если он
// сброшен за то же окно, «не вернулся» у W не отличить от закрепления,
// которое просто истекает (находка тестировщика 25.09).
function control(ms) {
  var X = S.W, c = S.гр[W0];
  if (X.контроль) return 'сброшен через ' + X.контроль + ' с';
  return c.стат === 'держит' && c.посл && c.посл.ms === ms ? 'чист' : 'не прочитан';
}
function sickOf(list) {
  if (!list.length) return 'не прочитано';
  for (var i = 0; i < list.length; i++) if (list[i] !== 'Ручной') return 'ушёл';
  return 'не ушёл';
}
function wObserve(snap, ms) {
  var X = S.W, v = snap.now[W];
  if (X.фаза === 'держит' || X.фаза === 'болеет' || X.фаза === 'выздор') {
    if (track(W0, snap.now[W0], ms) && !X.контроль) X.контроль = Math.round((ms - X.tPin0) / 1000);
  } else {
    track(W0, snap.now[W0], ms);
  }
  if (X.фаза === 'держит') {
    var ev = track(W, v, ms);
    if (ev) roundDone({ итог: 'снято до провала', кандидат: ev.кандидат, контроль: control(ms) });
  } else if (X.фаза === 'болеет') {
    if (valid(v)) { X.болезнь.push(short(v)); cap(X.болезнь, 20); }
  } else if (X.фаза === 'выздор') {
    if (!valid(v)) return;
    var sick = sickOf(X.болезнь), dt = Math.round((ms - X.tRec) / 1000);
    if (v === MANUAL) roundDone({ болезнь: sick, итог: 'вернулся', через_с: dt, контроль: control(ms) });
    else if (ms - X.tRec >= REC_MS) roundDone({ болезнь: sick, итог: 'не вернулся', через_с: dt, контроль: control(ms) });
  } else if (valid(v)) {
    S.гр[W].посл = { ms: ms, v: v };
  }
}

// ── ОБРАБОТКА СНИМКА ────────────────────────────────────────────────────
function processSnap(snap, ms) {
  var prev = S.lastMs;
  // Второе нажатие плитки в пределах минуты подтверждает ручную точку:
  // автообновление плитки (Stash запускает её сам по interval) дважды
  // подряд не срабатывает. Новой точки второе нажатие не заводит.
  PAIRED = TILE && S.ручные.length > 0 && S.плиткаMs && ms - S.плиткаMs <= TILE_PAIR_MS;
  // Подтверждение — до разбора окон этого прогона: окно группы, не
  // прочитанной при первом нажатии, тоже должно увидеть точку подтверждённой.
  if (PAIRED) { S.ручные[S.ручные.length - 1].подтв = true; confirmTile(S.ручные[S.ручные.length - 1].n); }
  S.фаза = ms - S.t0 >= MAX_MS ? 'итог' : 'работа';
  for (var g in S.гр) if (S.гр[g].было === null && valid(snap.now[g])) S.гр[g].было = short(snap.now[g]);
  markers(snap, ms, prev);
  PINS.forEach(function (g) { track(g, snap.now[g], ms); });
  wObserve(snap, ms);
  S.lastMs = ms;
  var h = { t: sec(ms), тип: TILE ? 'т' : 'c', now: {}, сеть: snap.net, up: snap.up, down: snap.down, часы: snap.часы };
  TRACKED.forEach(function (g) { h.now[short(g)] = snap.now[g] === null ? null : short(snap.now[g]); });
  S.hist.push(h); cap(S.hist, 10);
  if (TILE && !PAIRED) {
    var c = cause(prev || ms, ms);
    S.ручные.push({ n: S.ручные.length + 1, t: sec(ms), utc: iso(ms), сеть: snap.net, подтв: false,
      метки: c.метки.filter(function (k) { return k !== 'ручная' && k !== 'ручная?'; }),
      сброшены: RUN_EV.map(function (e) { return e.гр; }) });
    cap(S.ручные, 10);
  }
  if (TILE) S.плиткаMs = ms;
}

// ── ДЕЙСТВИЯ (только тестовые группы) ───────────────────────────────────
// Закрепление — запись и сразу чтение; начинается, только если бюджета хватает
// на пару с повтором чтения. Код не 2xx или выбор не тот — «снято», повтор в
// следующем прогоне; FAIL_LIMIT подряд — «отказ», больше не пишем.
function pin(g, target, cb) {
  var st = S.гр[g];
  if (FINISHED || !room(3)) { rep.err.push('бюджет: закрепление ' + short(g) + ' — в следующем прогоне'); return cb(false); }
  write(g, target, function (r) {
    var okCode = r.status >= 200 && r.status < 300;
    if (!okCode) {
      st.код = r.status || r.error;
      if (++st.подряд >= FAIL_LIMIT) st.стат = 'отказ';
      return cb(false);
    }
    readNow(g, function (v, ms) {
      if (v === target) {
        st.стат = 'держит'; st.посл = { ms: ms, v: v }; st.закреплений++; st.подряд = 0; st.tConf = ms;
      } else if (v) {
        st.стат = 'снято'; st.посл = { ms: ms, v: v }; st.неВстало++;
        if (++st.подряд >= FAIL_LIMIT) st.стат = 'отказ';
      } else {
        st.стат = 'ждём';
      }
      cb(v === target);
    });
  });
}

function setSel(g, name, cb) {
  if (FINISHED || !room(3)) { rep.err.push('бюджет: выбор ' + short(g) + ' — в следующем прогоне'); return cb(false); }
  write(g, name, function (r) {
    readNow(g, function (v) {
      S.W.записи.push({ t: sec(Date.now()), гр: short(g), на: short(name), код: r.status || r.error, стало: v ? short(v) : null });
      cap(S.W.записи, 8);
      cb(v === name);
    });
  });
}

function connTest(snap, cb) {
  var st = S.гр[CONN];
  if (st.стат !== 'держит' || snap.now[CONN] !== st.цель) return cb();
  if (FINISHED || !room(3)) { rep.err.push('бюджет: соединение через Связь — в следующем прогоне'); return cb(); }
  var t = Date.now(), X = S.связь;
  get(gp(CONN) + '/delay?timeout=3000&url=' + encodeURIComponent(TEST_URL), function (r) {
    var d = json(r.body);
    var rec = { t: sec(t), код: r.status || r.error, мс: d && num(d.delay) };
    X.тесты.push(rec); cap(X.тесты, 8);
    if (r.status !== 200) { X.ошибок++; X.код = r.status || String(r.error).slice(0, 60); return cb(); }
    X.n++;
    readNow(CONN, function (v, ms) {
      rec.после = v ? short(v) : null;
      if (!v) { X.неясно++; return cb(); }
      if (v === st.цель) { X.держит++; st.посл = { ms: ms, v: v }; return cb(); }
      X.сброс++; st.сбросов++; st.стат = 'снято'; st.посл = { ms: ms, v: v };
      var ev = { гр: 'Связь', от: sec(t), до: sec(ms), utc: iso(ms), стало: short(v), метки: ['соединение'], кандидат: 'соединение' };
      S.события.push(ev); cap(S.события, CAP); RUN_EV.push(ev);
      cb();
    });
  });
}

function wAct(snap, ms, cb) {
  var X = S.W;
  if (X.фаза === 'закреп') {
    // Контроль W0 и опытная W закрепляются в одном прогоне, W0 — первым.
    var refused = function (g) { if (S.гр[g].стат === 'отказ') { X.фаза = 'готово'; X.отказ = short(g); } };
    var pinW = function () {
      pin(W0, D2, function (ok0) {
        if (!ok0) { refused(W0); return cb(); }
        X.tPin0 = Date.now(); X.контроль = null;
        pin(W, MANUAL, function (ok) {
          if (ok) { X.фаза = 'держит'; X.tHold = Date.now(); } else refused(W);
          cb();
        });
      });
    };
    if (snap.now[MANUAL] === 'DIRECT') return pinW();
    return setSel(MANUAL, 'DIRECT', function (ok) { if (ok) pinW(); else cb(); });
  }
  if (X.фаза === 'держит') {
    if (S.гр[W].стат !== 'держит' || snap.now[W] !== MANUAL || ms - X.tHold < HOLD_MS) return cb();
    return setSel(MANUAL, DUMMY, function (ok) {
      if (ok) { X.фаза = 'болеет'; X.tSick = Date.now(); X.болезнь = []; X.до = short(snap.now[W]); }
      cb();
    });
  }
  if (X.фаза === 'болеет' && ms - X.tSick >= SICK_MS) {
    return setSel(MANUAL, 'DIRECT', function (ok) { if (ok) { X.фаза = 'выздор'; X.tRec = Date.now(); } cb(); });
  }
  cb();
}

function repins(cb) {
  var list = [CANARY].concat(PINS), i = 0;
  function next() {
    while (i < list.length && !(S.гр[list[i]].стат === 'нов' || S.гр[list[i]].стат === 'снято')) i++;
    if (i >= list.length) return cb();
    var g = list[i++];
    pin(g, S.гр[g].цель, function () { next(); });
  }
  next();
}

function act(snap, ms, cb) {
  if (S.фаза === 'итог') {
    // Сутки прошли — только чтение; единственное исключение — вернуть Ручной
    // с муляжа, если опыт оборвался посреди болезни.
    // Раунд закрывается, иначе «болезнь» копилась бы каждый прогон (ревью 25.09).
    if (S.W.фаза === 'болеет') {
      return setSel(MANUAL, 'DIRECT', function (ok) {
        if (ok) { roundDone({ итог: 'прервано сутками' }); S.W.фаза = 'готово'; }
        cb();
      });
    }
    return cb();
  }
  connTest(snap, function () { wAct(snap, ms, function () { repins(cb); }); });
}

// ── ВЕРДИКТЫ ────────────────────────────────────────────────────────────
function mins(ms) { return Math.round(ms / 6000) / 10; }

function vInterval() {
  var a = S.гр[F30], b = S.гр[F3600];
  if (a.стат === 'отказ' || b.стат === 'отказ') return 'НЕ ПРОВЕРЕНО: fallback не принимает закрепление (' + (a.код || b.код || 'выбор не тот') + ')';
  var fa = a.безМеток, fb = b.безМеток;
  var k = (a.плиткаБМ || 0) + (b.плиткаБМ || 0);
  var tail = ' (F30: ' + fa + ' сбросов без меток за ' + mins(a.E) + ' мин; F3600: ' + fb + ' за ' + mins(b.E) + ' мин' +
    (k ? '; из них в окнах неподтверждённого запуска плитки: ' + k : '') + ')';
  if (fa === 0) return a.E >= EXPO_MS ? 'ОПРОВЕРГНУТА: F30 (interval 30 с) держит закрепление' + tail : 'мало данных' + tail;
  if (fa === 1) return 'мало данных: один сброс F30 без меток' + tail;
  var ra = fa / Math.max(a.E, 1), rb = fb / Math.max(b.E, 1);
  if (fb === 0 ? b.E >= EXPO_MS : ra >= 4 * rb) return 'ПОДТВЕРЖДЕНА: проверка здоровья снимает закрепление' + tail;
  if (fb >= 1 && b.E >= EXPO_MS) return 'НЕ ИНТЕРВАЛ: сбросы без меток у обеих, от interval не зависят' + tail;
  return 'мало данных' + tail;
}

function vCause(c) {
  var o = S.гр[F3600].окна[c] || [0, 0], x = o[0], n = o[0] + o[1];
  var o2 = S.гр[F30].окна[c] || [0, 0];
  if (!n) return 'не наблюдалось';
  var s = x === 0 ? 'НЕ СБРАСЫВАЕТ' : (x === n ? 'СБРАСЫВАЕТ' : 'ИНОГДА СБРАСЫВАЕТ');
  s += ' (F3600: ' + x + ' из ' + n + ' окон; F30: ' + o2[0] + ' из ' + (o2[0] + o2[1]) + ')';
  if (n === 1) s += ' — одиночный опыт';
  return s;
}

function vConn() {
  var X = S.связь, ua = S.гр[CONN].безМеток, ub = S.гр[F3600].безМеток;
  var tail = ' (соединений ' + X.n + ', сброшено сразу ' + X.сброс + ', держит ' + X.держит +
    (X.неясно ? ', не прочитано ' + X.неясно : '') + (X.ошибок ? ', замер с ошибкой ' + X.ошибок : '') + ')';
  var c = S.гр[CONN];
  if (X.сброс + X.держит < CONN_MIN) {
    if (c.стат === 'отказ') return 'НЕ ПРОВЕРЕНО: Связь не принимает закрепление (' + (c.код || 'выбор не тот') + ')' + tail;
    if (X.ошибок >= CONN_MIN) return 'НЕ ПРОВЕРЕНО: замер через группу не принят (' + X.код + ')' + tail;
    if (heldWin(c) === 0 && c.сбросов >= CONN_MIN) return 'НЕ ПРОВЕРЕНО: Связь не держит закрепление до следующего прогона — см. «закрепление»' + tail;
    return 'мало данных' + tail;
  }
  var late = ua > ub ? '; между прогонами Связь сброшена без меток ' + ua + ' раз против ' + ub + ' у F3600 — возможен отложенный сброс' : '';
  if (X.сброс === 0) return 'НЕ СБРАСЫВАЕТ' + tail + late;
  if (X.держит === 0) return 'СБРАСЫВАЕТ' + tail;
  return 'ИНОГДА СБРАСЫВАЕТ' + tail;
}

function vFail() {
  var X = S.W, rs = X.раунды, A1 = 0, B = 0, C = 0, pre = 0, cut = 0, dirty = [];
  rs.forEach(function (r) {
    if (r.итог === 'снято до провала') pre++;
    else if (r.итог === 'прервано сутками') cut++;
    else if (r.болезнь === 'не ушёл') C++;
    else if (r.болезнь === 'не прочитано') cut++;
    else if (r.итог === 'вернулся') B++;
    else if (r.контроль === 'чист') A1++;
    else dirty.push(r.контроль);
  });
  var tail = ' (раундов ' + rs.length + ' из ' + ROUNDS + (X.фаза !== 'готово' ? ', идёт: ' + X.фаза : '') + ')';
  if (X.отказ) return 'НЕ ПРОВЕРЕНО: ' + X.отказ + ' не принимает закрепление (' + (S.гр[X.отказ === 'W0' ? W0 : W].код || 'выбор не тот') + ')' + tail;
  if (!rs.length) return 'идёт' + tail;
  var tested = A1 + B + C, s;
  var dtail = dirty.length ? '; ещё ' + dirty.length + ' «не вернулся» при сброшенном контроле W0' : '';
  if (!tested && dirty.length) s = 'НЕ РАЗЛИЧИТЬ: закрепление снимается и без провала — контроль W0 ' + dirty.join(', ');
  else if (!tested) s = pre ? 'ВЫВОД НЕВОЗМОЖЕН: закрепление W снято до провала (' + pre + ' раз) — см. интервал' : 'нет данных: W в болезни не прочитан';
  else if (A1 && !B && !C) s = 'ПОДТВЕРЖДЕНА: один провал стирает закрепление — W остался на Прямо1, контроль W0 держит (' + A1 + ' из ' + tested + ')' + dtail;
  else if (B && !A1 && !C) s = 'ОПРОВЕРГНУТА: закрепление переживает провал — W вернулся к Ручному (' + B + ' из ' + tested + ')' + dtail;
  else if (C && !A1 && !B) s = 'ПРОВАЛ НЕ СНИМАЕТ: W не уходит с закреплённого больного члена (' + C + ' из ' + tested + ')' + dtail;
  else s = 'НЕОДНОЗНАЧНО: не вернулся ' + A1 + ', вернулся ' + B + ', не ушёл ' + C + dtail;
  if (tested === 1) s += ' — одиночный опыт';
  return s + tail;
}

// Окон, которые закрепление пережило (по всем причинам).
function heldWin(st) { var n = 0; for (var k in st.окна) n += st.окна[k][1]; return n; }
function resetWin(st) { var n = 0; for (var k in st.окна) n += st.окна[k][0]; return n; }

// Сколько живёт закрепление само по себе. Если F3600 не пережил ни одного
// окна между чтениями — это ответ сам по себе, и прочие опыты недостижимы.
function vLife() {
  var b = S.гр[F3600], a = S.гр[F30], hb = heldWin(b), rb = resetWin(b);
  // Три окна подряд без единого пережитого: одиночное измерение — не вывод.
  if (rb >= 3 && hb === 0) {
    return 'МЕНЬШЕ ПЕРИОДА ЧТЕНИЙ: F3600 сброшен во всех ' + rb + ' окнах (окно ~' + Math.round(b.E / rb / 1000) + ' с), ни одного не пережил';
  }
  if (!hb) return 'мало данных';
  return 'держалось подряд до ' + mins(b.жизнь || 0) + ' мин (F3600), до ' + mins(a.жизнь || 0) + ' мин (F30); окон пережито ' + hb + ', сброшено ' + rb;
}

function verdicts() {
  var V = {};
  V.интервал = vInterval();
  V.закрепление = vLife();
  V.провал = vFail();
  V.соединение = vConn();
  V.сеть = vCause('сеть');
  var g = S.глоб;
  V.перезапуск = vCause('перезапуск') + '; метки перезапуска: итоги ' + (g.итоги ? 'есть' : 'НЕТ') +
    ', часы ' + (g.часы ? 'есть' : 'НЕТ');
  V.пересборка = vCause('пересборка?');
  V.окна = vCause('окно недоступности');
  var u = S.гр[U30];
  V.url_test = u.стат === 'отказ' ? 'PUT не принят: ' + (u.код || '—')
    : 'сбросов без меток ' + u.безМеток + ' за ' + mins(u.E) + ' мин, всего сбросов ' + u.сбросов;
  if (S.ручные.length) {
    V.ручные = S.ручные.map(function (m) {
      return '№' + m.n + ' ' + m.utc.slice(11, 16) + ' UTC' + (m.подтв ? '' : ' (не подтверждена — возможно автозапуск плитки)') +
        ': метки [' + m.метки.join(', ') + '], сброшены [' + m.сброшены.join(', ') + ']';
    }).join('; ');
  }
  return V;
}

function groupsOut() {
  var o = {};
  for (var g in S.гр) {
    var st = S.гр[g];
    o[short(g)] = { цель: short(st.цель), было: st.было, стат: st.стат, сбросов: st.сбросов, без_меток: st.безМеток,
      держал_мин: mins(st.H), наблюдал_мин: mins(st.E), закреплений: st.закреплений, не_встало: st.неВстало,
      окна: st.окна, код: st.код };
  }
  return o;
}

// ── ВЫВОД ───────────────────────────────────────────────────────────────
// Уведомление cron — только вехи и новые пары «группа — причина».
function notePolicy(V) {
  var N = S.ноты, now = Date.now(), mile = false;
  if (!N.первая) { N.первая = true; mile = true; NOTE_WHY.push('запуск'); }
  RUN_EV.forEach(function (e) {
    var k = e.гр + '|' + e.кандидат;
    if (!N.пары[k]) { N.пары[k] = 1; N.ждут.push(e.гр + ': ' + e.кандидат); }
  });
  if (S.готово && !N.готово) { N.готово = true; mile = true; NOTE_WHY.push('готово'); }
  if (S.фаза === 'итог' && !N.итог) { N.итог = true; mile = true; NOTE_WHY.push('итог'); }
  if (N.ждут.length && (mile || PAIRED || now - N.ms >= NOTE_GAP_MS)) {
    NOTE_WHY.push('новые сбросы: ' + N.ждут.join(', '));
    N.ждут = [];
  }
  // Плитка уведомляет только о подтверждённой точке: автообновление плитки
  // не должно слать уведомлений (ревью 25.09).
  if (PAIRED) NOTE_WHY.push('ручная точка №' + S.ручные[S.ручные.length - 1].n + ' подтверждена');
  if (NOTE_WHY.length) N.ms = now;
}

function finish() {
  if (FINISHED) return;
  FINISHED = true;
  try { clearTimeout(GUARD); } catch (e) {}
  var lines, color = '#FF9F0A';
  try {
    // Состояние сохраняется, только если снимок этого прогона обработан:
    // сторож посреди чтений не должен записать пустой цикл.
    if (S && SNAPPED) {
      var V = verdicts();
      // Готово, когда решено всё достижимое, — или по сроку: гипотеза, которую
      // мир делает недостижимой, не должна держать Диану без сигнала.
      if (!S.готово && S.W.фаза === 'готово' && !/^мало данных/.test(V.интервал) &&
          !/^мало данных/.test(V.соединение)) S.готово = true;
      if (!S.готово && S.lastMs - S.t0 >= READY_MAX_MS) S.готово = 'по сроку';
      notePolicy(V);
      A.фаза = S.фаза;
      A.мин = mins(S.lastMs - S.t0);
      A.вердикты = V;
      A.группы = groupsOut();
      A.W = { фаза: S.W.фаза, раунд: S.W.раунд, раунды: S.W.раунды, болезнь: S.W.болезнь, записи: S.W.записи };
      A.связь = S.связь;
      A.события = S.события.slice(-30);
      A.метки = S.марки.slice(-30).map(function (m) {
        var o = {}; for (var k in m) o[k] = m[k];
        o.от = sec(m.от); o.до = sec(m.до); return o;
      });
      A.ручные = S.ручные;
      A.снимки = S.hist.slice(-10);
      A.t0 = iso(S.t0);
      if (OWN_LOCK && !lockMine()) {
        // Замок истёк и перехвачен: состояние у другого прогона новее.
        rep.err.push('замок перехвачен — состояние не сохранено');
        NOTE_WHY = [];
      } else if (!save()) {
        // Без сохранения каждый прогон — «первый»: cron молчит, чтобы не звать раз в минуту.
        rep.err.push('состояние не сохранено');
        if (!TILE) NOTE_WHY = [];
      }
      if (!A.ВЕРДИКТ) {
        if (S.фаза === 'итог') { A.ВЕРДИКТ = 'ST20 ИТОГ: сутки прошли, проба только читает — выключите override'; color = '#34C759'; }
        else if (S.готово) {
          A.ВЕРДИКТ = 'ST20: автоматическая часть готова' + (S.готово === 'по сроку' ? ' (по сроку 1,5 ч, решено не всё)' : '') +
            ' — можно делать ручные шаги';
          color = '#34C759';
        }
        else A.ВЕРДИКТ = 'ST20 идёт: ' + A.мин + ' мин, сбросов ' + resets();
      }
    }
    lines = [A.ВЕРДИКТ || 'ST20: прогон прерван'];
    if (TILE && SNAPPED && !PAIRED && S && S.ручные.length) {
      lines.splice(1, 0, 'ручная точка №' + S.ручные[S.ручные.length - 1].n + ' записана — нажмите плитку ещё раз в течение минуты');
    }
    var V2 = A.вердикты || {};
    ['закрепление', 'интервал', 'провал', 'соединение', 'сеть', 'перезапуск', 'пересборка', 'окна', 'url_test', 'ручные']
      .forEach(function (k) { if (V2[k]) lines.push(k.replace('_', '-') + ': ' + V2[k]); });
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
  if (NOTE_WHY.length) {
    try {
      var why = NOTE_WHY;
      var body = (why.length ? 'повод: ' + why.join('; ') + '\n' : '') + lines.slice(1).join('\n');
      $notification.post('RouteHub ' + REV, lines[0], body, { clipboard: JSON.stringify(rep) });
    } catch (e3) {}
  }
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'), icon: 'pin', backgroundColor: color });
  } catch (e4) { try { $done(); } catch (e5) {} }
}

function resets() {
  var n = 0;
  for (var g in S.гр) if (g !== CANARY) n += S.гр[g].сбросов;
  return n;
}

function save() { return swrite(JSON.stringify(S), KEY); }

// Override не применился — сказать, но не чаще раза в 6 ч (cron раз в минуту).
function missNote() {
  if (TILE) return;
  var n = Number(sread(NOTE_KEY)) || 0;
  if (Date.now() - n >= MISS_GAP_MS) { NOTE_WHY.push('нет групп'); swrite(String(Date.now()), NOTE_KEY); }
}

// ── ГЛАВНАЯ ЦЕПОЧКА ─────────────────────────────────────────────────────
function main() {
  if (!lockTake()) {
    // Совет согласован с парой нажатий: ждать, пока замок освободится
    // (после перезапуска VPN — до ~5 мин от убитого прогона), и нажать ДВАЖДЫ.
    var wait = LOCK_LEFT > 20000 ? 'через ' + Math.ceil(LOCK_LEFT / 1000 + 5) + ' с' : 'через 10–20 с';
    A.ВЕРДИКТ = 'ЗАНЯТО: идёт другой прогон ST20' + (TILE ? ' — ' + wait + ' нажмите плитку ДВАЖДЫ' : '');
    return finish();
  }
  get('/', function (r) {
    A.прогрев = { код: r.status, мс: r.ms, повтор: !!r.повтор, ошибка: r.error };
    if (r.status !== 200) { failRun('прогрев: ' + (r.status || r.error)); return finish(); }
    if (FINISHED || !room(1)) { failRun('бюджет'); return finish(); }
    get('/proxies', function (r2) {
      var j = r2.status === 200 ? json(r2.body) : null;
      var px = j && j.proxies && typeof j.proxies === 'object' && !(j.proxies instanceof Array) ? j.proxies : null;
      if (!px) { failRun('/proxies: ' + (r2.status || r2.error)); return finish(); }
      var ms = Date.now();
      var miss = ALL.filter(function (n) { return !px[n]; });
      if (miss.length) {
        A.ВЕРДИКТ = 'ТЕСТОВЫХ ГРУПП ST20 НЕТ — override не применился. Ничего не записано';
        A.нет = miss.map(function (n) { return n.replace(P, ''); });
        missNote();
        return finish();
      }
      if (!px[REAL]) rep.err.push('нет RH-AI — метки сети не будет');
      S = load() || fresh(ms);
      var snap = snapOf(px);
      totals(function (up, down) {
        snap.up = up; snap.down = down;
        processSnap(snap, ms);
        SNAPPED = true;
        act(snap, ms, finish);
      });
    });
  });
}

GUARD = setTimeout(function () {
  if (FINISHED) return;
  rep.err.push('сторож: цепочка не завершилась');
  if (!SNAPPED && OWN_LOCK) failRun('сторож');
  finish();
}, GUARD_MS);

if (typeof G.$httpClient === 'undefined') {
  rep.err.push('нет $httpClient');
  finish();
} else {
  main();
}
// конец файла — хвостовой страж (вывод 49)
