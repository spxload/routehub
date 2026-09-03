/*
 * RouteHub — ПРОБА STASH ST13. Один вопрос, по схеме ST7–ST12.
 * ===========================================================================
 * ВОПРОС: КАКОЕ ПРАВИЛО И КАКОЙ УЗЕЛ обслуживают отдачу в Telegram и в MAX,
 * когда загрузка не проходит.
 *
 * ПОЧЕМУ ИМЕННО ЭТОТ. 03.09 Диана сообщила: в Telegram видео СМОТРИТСЯ, но
 * своё в группу НЕ ЗАГРУЖАЕТСЯ; в MAX загрузка не идёт, пока не включить
 * прямой туннель руками. Обе жалобы про ОТДАЧУ, и у них две несовместимые
 * причины-кандидата, а лечить, не различив их, проект уже пробовал — так
 * потерялся Discord (отключили набор, посмотрев на количество правил, а не
 * на содержимое).
 *
 * КАНДИДАТ 1 — MAX уезжает на платный обход. Правила для MAX у нас нет, он
 * попадает либо в `GEOIP,RU` -> группа `RH-RU`, либо в `MATCH` ->
 * `RH-Главный`. `RH-RU` — это `fallback` с DIRECT первым и обходным узлом
 * вторым. Модель «слабого DIRECT» проверена полевым тестом В LOON; ДЛЯ STASH
 * ОНА НЕ ПРОВЕРЕНА НИ РАЗУ — это записано прямо в шапке `stash-profile.js`.
 * Если ядро Stash считает DIRECT недоступным, fallback уходит на следующего
 * члена, и российский трафик едет через заграничный узел: загрузка в
 * российский сервис ломается ровно так, как описано.
 *
 * КАНДИДАТ 2 — Telegram направлен в `RH-АВТО` намеренно, и там всё работает,
 * кроме отдачи. Тогда дело не в маршруте, а в КАЧЕСТВЕ ОТДАЧИ узла, которое
 * проект не меряет вообще: в композитном балле четыре компонента, и upload
 * среди них нет.
 *
 * Проба различает эти два случая: она показывает по каждому интересующему
 * соединению СРАБОТАВШЕЕ ПРАВИЛО и ФАКТИЧЕСКУЮ ЦЕПОЧКУ, плюс отдельно —
 * стоит ли в цепочке обходной узел.
 *
 * ПОЧЕМУ ОНА ОПРАШИВАЕТ КОНТРОЛЛЕР НЕСКОЛЬКО РАЗ. `/connections` отдаёт
 * ЖИВЫЕ соединения. Загрузка видео длится десятки секунд, и одиночный снимок
 * легко в неё не попадёт. Проба делает SNAPSHOTS снимков внутри одного
 * прогона и объединяет их по `id`, поэтому попадание не зависит от того,
 * секунда в секунду ли запустился cron.
 *
 * ЧТО С ЛИЧНЫМИ ДАННЫМИ. В `/connections` лежит история обращений. Имена
 * хостов выгружаются ТОЛЬКО для адресов из списка WATCH (Telegram, MAX, VK) —
 * то есть ровно для тех, про которые задан вопрос. Всё остальное считается,
 * но не называется. Это отличие от ST11, которая не выгружала хосты вовсе:
 * там вопрос был про доли, здесь — про конкретные сервисы, и без имени
 * ответить нельзя.
 *
 * ТОЛЬКО ЧТЕНИЕ. Три пути, все GET: `/connections`, `/proxies`, `/configs`.
 * Ни PUT, ни PATCH. Через узлы проба не ходит вовсе, поэтому правила 1 и 2
 * соблюдаются по построению.
 *
 * КАК ЗАПУСКАТЬ. Расписанием `cron` раз в минуту, туннель поднят, и —
 * ГЛАВНОЕ — В ЭТО ЖЕ ВРЕМЯ ПОВТОРИТЬ СБОЙ на телефоне: попробовать
 * отправить видео в Telegram и файл в MAX. Без повторения сбоя смотреть
 * нечего. После разбора override выключить.
 */

var REV = 'ST13';
var T0 = Date.now();
var BUDGET_MS = 45000;         // настоящие миллисекунды, через Date.now()
var SNAPSHOTS = 12;            // сколько раз опросить /connections
var SNAP_GAP = 900;            // номинальная пауза между снимками, мс
var CTRL_SEC = 5;
var MAX_SHOW = 14;             // сколько интересующих соединений показать

// Адреса, про которые задан вопрос. Совпадение по подстроке: у Telegram и
// MAX доменов много и они меняются, точный список тут вреднее приблизительного.
var WATCH = [
  'telegram', 't.me', 'telesco.pe', 'tdesktop',
  'max.ru', 'oneme.ru',
  'vk.com', 'vk-cdn', 'userapi.com', 'mycdn.me', 'vkuser',
];
// Признак правила Telegram: набор адресуется по IP, и тогда host пуст.
var WATCH_RULE = ['telegram', 'rh-telegram'];
var BYPASS = 'Обход';

// Группы, состояние которых решает вопрос. RH-RU — главная: если она
// смотрит на обходной узел, кандидат 1 подтверждён.
var GROUPS = ['RH-RU', 'RH-Главный', 'RH-Обход', 'RH-АВТО', 'RH-AI', 'RH-Звонки'];

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
  var o = { url: CTRL + path, timeout: CTRL_SEC };
  if (AUTH) o.headers = { Authorization: AUTH };
  var done = false;
  function once(b, e) { if (done) return; done = true; cb(b, e); }
  try {
    G.$httpClient.get(o, function (e, r, body) {
      once(e ? null : body,
        e ? String(e) : ((r && r.status >= 400) ? ('HTTP ' + r.status) : null));
    });
  } catch (e2) { once(null, String(e2)); }
}

function low(s) { return String(s == null ? '' : s).toLowerCase(); }
function hasAny(hay, list) {
  var h = low(hay);
  for (var i = 0; i < list.length; i++) if (h.indexOf(list[i]) >= 0) return true;
  return false;
}
function num(v) { return (v && typeof v === 'object' && typeof v.total === 'number') ? v.total : (+v || 0); }
function kb(n) { return Math.round(n / 1024) + ' КБ'; }

// ── ШАГ 1: состояние ядра и групп ────────────────────────────────────
// Без него любой вывод о правилах условен: в глобальном режиме правила не
// применяются вовсе, и «правило не сработало» значило бы «правила выключены».
function stepState(next) {
  get('/configs', function (body) {
    var mode = '?';
    if (body) { try { var c = JSON.parse(body); mode = c && (c.mode || c.Mode) || '?'; } catch (e) {} }
    rep.ans.режим_ядра = mode;
    get('/proxies', function (b2) {
      if (!b2) { rep.ans.группы = 'не ответил'; next(); return; }
      var d = null;
      try { d = JSON.parse(b2); } catch (e2) { rep.ans.группы = 'не разобрался'; next(); return; }
      var map = (d && (d.proxies || d.Proxies)) || d || {};
      var now = {};
      for (var i = 0; i < GROUPS.length; i++) {
        var g = map[GROUPS[i]];
        if (!g) { now[GROUPS[i]] = 'НЕТ ГРУППЫ'; continue; }
        var cur = String(g.now || g.Now || '?');
        // Имя узла несёт хвост метрик — в отчёте он не нужен, только суть.
        var short = cur.indexOf(' · ') >= 0 ? cur.slice(0, cur.indexOf(' · ')) : cur;
        now[GROUPS[i]] = short + (cur.indexOf(BYPASS) >= 0 ? '  ← ОБХОД (платный)' : '');
      }
      rep.ans.группы = now;
      next();
    });
  });
}

// ── ШАГ 2: снимки /connections ───────────────────────────────────────
var seen = {}, snaps = 0, total = 0;

function absorb(body) {
  var d = null;
  try { d = JSON.parse(body); } catch (e) { return; }
  var list = (d && (d.connections || d.Connections)) || [];
  total = list.length;
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    if (!r) continue;
    var md = r.metadata || r.Metadata || {};
    var host = md.host || md.Host || '';
    var payload = r.rulePayload || md.rulePayload || '';
    var rule = r.rule || md.ruleType || '';
    var chains = r.chains || r.chain || md.chain || [];
    var chainStr = Array.isArray(chains) ? chains.join(' <- ') : String(chains);
    var interesting = hasAny(host, WATCH) || hasAny(payload, WATCH_RULE) ||
      hasAny(chainStr, WATCH_RULE);
    if (!interesting) continue;
    var id = String(r.id || r.Id || (host + ':' + md.destinationPort));
    var up = num(r.upload), dn = num(r.download);
    var prev = seen[id];
    // Снимок берётся ПОСЛЕДНИЙ: счётчики растут, и нас интересует итог.
    if (prev && prev.upB > up && prev.dnB > dn) continue;
    seen[id] = {
      хост: host || ('(без имени) ' + (md.destinationIP || md.DestinationIP || '?')),
      правило: (rule || '?') + (payload ? (',' + payload) : ''),
      цепочка: chainStr || '(пусто)',
      обход_в_цепочке: chainStr.indexOf(BYPASS) >= 0,
      отдано: kb(up), принято: kb(dn),
      upB: up, dnB: dn,
      сеть: md.network || md.Network || '?',
    };
  }
}

function snap(cb) {
  if (snaps >= SNAPSHOTS || (Date.now() - T0) > BUDGET_MS - 6000) { cb(); return; }
  snaps++;
  get('/connections', function (body, e) {
    if (e && snaps === 1) rep.err.push('снимок 1: ' + e);
    if (body) absorb(body);
    setTimeout(function () { snap(cb); }, SNAP_GAP);
  });
}

// ── ВЕРДИКТ ──────────────────────────────────────────────────────────
function verdict() {
  var ids = [], k;
  for (k in seen) ids.push(k);
  rep.ans.снимков = snaps;
  rep.ans.соединений_в_последнем_снимке = total;
  rep.ans.интересующих_соединений = ids.length;

  if (String(rep.ans.режим_ядра).toLowerCase() !== 'rule') {
    return 'НЕ СУДИМ: режим ядра «' + rep.ans.режим_ядра +
      '», правила не применяются — включить «Режим по правилам» и повторить';
  }
  if (!ids.length) {
    return 'ПУСТО: соединений Telegram/MAX не поймано — повторить сбой ВО ВРЕМЯ прогона';
  }

  // Сортировка по отданным байтам: загрузка — это то, где отдано много.
  ids.sort(function (a, b) { return seen[b].upB - seen[a].upB; });
  var show = [], byp = 0, uploads = 0;
  for (var i = 0; i < ids.length && i < MAX_SHOW; i++) {
    var s = seen[ids[i]];
    if (s.обход_в_цепочке) byp++;
    if (s.upB > s.dnB) uploads++;
    show.push({
      хост: s.хост, правило: s.правило, цепочка: s.цепочка,
      отдано: s.отдано, принято: s.принято, сеть: s.сеть,
      обход: s.обход_в_цепочке ? 'ДА' : 'нет',
    });
  }
  rep.ans.соединения = show;
  rep.ans.отдающих_соединений = uploads;

  if (byp) {
    return 'НАЙДЕНО: ' + byp + ' соединений идут через ОБХОДНОЙ узел — ' +
      'подтверждён кандидат 1 (fallback увёл трафик на платный запас)';
  }
  var direct = 0;
  for (var j = 0; j < show.length; j++) {
    if (low(show[j].цепочка).indexOf('direct') >= 0) direct++;
  }
  return 'СНЯТО: ' + ids.length + ' соединений, отдающих ' + uploads +
    ', напрямую ' + direct + ', обходных 0 — смотреть таблицу правил и цепочек';
}

var FINISHED = false;
var GUARD = null;

function finish() {
  if (FINISHED) return;
  FINISHED = true;
  try { clearTimeout(GUARD); } catch (e) {}
  rep.ans.ВЕРДИКТ = verdict();
  rep.ms = Date.now() - T0;
  var a = rep.ans;
  var lines = [
    a.ВЕРДИКТ,
    'режим ядра: ' + a.режим_ядра,
    'группы: ' + JSON.stringify(a.группы || {}),
    'снимков ' + a.снимков + ', соединений ' + a.соединений_в_последнем_снимке +
      ', интересующих ' + a.интересующих_соединений,
    'Stash ' + (a.stash || '?') + ', ' + rep.ms + ' мс',
  ];
  console.log('[' + REV + '] ' + JSON.stringify(rep));
  try {
    $notification.post('RouteHub ' + REV, lines[0], lines.slice(1).join('\n'),
      { clipboard: JSON.stringify(rep) });
  } catch (e2) {}
  var color = '#8E8E93';
  if (a.ВЕРДИКТ.indexOf('НАЙДЕНО') === 0) color = '#FF3B30';
  else if (a.ВЕРДИКТ.indexOf('СНЯТО') === 0) color = '#34C759';
  else if (a.ВЕРДИКТ.indexOf('ПУСТО') === 0 || a.ВЕРДИКТ.indexOf('НЕ СУДИМ') === 0) color = '#FF9F0A';
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'),
            icon: 'arrow.up.circle', backgroundColor: color });
  } catch (e3) { try { $done(); } catch (e4) {} }
}

// Сторож. Номинал заведомо больше бюджета: у сборщика уже видели, что
// растяжение таймеров в Stash непостоянно (03.09: один раз ровно по номиналу,
// другой — втрое с лишним). Обрезать здоровый прогон он не должен.
GUARD = setTimeout(function () {
  if (!FINISHED) { rep.err.push('сторож: цепочка не завершилась'); finish(); }
}, 60000);

stepState(function () { snap(finish); });
// конец файла — хвостовой страж (вывод 49)
