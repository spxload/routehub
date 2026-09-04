/*
 * RouteHub — ПРОБА STASH ST14. Один вопрос.
 * ===========================================================================
 * ВОПРОС: ЧТО ИМЕННО отвечает ядро, когда меряет обходной узел, — какая
 * ошибка стоит за словом «timeout».
 *
 * ПОЧЕМУ ИМЕННО ЭТОТ. После S-draft-5 обходные узлы наконец МЕРЯЮТСЯ, но
 * все до одного дают таймаут, тогда как в Loon те же узлы отвечают и
 * работают. Дальше гадать нельзя: у обходных узлов есть три особенности
 * разом — порт 443 (у всех рабочих 52006 или 8443), инфраструктура
 * `deploy-assure.ru` и половина на `type=ws`. Любая из них может быть
 * причиной, и различить их «снаружи» нечем.
 *
 * Ядро при замере знает точную причину отказа: не разобрался TLS, не
 * поднялось соединение, не поддержан транспорт. `GET /proxies/{имя}/delay`
 * при неудаче возвращает тело с описанием — проба его и забирает.
 *
 * ЧТО ЭТО ДАСТ. Различит три версии сразу:
 *   • ошибка вида «handshake/tls» — виноват SNI или отпечаток, то есть НАШЕ
 *     описание узла (у Stash в схеме vless поля `sni` нет вовсе — есть
 *     `servername` у Clash-совместимых ядер; наш профиль пишет `sni`);
 *   • «connection refused / i/o timeout» на TCP — узел недоступен с этой
 *     сети, и мы тут ни при чём;
 *   • что-то про `ws`/`flow` — виноват транспорт, и тогда `ws`-половина
 *     обхода отличается от `tcp`-половины.
 *
 * ПРАВИЛО 1. Проба ДЕЛАЕТ замер через обходные узлы — сознательно и в
 * минимальном объёме: не больше BYPASS_N узлов, по одному HEAD на
 * `generate_204`, порядка килобайта каждый. С S-draft-5 ядро и так меряет
 * их раз в час; три лишних запроса на фоне этого — ничто, а альтернатива —
 * продолжать гадать. Для сравнения проба меряет ещё и ОДИН рабочий узел:
 * без опорной точки «таймаут» ничего не значит.
 * ПРАВИЛО 2. Только GET. Ни PUT, ни PATCH.
 *
 * КАК ЗАПУСКАТЬ. Расписанием `cron`, туннель поднят. Профиль на устройстве
 * должен быть УЖЕ S-draft-5 (иначе замер обходных выключен и проба честно
 * это скажет).
 */

var REV = 'ST14';
var T0 = Date.now();
var BUDGET_MS = 60000;
var CTRL_SEC = 5;                  // обычный запрос к контроллеру
// ⛔ ДЕФЕКТ ПЕРВОЙ РЕДАКЦИИ, найденный прогонами 04.09. Клиентский тайм-аут
// был равен серверному (5 с и 5000 мс), и проба рубила СВОЙ ЖЕ запрос ровно
// на 5008–5017 мс: в выгрузке это выглядело как `статус: 0` и
// «context deadline exceeded», а вердикт объявлял «ОБХОД МОЛЧИТ». Молчала
// проба. Тот же узел в соседних прогонах отвечал за 144–605 мс.
// ПРАВИЛО: клиентский тайм-аут обязан быть С ЗАПАСОМ больше серверного —
// иначе измеряется не узел, а собственное терпение.
// ⚠️ ФАКТ О STASH, установленный прогонами 04.09: параметр `?timeout=` у
// `/delay` ЯДРОМ ИГНОРИРУЕТСЯ — действует `benchmark-timeout` самого узла.
// Доказательство: обычный узел с `benchmark-timeout: 3` отказывал ровно на
// 3034–3040 мс (четыре прогона подряд, разброс 6 мс — это не сеть, это
// тайм-аут), а обходные с `benchmark-timeout: 10` (S-draft-6) упирались уже
// в НАШ клиентский предел. Значит временем замера управляет профиль, а не
// проба; здесь параметр оставлен как верхняя граница на случай, если в
// другой версии клиента он всё же учитывается.
var DELAY_MS = 10000;              // ядру: верхняя граница, см. выше
var DELAY_CTRL_SEC = 20;           // сколько ждём ответа контроллера
var BYPASS_N = 3;
// ДВА рабочих узла, а не один. Прогоны 04.09, 19:50–20:05: опорным узлом
// оказалась Польша, и она отказывала четыре раза подряд — вердикт объявлял
// «СЕТЬ: молчат и рабочий, и обходные», хотя в те же минуты Германия [Обход]
// #2 отвечала за 505 мс. Одна опорная точка делает вердикт заложником
// одного плохого узла.
var NORMAL_N = 2;
var DELAY_URL = 'http://connectivitycheck.gstatic.com/generate_204';
var BYPASS = 'Обход';
var POOL = 'RH-АВТО-W';
var POOL_C = 'RH-АВТО-C';
var SEP = ' · ';

var rep = { rev: REV, ts: new Date().toISOString(), ans: {}, err: [] };
var G = (typeof globalThis !== 'undefined') ? globalThis : this;

var CTRL = 'http://127.0.0.1:9090', AUTH = '';
try {
  CTRL = ($environment && $environment['controller-url']) || CTRL;
  AUTH = ($environment && $environment['controller-authorization']) || '';
  rep.ans.stash = ($environment && $environment['stash-version']) || '?';
} catch (e) { rep.err.push('нет $environment'); }
CTRL = String(CTRL).replace(/\/+$/, '');

function get(path, cb, sec) {
  var o = { url: CTRL + path, timeout: sec || CTRL_SEC };
  if (AUTH) o.headers = { Authorization: AUTH };
  var done = false;
  function once(b, st, e) { if (done) return; done = true; cb(b, st, e); }
  try {
    G.$httpClient.get(o, function (e, r, body) {
      once(e ? null : body, (r && r.status) || 0, e ? String(e) : null);
    });
  } catch (e2) { once(null, 0, String(e2)); }
}

function isBypass(n) { return String(n).indexOf(BYPASS) >= 0; }
function shortName(n) {
  var s = String(n);
  var i = s.indexOf(SEP);
  return i >= 0 ? s.slice(0, i) : s;
}

var MAP = null, picked = [], out = {};

function stepList(next) {
  get('/proxies', function (body, st, e) {
    if (!body) { rep.ans.ВЕРДИКТ = 'контроллер не ответил: ' + (e || st); next(); return; }
    var d = null;
    try { d = JSON.parse(body); } catch (e2) { rep.ans.ВЕРДИКТ = 'ответ /proxies не разобран'; next(); return; }
    MAP = (d && (d.proxies || d.Proxies)) || d || {};
    var g = MAP[POOL] || MAP[POOL_C];
    var members = (g && (g.all || g.All)) || [];
    var nb = 0, nn = 0;
    for (var i = 0; i < members.length; i++) {
      var nm = members[i];
      if (!MAP[nm]) continue;
      if (isBypass(nm)) { if (nb < BYPASS_N) { picked.push({ n: nm, b: true }); nb++; } }
      else if (nn < NORMAL_N) { picked.push({ n: nm, b: false }); nn++; }
      if (nb >= BYPASS_N && nn >= NORMAL_N) break;
    }
    rep.ans.членов_в_пуле = members.length;
    rep.ans.взято = { обходных: nb, рабочий: nn };
    // Что о них думает ядро БЕЗ нашего замера: поле delay в /proxies.
    var view = {};
    for (var k = 0; k < picked.length; k++) {
      var p = MAP[picked[k].n] || {};
      view[shortName(picked[k].n)] = {
        alive: (p.alive !== undefined ? p.alive : '?'),
        delay: (p.delay !== undefined ? p.delay : 'нет поля'),
        обход: picked[k].b,
      };
    }
    rep.ans.глазами_ядра = view;
    next();
  });
}

// Замер по одному, с сохранением СЫРОГО тела ответа: в нём и лежит причина.
function measure(i, next) {
  if (i >= picked.length || (Date.now() - T0) > BUDGET_MS - 7000) { next(); return; }
  var it = picked[i];
  var q = '/proxies/' + encodeURIComponent(it.n) + '/delay?timeout=' + DELAY_MS +
    '&url=' + encodeURIComponent(DELAY_URL);
  var t0 = Date.now();
  get(q, function (body, st, e) {
    var wall = Date.now() - t0;
    var rec = { обход: it.b, статус: st, стенка_мс: wall };
    if (e) rec.ошибка_запроса = e;
    // Обрыв по НАШЕМУ тайм-ауту — это не «узел молчит», а «проба не
    // дождалась». Смешивать эти два исхода нельзя: именно так первая
    // редакция и объявляла живой узел мёртвым.
    if (!body && e && (String(e).indexOf('Client.Timeout') >= 0 ||
        String(e).indexOf('deadline') >= 0)) rec.не_дождались = true;
    if (body) {
      var d = null;
      try { d = JSON.parse(body); } catch (e2) { d = null; }
      if (d && d.delay != null) rec.задержка = d.delay;
      // ГЛАВНОЕ: текст причины. Ядро кладёт его в поле message/error, но
      // форма у Stash не документирована, поэтому берём тело целиком,
      // обрезав до разумного размера. Секретов в нём нет: это описание
      // сетевой ошибки.
      rec.ответ = String(body).slice(0, 300);
    }
    out[shortName(it.n)] = rec;
    measure(i + 1, next);
  }, DELAY_CTRL_SEC);
}

function verdict() {
  if (rep.ans.ВЕРДИКТ) return rep.ans.ВЕРДИКТ;
  var okB = 0, badB = 0, waitB = 0, okN = 0, badN = 0, texts = [];
  for (var k in out) {
    var r = out[k];
    var ok = (r.задержка != null && r.задержка > 0);
    if (r.обход) {
      if (ok) okB++;
      else if (r.не_дождались) waitB++;
      else { badB++; if (r.ответ) texts.push(r.ответ); }
    } else { if (ok) okN++; else badN++; }
  }
  rep.ans.итог = { обход_ответил: okB, обход_отказал: badB, не_дождались: waitB,
                   рабочий_ответил: okN, рабочий_молчит: badN };
  if (!okN && !badN) return 'НЕПОЛНО: рабочий узел не измерен, сравнивать не с чем';
  // «СЕТЬ» объявляется, только если НИ ОДИН рабочий узел не ответил. С одной
  // опорной точкой этот вердикт выносился по единственному плохому узлу.
  if (!okN && badN && (badB || waitB)) return 'СЕТЬ: не ответил ни один узел, ни рабочий, ни обходной — дело не в описании узла, а в подключении';
  if (okB) return 'ОБХОД ЖИВ (' + okB + ' из ' + (okB + badB + waitB) +
    '), отказало ' + badB + ', не дождались ' + waitB;
  if (waitB && !badB) return 'НЕОПРЕДЕЛЁННО: ни один обходной не успел в тайм-аут — поднять DELAY_CTRL_SEC';
  return 'ОБХОД ОТКАЗАЛ при живом рабочем узле — ответ ядра: ' +
    (texts.length ? texts[0] : 'тело пустое');
}

var FINISHED = false, GUARD = null;
function finish() {
  if (FINISHED) return;
  FINISHED = true;
  try { clearTimeout(GUARD); } catch (e) {}
  rep.ans.ВЕРДИКТ = verdict();
  rep.ans.замеры = out;
  rep.ms = Date.now() - T0;
  var a = rep.ans;
  var lines = [
    a.ВЕРДИКТ,
    'глазами ядра: ' + JSON.stringify(a.глазами_ядра || {}),
    'замеры: ' + JSON.stringify(out),
    'Stash ' + (a.stash || '?') + ', ' + rep.ms + ' мс',
  ];
  console.log('[' + REV + '] ' + JSON.stringify(rep));
  try {
    $notification.post('RouteHub ' + REV, lines[0], lines.slice(1).join('\n'),
      { clipboard: JSON.stringify(rep) });
  } catch (e2) {}
  var color = '#FF9F0A';
  if (a.ВЕРДИКТ.indexOf('ОБХОД ЖИВ') === 0) color = '#34C759';
  else if (a.ВЕРДИКТ.indexOf('ОБХОД ОТКАЗАЛ') === 0) color = '#FF3B30';
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'),
            icon: 'bolt.horizontal.circle', backgroundColor: color });
  } catch (e3) { try { $done(); } catch (e4) {} }
}

GUARD = setTimeout(function () {
  if (!FINISHED) { rep.err.push('сторож: цепочка не завершилась'); finish(); }
}, 90000);

stepList(function () { measure(0, finish); });
// конец файла — хвостовой страж (вывод 49)
