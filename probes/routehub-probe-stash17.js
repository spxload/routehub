/*
 * RouteHub — ПРОБА STASH ST17. Один вопрос.
 * ===========================================================================
 * ВОПРОС: видно ли в журнале соединений Stash, что обращение к ИИ-сервису
 * ЗАКОНЧИЛОСЬ НЕУДАЧЕЙ, — и если да, то по какому полю.
 *
 * ПОЧЕМУ ЭТО ГЛАВНЫЙ ВОПРОС. Всё, что проект делал до сих пор, — это
 * ПРЕДСКАЗАНИЕ: проба стучится к сервису сама и говорит «минуту назад
 * пускало». Диана справедливо возражает, что нужна уверенность, а не
 * предсказание. Уверенность даёт только ФАКТ: телефон и так открывает эти
 * сервисы каждый день, и ядро записывает каждое соединение. Если в записи
 * виден исход, то вопрос «работает ли» перестаёт быть гаданием.
 *
 * ЧТО ИМЕННО НЕИЗВЕСТНО. По ST7 запись `/connections` содержит поля
 * `Id, network, inbound, sourceIP, destinationIP, sourcePort, destinationPort,
 * host, processPath, pid, ruleType, rulePayload, chain, tracing, log`.
 * Состав известен, ЗНАЧЕНИЯ — нет. Два поля выглядят обещающе (`log`,
 * `tracing`), но что в них лежит и появляется ли там причина отказа, проект
 * не проверял ни разу. Плюс `/connections` отдаёт, по всей видимости, только
 * ЖИВЫЕ соединения, а неудачное живёт доли секунды — поэтому проба берёт
 * несколько снимков подряд, как ST13, и показывает поля целиком.
 *
 * ЧТО ЭТО ДАСТ.
 *   • Видно исход — строится журнал: «Gemini через узел X не открылся в
 *     14:20». Это уже не предсказание, и именно этого не хватает.
 *   • Не видно — направление закрыто замером, и мы перестаём на него
 *     надеяться. Отрицательный ответ здесь тоже результат.
 *
 * ГРАНИЦА ПРИВАТНОСТИ, и она здесь не формальность. Проба ВЫГРУЖАЕТ ИМЕНА
 * ХОСТОВ, а телефон ходит не только в ИИ-сервисы. Поэтому наружу идут ТОЛЬКО
 * соединения к хостам из списка WATCH ниже; всё остальное считается и
 * выводится ЧИСЛОМ, без имён. То же решение, что в ST13.
 *
 * ПРАВИЛО 2. Только GET `/connections`, ничего не пишем.
 * ПРАВИЛО 1 не задействовано: проба не ходит через узлы вовсе, она читает
 * журнал у себя на устройстве. Обходной трафик не тратится ни на байт.
 *
 * КАК ПОЛЬЗОВАТЬСЯ. Поставить, и ПОЛЬЗОВАТЬСЯ ТЕЛЕФОНОМ КАК ОБЫЧНО: открыть
 * ChatGPT, Gemini, Grok — особенно тот, который «не работает». Проба идёт раз
 * в минуту и ловит то, что происходит в это время. Прислать выгрузку.
 */

var REV = 'ST17';
var T0 = Date.now();

var BUDGET_MS = 45000;
var GUARD_MS = 30000;
var CTRL_SEC = 5;
var SNAPSHOTS = 20;            // сколько раз опросить журнал
var SNAP_GAP = 700;            // номинальная пауза между снимками, мс

// ПРИЗНАК ОТКАЗА, НАЙДЕННЫЙ ПРОГОНОМ 06.09, 22:30.
// Диана вручную перебирала узлы и открывала сервисы. Журнал показал по каждой
// паре «сервис + узел» число отданных и принятых байт, и одна строка выбилась:
// grok.com через 🇩🇪 Германия ⭐🟢 — отдано 1528 байт, ПРИНЯТО НОЛЬ, соединение
// провисело так десять снимков. Тот же Grok в те же секунды через три других
// узла отдал 6–9 КБ. Это не предсказание и не проба: это её собственный
// запрос и отсутствие ответа на него.
// Сошлось независимо: Германия ⭐🟢 — узел с выходом 5.231.105.x, которому
// Grok отказывал 403 в дневном прогоне ST15. Два метода, разное время, один
// виновник.
// ПОЧЕМУ НУЖЕН ПОРОГ ПО СНИМКАМ. Только что открытое соединение ещё не успело
// получить ответ, и ноль у него ничего не значит. Считаем отказом только то,
// что провисело без ответа MIN_SNAPS снимков подряд.
var MIN_SNAPS = 5;             // снимков без ответа, прежде чем судить
var MIN_UP = 200;              // байт отдано — иначе запрос толком не ушёл

// Хосты, чьи имена разрешено выгружать. Всё остальное — только счётчик.
var WATCH = ['chatgpt.com', 'openai.com', 'oaistatic.com', 'oaiusercontent.com',
             'claude.ai', 'anthropic.com',
             'gemini.google.com', 'bard.google.com', 'aistudio.google.com',
             'generativelanguage.googleapis.com',
             'grok.com', 'x.ai', 'perplexity.ai'];

var rep = { rev: REV, ts: new Date().toISOString(), ans: {}, err: [] };
var G = (typeof globalThis !== 'undefined') ? globalThis : this;

var CTRL = 'http://127.0.0.1:9090', AUTH = '';
try {
  CTRL = ($environment && $environment['controller-url']) || CTRL;
  AUTH = ($environment && $environment['controller-authorization']) || '';
  rep.ans.stash = ($environment && $environment['stash-version']) || '?';
} catch (e) { rep.err.push('нет $environment'); }
CTRL = String(CTRL).replace(/\/+$/, '');

var FINISHED = false;
function left() { return BUDGET_MS - (Date.now() - T0); }

function ctl(path, cb) {
  var o = { url: CTRL + path, timeout: CTRL_SEC };
  if (AUTH) o.headers = { Authorization: AUTH };
  var done = false;
  function once(b, e) { if (done) return; done = true; cb(b, e); }
  try {
    G.$httpClient.get(o, function (e, r, body) {
      once(e ? null : body, e ? String(e) : ((r && r.status >= 400) ? ('HTTP ' + r.status) : null));
    });
  } catch (e2) { once(null, String(e2)); }
}

// ⛔ ДЕФЕКТ ПЕРВОЙ РЕДАКЦИИ, найденный первым же прогоном на устройстве
// 06.09, 22:12. Проверка суффикса была написана так:
//     h.indexOf('.' + W) === h.length - W.length - 1
// и это КЛАССИЧЕСКАЯ ловушка «минус единицы»: когда подстроки нет, indexOf
// возвращает -1, а правая часть даёт -1 у любого хоста, чья длина ровно на
// единицу МЕНЬШЕ длины маркера. В итоге чужие хосты объявлялись ИИ-сервисами
// по одному лишь совпадению длины: `api.ip.sb` (9) -> `claude.ai` (9),
// `mask.icloud.com` (15) -> `bard.google.com` (15), `fonts.gstatic.com` (17)
// -> `gemini.google.com` (17), `js.stripe.com` (13) -> `oaistatic.com` (13),
// `pd.itunes.apple.com` (19) -> `aistudio.google.com` (19).
// ЦЕНА ОШИБКИ ЗДЕСЬ НЕ В ЦИФРАХ, А В ПРИВАТНОСТИ: имена личных хостов
// выгружались наружу под видом ИИ-сервисов — ровно то, что фильтр обязан был
// не допустить. Сравнение переписано на явную проверку хвоста без арифметики
// с индексами.
function watched(host) {
  var h = String(host || '').toLowerCase();
  if (!h) return '';
  for (var i = 0; i < WATCH.length; i++) {
    var w = WATCH[i];
    if (h === w) return w;
    if (h.length > w.length + 1 && h.slice(h.length - w.length - 1) === '.' + w) return w;
  }
  return '';
}
function shortNode(chain) {
  if (!chain || !chain.length) return '?';
  var s = String(chain[0]), i = s.indexOf(' · ');
  return i >= 0 ? s.slice(0, i) : s;
}
// Байты приходят объектом {current,last,max,total} либо числом — обе формы
// встречались в замерах проекта.
function num(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  return +(v.total != null ? v.total : (v.current != null ? v.current : 0)) || 0;
}

var seen = {}, snaps = 0, other = 0, totalSeen = 0;
// ПОЛЯ, КОТОРЫХ МЫ НЕ ЗНАЕМ, — главная ценность прогона. Их содержимое
// выгружается ЦЕЛИКОМ (обрезанным по длине) только для наблюдаемых хостов:
// именно в них может лежать исход, и гадать вместо чтения нельзя.
var UNKNOWN = ['log', 'tracing', 'Log', 'Tracing', 'error', 'Error', 'state', 'State', 'closed', 'Closed'];

function snap(cb) {
  if (FINISHED || snaps >= SNAPSHOTS || left() < 8000) { cb(); return; }
  ctl('/connections', function (body, e) {
    snaps++;
    if (!body) { if (!rep.ans.ВЕРДИКТ) rep.ans.ВЕРДИКТ = 'контроллер не ответил: ' + (e || 'пусто'); cb(); return; }
    var d = null;
    try { d = JSON.parse(body); } catch (e2) { rep.ans.ВЕРДИКТ = 'ответ /connections не разобран'; cb(); return; }
    var list = (d && (d.connections || d.Connections)) || [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i] || {}, m = c.metadata || c.Metadata || c;
      totalSeen++;
      var w = watched(m.host || m.Host);
      if (!w) { other++; continue; }
      var id = String(c.id || c.Id || (w + ':' + i));
      var rec = seen[id];
      if (!rec) {
        rec = seen[id] = {
          сервис: w, хост: String(m.host || m.Host),
          правило: String(c.rule || c.Rule || '') + (c.rulePayload ? (' ' + c.rulePayload) : ''),
          узел: shortNode(c.chains || c.chain || c.Chains),
          снимков: 0, вверх: 0, вниз: 0, поля: {}
        };
      }
      rec.снимков++;
      rec.вверх = Math.max(rec.вверх, num(c.upload || c.Upload));
      rec.вниз = Math.max(rec.вниз, num(c.download || c.Download));
      // При РУЧНОМ выборе узла правил нет (`NO-RULE`), и цепочка бывает
      // пустой, зато ядро пишет выбранный узел прямо в лог строкой
      // «connect with selected proxy: <имя> · <метрики>». Прогон 22:30
      // показал, что это единственное место, где узел назван в таком режиме.
      if (rec.узел === '?' || !rec.узел) {
        var lg = c.log || c.Log || m.log;
        var ls = (typeof lg === 'string') ? lg : (function () { try { return JSON.stringify(lg); } catch (e4) { return ''; } })();
        // ⛔ Первая редакция резала по `]`, а в имени узла есть `[VPN]` —
        // получалось «🇵🇱 ⭐ 🟢 Польша [VPN». Границей служит хвост метрик
        // ` · `, кавычка или конец строки, но НЕ скобка.
        var mm = /connect with selected proxy:\s*(.+?)(?:\s·\s|"|\\|$)/.exec(ls || '');
        if (mm && mm[1]) {
          rec.узел = String(mm[1]).replace(/^\s+|\s+$/g, '');
          rec.выбран_вручную = true;
        }
      }
      // Неизвестные поля — из самой записи и из metadata.
      for (var u = 0; u < UNKNOWN.length; u++) {
        var k = UNKNOWN[u];
        var v = (c[k] !== undefined) ? c[k] : m[k];
        if (v === undefined || v === null || v === '') continue;
        var s = (typeof v === 'string') ? v : (function () { try { return JSON.stringify(v); } catch (e3) { return String(v); } })();
        if (s && s !== '{}' && s !== '[]') rec.поля[k] = String(s).slice(0, 200);
      }
    }
    setTimeout(function () { snap(cb); }, SNAP_GAP);
  });
}

var GUARD = null;
function finish() {
  if (FINISHED) return;
  FINISHED = true;
  try { clearTimeout(GUARD); } catch (e) {}
  var lines, color = '#FF9F0A';
  try {
    var rows = [], withFields = 0, svc = {}, немые = [], живые = 0;
    for (var id in seen) {
      if (!seen.hasOwnProperty(id)) continue;
      var r = seen[id];
      var nf = 0; for (var k in r.поля) if (r.поля.hasOwnProperty(k)) nf++;
      if (nf) withFields++;
      svc[r.сервис] = (svc[r.сервис] || 0) + 1;
      // ГЛАВНЫЙ ВЫВОД ПРОБЫ: запрос ушёл, ответа нет.
      if (r.снимков >= MIN_SNAPS && r.вверх >= MIN_UP && r.вниз === 0) {
        r.ИТОГ = 'ОТВЕТА НЕТ';
        немые.push(r.сервис + ' через ' + (r.узел || '?'));
      } else if (r.вниз > 0) { r.ИТОГ = 'ответил'; живые++; }
      else r.ИТОГ = 'рано судить (' + r.снимков + ' снимков)';
      rows.push(r);
    }
    rep.ans.снимков = snaps;
    rep.ans.соединений_всего = totalSeen;
    rep.ans.чужих_не_названо = other;      // счётчик без имён — граница приватности
    rep.ans.ии_соединений = rows.length;
    rep.ans.по_сервисам = svc;
    rep.ans.с_неизвестными_полями = withFields;
    rep.ans.ответили = живые;
    if (немые.length) rep.ans.БЕЗ_ОТВЕТА = немые;
    rep.ans.соединения = rows;
    if (!rep.ans.ВЕРДИКТ) {
      if (!rows.length) {
        rep.ans.ВЕРДИКТ = 'ИИ-СОЕДИНЕНИЙ НЕ БЫЛО за ' + snaps + ' снимков. ' +
          'Это не отказ: журнал показывает только то, что происходит ПРЯМО СЕЙЧАС. ' +
          'Нужно открыть ИИ-сервис на телефоне и повторить прогон';
      } else if (немые.length) {
        // Дубликаты убираем: одна и та же пара «сервис + узел» может дать
        // несколько соединений, а читать это должен человек.
        var uniq = [], mark = {};
        for (var q = 0; q < немые.length; q++) if (!mark[немые[q]]) { mark[немые[q]] = 1; uniq.push(немые[q]); }
        rep.ans.ВЕРДИКТ = 'НЕ ОТВЕТИЛИ: ' + uniq.join('; ') +
          ' — запрос ушёл, ответа ноль. Ответили ' + живые + ' из ' + rows.length;
      } else if (withFields) {
        rep.ans.ВЕРДИКТ = 'ВСЁ ОТВЕЧАЕТ: ' + живые + ' из ' + rows.length +
          ' ИИ-соединений получили ответ, молчащих нет';
      } else {
        rep.ans.ВЕРДИКТ = 'ИИ-соединений ' + rows.length + ', но поля log/tracing ПУСТЫ у всех — ' +
          'исход по журналу не читается, направление закрыто замером';
      }
    }
    rep.ms = Date.now() - T0;
    lines = [
      rep.ans.ВЕРДИКТ,
      'снимков ' + snaps + ', соединений всего ' + totalSeen + ', из них ИИ ' + rows.length +
        ', чужих (имена не выгружаются) ' + other,
      (rep.ans.БЕЗ_ОТВЕТА ? '⛔ без ответа: ' + rep.ans.БЕЗ_ОТВЕТА.join('; ') + '\n' : '') +
        'по сервисам: ' + JSON.stringify(svc),
      'соединения: ' + JSON.stringify(rows),
      'Stash ' + (rep.ans.stash || '?') + ', ' + rep.ms + ' мс'
    ];
    if (немые.length) color = '#FF3B30';
    else if (rows.length && withFields) color = '#34C759';
  } catch (e0) {
    rep.err.push('сборка вывода упала: ' + String(e0));
    lines = ['СБОЙ ПРОБЫ: ' + String(e0)];
    color = '#FF3B30';
  }
  try { console.log('[' + REV + '] ' + JSON.stringify(rep)); } catch (e2) {}
  try {
    $notification.post('RouteHub ' + REV, lines[0], lines.slice(1).join('\n'),
      { clipboard: JSON.stringify(rep) });
  } catch (e3) {}
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'),
            icon: 'doc.text.magnifyingglass', backgroundColor: color });
  } catch (e4) { try { $done(); } catch (e5) {} }
}

GUARD = setTimeout(function () {
  if (!FINISHED) { rep.err.push('сторож: цепочка не завершилась'); finish(); }
}, GUARD_MS);

snap(finish);
// конец файла — хвостовой страж (вывод 49)
