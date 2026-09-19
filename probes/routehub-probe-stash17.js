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
 * ЧТО ДОБАВЛЕНО СВЕРХ ПЕРВОЙ РЕДАКЦИИ (пункт 10).
 *   1. ПРОТОКОЛ. В записи есть поле `network`, и проба его теперь читает:
 *      видно, по TCP или по UDP шло несостоявшееся соединение. UDP-отказы
 *      считаются отдельно, а UDP на порт 443 помечается как QUIC. Блокировку
 *      QUIC проект сознательно НЕ включает, но до сих пор было нечем увидеть,
 *      отваливается ли именно QUIC; теперь есть.
 *   2. ПОВТОРЫ. Приложение, которому не ответили, переоткрывает соединение к
 *      тому же хосту. Проба считает, сколько РАЗНЫХ соединений возникло к
 *      каждому хосту за время наблюдения, и выносит переоткрытия в вердикт.
 *      Это независимый от байтов признак, и он не требует ходить в сервис.
 *   3. ШИРЕ GEMINI. Список WATCH пополнен доменами Gemini и AI Studio; каждый
 *      подтверждён боевыми правилами (см. комментарий у WATCH).
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

// ПОВТОРНЫЕ ОБРАЩЕНИЯ. Приложение, которому не ответили, не ждёт вечно: оно
// закрывает соединение и открывает к тому же хосту новое. Одно соединение
// ядро показывает под одним `id`, поэтому РАЗНЫЕ id к одному хосту за время
// наблюдения — это и есть счётчик переоткрытий. Признак косвенный (браузер
// открывает несколько потоков и в норме), но независимый от байтов: он виден
// даже тогда, когда ответ приходит, а приложение всё равно начинает заново.
// Порог 3: два параллельных потока — обычное дело, три и больше за минуту
// наблюдения уже стоит показать человеку.
var MIN_REPEAT = 3;

// Хосты, чьи имена разрешено выгружать. Всё остальное — только счётчик.
// КАЖДЫЙ домен взят из боевого контура, а не придуман:
//   • помечен [conf] — стоит строкой DOMAIN-SUFFIX ... ,RH-AI в `[Rule]`
//     файла `routehub.conf` ветки `main`;
//   • помечен [OverseasAI] — есть в наборе viewer12/OverseasAI.list, который
//     тот же `routehub.conf` подключает в `[Remote Rule]` с policy=RH-AI.
// РАСШИРЯТЬ ЭТОТ СПИСОК ОСТОРОЖНО: каждая строка здесь — разрешение выгрузить
// имя хоста наружу. Широкие маркеры (`google.com`, `apis.google.com`,
// `gstatic.com`) в наборе OverseasAI ЕСТЬ, но сюда НЕ БЕРУТСЯ: под них
// попадает личная почта, фото и шрифты, а не ИИ-сервисы.
var WATCH = ['chatgpt.com', 'openai.com', 'oaistatic.com', 'oaiusercontent.com',
             'claude.ai', 'anthropic.com',
             'gemini.google.com', 'bard.google.com', 'aistudio.google.com',
             'generativelanguage.googleapis.com',
             // ↓ Gemini и AI Studio: прежний набор ловил только витрину, и
             // отказ на служебном канале выглядел как «соединений не было».
             'gemini.google',                        // [OverseasAI] + business.gemini.google
             'generativeai.google',                  // [OverseasAI] портал Gemini API
             'ai.google.dev',                        // [OverseasAI] документация и ключи AI Studio
             'makersuite.google.com',                // [OverseasAI] прежнее имя AI Studio, живой редирект
             'alkalimakersuite-pa.clients6.google.com', // [OverseasAI] служебный канал AI Studio
             'aiplatform.googleapis.com',            // [OverseasAI] Vertex AI / Gemini API
             'proactivebackend-pa.googleapis.com',   // [OverseasAI] фоновый канал Gemini
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

// ПРОТОКОЛ. Поле `network` лежит в metadata, но встречалось и в самой записи;
// регистр не гарантирован. Неизвестное значение остаётся '?' — выдумывать
// 'tcp' по умолчанию нельзя, иначе UDP-отказ спрячется под видом TCP.
function netOf(m, c) {
  var n = m.network || m.Network || c.network || c.Network || '';
  n = String(n).toLowerCase().replace(/^\s+|\s+$/g, '');
  return (n === 'tcp' || n === 'udp') ? n : (n || '?');
}
function portOf(m, c) {
  var p = m.destinationPort || m.DestinationPort || c.destinationPort || '';
  return String(p == null ? '' : p);
}
// QUIC ходит по UDP/443. Проект блокировку QUIC не включает, но отличить
// «отвалился QUIC» от «отвалился TCP» надо: лечится это разными способами.
function netLabel(r) {
  var n = r.сеть || '?';
  if (n === 'udp' && r.порт === '443') return 'udp/443 QUIC';
  return n;
}

var seen = {}, hosts = {}, snaps = 0, other = 0, totalSeen = 0;
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
      // СОБСТВЕННЫЙ id ядра или запасной ключ по месту в списке. Разница
      // важна для счётчика повторов: запасной ключ строится из НОМЕРА записи,
      // а номер съезжает, как только соседнее соединение закрылось, — одно и
      // то же соединение получило бы в следующем снимке другой ключ и было бы
      // засчитано как переоткрытие. Поэтому повторы считаются только по
      // записям с настоящим id.
      var rawId = c.id || c.Id;
      var id = String(rawId || (w + ':' + i));
      var rec = seen[id];
      if (!rec) {
        rec = seen[id] = {
          сервис: w, хост: String(m.host || m.Host),
          сеть: netOf(m, c), порт: portOf(m, c),
          правило: String(c.rule || c.Rule || '') + (c.rulePayload ? (' ' + c.rulePayload) : ''),
          узел: shortNode(c.chains || c.chain || c.Chains),
          снимков: 0, вверх: 0, вниз: 0, поля: {}
        };
        // ПОВТОРЫ считаются здесь и только здесь: сюда попадает каждое НОВОЕ
        // соединение, а уже виденное соединение идёт мимо. Ключ — имя хоста,
        // и оно заведомо из WATCH: чужие отсеяны выше счётчиком `other`.
        if (rawId) {
          var hk = String(m.host || m.Host).toLowerCase();
          var hs = hosts[hk];
          if (!hs) hs = hosts[hk] = { сервис: w, хост: hk, соединений: 0, без_ответа: 0, сети: {} };
          hs.соединений++;
          hs.сети[rec.сеть] = (hs.сети[rec.сеть] || 0) + 1;
        }
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
    var прот = {}, udpНемых = 0, quicНемых = 0;
    for (var id in seen) {
      if (!seen.hasOwnProperty(id)) continue;
      var r = seen[id];
      var nf = 0; for (var k in r.поля) if (r.поля.hasOwnProperty(k)) nf++;
      if (nf) withFields++;
      svc[r.сервис] = (svc[r.сервис] || 0) + 1;
      прот[r.сеть || '?'] = (прот[r.сеть || '?'] || 0) + 1;
      // ГЛАВНЫЙ ВЫВОД ПРОБЫ: запрос ушёл, ответа нет.
      if (r.снимков >= MIN_SNAPS && r.вверх >= MIN_UP && r.вниз === 0) {
        r.ИТОГ = 'ОТВЕТА НЕТ';
        // Протокол назван прямо в строке вердикта: «через какой узел» без
        // «по какому протоколу» не отличает обрыв QUIC от обрыва TCP.
        немые.push(r.сервис + ' через ' + (r.узел || '?') + ' [' + netLabel(r) + ']');
        if (r.сеть === 'udp') { udpНемых++; if (r.порт === '443') quicНемых++; }
        var hf = hosts[String(r.хост).toLowerCase()];
        if (hf) hf.без_ответа++;
      } else if (r.вниз > 0) { r.ИТОГ = 'ответил'; живые++; }
      else r.ИТОГ = 'рано судить (' + r.снимков + ' снимков)';
      rows.push(r);
    }
    // ХОСТЫ С ПЕРЕОТКРЫТИЯМИ. Порядок — по убыванию числа соединений, чтобы
    // самый настойчивый хост стоял первым и читался с телефона сразу.
    var повторы = [], повторыСтроки = [];
    for (var hk2 in hosts) {
      if (!hosts.hasOwnProperty(hk2)) continue;
      if (hosts[hk2].соединений >= MIN_REPEAT) повторы.push(hosts[hk2]);
    }
    повторы.sort(function (a, b) { return b.соединений - a.соединений; });
    for (var p2 = 0; p2 < повторы.length; p2++) {
      повторыСтроки.push(повторы[p2].хост + ' ×' + повторы[p2].соединений +
        (повторы[p2].без_ответа ? (' (без ответа ' + повторы[p2].без_ответа + ')') : ''));
    }
    // В ВЕРДИКТ — только первые три хоста: строка читается с экрана телефона,
    // и перечень из десятка имён вытесняет из неё главное. Полный список
    // остаётся в `ПОВТОРЫ` и в строке «переоткрытия» ниже.
    var повторыКратко = повторыСтроки.slice(0, 3).join('; ') +
      (повторыСтроки.length > 3 ? (' и ещё ' + (повторыСтроки.length - 3)) : '');
    rep.ans.снимков = snaps;
    rep.ans.соединений_всего = totalSeen;
    rep.ans.чужих_не_названо = other;      // счётчик без имён — граница приватности
    rep.ans.ии_соединений = rows.length;
    rep.ans.по_сервисам = svc;
    rep.ans.с_неизвестными_полями = withFields;
    rep.ans.ответили = живые;
    rep.ans.по_протоколам = прот;
    if (udpНемых) rep.ans.udp_без_ответа = udpНемых;
    if (quicНемых) rep.ans.quic_без_ответа = quicНемых;
    if (повторыСтроки.length) rep.ans.ПОВТОРЫ = повторыСтроки;
    if (повторы.length) rep.ans.по_хостам = повторы;
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
          ' — запрос ушёл, ответа ноль. Ответили ' + живые + ' из ' + rows.length +
          (quicНемых ? ('. Из них по QUIC (udp/443) ' + quicНемых) : '') +
          (повторыСтроки.length ? ('. Переоткрывает: ' + повторыКратко) : '');
      } else if (повторыСтроки.length) {
        // ОТВЕТ ПРИХОДИТ, А ПРИЛОЖЕНИЕ НАЧИНАЕТ ЗАНОВО. Именно этот случай
        // объясняет расхождение «пробы молчат, а сервис не работает»: байты
        // идут в обе стороны, но соединение не доживает до полезного ответа.
        rep.ans.ВЕРДИКТ = 'ПЕРЕОТКРЫВАЕТ: ' + повторыКратко +
          ' — молчащих соединений нет, но к этим хостам приложение заходило заново. ' +
          'Признак косвенный: несколько потоков бывают и в норме';
      } else if (withFields) {
        rep.ans.ВЕРДИКТ = 'ВСЁ ОТВЕЧАЕТ: ' + живые + ' из ' + rows.length +
          ' ИИ-соединений получили ответ, молчащих нет';
      } else {
        rep.ans.ВЕРДИКТ = 'ИИ-соединений ' + rows.length + ', но поля log/tracing ПУСТЫ у всех — ' +
          'исход по журналу не читается, направление закрыто замером';
      }
    }
    rep.ms = Date.now() - T0;
    // ВЫВОД ЧИТАЮТ С ТЕЛЕФОНА: первая строка — вердикт целиком, дальше по
    // одной короткой строке на тему. Подробности (JSON соединений) — в самом
    // низу и в буфере обмена, чтобы не оттеснять главное.
    var protStr = [];
    for (var pk in прот) if (прот.hasOwnProperty(pk)) protStr.push(pk + ' ' + прот[pk]);
    lines = [
      rep.ans.ВЕРДИКТ,
      'снимков ' + snaps + ', соединений всего ' + totalSeen + ', из них ИИ ' + rows.length +
        ', чужих (имена не выгружаются) ' + other,
      'протоколы: ' + (protStr.length ? protStr.join(' · ') : '—') +
        (udpНемых ? (' · без ответа по UDP ' + udpНемых + (quicНемых ? (', из них QUIC/443 ' + quicНемых) : '')) : ''),
      (повторыСтроки.length ? '🔁 переоткрытия: ' + повторыСтроки.join('; ') : ''),
      (rep.ans.БЕЗ_ОТВЕТА ? '⛔ без ответа: ' + rep.ans.БЕЗ_ОТВЕТА.join('; ') + '\n' : '') +
        'по сервисам: ' + JSON.stringify(svc),
      'соединения: ' + JSON.stringify(rows),
      'Stash ' + (rep.ans.stash || '?') + ', ' + rep.ms + ' мс'
    ];
    var clean = [];
    for (var li = 0; li < lines.length; li++) if (lines[li]) clean.push(lines[li]);
    lines = clean;
    if (немые.length) color = '#FF3B30';
    // Переоткрытия — не отказ, но и не «всё хорошо»: жёлтый, а не зелёный.
    else if (повторыСтроки.length) color = '#FF9F0A';
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
