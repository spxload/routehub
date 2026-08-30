/*
 * RouteHub — ПРОБА STASH ST9. Один вопрос, по схеме ST7 и ST8.
 * ===========================================================================
 * ВОПРОС: можно ли на Stash собрать метрики узлов без того, чего у Stash нет,
 * и не сломал ли `benchmark-disabled` у обходных узлов их подхват.
 *
 * ПОЧЕМУ ИМЕННО ЭТОТ. Профиль Stash уже отдаётся стендом, но сортировки по
 * композитному баллу на нём НЕТ: балл кормит `scripts/routehub-speedtest.js`,
 * а он написан на трёх опорах Loon, из которых две у Stash отсутствуют:
 *   1. `$config.getSubPolicys(группа)` — список узлов группы;
 *   2. `$httpClient.get({ node: имя })` — пиновка запроса на конкретный узел;
 *   3. `$config.getConfig().ssid` — Wi-Fi это или сотовая.
 * По ST2 в среде Stash ровно шесть `$`-объектов и `$config` среди них НЕТ,
 * то есть третья опора недоступна принципиально. Проба проверяет замены.
 *
 * ГИПОТЕЗЫ, КОТОРЫЕ ПРОВЕРЯЮТСЯ (каждая может не подтвердиться):
 *   А. Список узлов даёт control API: `GET /proxies` (эндпоинт живой, ST3).
 *   Б. Сеть определяется КОСВЕННО. Переключением между Wi-Fi и сотовой у нас
 *      занимается сам Stash через `ssid-policy` у родительских групп. Значит
 *      достаточно спросить ядро, на какого члена сейчас смотрит родитель:
 *      RH-AI -> RH-AI-W означает Wi-Fi, RH-AI -> RH-AI-C означает сотовую.
 *      Это ЧТЕНИЕ уже принятого клиентом решения, а не своё определение.
 *   В. Задержку меряет само ядро: `GET /proxies/{имя}/delay`. По ST4 эндпоинт
 *      существует, но отвечал 503 без сети — на живом узле не мерян ни разу.
 *      Заодно закрывается открытый хвост 8: сопоставима ли эта задержка с
 *      нашим `rtt`.
 *
 * ЧЕМ ЭТО НЕ ЯВЛЯЕТСЯ. Проба НЕ меряет скорость скачивания и НЕ пишет
 * никуда результат. Скорость — самая дорогая часть замера, и решать, как её
 * снимать на Stash, можно только после ответа на вопрос выше.
 *
 * ПРАВИЛО 1 ПРОЕКТА СОБЛЮДЕНО: обходные узлы не замеряются. Замер задержки
 * идёт ЧЕРЕЗ узел, а трафик обходных узлов платный, поэтому любое имя с
 * пометкой обхода отбрасывается до вызова, а не после.
 * ПРАВИЛО 2 СОБЛЮДЕНО: только GET. Ни PUT /proxies/{имя}, ни PATCH /configs,
 * ни обновления наборов — пробам запись в боевую маршрутизацию запрещена.
 *
 * КАК ЗАПУСКАТЬ. Расписанием `cron` — плитка на Stash 3.4.1 нажатием скрипт
 * не запускает (проверено 24.08). Туннель должен быть поднят.
 * Выгрузка уходит двумя путями: в буфер обмена уведомлением и в «Журналы ->
 * Журналы сценариев» через console.log.
 */

var REV = 'ST9';
var T0 = Date.now();
var BUDGET_MS = 14000;                // настоящие миллисекунды, через Date.now()
var PROBE_N = 3;                      // сколько узлов мерить задержкой
var DELAY_URL = 'http://connectivitycheck.gstatic.com/generate_204';
var DELAY_MS = 2000;                  // бюджет ядру на один замер
var BYPASS_N = 3;                     // сколько обходных узлов ОПИСАТЬ (не мерить)

var rep = { rev: REV, ts: new Date().toISOString(), ans: {}, err: [] };
var G = (typeof globalThis !== 'undefined') ? globalThis : this;

// Родительские группы с `ssid-policy` — те, что кладёт src/clients/stash.js.
// Каждая обязана смотреть на своего члена -W или -C; расхождение между ними
// само по себе находка, поэтому спрашиваются все три, а не одна.
var PARENTS = ['RH-AI', 'RH-АВТО', 'RH-Звонки'];

// Пометка обходного узла в имени: тег провайдера, который ставит подписка.
var BYPASS = 'Обход';

var CTRL = 'http://127.0.0.1:9090', AUTH = '';
try {
  CTRL = ($environment && $environment['controller-url']) || CTRL;
  AUTH = ($environment && $environment['controller-authorization']) || '';
  rep.ans.stash = ($environment && $environment['stash-version']) || '?';
} catch (e) { rep.err.push('нет $environment'); }
CTRL = String(CTRL).replace(/\/+$/, '');

function get(path, sec, cb) {
  var o = { url: CTRL + path, timeout: sec };
  if (AUTH) o.headers = { Authorization: AUTH };
  var done = false;
  function once(body, e) { if (done) return; done = true; cb(body, e); }
  try {
    G.$httpClient.get(o, function (e, r, body) {
      once(e ? null : body, e ? String(e) : (r && r.status >= 400 ? 'HTTP ' + r.status : null));
    });
  } catch (e2) { once(null, String(e2)); }
}

function isBypass(name) { return String(name).indexOf(BYPASS) >= 0; }

// ── ШАГ 1: /proxies ──────────────────────────────────────────────
// Отвечает сразу на две гипотезы: А (есть ли состав групп) и Б (на кого
// смотрит родитель). Один запрос вместо трёх — /proxies отдаёт всё разом.
var PROXIES = null;

function stepProxies(next) {
  get('/proxies', 3, function (body, e) {
    if (e || !body) { rep.ans.proxies = 'не ответил: ' + (e || 'пусто'); next(); return; }
    var d = null;
    try { d = JSON.parse(body); } catch (e2) {
      rep.ans.proxies = 'не разобрался: ' + String(body).slice(0, 120);
      next(); return;
    }
    var map = (d && (d.proxies || d.Proxies)) || d || {};
    PROXIES = map;
    var all = [];
    for (var k in map) all.push(k);
    rep.ans.записей_в_proxies = all.length;

    // Гипотеза Б: куда смотрит каждый родитель.
    var now = {}, nets = {};
    for (var i = 0; i < PARENTS.length; i++) {
      var p = map[PARENTS[i]];
      if (!p) { now[PARENTS[i]] = 'НЕТ ГРУППЫ'; continue; }
      var cur = p.now || p.Now || '';
      now[PARENTS[i]] = cur || '?';
      var tail = String(cur).slice(-2);
      if (tail === '-W') nets.wifi = 1;
      else if (tail === '-C') nets.cell = 1;
      else if (cur) nets.other = 1;
    }
    rep.ans.родительские_группы = now;
    var keys = [];
    for (var n in nets) keys.push(n);
    rep.ans.сеть_по_группам = (keys.length === 1 && keys[0] === 'wifi') ? 'wifi'
      : (keys.length === 1 && keys[0] === 'cell') ? 'cell'
      : (keys.length === 0 ? 'не определена' : 'РАЗОШЛИСЬ: ' + keys.join('+'));

    // Гипотеза А: состав группы -W как замена getSubPolicys. Берём RH-AI-W:
    // она уже и есть каскад «что годится для AI», то есть ровно тот список,
    // который сборщику и нужно мерить.
    var src = map['RH-AI-W'];
    var members = (src && (src.all || src.All)) || [];
    rep.ans.членов_RH_AI_W = members.length;
    // Поля одной записи — чтобы в следующий раз не гадать, что там лежит.
    if (src) {
      var f = [];
      for (var ff in src) f.push(ff);
      rep.ans.поля_группы = f;
    }
    var node0 = null;
    for (var m = 0; m < members.length; m++) {
      if (!map[members[m]]) continue;
      node0 = map[members[m]]; break;
    }
    if (node0) {
      var fn = [];
      for (var fnn in node0) fn.push(fnn);
      rep.ans.поля_узла = fn;
      // Есть ли у ядра СВОЯ история задержек — тогда часть замера уже сделана.
      rep.ans.история_у_ядра = Array.isArray(node0.history) ? node0.history.length : 'нет';
    }

    // ЧЕТВЁРТЫЙ ВОПРОС, добавлен вместе с S-draft-3. Обходным узлам профиль
    // ставит `benchmark-disabled: true`, чтобы ядро не жгло платный трафик
    // замером каждые 600 с. Цена неизвестна: как fallback относится к члену
    // БЕЗ результата замера. Ожидание — считает доступным и берёт последним;
    // опасение — считает мёртвым, и тогда обход не возьмётся никогда, то
    // есть whitelist-сценарий сломан. Проба НЕ МЕРЯЕТ обходные узлы (правило
    // 1), а только читает, что о них думает ядро.
    var byp = {}, seenB = 0;
    for (var b = 0; b < members.length && seenB < BYPASS_N; b++) {
      var bn = members[b];
      if (!isBypass(bn)) continue;
      var bp = map[bn];
      if (!bp) continue;
      seenB++;
      byp[bn] = {
        alive: (bp.alive !== undefined ? bp.alive : (bp.Alive !== undefined ? bp.Alive : '?')),
        история: Array.isArray(bp.history) ? bp.history.length : 'нет',
      };
    }
    rep.ans.обходные_глазами_ядра = seenB ? byp : 'в группе их нет';
    next();
  });
}

// ── ШАГ 2: /proxies/{имя}/delay ──────────────────────────────────
// Гипотеза В. Обходные узлы отброшены ДО вызова: замер идёт через узел.
var picked = [], delays = {};

function pickNodes() {
  if (!PROXIES) return;
  var src = PROXIES['RH-AI-W'];
  var members = (src && (src.all || src.All)) || [];
  for (var i = 0; i < members.length && picked.length < PROBE_N; i++) {
    var nm = members[i];
    if (!nm || isBypass(nm)) continue;          // правило 1
    var p = PROXIES[nm];
    if (!p) continue;                            // это группа, а не узел
    var t = String(p.type || p.Type || '').toLowerCase();
    if (t === 'selector' || t === 'fallback' || t === 'urltest' ||
        t === 'url-test' || t === 'loadbalance' || t === 'load-balance') continue;
    picked.push(nm);
  }
  rep.ans.взято_на_замер = picked.length;
  rep.ans.обходные_пропущены = 'да (правило 1)';
}

function measure(i, cb) {
  if (i >= picked.length || (Date.now() - T0) > BUDGET_MS - 3000) { cb(); return; }
  var nm = picked[i];
  var q = '/proxies/' + encodeURIComponent(nm) + '/delay?timeout=' + DELAY_MS +
    '&url=' + encodeURIComponent(DELAY_URL);
  var t0 = Date.now();
  get(q, 5, function (body, e) {
    var wall = Date.now() - t0;
    if (e || !body) { delays[nm] = 'не ответил: ' + (e || 'пусто') + ' (' + wall + ' мс)'; }
    else {
      var d = null; try { d = JSON.parse(body); } catch (e2) {}
      var v = d && (d.delay != null ? d.delay : (d.Delay != null ? d.Delay : null));
      delays[nm] = (v == null)
        ? ('без поля delay: ' + String(body).slice(0, 80))
        : (v + ' мс ядра / ' + wall + ' мс стенки');
    }
    measure(i + 1, cb);
  });
}

function stepDelay(next) {
  pickNodes();
  if (!picked.length) { rep.ans.задержка = 'нечего мерить'; next(); return; }
  measure(0, function () { rep.ans.задержка = delays; next(); });
}

// ── ВЕРДИКТ ──────────────────────────────────────────────────────
function verdict() {
  var a = rep.ans;
  var netOk = (a.сеть_по_группам === 'wifi' || a.сеть_по_группам === 'cell');
  var listOk = (typeof a.членов_RH_AI_W === 'number' && a.членов_RH_AI_W > 0);
  var measured = 0;
  for (var k in delays) { if (String(delays[k]).indexOf('мс ядра') >= 0) measured++; }
  a.замерено = measured;
  if (!listOk) return 'НЕТ: список узлов не получен, сборщику не на чем стоять';
  if (!netOk) return 'ЧАСТИЧНО: список есть, сеть не определена (' + a.сеть_по_группам + ')';
  if (!measured) return 'ЧАСТИЧНО: список и сеть есть, задержку ядро не дало';
  return 'ДА: список, сеть (' + a.сеть_по_группам + ') и задержка (' + measured +
    ' из ' + picked.length + ') берутся без $config';
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
    'родители: ' + JSON.stringify(a.родительские_группы || {}),
    'членов RH-AI-W: ' + (a.членов_RH_AI_W != null ? a.членов_RH_AI_W : '?') +
      ', записей в /proxies: ' + (a.записей_в_proxies != null ? a.записей_в_proxies : '?'),
    'задержка: ' + JSON.stringify(a.задержка || {}),
    'обход глазами ядра: ' + JSON.stringify(a.обходные_глазами_ядра || {}),
    'Stash ' + (a.stash || '?') + ', ' + rep.ms + ' мс',
  ];
  console.log('[' + REV + '] ' + JSON.stringify(rep));
  try {
    $notification.post('RouteHub ' + REV, lines[0], lines.slice(1).join('\n'),
      { clipboard: JSON.stringify(rep) });
  } catch (e) {}
  var color = '#8E8E93';
  if (a.ВЕРДИКТ.indexOf('ДА') === 0) color = '#34C759';
  else if (a.ВЕРДИКТ.indexOf('ЧАСТИЧНО') === 0) color = '#FF9F0A';
  else if (a.ВЕРДИКТ.indexOf('НЕТ') === 0) color = '#FF3B30';
  try {
    $done({ title: 'RouteHub ' + REV, content: lines.join('\n'),
            icon: 'speedometer', backgroundColor: color });
  } catch (e2) { try { $done(); } catch (e3) {} }
}

// Сторож. Номинал делится на 3,6 — во столько раз Stash растягивает таймеры
// по замеру ST5. Точность не нужна: он обязан сработать РАНЬШЕ лимита.
setTimeout(function () {
  if (!FINISHED) { rep.err.push('сторож: бюджет ' + BUDGET_MS + ' мс исчерпан'); finish(); }
}, Math.round(BUDGET_MS / 3.6));

stepProxies(function () { stepDelay(finish); });
