/*
 * RouteHub — ПРОБА STASH ST11. Один вопрос, по схеме ST7–ST10.
 * ===========================================================================
 * ВОПРОС: что НА САМОМ ДЕЛЕ лежит в записи `/connections` — и работают ли
 * наши правила на живом трафике.
 *
 * ПОЧЕМУ ИМЕННО ЭТОТ. Экран соединения в приложении показывает по каждому
 * соединению «Трафик загрузки 29,81 МБ» и «Максимальная скорость загрузки
 * 4,2 МБ/с». Если эти числа доступны СКРИПТУ, у проекта появляется источник
 * скорости, за который НЕ НАДО ПЛАТИТЬ ТРАФИКОМ: сейчас `down` снимается
 * синтетической закачкой с speed.cloudflare.com, а тут клиент уже посчитал
 * реальную. Но опись состава записи из ST7 таких полей НЕ СОДЕРЖИТ, значит
 * либо опись была неполной, либо счётчики живут не там. Проба выясняет.
 *
 * ВТОРОЙ ВОПРОС, ВАЖНЕЕ ПЕРВОГО. На том же экране: «Правило: NO-RULE», а
 * цепочка — узел и **GLOBAL**. Для `rr1---sn-…googlevideo.com` это странно:
 * в профиле есть `DOMAIN-SUFFIX,googlevideo.com,RH-АВТО`, и цепочка должна
 * была пройти через RH-АВТО. NO-RULE и GLOBAL вместе означают, что правила
 * не применялись вовсе. Если так по всем соединениям — вся работа с
 * наборами правил не влияет ни на что, и это надо знать точно, а не по
 * одному экрану. Проба считает ДОЛЮ соединений, прошедших через правила.
 *
 * ЧТО ПРОБА НЕ ДЕЛАЕТ: не выгружает имена хостов и значения правил. В
 * `/connections` лежит история обращений — это личные данные, и в отчёт они
 * не попадают ни целиком, ни обрезанными. Считаются только ТИПЫ и КОЛИЧЕСТВА.
 * Состав полей выводится ИМЕНАМИ И ТИПАМИ значений, без самих значений.
 *
 * ТОЛЬКО ЧТЕНИЕ: один GET и один поток WebSocket, который закрывается сразу
 * после первого сообщения. Ни PUT, ни PATCH.
 *
 * КАК ЗАПУСКАТЬ. Расписанием `cron`, туннель поднят. И ЖЕЛАТЕЛЬНО — сразу
 * после того, как через телефон прошёл заметный трафик (видео, загрузка):
 * на пустом наборе соединений считать нечего.
 */

var REV = 'ST11';
var T0 = Date.now();
var BUDGET_MS = 12000;

var rep = { rev: REV, ts: new Date().toISOString(), ans: {}, err: [] };
var G = (typeof globalThis !== 'undefined') ? globalThis : this;

var CTRL = 'http://127.0.0.1:9090', AUTH = '';
try {
  CTRL = ($environment && $environment['controller-url']) || CTRL;
  AUTH = ($environment && $environment['controller-authorization']) || '';
  rep.ans.stash = ($environment && $environment['stash-version']) || '?';
} catch (e) { rep.err.push('нет $environment'); }
CTRL = String(CTRL).replace(/\/+$/, '');
// Секрет отдельно от заголовка: для WebSocket заголовок задать нельзя, там
// он идёт параметром адреса. В отчёт НЕ КЛАДЁТСЯ.
var SECRET = String(AUTH).replace(/^\s*Bearer\s+/i, '');

function get(path, sec, cb) {
  var o = { url: CTRL + path, timeout: sec };
  if (AUTH) o.headers = { Authorization: AUTH };
  var done = false;
  function once(b, e) { if (done) return; done = true; cb(b, e); }
  try {
    G.$httpClient.get(o, function (e, r, body) {
      once(e ? null : body, e ? String(e) : (r && r.status >= 400 ? 'HTTP ' + r.status : null));
    });
  } catch (e2) { once(null, String(e2)); }
}

// ── ДОБЫЧА /connections: ТРИ СПОСОБА ─────────────────────────────────
// ПОЧЕМУ НЕ ОДИН ЗАПРОС. Первый прогон 31.08 в 19:17 вернул
// «Get http://127.0.0.1:9090/connections: EOF» за 308 мс — соединение
// закрылось БЕЗ ответа. При этом ST10 тремя часами раньше тот же путь
// прочитала: 33 015 байт. Значит путь живой, а отказ зависит от состояния —
// вероятнее всего от РАЗМЕРА выдачи: после двух минут видео соединений
// накапливается заметно больше, и тело растёт. EOF это не таймаут (тот у
// Stash выглядит как «context deadline exceeded», см. /logs в ST10), а
// обрыв, поэтому просто ждать дольше бессмысленно — но попробовать стоит,
// и стоит иметь запасной путь.
// Способы идут по возрастанию непохожести на предыдущий, и КАЖДЫЙ
// записывается в отчёт: даже неудачная попытка говорит, чем именно
// контроллер отвечает на большую выдачу.
var attempts = [];

function note(way, ok, detail) {
  attempts.push(way + ': ' + (ok ? 'ДА' : 'нет') + (detail ? ' — ' + detail : ''));
}

// Способ 3 (запасной): тот же путь потоком. В экосистеме Clash
// `/connections` умеет отдавать снимок первым сообщением WebSocket. Если
// обрыв связан с телом обычного ответа, поток может пройти там, где GET нет.
function connByWs(cb) {
  var done = false;
  function fin(body, why) { if (done) return; done = true; note('поток ws', !!body, why); cb(body); }
  var ws;
  try {
    ws = new G.WebSocket(CTRL.replace(/^http/, 'ws') + '/connections' +
      (SECRET ? ('?token=' + encodeURIComponent(SECRET)) : ''));
  }
  catch (e) { fin(null, 'конструктор: ' + String(e).slice(0, 60)); return; }
  ws.onmessage = function (m) { try { ws.close(); } catch (e) {} fin(m && m.data, 'снимок получен'); };
  ws.onerror = function () { try { ws.close(); } catch (e) {} fin(null, 'ошибка потока'); };
  ws.onclose = function () { fin(null, 'закрылся без сообщений'); };
  setTimeout(function () { try { ws.close(); } catch (e) {} fin(null, 'таймаут'); }, 2500);
}

function fetchConnections(cb) {
  get('/connections', 5, function (b1, e1) {
    note('GET, 5 с', !!b1, e1 || (b1 ? String(b1).length + ' б' : ''));
    if (b1) { cb(b1); return; }
    // Вторая попытка с большим запасом: если дело всё-таки во времени.
    setTimeout(function () {
      get('/connections', 10, function (b2, e2) {
        note('GET, 10 с', !!b2, e2 || (b2 ? String(b2).length + ' б' : ''));
        if (b2) { cb(b2); return; }
        connByWs(cb);
      });
    }, 400);
  });
}

// Имя ключа и ТИП значения — без самого значения. Числа отдаём: они не
// личные, и именно числа мы и ищем. Строки — только длиной.
function shape(o) {
  var out = {};
  for (var k in o) {
    var v = o[k];
    if (v === null) { out[k] = 'null'; continue; }
    if (typeof v === 'number') { out[k] = 'число ' + v; continue; }
    if (typeof v === 'boolean') { out[k] = 'логич ' + v; continue; }
    if (typeof v === 'string') { out[k] = 'строка(' + v.length + ')'; continue; }
    if (Array.isArray(v)) { out[k] = 'список[' + v.length + ']'; continue; }
    if (typeof v === 'object') {
      var inner = [];
      for (var kk in v) inner.push(kk);
      out[k] = 'объект{' + inner.join(',') + '}';
      continue;
    }
    out[k] = typeof v;
  }
  return out;
}

// Ищем счётчики байт и скорости по известным именам из разных форков.
var BYTES = ['upload', 'download', 'uploadTotal', 'downloadTotal', 'up', 'down',
  'uploadSpeed', 'downloadSpeed', 'maxUploadSpeed', 'maxDownloadSpeed',
  'uploadCurrent', 'downloadCurrent', 'bytesSent', 'bytesReceived'];

// ⚠️ ИСПРАВЛЕНО 31.08 ПО ПЕРВОМУ ЖЕ УДАЧНОМУ ПРОГОНУ. Первая редакция брала
// только ЧИСЛА и потому объявила «счётчиков нет», хотя они были: у Stash
// `upload` и `download` — это ОБЪЕКТЫ вида {current, last, max, total}.
// Ложноотрицательный вердикт хуже отсутствия вердикта, поэтому теперь
// разбираются обе формы, и вложенные числа выводятся целиком: `total` — это
// накопленный объём, `max` — пиковая скорость, ради которой всё затевалось.
function findCounters(o) {
  var hit = {};
  if (!o || typeof o !== 'object') return hit;
  for (var k in o) {
    var lk = String(k).toLowerCase(), v = o[k], known = false;
    for (var i = 0; i < BYTES.length; i++) {
      if (lk === BYTES[i].toLowerCase()) { known = true; break; }
    }
    if (!known) continue;
    if (typeof v === 'number') { hit[k] = v; continue; }
    if (v && typeof v === 'object') {
      var sub = {}, any = false;
      for (var kk in v) { if (typeof v[kk] === 'number') { sub[kk] = v[kk]; any = true; } }
      if (any) hit[k] = sub;
    }
  }
  return hit;
}

// Тайминги соединения. Найдены той же выгрузкой: metadata.tracing — объект
// {ruleEvaluate, dnsQuery, connect}. `connect` это время установки
// соединения, то есть задержка, снятая на РЕАЛЬНОМ трафике, а не пробой.
// Значение для сборщика метрик ровно то же, что у счётчиков: цифры уже
// посчитаны клиентом, платить за них не надо.
function findTracing(c) {
  var t = (c && c.tracing) || (c && c.metadata && c.metadata.tracing);
  if (!t || typeof t !== 'object') return 'нет';
  var out = {};
  for (var k in t) out[k] = (typeof t[k] === 'number') ? t[k] : (typeof t[k]);
  return out;
}

function stepConn(next) {
  fetchConnections(function (body) {
    rep.ans.способы_добычи = attempts;
    if (!body) { rep.ans.connections = 'не дался ни одним способом'; next(); return; }
    var d = null;
    try { d = JSON.parse(body); } catch (e2) {
      rep.ans.connections = 'не разобрался, ' + String(body).length + ' б';
      next(); return;
    }
    rep.ans.размер_ответа_б = String(body).length;
    // Верхний уровень: у Clash тут downloadTotal/uploadTotal и connections.
    rep.ans.верхний_уровень = shape(d);

    var list = (d && (d.connections || d.Connections)) || (Array.isArray(d) ? d : []);
    rep.ans.соединений = list.length;
    if (!list.length) { rep.ans.вывод_по_записи = 'соединений нет — считать нечего'; next(); return; }

    // Состав ОДНОЙ записи: имена и типы, без значений.
    rep.ans.состав_записи = shape(list[0]);
    rep.ans.счётчики_в_записи = findCounters(list[0]);
    rep.ans.тайминги_в_записи = findTracing(list[0]);
    // ⚠️ ПЕРВАЯ ЗАПИСЬ НЕ ПОКАЗАТЕЛЬНА, и прогоны 01.09 это показали: у
    // list[0] счётчики были 306 и 172 байта при пике 2,2 МБ/с по всему
    // набору, а тайминги — по единице, чего у соединения через туннель быть
    // не может. Причина простая: свежее соединение ещё ничего не передало.
    // Поэтому ниже идёт СВОДКА ПО ВСЕМ записям, а поля `*_в_записи`
    // остаются только как образец ФОРМЫ, не как значения.
    var tsum = {};
    for (var w = 0; w < list.length; w++) {
      var tr = findTracing(list[w]);
      if (!tr || typeof tr !== 'object') continue;
      for (var tk in tr) {
        if (typeof tr[tk] !== 'number') continue;
        if (!tsum[tk]) tsum[tk] = [];
        tsum[tk].push(tr[tk]);
      }
    }
    var tout = {};
    for (var tk2 in tsum) {
      var arr = tsum[tk2].sort(function (a, b) { return a - b; });
      tout[tk2] = { мин: arr[0], медиана: arr[Math.floor(arr.length / 2)],
                    макс: arr[arr.length - 1], записей: arr.length };
    }
    rep.ans.тайминги_сводка = tout;
    // Сумма по всем соединениям: показывает, на скольких из них счётчики
    // непустые, — одна запись могла попасться свежей и нулевой.
    var withBytes = 0, maxSeen = 0;
    for (var q = 0; q < list.length; q++) {
      var cc = findCounters(list[q]);
      var dn = cc.download;
      if (dn && typeof dn === 'object' && dn.total) withBytes++;
      else if (typeof dn === 'number' && dn) withBytes++;
      if (dn && typeof dn === 'object' && typeof dn.max === 'number' && dn.max > maxSeen) maxSeen = dn.max;
    }
    rep.ans.соединений_со_счётчиком = withBytes;
    rep.ans.пиковая_скорость_байт_с = maxSeen;
    // Вложенный metadata, если он есть отдельным объектом.
    if (list[0] && typeof list[0].metadata === 'object' && list[0].metadata) {
      rep.ans.состав_metadata = shape(list[0].metadata);
      rep.ans.счётчики_в_metadata = findCounters(list[0].metadata);
    }

    // ── ГЛАВНОЕ: работают ли правила ───────────────────────────────
    // Значения правил и хостов НЕ выгружаются: только счёт по типам.
    var byType = {}, norule = 0, viaGlobal = 0, viaOurs = 0, direct = 0, other = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i] || {};
      var t = String(c.ruleType || c.rule || c.RuleType || '').toUpperCase() || '(нет поля)';
      byType[t] = (byType[t] || 0) + 1;
      if (t.indexOf('NO-RULE') >= 0 || t === '') norule++;
      var ch = c.chain || c.chains || c.Chain;
      var chs = Array.isArray(ch) ? ch.join('|') : String(ch || '');
      if (chs.indexOf('GLOBAL') >= 0) viaGlobal++;
      else if (chs.indexOf('RH-') >= 0) viaOurs++;
      // DIRECT считается ОТДЕЛЬНО, и это добавлено 31.08 не для полноты.
      // Правило `MATCH,RH-Главный` ведёт в `select`, первый член которого —
      // DIRECT. Значит всё, что не поймано правилами, уходит напрямую, а не
      // через узел. Именно так объясняется «YouTube не работает по
      // правилам»: видео шло через прокси, а API плеера — напрямую из РФ.
      // Много DIRECT при просмотре видео = дыра в правилах, а не поломка.
      // Имена хостов при этом по-прежнему НЕ выгружаются: только счёт.
      else if (chs.indexOf('DIRECT') >= 0 || chs === '') direct++;
      else other++;
    }
    rep.ans.правил_по_типам = byType;
    rep.ans.без_правила = norule;
    rep.ans.через_GLOBAL = viaGlobal;
    rep.ans.напрямую_DIRECT = direct;
    rep.ans.через_наши_группы = viaOurs;
    rep.ans.через_прочее = other;
    next();
  });
}

// Поток скоростей: у Clash это ws://…/traffic. Берём ОДНО сообщение и
// закрываемся. Отвечает на вопрос, доступны ли живые скорости вообще —
// пусть и суммарные, а не по узлам.
function stepTraffic(next) {
  var done = false;
  function fin(v) { if (done) return; done = true; rep.ans.поток_traffic = v; next(); }
  // ТОКЕН В АДРЕСЕ ОБЯЗАТЕЛЕН. Первые два прогона дали «ошибка потока»,
  // и причина, скорее всего, в авторизации: заголовки в WebSocket из JS
  // задать нельзя, а без них контроллер отвечает 401. Замер ST4 открывал
  // поток именно как `ws://…/traffic?token=`. Секрет в отчёт не попадает.
  var url = CTRL.replace(/^http/, 'ws') + '/traffic' +
    (SECRET ? ('?token=' + encodeURIComponent(SECRET)) : '');
  var ws;
  try { ws = new G.WebSocket(url); }
  catch (e) { fin('конструктор упал: ' + String(e).slice(0, 80)); return; }
  ws.onmessage = function (m) {
    var v = 'открылся, сообщение есть';
    try {
      var d = JSON.parse(m && m.data);
      v = shape(d);
    } catch (e2) {}
    try { ws.close(); } catch (e3) {}
    fin(v);
  };
  ws.onerror = function () { try { ws.close(); } catch (e) {} fin('ошибка потока'); };
  ws.onclose = function () { fin('закрылся, сообщений не было'); };
  setTimeout(function () { try { ws.close(); } catch (e) {} fin('таймаут потока'); }, 2500);
}

function stepMode(next) {
  get('/configs', 3, function (body, e) {
    if (e || !body) { rep.ans.режим_ядра = 'не ответил: ' + (e || 'пусто'); next(); return; }
    var d = null; try { d = JSON.parse(body); } catch (e2) {}
    rep.ans.режим_ядра = (d && (d.mode || d.Mode)) || 'поля mode нет';
    next();
  });
}

function verdict() {
  var a = rep.ans;
  // Режим ядра спрашивается ПЕРВЫМ делом и попадает в вердикт, потому что
  // 31.08 «Правило: NO-RULE» и цепочка через GLOBAL были приняты за поломку
  // правил, а объяснялись выбранным вручную глобальным режимом. Отличить
  // «правила не сработали» от «правила выключены» обязана проба, а не память.
  var m = String(a.режим_ядра || '').toLowerCase();
  if (m && m.indexOf('rule') < 0) {
    return 'РЕЖИМ ЯДРА «' + a.режим_ядра + '», НЕ ПО ПРАВИЛАМ — про маршрутизацию ' +
      'по правилам эта выгрузка не говорит ничего. Вернуть режим и прогнать заново.';
  }
  if (typeof a.соединений !== 'number' || !a.соединений) {
    return 'НЕТ ДАННЫХ: соединений в выдаче нет, прогнать после заметного трафика';
  }
  var cnt = a.счётчики_в_записи || {}, cntM = a.счётчики_в_metadata || {};
  var haveBytes = false;
  for (var k in cnt) { haveBytes = true; break; }
  if (!haveBytes) { for (var k2 in cntM) { haveBytes = true; break; } }
  var peak = a.пиковая_скорость_байт_с || 0;

  var ours = a.через_наши_группы || 0, glob = a.через_GLOBAL || 0, dir = a.напрямую_DIRECT || 0;
  var routing;
  if (ours === 0 && glob > 0) routing = 'ПРАВИЛА НЕ РАБОТАЮТ: всё идёт через GLOBAL';
  else if (ours === 0 && dir > 0) routing = 'ВСЁ НАПРЯМУЮ: ни одно соединение не ушло в наши группы';
  else if (ours > 0 && dir > ours) routing = 'ДЫРА В ПРАВИЛАХ: напрямую ' + dir +
    ' против ' + ours + ' через наши группы';
  else if (ours > 0 && glob === 0) routing = 'правила работают: наши ' + ours + ', напрямую ' + dir;
  else if (ours > 0 && glob > 0) routing = 'смешанно: наши ' + ours + ', GLOBAL ' + glob;
  else routing = 'по цепочкам судить не вышло';

  return (haveBytes
    ? ('СЧЁТЧИКИ ЕСТЬ' + (peak ? ', пик ' + Math.round(peak / 1024) + ' КБ/с' : ''))
    : 'СЧЁТЧИКОВ НЕТ') + '; ' + routing;
}

var FINISHED = false;
function finish() {
  if (FINISHED) return;
  FINISHED = true;
  rep.ans.ВЕРДИКТ = verdict();
  rep.ms = Date.now() - T0;
  var a = rep.ans;
  var lines = [
    a.ВЕРДИКТ,
    'режим ядра: ' + (a.режим_ядра || '?'),
    'соединений: ' + (a.соединений != null ? a.соединений : '?') +
      ', без правила ' + (a.без_правила != null ? a.без_правила : '?'),
    'цепочки: наши ' + (a.через_наши_группы != null ? a.через_наши_группы : '?') +
      ', DIRECT ' + (a.напрямую_DIRECT != null ? a.напрямую_DIRECT : '?') +
      ', GLOBAL ' + (a.через_GLOBAL != null ? a.через_GLOBAL : '?') +
      ', прочее ' + (a.через_прочее != null ? a.через_прочее : '?'),
    'счётчики: ' + JSON.stringify(a.счётчики_в_записи || {}),
    'тайминги мин/мед/макс: ' + JSON.stringify(a.тайминги_сводка || '?') +
      ', со счётчиком ' + (a.соединений_со_счётчиком != null ? a.соединений_со_счётчиком : '?'),
    'Stash ' + (a.stash || '?') + ', ' + rep.ms + ' мс',
  ];
  console.log('[' + REV + '] ' + JSON.stringify(rep));
  try {
    $notification.post('RouteHub ' + REV, lines[0], lines.slice(1).join('\n'),
      { clipboard: JSON.stringify(rep) });
  } catch (e) {}
  var color = '#8E8E93';
  if (a.ВЕРДИКТ.indexOf('ПРАВИЛА НЕ РАБОТАЮТ') > 0) color = '#FF3B30';
  else if (a.ВЕРДИКТ.indexOf('СЧЁТЧИКИ ЕСТЬ') === 0) color = '#34C759';
  else if (a.ВЕРДИКТ.indexOf('НЕТ ДАННЫХ') === 0) color = '#FF9F0A';
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'),
            icon: 'chart.bar.doc.horizontal', backgroundColor: color });
  } catch (e2) { try { $done(); } catch (e3) {} }
}

// Сторож. Номинал делится на 3,6 — во столько раз Stash растягивает таймеры
// по замеру ST5. Точность не нужна: он обязан сработать РАНЬШЕ лимита.
setTimeout(function () {
  if (!FINISHED) { rep.err.push('сторож: бюджет ' + BUDGET_MS + ' мс исчерпан'); finish(); }
}, Math.round(BUDGET_MS / 3.6));

stepMode(function () { stepConn(function () { stepTraffic(finish); }); });
