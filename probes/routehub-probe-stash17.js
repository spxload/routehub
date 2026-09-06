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

function watched(host) {
  var h = String(host || '').toLowerCase();
  if (!h) return '';
  for (var i = 0; i < WATCH.length; i++) {
    if (h === WATCH[i] || h.indexOf('.' + WATCH[i]) === h.length - WATCH[i].length - 1) return WATCH[i];
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
    var rows = [], withFields = 0, svc = {};
    for (var id in seen) {
      if (!seen.hasOwnProperty(id)) continue;
      var r = seen[id];
      var nf = 0; for (var k in r.поля) if (r.поля.hasOwnProperty(k)) nf++;
      if (nf) withFields++;
      svc[r.сервис] = (svc[r.сервис] || 0) + 1;
      rows.push(r);
    }
    rep.ans.снимков = snaps;
    rep.ans.соединений_всего = totalSeen;
    rep.ans.чужих_не_названо = other;      // счётчик без имён — граница приватности
    rep.ans.ии_соединений = rows.length;
    rep.ans.по_сервисам = svc;
    rep.ans.с_неизвестными_полями = withFields;
    rep.ans.соединения = rows;
    if (!rep.ans.ВЕРДИКТ) {
      if (!rows.length) {
        rep.ans.ВЕРДИКТ = 'ИИ-СОЕДИНЕНИЙ НЕ БЫЛО за ' + snaps + ' снимков. ' +
          'Это не отказ: журнал показывает только то, что происходит ПРЯМО СЕЙЧАС. ' +
          'Нужно открыть ИИ-сервис на телефоне и повторить прогон';
      } else if (withFields) {
        rep.ans.ВЕРДИКТ = 'ЕСТЬ ЧТО ЧИТАТЬ: ' + rows.length + ' ИИ-соединений, ' +
          'у ' + withFields + ' заполнены поля log/tracing — смотреть их содержимое в выгрузке';
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
      'по сервисам: ' + JSON.stringify(svc),
      'соединения: ' + JSON.stringify(rows),
      'Stash ' + (rep.ans.stash || '?') + ', ' + rep.ms + ' мс'
    ];
    if (rows.length && withFields) color = '#34C759';
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
