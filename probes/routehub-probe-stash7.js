/*
 * RouteHub — ПРОБА STASH ST7. Один вопрос, одна минута.
 * ===========================================================================
 * ПОЧЕМУ НЕ ST6. Проба ST6 пыталась снять всё сразу и по расписанию Stash
 * выпадала в timeout. Разбор 24.08: Stash РАСТЯГИВАЕТ таймеры — замер ST5 дал
 * бюджет 33 с против 120 с по факту. Три ожидания WebSocket по 5 с номинала
 * превращались в минуту с лишним, а принудительного сторожа в ST6 не было
 * вовсе, хотя в ST5 он есть. Плюс плитка на Stash 3.4.1 нажатием не
 * запускается — работает только расписание.
 *
 * ST7 сделана из этих трёх выводов:
 *   1. ОДИН вопрос вместо десяти. Тот, что висит в проекте полтора месяца:
 *      видно ли в `/connections` ИМЯ ХОСТА, а не только адрес. Если видно —
 *      журнал незагрузившихся доменов делается без MITM, и вывод 8 проекта
 *      пересматривается.
 *   2. Никаких WebSocket и никаких длинных ожиданий: только два запроса.
 *   3. Сторож, как в ST5: отчёт уходит, даже если запрос завис.
 *
 * ТОЛЬКО ЧТЕНИЕ. Ни одной записи: ни PUT, ни PATCH, ни смены политики.
 * Личное наружу не идёт — из соединений берутся только доменные имена и счёт,
 * первые восемь имён для примера, остальное числом.
 */

var REV = 'ST7';
var T0 = Date.now();
var BUDGET_MS = 8000;                 // настоящие миллисекунды, через Date.now()
var rep = { rev: REV, ts: new Date().toISOString(), ans: {}, err: [] };
var G = (typeof globalThis !== 'undefined') ? globalThis : this;

var CTRL = 'http://127.0.0.1:9090', AUTH = '';
try {
  CTRL = ($environment && $environment['controller-url']) || CTRL;
  AUTH = ($environment && $environment['controller-authorization']) || '';
  rep.ans.stash = ($environment && $environment['stash-version']) || '?';
} catch (e) { rep.err.push('нет $environment'); }
CTRL = String(CTRL).replace(/\/+$/, '');

function get(path, cb) {
  var o = { url: CTRL + path, timeout: 3 };
  if (AUTH) o.headers = { Authorization: AUTH };
  var done = false;
  function once(body, e) { if (done) return; done = true; cb(body, e); }
  try {
    G.$httpClient.get(o, function (e, r, body) {
      once(e ? null : body, e ? String(e) : (r && r.status >= 400 ? 'HTTP ' + r.status : null));
    });
  } catch (e2) { once(null, String(e2)); }
}

// Поля, в которых клиенты держат имя хоста. `remoteHost` добавлен не наугад:
// именно так поле называется у Surge (замер SG2), и в разборе SG2 я его
// сначала пропустил, объявив, что имён не видно.
var HOSTFIELDS = ['host', 'remoteHost', 'sniffHost', 'domain', 'serverName'];

function stepConnections(next) {
  get('/connections', function (body, e) {
    if (e || !body) { rep.ans.connections = 'не ответил: ' + (e || 'пусто'); next(); return; }
    var d = null;
    try { d = JSON.parse(body); } catch (e2) { rep.ans.connections = 'не разобрался: ' + body.slice(0, 120); next(); return; }
    var list = (d && (d.connections || d.Connections)) || [];
    rep.ans.соединений = list.length;
    if (!list.length) { rep.ans.ИМЯ_ХОСТА = 'СПИСОК ПУСТ — трафика не было'; next(); return; }
    var found = '', hosts = {}, n = 0;
    for (var i = 0; i < list.length; i++) {
      var m = list[i].metadata || list[i].Metadata || list[i];
      for (var f = 0; f < HOSTFIELDS.length; f++) {
        var v = m && m[HOSTFIELDS[f]];
        if (v && typeof v === 'string' && /[a-z]/i.test(v)) {
          if (!found) found = HOSTFIELDS[f];
          if (!hosts[v]) { hosts[v] = 1; n++; } else hosts[v]++;
          break;
        }
      }
    }
    rep.ans.ИМЯ_ХОСТА = found ? ('ДА, поле «' + found + '»') : 'НЕТ, только адреса';
    rep.ans.уникальных = n;
    var names = [];
    for (var h in hosts) { names.push(h); if (names.length >= 8) break; }
    rep.ans.примеры = names;
    // Ключи одной записи — чтобы в следующий раз не гадать, что там лежит.
    try {
      var m0 = list[0].metadata || list[0];
      rep.ans.поля_записи = [];
      for (var k in m0) rep.ans.поля_записи.push(k);
    } catch (e3) {}
    next();
  });
}

function stepDns(next) {
  // Второй вопрос, дешёвый: есть ли у Stash кэш DNS с доменами. У Surge такой
  // нашёлся (SG3, /v1/dns) и он закрывает журнал доменов вообще без MITM.
  get('/dns/cache', function (body, e) {
    if (e || !body) { rep.ans.кэш_DNS = 'нет (' + (e || 'пусто') + ')'; next(); return; }
    var d = null; try { d = JSON.parse(body); } catch (e2) {}
    var arr = d && (d.dnsCache || d.cache || d.entries || (d.length !== undefined ? d : null));
    rep.ans.кэш_DNS = arr && arr.length ? ('ДА, записей ' + arr.length) : ('ответил, но пусто: ' + String(body).slice(0, 80));
    next();
  });
}

var FINISHED = false;
function finish() {
  if (FINISHED) return;
  FINISHED = true;
  rep.ms = Date.now() - T0;
  var a = rep.ans;
  var lines = [
    'имя хоста: ' + (a.ИМЯ_ХОСТА || '?'),
    'соединений: ' + (a.соединений != null ? a.соединений : '?') + ', уникальных ' + (a.уникальных != null ? a.уникальных : '?'),
    'кэш DNS: ' + (a.кэш_DNS || '?'),
    'Stash ' + (a.stash || '?') + ', ' + rep.ms + ' мс',
  ];
  console.log('[' + REV + '] ' + JSON.stringify(rep));
  try {
    $notification.post('RouteHub ' + REV, lines[0], lines.slice(1).join('\n'),
      { clipboard: JSON.stringify(rep) });
  } catch (e) {}
  var color = '#8E8E93';
  if (typeof a.ИМЯ_ХОСТА === 'string') {
    if (a.ИМЯ_ХОСТА.indexOf('ДА') === 0) color = '#34C759';
    else if (a.ИМЯ_ХОСТА.indexOf('НЕТ') === 0) color = '#FF9F0A';
  }
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'),
            icon: 'network', backgroundColor: color });
  } catch (e2) { try { $done(); } catch (e3) {} }
}

// Сторож. Номинал делится на 3,6 — во столько раз Stash растягивает таймеры
// по замеру ST5. Точность не нужна: он обязан сработать РАНЬШЕ лимита.
setTimeout(function () {
  if (!FINISHED) { rep.err.push('сторож: бюджет ' + BUDGET_MS + ' мс исчерпан'); finish(); }
}, Math.round(BUDGET_MS / 3.6));

stepConnections(function () { stepDns(finish); });
