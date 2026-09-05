/*
 * RouteHub — ПРОБА STASH ST15. Один вопрос.
 * ===========================================================================
 * ВОПРОС: на каких узлах группы RH-AI край ИИ-сервисов пускает запрос, и
 * когда не пускает — из-за чего.
 *
 * ПОЧЕМУ ИМЕННО ЭТОТ. Жалоба Дианы 03.09: «многие вчера и не работали на
 * узлах нейронки». Группа RH-AI собирается КАСКАДОМ ПО СТРАНАМ (src/ai.js):
 * порядок фильтров считается от числа узлов в стране и от региона, а НЕ от
 * того, пускает ли сервис этот выход. Второе проект не мерял ни разу —
 * только предполагал по географии. Отсюда и расхождение: узел живой,
 * скорость есть, балл высокий, а ChatGPT на нём не открывается.
 *
 * ЧТО РАЗЛИЧАЕТ ПРОБА. Четыре исхода, снаружи выглядящих как «не работает»:
 *   • НЕ ДОШЛИ  — статус 0: узел не поднял соединение к этому хосту. Про узел;
 *   • ЗАПРЕТ    — 403/451 от края: запрос отклонён. Про выходной адрес;
 *   • ВРЕМЕННО  — 429/5xx: край перегружен или отказал на время. НЕ повод
 *     судить об узле — такой ответ в счёт чистоты узла не идёт;
 *   • ОТВЕТИЛ   — 2xx/3xx.
 * Плюс СТРАНА ВЫХОДА (`loc` из `/cdn-cgi/trace`): флаг в имени узла говорит
 * о стране СЕРВЕРА, а выходной адрес бывает другим — и объясняет запрет.
 *
 * ЧЕГО ПРОБА НЕ ДОКАЗЫВАЕТ, И ЭТО ВАЖНО.
 *   • «ОТВЕТИЛ» — край сервиса пустил ОДИН безымянный GET. Что откроется
 *     диалог, это не доказывает: приложение может отказать позже.
 *   • «ЗАПРЕТ» — край не пустил ЭТОТ запрос. Страновой это отказ или
 *     бот-защита, различается по телу ответа, и различие записывается
 *     отдельным полем: 403 от бот-защиты на запрос без cookie — рядовое
 *     дело, и он НЕ равен «сервис на узле не заработает».
 *   • «НЕ ДОШЛИ» — самое сильное из четырёх: соединения нет вовсе.
 * Запрашивается `/robots.txt` — несколько сотен байт, отдаётся тем же краем.
 * Первый прогон заодно ПРОВЕРЯЕТ САМ СПИСОК адресов: другой путь у сервиса
 * будет виден по статусу, и список правится по замеру, а не по догадке.
 *
 * ПРАВИЛО 1, ДВА РУБЕЖА (как в сборщике).
 *   Первый — обходные узлы отбрасываются по имени до любого сетевого вызова.
 *   Каскад RH-AI заканчивается обходом, поэтому фильтр обязателен.
 *   Второй — если пиновка молча перестанет работать, запрос уйдёт по ТЕКУЩЕЙ
 *   политике, а текущая политика здесь RH-AI, чей последний запас — обход.
 *   Причём состояние «RH-AI свалилась на обход» — ровно то, которое проба и
 *   приехала диагностировать. Поэтому прогон не начинается, если группа
 *   ПРЯМО СЕЙЧАС смотрит на обходной узел.
 * ПРАВИЛО 2. Проба не пишет: к контроллеру только GET, никаких
 * setSelectPolicy и правок конфига. Узел выбирается ЗАГОЛОВКОМ запроса,
 * маршрутизация устройства не меняется.
 *
 * ЦЕНА. NODES_N узлов x (1 запрос страны + число сервисов) по несколько
 * сотен байт — порядка 15 КБ за прогон, и только по ОБЫЧНЫМ узлам подписки.
 *
 * ОГОВОРКА О ПАРАЛЛЕЛЬНОСТИ. Запросы одного узла уходят вместе, чтобы
 * уложиться в бюджет. Для доступности это допустимо, для времени ответа —
 * нет: числа `мс` в выгрузке справочные и никуда, кроме глаз, не идут.
 *
 * СЕТЬ ЧИТАЕТСЯ, А НЕ УГАДЫВАЕТСЯ. На устройстве группы -W и -C существуют
 * ОДНОВРЕМЕННО, а какая из них действует, решает ядро по `ssid-policy`.
 * Поэтому сеть определяется так же, как в сборщике: по хвосту имени, которое
 * выбрали родительские группы RH-AI / RH-АВТО / RH-Звонки. Взять «W, а если
 * нет — C» нельзя: на сотовой это проверяло бы не ту группу и не тот набор
 * узлов, а второй рубеж правила 1 смотрел бы не на ту политику.
 *
 * КАК ЗАПУСКАТЬ. Расписанием `cron`, туннель Stash поднят. Прогонов нужно
 * несколько и в разное время: одиночное измерение — не вывод.
 */

var REV = 'ST15';
var T0 = Date.now();

/* ВРЕМЯ: ДВЕ ШКАЛЫ, И ИХ НЕЛЬЗЯ ПУТАТЬ.
 * BUDGET_MS и left() считаются по Date.now() — это настоящие миллисекунды.
 * Всё, что уходит в setTimeout, — НОМИНАЛ: у Stash фоновый таймер
 * растягивается втрое-вчетверо (ST5). Тайм-ауты $httpClient настоящие и не
 * растягиваются, и именно на них держится расчёт.
 *
 * ⛔ ДЕФЕКТ ПЕРВОЙ РЕДАКЦИИ (найден ревью 05.09): предохранитель узла стоял
 * на NODE_COST_MS/3 = 4667 мс при клиентском тайм-ауте 8 с. В переднем плане,
 * где растяжения нет, он резал СВОЙ ЖЕ запрос раньше, чем тот успевал
 * ответить: узел, у которого все пять сервисов отвечали за 6 с, объявлялся
 * мёртвым, а вердикт советовал чинить туннель. Это дословное повторение
 * дефекта ST14 — «молчала проба, а не узел». ПРАВИЛО: предохранитель обязан
 * стоять ПОЗЖЕ клиентского тайм-аута с запасом, потому что он нужен только
 * на патологию «обратный вызов не придёт никогда», а не на медленный ответ.
 *
 * Худший ЧЕСТНЫЙ прогон: CTRL_SEC + NODES_N * SVC_SEC = 5 + 4*6 = 29 с, все
 * секунды настоящие. Бюджет 60 с — двукратный запас. Сторож 40 с номинала:
 * в переднем плане срабатывает после худшего прогона (29 с) и до бюджета;
 * в фоне растягивается за пределы `timeout: 90` самого задания cron, и там
 * последним рубежом служит уже он — это осознанно, потому что в фоне до
 * сторожа доводит только патология, а её всё равно обрывает клиент.
 */
var BUDGET_MS = 60000;
var GUARD_MS = 40000;
var NODE_WATCH_MS = 9000;      // номинал; должен быть > SVC_SEC с запасом
// Резерв на узел считается по ХУДШЕМУ случаю, а он в фоне равен РАСТЯНУТОМУ
// предохранителю (9 с номинала при растяжении вчетверо — 36 с), а не честным
// шести секундам. С резервом 10 с проба начинала бы четвёртый узел, имея на
// него 10 с бюджета и 36 с потребности, и уходила бы за `timeout: 90` самого
// задания cron — то есть без вывода вовсе.
var NODE_COST_MS = 20000;      // сколько НАСТОЯЩЕГО времени резервировать

var CTRL_SEC = 5;              // запрос к контроллеру
var SVC_SEC = 6;               // запрос к сервису через узел
var NODES_N = 4;               // сколько узлов проверить за прогон

var POOL_W = 'RH-AI-W';
var POOL_C = 'RH-AI-C';
var PARENTS = ['RH-AI', 'RH-АВТО', 'RH-Звонки'];
var BYPASS = 'Обход';
var SEP = ' · ';

// Адрес страны выхода. `/cdn-cgi/trace` отдаёт край Cloudflare открытым
// текстом: строки `loc=DE`, `ip=…`, `warp=off`. Хост взят НЕЙТРАЛЬНЫЙ, а не
// сервисный: у сервиса он мог бы отказать по стране, и тогда мы потеряли бы
// саму страну — то есть объяснение отказа.
var GEO_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

// Заголовок клиента. Без него 403 от бот-защиты приходит на ровном месте и
// неотличим от странового запрета — а различить их и есть задача пробы.
var UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

// Список сервисов. Правится по результатам прогона, а не по памяти.
var SERVICES = [
  { id: 'ChatGPT',    url: 'https://chatgpt.com/robots.txt' },
  { id: 'Claude',     url: 'https://claude.ai/robots.txt' },
  { id: 'Gemini',     url: 'https://gemini.google.com/robots.txt' },
  { id: 'Grok',       url: 'https://grok.com/robots.txt' },
  { id: 'Perplexity', url: 'https://www.perplexity.ai/robots.txt' }
];

// Приметы бот-защиты в теле отказа. Список открытый: что не опознано,
// остаётся просто «ЗАПРЕТ» — молча дорисовывать причину нельзя.
var BOT_MARKS = ['just a moment', 'cf-mitigated', 'checking your browser',
                 'enable javascript and cookies', 'attention required'];
var GEO_MARKS = ['unsupported_country', 'not available in your country',
                 'country is not supported', 'unsupported region'];

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
function isBypass(n) { return String(n).indexOf(BYPASS) >= 0; }
function shortName(n) {
  var s = String(n), i = s.indexOf(SEP);
  return (i >= 0 ? s.slice(0, i) : s).replace(/^\s+|\s+$/g, '');
}
// Служебные члены (DIRECT, REJECT) и вложенные группы — не узлы. Обе
// проверки перенесены из сборщика: пиновка на имя ГРУППЫ отдала бы запрос
// тому, кого группа выбрала сейчас, то есть потенциально обходному узлу.
function looksLikeNode(n) { return typeof n === 'string' && n.length >= 5 && n.indexOf('[') >= 0; }
function isGroup(p) {
  var t = String((p && (p.type || p.Type)) || '').toLowerCase();
  return t === 'selector' || t === 'fallback' || t === 'urltest' || t === 'url-test' ||
    t === 'loadbalance' || t === 'load-balance' || t === 'relay';
}

// К контроллеру — только GET (правило 2).
function ctl(path, cb) {
  var o = { url: CTRL + path, timeout: CTRL_SEC };
  if (AUTH) o.headers = { Authorization: AUTH };
  var done = false;
  function once(b, st, e) { if (done) return; done = true; cb(b, st, e); }
  try {
    G.$httpClient.get(o, function (e, r, body) {
      once(e ? null : body, (r && r.status) || 0, e ? String(e) : null);
    });
  } catch (e2) { once(null, 0, String(e2)); }
}

// Пиновка на узел заголовком X-Stash-Selected-Proxy: имя ПОЛНОЕ, с хвостом
// метрик, URL-кодированное. Способ подтверждён сборщиком на устройстве.
function through(full, url, cb) {
  var o = {
    url: url, timeout: SVC_SEC,
    headers: {
      'X-Stash-Selected-Proxy': encodeURIComponent(full),
      'User-Agent': UA,
      'Accept': '*/*'
    }
  };
  var t0 = Date.now(), done = false;
  function once(st, body, e) { if (done) return; done = true; cb(st, body, e, Date.now() - t0); }
  try {
    G.$httpClient.get(o, function (e, r, body) {
      once((r && r.status) || 0, body || '', e ? String(e) : null);
    });
  } catch (e2) { once(0, '', String(e2)); }
}

// ── Ф1. ПУЛ ──────────────────────────────────────────────────────────
var picked = [], out = {};

function stepPool(next) {
  ctl('/proxies', function (body, st, e) {
    if (!body) { rep.ans.ВЕРДИКТ = 'контроллер не ответил: ' + (e || ('статус ' + st)); next(); return; }
    var d = null;
    try { d = JSON.parse(body); } catch (e2) { rep.ans.ВЕРДИКТ = 'ответ /proxies не разобран'; next(); return; }
    var MAP = (d && (d.proxies || d.Proxies)) || d || {};

    // СЕТЬ — это ЧТЕНИЕ решения, уже принятого ядром по ssid-policy, а не
    // своё определение (метод сборщика). Родителей трое; расхождение между
    // ними означает, что читать нечего, и прогон честнее пропустить.
    var nets = {}, seenP = 0;
    for (var pi = 0; pi < PARENTS.length; pi++) {
      var pp = MAP[PARENTS[pi]];
      if (!pp) continue;
      seenP++;
      var cur = String(pp.now || pp.Now || '');
      var tail = cur.slice(-2);
      if (tail === '-W') nets.wifi = 1;
      else if (tail === '-C') nets.cell = 1;
      else if (cur) nets.other = 1;
    }
    var ks = [];
    for (var nk in nets) ks.push(nk);
    var NET = (ks.length === 1 && ks[0] === 'wifi') ? 'wifi'
      : ((ks.length === 1 && ks[0] === 'cell') ? 'cell' : '');
    if (!NET) {
      rep.ans.ВЕРДИКТ = 'СЕТЬ НЕ ОПРЕДЕЛЕНА (родителей ' + seenP + ', признаки: ' +
        (ks.join('+') || 'нет') + ') — проверять было бы наугад не ту группу';
      next(); return;
    }
    rep.ans.сеть = (NET === 'wifi') ? 'Wi-Fi' : 'сотовая';

    var poolName = (NET === 'wifi') ? POOL_W : POOL_C;
    var g = MAP[poolName];
    if (!g) { rep.ans.ВЕРДИКТ = 'группы ' + poolName + ' нет в /proxies — профиль на устройстве не наш'; next(); return; }
    rep.ans.группа = poolName;
    var now = String(g.now || g.Now || '');
    rep.ans.выбран_сейчас = now ? shortName(now) : '?';
    // ВТОРОЙ РУБЕЖ ПРАВИЛА 1, и он ЗАКРЫТ ПО УМОЛЧАНИЮ. Если пиновка молча
    // перестанет работать, запрос уйдёт по текущей политике, а её последний
    // запас — обход. Пустое `now` означает «ядро не сказало, кого выбрало»,
    // то есть проверить рубеж НЕЧЕМ; открывать его в этом случае — ровно тот
    // способ, которым правило 1 уже нарушалось конструкцией, а не пробой.
    if (!now || isBypass(now)) {
      rep.ans.ВЕРДИКТ = 'НЕ НАЧАЛИ: группа ' + poolName + ' сейчас ' +
        (now ? ('на обходном узле (' + shortName(now) + ')') : 'не сообщила выбранный узел') +
        '. Если пиновка не сработает, запросы уйдут по платному трафику — ' +
        'прогон отложен до возврата на обычный узел';
      next(); return;
    }
    var members = g.all || g.All || [];
    var skipped = 0, notNode = 0, dup = 0, seen = {};
    for (var i = 0; i < members.length && picked.length < NODES_N; i++) {
      var nm = members[i];
      if (isBypass(nm)) { skipped++; continue; }              // первый рубеж правила 1
      if (!looksLikeNode(nm)) { notNode++; continue; }
      var p = MAP[nm];
      if (!p || isGroup(p)) { notNode++; continue; }
      var sn = shortName(nm);
      // Короткое имя — ключ отчёта, и оно у двух членов может совпасть:
      // суффикс уникальности ` (2)` навешивается ПОСЛЕ хвоста метрик, а узел
      // без замеров остаётся с чистым базовым именем. Дубликат пропускаем ДО
      // опроса — иначе трафик тратится, а результат затирается.
      if (seen[sn]) { dup++; continue; }
      seen[sn] = 1;
      picked.push({ full: nm, name: sn,
                    alive: (p.alive !== undefined ? p.alive : '?') });
    }
    rep.ans.членов = members.length;
    rep.ans.обходных_пропущено = skipped;
    if (notNode) rep.ans.не_узлы = notNode;
    if (dup) rep.ans.дубликаты_имён = dup;
    rep.ans.взято = picked.length;
    next();
  });
}

// ── Ф2. ПРОВЕРКА ОДНОГО УЗЛА ─────────────────────────────────────────
// Запросы уходят вместе; ответы собирает счётчик. Ждать нечего: хосты
// разные, общий у них только узел.
function classify(st, body) {
  var r = { статус: st };
  var low = String(body || '').toLowerCase();
  if (st >= 200 && st < 400) { r.итог = 'ОТВЕТИЛ'; return r; }
  if (st === 403 || st === 451) {
    r.итог = 'ЗАПРЕТ';
    for (var i = 0; i < GEO_MARKS.length; i++) if (low.indexOf(GEO_MARKS[i]) >= 0) r.вид = 'страна';
    if (!r.вид) for (var j = 0; j < BOT_MARKS.length; j++) if (low.indexOf(BOT_MARKS[j]) >= 0) r.вид = 'бот-защита';
    if (!r.вид) r.вид = 'не опознан';
    return r;
  }
  if (st === 0) { r.итог = 'НЕ ДОШЛИ'; return r; }
  if (st === 429 || st >= 500) { r.итог = 'ВРЕМЕННО'; return r; }
  r.итог = 'ОТКАЗ ' + st;
  return r;
}

function checkNode(it, cb) {
  var rec = { alive_ядро: it.alive, страна: '?', сервисы: {} };
  var need = 1 + SERVICES.length, got = 0, fired = false, watch = null;
  // Предохранитель заводится ДО отправки запросов: $httpClient умеет
  // ответить синхронно (ветка catch в through), и тогда присваивание watch
  // выполнилось бы уже после вывода — таймер повис бы за $done.
  function close(reason) {
    if (fired) return;
    fired = true;
    try { clearTimeout(watch); } catch (e) {}
    // Сервисы, не приславшие ответ вовсе: без этой строки узел с пропавшим
    // сервисом считался бы чистым — «4 из 4» вместо «4 из 5».
    var lost = 0;
    for (var i = 0; i < SERVICES.length; i++) {
      if (!rec.сервисы[SERVICES[i].id]) { rec.сервисы[SERVICES[i].id] = { итог: 'НЕТ ОТВЕТА', статус: null }; lost++; }
    }
    // Неполнота ПО СЕРВИСАМ и неполнота по стране — разные вещи, и мерить их
    // одним счётчиком нельзя: потеря одного запроса `trace` при пяти
    // ответивших сервисах обесценивала бы полный опрос. У неудачи со страной
    // есть своё честное представление — поле `страна`.
    if (reason && lost) rec.неполно = 'нет ответа от сервисов: ' + lost + ' из ' + SERVICES.length;
    else if (reason) rec.неполно_страна = reason;
    out[it.name] = rec;
    cb();
  }
  function done1() { got++; if (got >= need) close(null); }

  // Только на патологию «обратный вызов не придёт никогда»: стоит ПОЗЖЕ
  // клиентского тайм-аута с запасом (см. шапку про две шкалы времени).
  watch = setTimeout(function () { close('ответов ' + got + ' из ' + need); }, NODE_WATCH_MS);

  through(it.full, GEO_URL, function (st, body, e, ms) {
    if (fired) return;                       // поздний ответ уже отданной записи
    rec.страна_мс = ms;
    if (st >= 200 && st < 400 && body) {
      var m = String(body).match(/(?:^|\n)loc=([A-Z]{2})/);
      if (m) rec.страна = m[1];
      var w = String(body).match(/(?:^|\n)warp=(\w+)/);
      if (w && w[1] !== 'off') rec.warp = w[1];
      var ip = String(body).match(/(?:^|\n)ip=([0-9a-fA-F.:]+)/);
      // Адрес выхода нужен для сверки пиновки; последняя группа скрыта —
      // страну он объясняет, а сам по себе в отчёте не нужен целиком.
      if (ip) rec.выход = ip[1].replace(/(\.\d+)$/, '.x').replace(/:[0-9a-fA-F]{1,4}$/, ':x');
    } else {
      rec.страна = st ? ('статус ' + st) : ('нет ответа: ' + (e || 'таймаут'));
    }
    done1();
  });
  for (var i = 0; i < SERVICES.length; i++) {
    (function (s) {
      through(it.full, s.url, function (st, body, e, ms) {
        if (fired) return;
        var r = classify(st, body);
        r.мс = ms;
        if (r.итог === 'ОТВЕТИЛ') {
          // Отпечаток тела: 200 с капчей или заглушкой иначе неотличим от
          // настоящего robots.txt, и «ОТВЕТИЛ» нечем перепроверить.
          r.байт = String(body || '').length;
          r.начало = String(body || '').replace(/\s+/g, ' ').slice(0, 40);
        } else {
          if (e) r.ошибка = String(e).slice(0, 120);
          if (body) r.ответ = String(body).slice(0, 160);
        }
        rec.сервисы[s.id] = r;
        done1();
      });
    })(SERVICES[i]);
  }
}

function stepNodes(i, next) {
  if (FINISHED) return;
  if (i >= picked.length || left() < NODE_COST_MS) {
    if (i < picked.length) rep.ans.не_успели = picked.length - i;
    next(); return;
  }
  checkNode(picked[i], function () { stepNodes(i + 1, next); });
}

// ── Ф3. ВЕРДИКТ ──────────────────────────────────────────────────────
function verdict() {
  if (rep.ans.ВЕРДИКТ) return rep.ans.ВЕРДИКТ;
  var names = [];
  for (var k in out) if (out.hasOwnProperty(k)) names.push(k);
  if (!names.length) return 'НЕПОЛНО: ни один узел не проверен';
  // ПЯТЬ корзин, а не четыре. «Только временные отказы» — отдельный исход:
  // 429 и 5xx приходят от края сервиса при перегрузке и об узле не говорят
  // ничего. Свалить их в «мимо» значило бы отправить Диану чинить исправный
  // туннель, а свалить в «чистые» — назвать пропущенным то, что не пробовали.
  var clean = [], part = [], bad = [], busy = [], incomplete = [], byService = {};
  for (var i = 0; i < names.length; i++) {
    var rec = out[names[i]], ok = 0, no = 0, tmp = 0;
    var tot = SERVICES.length;               // знаменатель ЗАЯВЛЕННЫЙ, не пришедший
    for (var si = 0; si < SERVICES.length; si++) {
      var id = SERVICES[si].id;
      var v = (rec.сервисы[id] && rec.сервисы[id].итог) || 'НЕТ ОТВЕТА';
      if (!byService[id]) byService[id] = { ответил: 0, отказал: 0, всего: 0 };
      byService[id].всего++;
      if (v === 'ОТВЕТИЛ') { ok++; byService[id].ответил++; }
      else if (v === 'ВРЕМЕННО') tmp++;      // временный отказ узел не порочит
      else { no++; byService[id].отказал++; }
    }
    rec.сводка = ok + ' из ' + tot + ', выход ' + rec.страна +
      (tmp ? ', временных отказов ' + tmp : '');
    if (rec.неполно) incomplete.push(names[i]);
    else if (ok === tot) clean.push(names[i]);          // ВСЕ, без оговорок
    else if (!ok && tmp && !no) busy.push(names[i]);    // только временные
    else if (ok) part.push(names[i]);
    else bad.push(names[i]);
  }
  rep.ans.по_сервисам = byService;
  rep.ans.чистых = clean;
  rep.ans.частично = part;
  rep.ans.мимо = bad;
  if (busy.length) rep.ans.только_временные = busy;
  if (incomplete.length) rep.ans.неполные = incomplete;

  // ОДИН И ТОТ ЖЕ СЕРВИС ОТКАЗАЛ НА ВСЕХ УЗЛАХ — это подозрение на НАШ адрес
  // в списке, а не на узлы. Без такой подсказки ошибка в SERVICES выглядит
  // как поломка половины пула, и чинить пошли бы не то.
  var suspect = [];
  for (var sid in byService) {
    if (byService.hasOwnProperty(sid) && byService[sid].всего > 1 &&
        byService[sid].ответил === 0 && byService[sid].отказал === byService[sid].всего) suspect.push(sid);
  }
  if (suspect.length) rep.ans.проверить_адрес = suspect;

  var full = names.length - incomplete.length;
  var tail = (suspect.length ? '; на всех узлах молчат ' + suspect.join(', ') +
    ' — проверить адрес в списке пробы, а не узлы' : '') +
    (incomplete.length ? '; неполно опрошено: ' + incomplete.join(', ') : '');
  if (!full) return 'НЕПОЛНО: ни один узел не опрошен целиком (' + incomplete.join(', ') + ')' + tail;
  if (busy.length === full) return 'НЕ ПРОВЕРЕНО: все ' + full +
    ' узлов получили только временные отказы (429/5xx) — край сервисов сейчас не отвечает по существу, ' +
    'об узлах это не говорит ничего; повторить позже' + tail;
  if (clean.length === full) return 'ЧИСТЫ ВСЕ ПРОВЕРЕННЫЕ УЗЛЫ (' + full + ')' + tail;
  if (!clean.length && !part.length && !busy.length) return 'НИ ОДИН из ' + full +
    ' узлов не пустил ни один сервис — сперва проверить, поднят ли туннель и есть ли доступ вообще' + tail;
  if (!clean.length) return 'ЧИСТЫХ УЗЛОВ НЕТ' +
    (part.length ? ': частично работают ' + part.join(', ') : '') +
    (busy.length ? '; только временные отказы у ' + busy.join(', ') : '') + tail;
  return 'ЧИСТЫХ ' + clean.length + ' из ' + full + ': ' + clean.join(', ') +
    (part.length ? '; частично: ' + part.join(', ') : '') +
    (busy.length ? '; только временные отказы: ' + busy.join(', ') : '') +
    (bad.length ? '; мимо: ' + bad.join(', ') : '') + tail;
}

// ── ЗАВЕРШЕНИЕ ───────────────────────────────────────────────────────
var GUARD = null;
function finish() {
  if (FINISHED) return;
  FINISHED = true;
  try { clearTimeout(GUARD); } catch (e) {}
  // Всё до $done — под try: исключение здесь означало бы, что проба не дошла
  // до вывода вовсе, а сторож уже не поможет (FINISHED выставлен).
  var lines, color = '#FF9F0A';
  try {
    rep.ans.ВЕРДИКТ = verdict();
    rep.ans.узлы = out;
    rep.ms = Date.now() - T0;
    var a = rep.ans;
    // Усечение прогона обязано быть видно в ТЕКСТЕ, а не только в буфере:
    // иначе срезанный прогон выглядит как штатный и выдаёт бодрый вердикт.
    var warn = [];
    if (a.не_успели) warn.push('не успели узлов: ' + a.не_успели);
    if (a.неполные) warn.push('неполно опрошено: ' + a.неполные.join(', '));
    if (a.проверить_адрес) warn.push('проверить адрес в списке пробы: ' + a.проверить_адрес.join(', '));
    if (a.дубликаты_имён) warn.push('дубликатов имён пропущено: ' + a.дубликаты_имён);
    if (rep.err.length) warn.push('сбои: ' + rep.err.join('; '));
    lines = [
      a.ВЕРДИКТ,
      'сеть ' + (a.сеть || '?') + ', группа ' + (a.группа || '?') + ', членов ' + (a.членов || 0) +
        ', обходных пропущено ' + (a.обходных_пропущено || 0) +
        ', сейчас выбран ' + (a.выбран_сейчас || '?'),
      'по сервисам: ' + JSON.stringify(a.по_сервисам || {}),
      'узлы: ' + JSON.stringify(out),
      'Stash ' + (a.stash || '?') + ', ' + rep.ms + ' мс'
    ];
    if (warn.length) lines.splice(1, 0, '⚠ ' + warn.join('; '));
    if (a.ВЕРДИКТ.indexOf('ЧИСТЫ ВСЕ') === 0 && !warn.length) color = '#34C759';
    else if (a.ВЕРДИКТ.indexOf('НИ ОДИН') === 0 ||
             a.ВЕРДИКТ.indexOf('ЧИСТЫХ УЗЛОВ НЕТ') === 0) color = '#FF3B30';
  } catch (e0) {
    rep.err.push('сборка вывода упала: ' + String(e0));
    lines = ['СБОЙ ПРОБЫ: ' + String(e0), 'сырьё: ' + (function () {
      try { return JSON.stringify(out).slice(0, 400); } catch (e1) { return '?'; }
    })()];
    color = '#FF3B30';
  }
  try { console.log('[' + REV + '] ' + JSON.stringify(rep)); } catch (e2) {}
  try {
    $notification.post('RouteHub ' + REV, lines[0], lines.slice(1).join('\n'),
      { clipboard: JSON.stringify(rep) });
  } catch (e3) {}
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'),
            icon: 'brain.head.profile', backgroundColor: color });
  } catch (e4) { try { $done(); } catch (e5) {} }
}

GUARD = setTimeout(function () {
  if (!FINISHED) { rep.err.push('сторож: цепочка не завершилась'); finish(); }
}, GUARD_MS);

stepPool(function () { stepNodes(0, finish); });
// конец файла — хвостовой страж (вывод 49)
