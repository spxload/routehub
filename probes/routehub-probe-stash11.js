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

function get(path, cb) {
  var o = { url: CTRL + path, timeout: 4 };
  if (AUTH) o.headers = { Authorization: AUTH };
  var done = false;
  function once(b, e) { if (done) return; done = true; cb(b, e); }
  try {
    G.$httpClient.get(o, function (e, r, body) {
      once(e ? null : body, e ? String(e) : (r && r.status >= 400 ? 'HTTP ' + r.status : null));
    });
  } catch (e2) { once(null, String(e2)); }
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

function findCounters(o) {
  var hit = {};
  for (var k in o) {
    var lk = String(k).toLowerCase();
    for (var i = 0; i < BYTES.length; i++) {
      if (lk === BYTES[i].toLowerCase() && typeof o[k] === 'number') { hit[k] = o[k]; break; }
    }
  }
  return hit;
}

function stepConn(next) {
  get('/connections', function (body, e) {
    if (e || !body) { rep.ans.connections = 'не ответил: ' + (e || 'пусто'); next(); return; }
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
    // Вложенный metadata, если он есть отдельным объектом.
    if (list[0] && typeof list[0].metadata === 'object' && list[0].metadata) {
      rep.ans.состав_metadata = shape(list[0].metadata);
      rep.ans.счётчики_в_metadata = findCounters(list[0].metadata);
    }

    // ── ГЛАВНОЕ: работают ли правила ───────────────────────────────
    // Значения правил и хостов НЕ выгружаются: только счёт по типам.
    var byType = {}, norule = 0, viaGlobal = 0, viaOurs = 0, other = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i] || {};
      var t = String(c.ruleType || c.rule || c.RuleType || '').toUpperCase() || '(нет поля)';
      byType[t] = (byType[t] || 0) + 1;
      if (t.indexOf('NO-RULE') >= 0 || t === '') norule++;
      var ch = c.chain || c.chains || c.Chain;
      var chs = Array.isArray(ch) ? ch.join('|') : String(ch || '');
      if (chs.indexOf('GLOBAL') >= 0) viaGlobal++;
      else if (chs.indexOf('RH-') >= 0) viaOurs++;
      else other++;
    }
    rep.ans.правил_по_типам = byType;
    rep.ans.без_правила = norule;
    rep.ans.через_GLOBAL = viaGlobal;
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
  var url = CTRL.replace(/^http/, 'ws') + '/traffic';
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

function verdict() {
  var a = rep.ans;
  if (typeof a.соединений !== 'number' || !a.соединений) {
    return 'НЕТ ДАННЫХ: соединений в выдаче нет, прогнать после заметного трафика';
  }
  var cnt = a.счётчики_в_записи || {}, cntM = a.счётчики_в_metadata || {};
  var haveBytes = false;
  for (var k in cnt) { haveBytes = true; break; }
  if (!haveBytes) { for (var k2 in cntM) { haveBytes = true; break; } }

  var ours = a.через_наши_группы || 0, glob = a.через_GLOBAL || 0;
  var routing;
  if (ours === 0 && glob > 0) routing = 'ПРАВИЛА НЕ РАБОТАЮТ: всё идёт через GLOBAL';
  else if (ours > 0 && glob === 0) routing = 'правила работают: всё через наши группы';
  else if (ours > 0 && glob > 0) routing = 'смешанно: наши ' + ours + ', GLOBAL ' + glob;
  else routing = 'по цепочкам судить не вышло';

  return (haveBytes ? 'СЧЁТЧИКИ ЕСТЬ' : 'СЧЁТЧИКОВ НЕТ') + '; ' + routing;
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
    'соединений: ' + (a.соединений != null ? a.соединений : '?') +
      ', без правила ' + (a.без_правила != null ? a.без_правила : '?'),
    'цепочки: наши ' + (a.через_наши_группы != null ? a.через_наши_группы : '?') +
      ', GLOBAL ' + (a.через_GLOBAL != null ? a.через_GLOBAL : '?') +
      ', прочее ' + (a.через_прочее != null ? a.через_прочее : '?'),
    'счётчики: ' + JSON.stringify(a.счётчики_в_записи || {}),
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

stepConn(function () { stepTraffic(finish); });
