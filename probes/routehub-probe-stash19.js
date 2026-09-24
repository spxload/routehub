/*
 * RouteHub — ПРОБА STASH ST19. Закрепление во времени и карта рычагов.
 * ===========================================================================
 * ЗАЧЕМ. ST18 (24.09) доказала: `PUT /proxies/{группа}` меняет выбор и в
 * select, и в fallback (узлы стенда живут в fallback RH-X-W/-C). Открытым
 * остался главный для управления вопрос: ЧТО ДАЛЬШЕ с закреплённым fallback.
 * `DELETE` дал 405, поля `fixed` в ответе нет. Если закрепление вечное, то
 * fallback, которому скрипт однажды выбрал узел, перестаёт сам уходить с
 * упавшего узла — управление ломает то, ради чего fallback и стоит.
 *
 * ОДИН ВОПРОС В ТРЁХ ВИДАХ, наблюдаемый несколькими прогонами cron подряд:
 *   1. Закрепить ЗДОРОВЫЙ член, не первый по порядку (RH-Т19-Здоров → DIRECT
 *      при автовыборе RH-Т19-Прямо): держится или проверка здоровья сбросит.
 *   2. Закрепить МЁРТВЫЙ член (RH-Т19-Мёртв → RH-Т19-Муляж, socks5 на
 *      192.0.2.1 — адрес TEST-NET, никуда не ведёт): уйдёт ли fallback сам.
 *   3. САМОВОССТАНАВЛИВАЮЩАЯСЯ ОБЁРТКА (идея ideator 24.09): fallback
 *      RH-Т19-Обёртка = [RH-Т19-Ручной (select), RH-Т19-Прямо]. Ручной выбор
 *      делается в select, а не в fallback; выбрали мёртвое — пропустит ли
 *      fallback ручную группу, и вернётся ли к ней, когда выбор снова живой.
 *      Если да — закреплять fallback не нужно вовсе, DELETE не нужен.
 * Попутно: PUT в url-test и load-balance; группа с ssid-policy как датчик
 * сети (Wi-Fi/сотовая) и держится ли ручной выбор в ней.
 *
 * КАРТА РЫЧАГОВ (первый прогон). Существование пишущих маршрутов проверяется
 * БЕЗ их вызова: GET на маршрут, который принимает другой метод, даёт 405;
 * текст «404 page not found» — маршрута нет; 404 в JSON — маршрут есть, имени
 * нет. Пишущий запрос делается только с заведомо несуществующим именем.
 *
 * ФАЗЫ (состояние — $persistentStore, ключ RH_ST19):
 *   старт       — карта рычагов, закрепления, первое наблюдение;
 *   наблюдение  — только чтение, не меньше OBSERVE_MS после закреплений;
 *   возврат     — Ручной снова на DIRECT: вернётся ли Обёртка к нему;
 *   итог        — только чтение и вердикт. Override можно выключать.
 *
 * ПРАВИЛО 1. Узлов в тестовых группах нет: DIRECT, выбор из одного DIRECT и
 * муляж на адрес TEST-NET. Замеры задержки — только DIRECT и тестовых групп.
 * НЕ вызываются: healthcheck настоящего поставщика и /group/{боевая}/delay —
 * они прогнали бы все узлы, включая обходные.
 * ПРАВИЛО 2. Пишет только в тестовые группы RH-Т19-* (список WRITABLE,
 * проверка в write()). Боевые группы и RH-AI — только чтение. PUT /configs,
 * PATCH /configs, /restart, /upgrade, сброс кэшей, DELETE /connections — не
 * вызываются; их существование видно по 405 на GET.
 * СЕКРЕТ контроллера уходит только в заголовок; из $environment в выгрузку
 * идут лишь ИМЕНА ключей. Из /connections — только число и имена полей,
 * без хостов (граница приватности, как в ST13/ST17).
 *
 * ВРЕМЯ. timeout $httpClient у Stash — в секундах. Шаг начинается, только
 * если бюджета хватает на всю его цепочку (room(n)); сторож 75 с позже
 * бюджета 45 с, а в фоне таймеры растягиваются только в большую сторону.
 * EOF на первом запросе (ST18, 1 прогон из 4) — прогревочный GET / с одним
 * повтором; без успешного чтения проба ничего не пишет.
 */

var REV = 'ST19';
var T0 = Date.now();

var BUDGET_MS = 45000;
var GUARD_MS = 75000;
var CTRL_SEC = 5;                    // Stash: секунды, не миллисекунды
var STEP_MS = (CTRL_SEC + 1) * 1000;
var OBSERVE_MS = 12 * 60000;         // наблюдение после закреплений: 12 проверок по 60 с
var BACK_MS = 5 * 60000;             // наблюдение после возврата Ручного
var STALE_MS = 6 * 3600000;          // старое состояние — начать заново
var KEY = 'RH_ST19';
var TEST_URL = 'http://www.gstatic.com/generate_204';
var CMD_URL = 'http://rh-cmd.example.net/st19';  // страница перехватчика (часть 2)

var P = 'RH-Т19-';
var DUMMY = P + 'Муляж';             // socks5 192.0.2.1:1 — мёртв
var ALIAS = P + 'Прямо';             // select: [DIRECT]
var FB_OK = P + 'Здоров';            // fallback: [Муляж, Прямо, DIRECT] → авто Прямо
var FB_DEAD = P + 'Мёртв';           // fallback: [Прямо, Муляж, DIRECT] → авто Прямо
var MANUAL = P + 'Ручной';           // select: [DIRECT, Муляж]
var WRAP = P + 'Обёртка';            // fallback: [Ручной, Прямо] → авто Ручной
var URLT = P + 'Скорость';           // url-test: [Прямо, DIRECT]
var LB = P + 'Баланс';               // load-balance: [Прямо, DIRECT]
var NET = P + 'Сеть';                // select + ssid-policy {cellular: Прямо, default: DIRECT}
var CMD = P + 'Команда';             // select: [Прямо, DIRECT] — для скрипта-перехватчика
var REAL = 'RH-AI';                  // боевая — только чтение (тип сети по now)

var WATCH = [FB_OK, FB_DEAD, MANUAL, WRAP, URLT, LB, NET, CMD];
var WRITABLE = {};
WRITABLE[FB_OK] = 1; WRITABLE[FB_DEAD] = 1; WRITABLE[MANUAL] = 1; WRITABLE[URLT] = 1;
WRITABLE[LB] = 1; WRITABLE[NET] = 1;

var rep = { rev: REV, ts: new Date().toISOString(), ans: {}, err: [] };
var A = rep.ans;
var G = (typeof globalThis !== 'undefined') ? globalThis : this;

var CTRL = 'http://127.0.0.1:9090', AUTH = '';
try {
  CTRL = ($environment && $environment['controller-url']) || CTRL;
  AUTH = ($environment && $environment['controller-authorization']) || '';
  A.stash = ($environment && $environment['stash-version']) || '?';
} catch (e) { rep.err.push('нет $environment'); }
CTRL = String(CTRL).replace(/\/+$/, '');

var FINISHED = false, GUARD = null;
function left() { return BUDGET_MS - (Date.now() - T0); }
function room(n) { return left() > STEP_MS * n; }

// ── ЗАПРОСЫ ─────────────────────────────────────────────────────────────
function raw(method, path, body, sec, cb) {
  var o = { url: CTRL + path, timeout: sec || CTRL_SEC, headers: {} };
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
function get(path, cb, sec) {
  raw('get', path, null, sec, function (r) {
    if (r.status !== null || FINISHED || !room(1)) return cb(r);
    setTimeout(function () {
      raw('get', path, null, sec, function (r2) { r2.повтор = true; cb(r2); });
    }, 1000);
  });
}

function write(method, group, name, cb) {
  if (!WRITABLE.hasOwnProperty(group)) {
    rep.err.push('запись вне тестовых групп запрещена: ' + group);
    return cb({ status: null, error: 'отказ пробы', body: '' });
  }
  raw(method, gp(group), method === 'put' ? { name: name } : null, CTRL_SEC, cb);
}

function gp(name) { return '/proxies/' + encodeURIComponent(name); }
function json(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function keys(o) { var k = []; for (var x in o) if (o.hasOwnProperty(x)) k.push(x); return k.sort(); }

// ── СОСТОЯНИЕ ───────────────────────────────────────────────────────────
function load() {
  var s = null;
  try { s = json(G.$persistentStore.read(KEY)); } catch (e) {}
  if (!s || s.v !== 1 || !s.t0) return null;
  // После «итог» цикл не начинается заново, даже если override забыли выключить.
  if (s.фаза !== 'итог' && Date.now() - s.t0 > STALE_MS) return null;
  return s;
}
function save(s) {
  try { return G.$persistentStore.write(JSON.stringify(s), KEY) !== false; } catch (e) { return false; }
}
var S = null;

// ── НАБЛЮДЕНИЕ: now всех тестовых групп, живость муляжа, RH-AI ─────────
function observe(label, cb) {
  var snap = { t: Math.round((Date.now() - S.t0) / 1000), фаза: label, now: {} };
  var list = WATCH.concat([REAL]);
  var i = 0;
  function next() {
    if (i >= list.length) return dummy();
    if (FINISHED || !room(1)) { snap.неполное = true; return end(); }
    var g = list[i++];
    get(gp(g), function (r) {
      var j = r.status === 200 ? json(r.body) : null;
      snap.now[g] = j && typeof j.now === 'string' ? j.now : (r.status === 404 ? 'НЕТ' : ('? ' + (r.status || r.error)));
      next();
    });
  }
  function dummy() {
    if (FINISHED || !room(1)) return end();
    get(gp(DUMMY), function (r) {
      var j = r.status === 200 ? json(r.body) : null;
      snap.муляж = j ? { alive: j.alive, delay: j.delay } : ('? ' + (r.status || r.error));
      end();
    });
  }
  function end() {
    S.hist.push(snap);
    if (S.hist.length > 40) S.hist.splice(1, S.hist.length - 40); // первый снимок храним
    cb(snap);
  }
  next();
}

// ── КАРТА РЫЧАГОВ ───────────────────────────────────────────────────────
// Класс ответа: чем 405 отличается от «404 page not found» — см. шапку.
function kind(r) {
  if (r.status === 405) return 'есть (другой метод)';
  if (r.status === 404) return /404 page not found/i.test(r.body) ? 'маршрута нет' : 'маршрут есть, имени нет';
  if (r.status === 200 || r.status === 204) return 'есть';
  if (r.status === null) return 'нет ответа: ' + (r.error || '').slice(0, 60);
  return 'код ' + r.status;
}

var GHOST = 'RH-Т19-нет-такого';
var SWEEP = [
  // [метод, путь, секунд, что выгрузить]
  ['get', '/', 0, 'keys'],
  ['get', '/configs', 0, 'keys'],
  ['get', '/providers/proxies', 0, 'providers'],
  ['get', '/providers/rules', 0, 'count'],
  ['get', '/rules', 0, 'count'],
  ['get', '/connections', 0, 'conns'],
  ['get', '/connections/00000000-0000-0000-0000-000000000000', 0, ''],
  ['get', '/group', 0, ''],
  ['get', '/group/' + encodeURIComponent(URLT) + '/delay?timeout=3000&url=' + encodeURIComponent(TEST_URL), 0, 'body'],
  ['get', '/proxies/DIRECT/delay?timeout=3000&url=' + encodeURIComponent(TEST_URL), 0, 'body'],
  ['get', '/providers/proxies/' + encodeURIComponent(GHOST), 0, 'body'],
  ['put', '/providers/proxies/' + encodeURIComponent(GHOST), 0, 'body'],
  ['get', '/providers/proxies/' + encodeURIComponent(GHOST) + '/healthcheck', 0, 'body'],
  // /cache/fakeip/flush НЕ проверяется: если Stash не смотрит на метод, GET
  // сбросил бы fake-ip на рабочем телефоне (тестировщик 24.09). Польза мала.
  ['get', '/dns/query?name=example.com&type=A', 0, 'body'],
  ['get', '/logs?level=info', 3, 'len']   // в журнале хосты и адреса — только длина
];

// По одному пункту: пункт начинается, только если на него (с повтором)
// хватает бюджета; остаток — в следующий прогон (S.картаИ).
function sweep(cb) {
  if (!S.карта) S.карта = [];
  var out = S.карта;
  function next() {
    if (out.length >= SWEEP.length) { S.картаГотова = true; return envSweep(cb); }
    if (FINISHED || !room(2)) { rep.err.push('бюджет: карта рычагов — продолжение в следующем прогоне'); return cb(); }
    var it = SWEEP[out.length];
    var fn = it[0] === 'get' ? function (c) { get(it[1], c, it[2]); } : function (c) { raw(it[0], it[1], {}, CTRL_SEC, c); };
    fn(function (r) {
      var row = { м: it[0].toUpperCase(), путь: it[1].replace(/\?.*$/, ''), код: r.status, итог: kind(r), мс: r.ms };
      var j = json(r.body);
      if (it[3] === 'keys' && j) row.поля = keys(j);
      if (it[3] === 'count' && j) row.число = j.rules ? j.rules.length : keys(j.providers || {}).length;
      if (it[3] === 'providers' && j && j.providers) {
        row.поставщики = keys(j.providers).map(function (k) {
          var p = j.providers[k] || {};
          return k + ' (' + (p.vehicleType || '?') + ', ' + (p.proxies ? p.proxies.length : '?') + ')';
        });
      }
      if (it[3] === 'conns' && j && j.connections) {
        row.число = j.connections.length;
        if (j.connections[0]) {
          row.поля = keys(j.connections[0]);
          if (j.connections[0].metadata) row.метаданные = keys(j.connections[0].metadata);
        }
      }
      if (it[3] === 'body') row.ответ = r.body.slice(0, 120);
      if (it[3] === 'len') row.длина = r.body.length;
      out.push(row);
      next();
    });
  }
  next();
}

// $-объекты среды: только имена, значения $environment не выгружаются.
function envSweep(cb) {
  var env = {};
  try {
    for (var k in G) {
      if (k.charAt(0) !== '$') continue;
      var v = G[k];
      env[k] = (v && typeof v === 'object') ? keys(v) : typeof v;
    }
  } catch (e) { env.ошибка = String(e); }
  S.среда = env;
  cb();
}

// ── ЗАКРЕПЛЕНИЯ ─────────────────────────────────────────────────────────
// План строится один раз по первому снимку и хранится: прогоны, которые
// доделывают закрепления, не должны выбирать цели заново. Каждое закрепление
// — запись и сразу чтение этой группы; начинается, только если бюджета
// хватает на пару (с повтором чтения). Время — своё у каждой группы.
function makePlan(snap) {
  var other = function (g, a, b) { return snap.now[g] === a ? b : a; };
  return [
    [FB_OK, 'DIRECT'],
    [FB_DEAD, DUMMY],
    [MANUAL, DUMMY],
    [URLT, other(URLT, 'DIRECT', ALIAS)],
    [LB, other(LB, ALIAS, 'DIRECT')],
    [NET, other(NET, ALIAS, 'DIRECT')]
  ];
}

function pinAll(snap, cb) {
  if (!S.план) S.план = makePlan(snap);
  if (!S.закрепления) S.закрепления = {};
  function next() {
    var p = null;
    for (var i = 0; i < S.план.length; i++) if (!S.закрепления[S.план[i][0]]) { p = S.план[i]; break; }
    if (!p) return cb(true);
    if (FINISHED || !room(3)) { rep.err.push('бюджет: закрепления — продолжение в следующем прогоне'); return cb(false); }
    write('put', p[0], p[1], function (r) {
      get(gp(p[0]), function (r2) {
        var j = r2.status === 200 ? json(r2.body) : null;
        var t = Math.round((Date.now() - S.t0) / 1000);
        S.закрепления[p[0]] = { ждали: p[1], было: snap.now[p[0]], код: r.status, t: t,
          обёртка_до: p[0] === MANUAL ? snap.now[WRAP] : undefined,
          сразу: j && typeof j.now === 'string' ? j.now : null,
          ответ: r.body ? r.body.slice(0, 100) : null, ошибка: r.error };
        next();
      });
    });
  }
  next();
}

// ── ВЕРДИКТЫ ПО ИСТОРИИ ─────────────────────────────────────────────────
// Снимки не раньше t1; part — 'до' или 'после' возврата Ручного. Граница —
// по фазе, в которой снят снимок, а не по секундам: снимок прогона, в котором
// делается возврат, и сам возврат округлялись к одной секунде (тестировщик
// 24.09), и снимок ДО возврата попадал в ряд «после».
function isBack(h) { return h.фаза === 'возврат' || h.фаза === 'итог'; }
function after(t1, part) {
  var out = [];
  for (var i = 0; i < S.hist.length; i++) {
    var h = S.hist[i];
    if (h.t < t1) continue;
    if (part === 'до' && isBack(h)) continue;
    if (part === 'после' && !isBack(h)) continue;
    out.push(h);
  }
  return out;
}
// Неудачное чтение ('? …', 'НЕТ', null) — не выбор: его не считаем ни сменой,
// ни подтверждением (ловушка «отсутствие значения», ревью 24.09).
function valid(v) { return typeof v === 'string' && v !== 'НЕТ' && v.indexOf('? ') !== 0; }
function firstNot(list, g, v) {
  for (var i = 0; i < list.length; i++) if (valid(list[i].now[g]) && list[i].now[g] !== v) return list[i];
  return null;
}
// Только снимки, где все группы gs прочитаны удачно: длительность наблюдения
// и «после возврата» не должны прирастать неудачными чтениями (тестировщик 24.09).
function good(list, gs) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var ok = true;
    for (var k = 0; k < gs.length; k++) if (!valid(list[i].now[gs[k]])) ok = false;
    if (ok) out.push(list[i]);
  }
  return out;
}
var KEY_GROUPS = [FB_OK, FB_DEAD, WRAP];
function firstValid(list, g) {
  for (var i = 0; i < list.length; i++) if (valid(list[i].now[g])) return list[i];
  return null;
}
function lastT(list) { return list.length ? list[list.length - 1].t : 0; }
// Ряд наблюдений группы после её закрепления: первым — чтение сразу после
// записи, дальше снимки прогонов (до возврата, если он был).
function series(g, part) {
  var p = (S.закрепления || {})[g];
  if (!p) return [];
  var out = [];
  if (valid(p.сразу)) { out.push({ t: p.t, now: {} }); out[0].now[g] = p.сразу; }
  return out.concat(good(after(p.t + 1, part), [g]));
}
// Закрепление, которое не состоялось сразу, не должно читаться как «сброшено».
// true / false — по первому удачному чтению; null — данных нет.
function tookHold(list, g, v) { var f = firstValid(list, g); return f ? f.now[g] === v : null; }

function verdicts() {
  var V = {};
  if (!S.tpin) return V;
  var tb = S.tback;
  var pin = S.закрепления || {};
  var part = 'до';
  function pinned(g) { return pin[g] && pin[g].код >= 200 && pin[g].код < 300; }

  // 1. Здоровый член, не первый.
  var obs = series(FB_OK, part), tp = pin[FB_OK] ? pin[FB_OK].t : 0, span = lastT(obs) - tp;
  var hOk = tookHold(obs, FB_OK, 'DIRECT');
  if (pinned(FB_OK) && hOk === null) {
    V.здоровый = 'нет данных: выбор после закрепления не прочитан';
  } else if (pinned(FB_OK) && !hOk) {
    V.здоровый = 'НЕ ЗАКРЕПИЛСЯ: PUT ' + pin[FB_OK].код + ', выбор ' + firstValid(obs, FB_OK).now[FB_OK];
  } else if (pinned(FB_OK)) {
    var fOk = firstNot(obs, FB_OK, 'DIRECT');
    V.здоровый = fOk ? 'СБРАСЫВАЕТСЯ: через ' + (fOk.t - tp) + ' с стало ' + fOk.now[FB_OK]
      : (span >= 120 ? 'ДЕРЖИТСЯ ' + span + ' с (≥ ' + Math.floor(span / 60) + ' проверок здоровья)'
        : 'держится ' + span + ' с — мало для вывода');
  } else if (pin[FB_OK]) V.здоровый = 'PUT ' + (pin[FB_OK].код || pin[FB_OK].ошибка);

  // 2. Мёртвый член.
  var dAlive = null;
  for (var i = 0; i < S.hist.length; i++) if (S.hist[i].муляж && typeof S.hist[i].муляж === 'object') dAlive = S.hist[i].муляж.alive;
  obs = series(FB_DEAD, part); tp = pin[FB_DEAD] ? pin[FB_DEAD].t : 0; span = lastT(obs) - tp;
  var hD = tookHold(obs, FB_DEAD, DUMMY);
  if (pinned(FB_DEAD) && hD === null) {
    V.мёртвый = 'нет данных: выбор после закрепления не прочитан';
  } else if (pinned(FB_DEAD) && !hD) {
    V.мёртвый = 'НА МЁРТВЫЙ НЕ ЗАКРЕПЛЯЕТСЯ: PUT ' + pin[FB_DEAD].код + ', выбор ' + firstValid(obs, FB_DEAD).now[FB_DEAD];
  } else if (pinned(FB_DEAD)) {
    var fD = firstNot(obs, FB_DEAD, DUMMY);
    V.мёртвый = fD ? 'УХОДИТ САМ: через ' + (fD.t - tp) + ' с стало ' + fD.now[FB_DEAD]
      : (span >= 120 ? 'ЗАСТРЕВАЕТ на муляже ' + span + ' с' : 'на муляже ' + span + ' с — мало для вывода');
  } else if (pin[FB_DEAD]) V.мёртвый = 'PUT ' + (pin[FB_DEAD].код || pin[FB_DEAD].ошибка) + (pin[FB_DEAD].ответ ? ' ' + pin[FB_DEAD].ответ : '');
  if (dAlive === true) V.муляж = 'ВНИМАНИЕ: муляж считается живым — выводы о мёртвом члене недостоверны';

  // 3. Обёртка: пропускает ли Ручной с мёртвым выбором и возвращается ли.
  if (pinned(MANUAL) && pin[MANUAL].обёртка_до !== MANUAL) {
    V.обёртка = 'вывод невозможен: до закрепления обёртка стояла на ' + pin[MANUAL].обёртка_до + ', а не на ' + MANUAL;
  } else if (pinned(MANUAL)) {
    tp = pin[MANUAL].t;
    obs = good(after(tp, 'до'), [WRAP]); span = lastT(obs) - tp;
    var fW = firstNot(obs, WRAP, MANUAL);
    V.обёртка = fW ? 'ПРОПУСКАЕТ ручную группу с мёртвым выбором: через ' + (fW.t - tp) + ' с стало ' + fW.now[WRAP]
      : (span >= 120 ? 'НЕ ПРОПУСКАЕТ: ' + span + ' с на ' + MANUAL + ' с мёртвым выбором' : 'рано судить (' + span + ' с)');
    var bc = S.возврат ? S.возврат.код : null;
    if (tb && !fW) {
      V.обёртка_возврат = 'не применимо: обёртка не уходила с ручной группы';
    } else if (tb && !(bc >= 200 && bc < 300)) {
      V.обёртка_возврат = 'возврат не выполнен: PUT ' + (bc || (S.возврат && S.возврат.ошибка) || '—');
    } else if (tb) {
      var back = good(after(0, 'после'), [WRAP]);
      var bk = null;
      for (var j = 0; j < back.length; j++) if (back[j].now[WRAP] === MANUAL) { bk = back[j]; break; }
      V.обёртка_возврат = bk ? 'ВОЗВРАЩАЕТСЯ к ручной группе через ' + (bk.t - tb) + ' с'
        : (lastT(back) - tb >= 120 ? 'НЕ ВОЗВРАЩАЕТСЯ за ' + (lastT(back) - tb) + ' с' : 'рано судить');
    }
  }

  // 4. url-test и load-balance: принимают ли PUT и держат ли.
  [[URLT, 'url_test'], [LB, 'load_balance']].forEach(function (x) {
    var p = pin[x[0]];
    if (!p) return;
    var obs = series(x[0], part), tp = p.t, span = lastT(obs) - tp;
    if (!(p.код >= 200 && p.код < 300)) { V[x[1]] = 'PUT ' + (p.код || p.ошибка) + (p.ответ ? ' ' + p.ответ : ''); return; }
    var h = tookHold(obs, x[0], p.ждали);
    if (h === null) { V[x[1]] = 'PUT ' + p.код + ', выбор после записи не прочитан'; return; }
    if (!h) { V[x[1]] = 'PUT ' + p.код + ', но выбор ' + firstValid(obs, x[0]).now[x[0]]; return; }
    var f = firstNot(obs, x[0], p.ждали);
    V[x[1]] = 'PUT ' + p.код + (f ? ', сброшено через ' + (f.t - tp) + ' с на ' + f.now[x[0]] : ', держится ' + span + ' с');
  });

  // 5. Сеть: датчик по ssid-policy против RH-AI (W — Wi-Fi, C — сотовая).
  var netRows = [];
  for (var k = 0; k < S.hist.length; k++) {
    var h = S.hist[k];
    netRows.push(h.t + 'с: ' + (h.now[REAL] || '?') + ' / ' + (h.now[NET] || '?'));
  }
  V.сеть = netRows.slice(-6).join('; ');
  if (pinned(NET)) {
    obs = series(NET, part); tp = pin[NET].t; span = lastT(obs) - tp;
    var fN = firstNot(obs, NET, pin[NET].ждали);
    V.сеть_ручной = fN ? 'ручной выбор сброшен через ' + (fN.t - tp) + ' с (' + fN.now[REAL] + ')' :
      'ручной выбор держится ' + span + ' с — сбросит ли смена сети, видно, если переключить Wi-Fi/сотовую';
  }
  return V;
}

// ── ГЛАВНАЯ ЦЕПОЧКА ─────────────────────────────────────────────────────
function main() {
  get('/', function (r) {
    A.прогрев = { код: r.status, мс: r.ms, повтор: !!r.повтор, ошибка: r.error };
    if (r.status !== 200) {
      A.ВЕРДИКТ = 'КОНТРОЛЛЕР НЕ ОТВЕТИЛ на прогрев: ' + (r.status || r.error) + '. Ничего не записано';
      return finish();
    }
    S = load();
    if (!S) S = { v: 1, t0: Date.now(), фаза: 'старт', hist: [] };
    A.фаза_до = S.фаза;
    observe(S.фаза, function (snap) {
      if (snap.now[FB_OK] === 'НЕТ' || snap.now[CMD] === 'НЕТ') {
        A.ВЕРДИКТ = 'ТЕСТОВЫХ ГРУПП ST19 НЕТ (404) — override не применился. Ничего не записано';
        S.hist = [];
        return finish();
      }
      if (S.фаза === 'старт') return start(snap);
      var now = Date.now();
      if (S.фаза === 'наблюдение' && now - S.tpinMs >= OBSERVE_MS && good(after(S.tpin, 'до'), KEY_GROUPS).length >= 3) return goBack();
      // Один снимок после возврата через 5 мин — это пять проверок здоровья по 60 с.
      if (S.фаза === 'возврат' && now - S.tbackMs >= BACK_MS && good(after(0, 'после'), [WRAP]).length >= 1) S.фаза = 'итог';
      finish();
    });
  });
}

function start(snap) {
  if (!S.картаГотова) return sweep(function () { if (S.картаГотова) start(snap); else finish(); });
  pinAll(snap, function (all) {
    if (!all) return finish();
    S.tpinMs = Date.now();
    S.tpin = Math.round((S.tpinMs - S.t0) / 1000);
    S.фаза = 'наблюдение';
    finish();
  });
}

function goBack() {
  if (FINISHED || !room(2)) return finish();
  write('put', MANUAL, 'DIRECT', function (r) {
    S.возврат = { код: r.status, ошибка: r.error };
    S.tbackMs = Date.now();
    S.tback = Math.round((S.tbackMs - S.t0) / 1000);
    S.фаза = 'возврат';
    finish();
  });
}

// ── ВЫВОД ───────────────────────────────────────────────────────────────
function finish() {
  if (FINISHED) return;
  FINISHED = true;
  try { clearTimeout(GUARD); } catch (e) {}
  var lines, color = '#FF9F0A';
  try {
    if (S) {
      A.фаза = S.фаза;
      A.снимков = S.hist.length;
      var V = verdicts();
      A.вердикты = V;
      A.карта = S.карта || null;
      A.среда = S.среда || null;
      A.закрепления = S.закрепления || null;
      A.история = S.hist;
      if (!save(S)) rep.err.push('состояние не сохранено — следующий прогон начнёт сначала');
      // Отчёт перехватчика ссылок, если Диана его открывала.
      try { A.перехват = json(G.$persistentStore.read('RH_ST19_cmd')); } catch (e) {}
      if (!A.ВЕРДИКТ) {
        A.ВЕРДИКТ = S.фаза === 'итог' ? 'ST19 ГОТОВО — override можно выключать'
          : 'ST19 идёт: фаза «' + S.фаза + '», снимков ' + S.hist.length;
        if (S.фаза === 'итог') color = '#34C759';
      }
    }
    lines = [A.ВЕРДИКТ];
    var V2 = A.вердикты || {};
    ['здоровый', 'мёртвый', 'муляж', 'обёртка', 'обёртка_возврат', 'url_test', 'load_balance', 'сеть_ручной', 'сеть']
      .forEach(function (k) { if (V2[k]) lines.push(k.replace('_', ' ') + ': ' + V2[k]); });
    if (A.перехват) lines.push('перехват ссылки: ' + JSON.stringify(A.перехват).slice(0, 160));
    if (A.карта && A.карта.length && A.фаза_до === 'старт') {
      lines.push('рычаги: ' + A.карта.map(function (r) { return r.м + ' ' + r.путь + ' → ' + r.итог; }).join('; '));
    }
    lines.push('Stash ' + (A.stash || '?') + ', ' + (Date.now() - T0) + ' мс' + (rep.err.length ? ' · ' + rep.err.join('; ') : ''));
  } catch (e0) {
    rep.err.push('сборка вывода упала: ' + String(e0));
    lines = ['СБОЙ ПРОБЫ: ' + String(e0)];
    color = '#FF3B30';
  }
  rep.ms = Date.now() - T0;
  try { console.log('[' + REV + '] ' + JSON.stringify(rep)); } catch (e2) {}
  try {
    // `url` в опциях уведомления в вики Stash не описан (researcher, 24.09):
    // откроется ли по нажатию страница перехватчика — часть опыта (идея 9).
    $notification.post('RouteHub ' + REV, lines[0], lines.slice(1).join('\n'),
      { clipboard: JSON.stringify(rep), url: CMD_URL });
  } catch (e3) {}
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'), icon: 'pin', backgroundColor: color });
  } catch (e4) { try { $done(); } catch (e5) {} }
}

GUARD = setTimeout(function () {
  if (!FINISHED) { rep.err.push('сторож: цепочка не завершилась'); finish(); }
}, GUARD_MS);

if (typeof G.$httpClient === 'undefined') {
  rep.err.push('нет $httpClient');
  finish();
} else {
  main();
}
// конец файла — хвостовой страж (вывод 49)
