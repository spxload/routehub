/*
 * RouteHub — ПРОБА STASH ST6: «ЛАЗЕЙКИ».
 * ===========================================================================
 * ЗАЧЕМ ИМЕННО ЭТА ПРОБА. Разведка Surge затевалась не ради Surge: цель —
 * найти приёмы, которые переносятся в Stash. ST6 идёт с другой стороны:
 * берёт список того, что у Surge ЕСТЬ, и ищет то же самое у Stash.
 *
 * Плюс закрывает старый долг. В ST4 путь `/connections` ответил 200 и отдал
 * около 19 КБ, но тело в срез не поместилось и разобрано не было (ST7.1).
 * Полтора месяца в проекте висит вопрос «видно ли имя хоста» — от него
 * зависит, нужен ли нам MITM вообще. ST6 читает это тело целиком.
 *
 * ЧТО ПРОВЕРЯЕМ, ПО УБЫВАНИЮ ЦЕННОСТИ
 *
 * 1. ТЕЛО `/connections`. Есть ли имя хоста, а не только адрес. Если есть —
 *    журнал незагрузившихся доменов делается без MITM, и вывод 8 проекта
 *    пересматривается. У Surge аналогичная запись содержит поле `remoteHost`,
 *    так что искать надо не только `host`, но и его родню.
 *
 * 2. ЖИВЫЕ ПОТОКИ WebSocket. В ST2 замерено, что WebSocket в Stash
 *    соединяется, а в ST4 открыт `ws://…/traffic?token=`. Если рядом живут
 *    `/logs` или `/connections` потоком — это поток решений маршрутизации с
 *    доменами в реальном времени. Ровно то, чего проекту не хватает.
 *
 * 3. ЧТЕНИЕ СЕТИ ИЗ СКРИПТА. У Surge есть `$network` с SSID; в ADR-02 мы
 *    решили, что в Stash так нельзя, опираясь на опись ST2 (шесть
 *    `$`-объектов). Проверяем заново на текущей версии: вдруг добавили.
 *    Заодно смотрим, не отдаёт ли SSID сам контроллер.
 *
 * 4. ПАРИТЕТ С `$surge`. У Surge девять функций управления клиентом.
 *    Ищем у Stash эквиваленты — и в среде, и среди путей контроллера.
 *
 * 5. НЕПРОВЕРЕННЫЕ ПУТИ. ST4 перебрал 29 кандидатов. Здесь — вторая волна,
 *    построенная по тому, что нашлось у Surge и в клиентах на Clash.
 *
 * ТОЛЬКО ЧТЕНИЕ, И ЭТО ВАЖНО
 *   • Ни одного метода, кроме GET. `PUT /proxies/{имя}` в Stash РАБОТАЕТ и
 *     меняет боевую маршрутизацию — поэтому он здесь не вызывается.
 *   • Пути, которые звучат как действие (`/restart`, `/upgrade`, `/flush`,
 *     `/cache/fakeip/flush`), НЕ запрашиваются даже методом GET: у части
 *     клиентов они срабатывают на любом методе. Они перечислены в отчёте
 *     как «намеренно не проверены».
 *   • Через обходные узлы трафик не идёт: все запросы к 127.0.0.1.
 *   • Имена хостов из журнала выгружаются БЕЗ путей и параметров запроса —
 *     там может быть личное. Только доменное имя и счётчик.
 *
 * ЗАПУСК: секция `cron` профиля Stash либо плитка (`$script.type = tile`).
 * Отчёт — в консоль Stash; сводка уведомлением.
 */

var REV = 'ST6b';
var BUDGET_MS = 28000;
var T0 = Date.now();
var rep = { rev: REV, ts: new Date().toISOString(), answers: {}, steps: {}, errors: [] };

var G = (typeof globalThis !== 'undefined') ? globalThis : this;
function left() { return BUDGET_MS - (Date.now() - T0); }
function note(k, v) { rep.steps[k] = v; }
function err(k, e) { rep.errors.push(k + ': ' + String((e && e.message) || e)); }
function cut(s, n) { s = String(s == null ? '' : s); return s.length <= n ? s : s.slice(0, n) + '…<+' + (s.length - n) + '>'; }
function json(s) { try { return JSON.parse(s); } catch (e) { return null; } }

// Адрес и токен контроллера скрипт получает из среды — оба поля в
// документации Stash отсутствуют, найдены замером ST2.
var CTRL = '', AUTH = '';
try {
  CTRL = ($environment && $environment['controller-url']) || 'http://127.0.0.1:9090';
  AUTH = ($environment && $environment['controller-authorization']) || '';
} catch (e) { CTRL = 'http://127.0.0.1:9090'; }
CTRL = String(CTRL).replace(/\/+$/, '');

function get(path, timeoutMs, cb) {
  var done = false;
  var t = setTimeout(function () { if (!done) { done = true; cb(null, 'timeout'); } }, timeoutMs);
  try {
    $httpClient.get({ url: CTRL + path, headers: { Authorization: AUTH }, timeout: Math.ceil(timeoutMs / 1000) },
      function (e, r, b) {
        if (done) return; done = true; clearTimeout(t);
        if (e) { cb(null, String(e)); return; }
        cb({ status: (r && r.status) || null, body: b == null ? '' : String(b) }, null);
      });
  } catch (e2) { if (!done) { done = true; clearTimeout(t); cb(null, String(e2)); } }
}

// ── 1. Опись среды: сравнение с 13 объектами Surge ────────────────────────
(function () {
  try {
    var names = Object.getOwnPropertyNames(G).sort();
    var dollars = [];
    for (var i = 0; i < names.length; i++) if (names[i].charAt(0) === '$') dollars.push(names[i]);
    rep.answers['глобальных_имён'] = names.length;
    rep.answers['$объекты'] = dollars;
    // У Surge: $argument $done $environment $httpAPI $httpClient $input
    // $network $notification $persistentStore $script $surge $trigger $utils
    var SURGE_HAS = ['$network', '$surge', '$httpAPI', '$utils', '$input', '$trigger'];
    var miss = [], have = [];
    for (var j = 0; j < SURGE_HAS.length; j++) {
      var n = SURGE_HAS[j];
      (typeof G[n] === 'undefined' ? miss : have).push(n);
    }
    rep.answers['из_Surge_есть_в_Stash'] = have;
    rep.answers['из_Surge_нет_в_Stash'] = miss;
    // Полный разбор каждого $-объекта: вдруг нужное лежит внутри под
    // другим именем.
    var deep = {};
    for (var k = 0; k < dollars.length; k++) {
      var nm = dollars[k], v;
      try { v = G[nm]; } catch (e) { continue; }
      if (typeof v !== 'object' && typeof v !== 'function') { deep[nm] = typeof v; continue; }
      try { deep[nm] = Object.getOwnPropertyNames(v).sort().join(' '); } catch (e2) { deep[nm] = 'error'; }
    }
    note('среда_подробно', deep);
    // Ищем что угодно, похожее на чтение сети, по ИМЕНИ члена, а не по
    // имени объекта — приём, которым у Stash нашёлся globalProxy.
    var netLike = [];
    for (var nm2 in deep) {
      var members = String(deep[nm2]);
      if (/ssid|wifi|network|cellular|interface|carrier|radio/i.test(members)) netLike.push(nm2 + ': ' + members);
    }
    rep.answers['похожее_на_чтение_сети'] = netLike.length ? netLike : 'не найдено';
  } catch (e) { err('среда', e); }
})();

// ── 2. ТЕЛО /connections — главный долг ───────────────────────────────────
function stepConnections(next) {
  get('/connections', 6000, function (r, e) {
    if (!r) { err('connections', e); next(); return; }
    rep.answers['connections_статус'] = r.status;
    rep.answers['connections_байт'] = r.body.length;
    var j = json(r.body);
    if (!j) { note('connections_head', cut(r.body, 800)); next(); return; }
    var list = j.connections || (Array.isArray(j) ? j : []);
    rep.answers['соединений'] = list.length;
    if (!list.length) {
      rep.answers['ИМЯ_ХОСТА_ВИДНО'] = 'соединений нет — прогнать при включённом туннеле и живом трафике';
      next(); return;
    }
    // Схему записи выгружаем целиком: у Surge поле называлось remoteHost,
    // и первая редакция пробы его не нашла именно потому, что искала по
    // заранее выдуманному списку имён.
    var fields = [], meta = [];
    try { fields = Object.keys(list[0]).sort(); } catch (e2) {}
    try { if (list[0].metadata) meta = Object.keys(list[0].metadata).sort(); } catch (e3) {}
    rep.answers['поля_записи'] = fields;
    rep.answers['поля_metadata'] = meta;
    note('запись_пример', cut(JSON.stringify(list[0]), 900));

    var hosts = {}, withHost = 0, rules = {}, policies = {};
    for (var i = 0; i < list.length; i++) {
      var c = list[i] || {}, m = c.metadata || c;
      // Перебираем все правдоподобные имена поля, но берём их ИЗ ФАКТИЧЕСКОЙ
      // записи, а не из головы.
      var h = m.host || m.sniffHost || m.remoteHost || m.remoteDestination ||
              m.destinationHost || m.serverName || m.sni || '';
      h = String(h).replace(/:\d+$/, '');
      if (h && !/^\d+\.\d+\.\d+\.\d+$/.test(h) && h.indexOf(':') < 0) {
        withHost++; hosts[h] = (hosts[h] || 0) + 1;
      }
      var rl = c.rule || m.rule || '';
      if (rl) rules[rl] = (rules[rl] || 0) + 1;
      var ch = c.chains || c.chain;
      var pol = Array.isArray(ch) ? ch.join(' → ') : String(ch || '');
      if (pol) policies[pol] = (policies[pol] || 0) + 1;
    }
    var uniq = Object.keys(hosts).sort(function (a, b) { return hosts[b] - hosts[a]; });
    rep.answers['ИМЯ_ХОСТА_ВИДНО'] = withHost ? ('ДА, у ' + withHost + ' из ' + list.length) : 'НЕТ';
    rep.answers['уникальных_хостов'] = uniq.length;
    rep.answers['хосты_топ'] = uniq.slice(0, 40);
    rep.answers['правила_в_журнале'] = rules;
    rep.answers['цепочки_политик'] = policies;
    next();
  });
}

// ── 3. Вторая волна путей. ТОЛЬКО GET, только безвредные ─────────────────
// Список пополнен 24.08 по итогам SG3: у Surge нашлись три вещи, которых
// нет ни в Loon, ни в нашем стенде, и все три стоит поискать здесь.
//   /v1/dns       — кэш резолвера С ДОМЕНАМИ, цепочкой CNAME и таймингами.
//                   Готовый журнал доменов без всякого MITM.
//   /v1/events    — события клиента текстом: почему группа пуста, на каком
//                   порту слушает прокси. Диагностика, читаемая из скрипта.
//   /v1/scripting — список скриптов вместе с их параметрами.
var PATHS = [
  '/connections', '/proxies', '/providers/proxies', '/rules', '/configs',
  '/memory', '/logs', '/traffic', '/group', '/groups/delay',
  '/providers/rules', '/dns', '/dns/query?name=example.com&type=A',
  '/dns/cache', '/events', '/event', '/notifications',
  '/script', '/scripts', '/scripting', '/profile', '/version', '/ui', '/cache',
  '/proxies/DIRECT', '/proxies/GLOBAL'
];
// Намеренно НЕ запрашиваются: у части клиентов они срабатывают на любом методе.
var SKIPPED = ['/restart', '/upgrade', '/upgrade/core', '/cache/fakeip/flush',
  '/dns/flush', '/configs (PATCH)', '/proxies/{имя} (PUT)'];

function walk(i, acc, next) {
  if (i >= PATHS.length || left() < 6000) { next(acc, i); return; }
  get(PATHS[i], 2000, function (r) {
    acc[PATHS[i]] = r ? (r.status + ' · ' + r.body.length + ' Б') : '— нет ответа';
    if (r && r.status === 200 && r.body.length < 400) acc[PATHS[i]] += ' · ' + cut(r.body, 200);
    walk(i + 1, acc, next);
  });
}

// ── 3б. Кэш DNS: у Surge это готовый список доменов ──────────────────────
// SG3 показала, что Surge отдаёт по `/v1/dns` кэш резолвера с доменом,
// цепочкой CNAME, адресом сервера и временем ответа. Если Stash отдаёт
// такое же, задача «журнал доменов» закрывается без MITM и без разбора
// соединений: резолвер видит имя ДО того, как трафик пошёл.
function stepDns(next) {
  var tried = ['/dns', '/dns/cache', '/cache/dns'];
  function go(i) {
    if (i >= tried.length || left() < 5000) { next(); return; }
    get(tried[i], 3000, function (r) {
      if (r && r.status === 200 && r.body.length > 20) {
        rep.answers['кэш_DNS_путь'] = tried[i];
        rep.answers['кэш_DNS_байт'] = r.body.length;
        var j = json(r.body);
        var arr = j && (j.dnsCache || j.cache || (Array.isArray(j) ? j : null));
        if (arr && arr.length) {
          var doms = [];
          for (var k = 0; k < arr.length && k < 60; k++) {
            var d = arr[k] && (arr[k].domain || arr[k].name || arr[k].host);
            if (d) doms.push(String(d));
          }
          rep.answers['ДОМЕНОВ_В_КЭШЕ_DNS'] = arr.length;
          rep.answers['домены_из_DNS'] = doms;
          try { rep.answers['поля_записи_DNS'] = Object.keys(arr[0]).sort(); } catch (e) {}
        } else {
          note('dns_head', cut(r.body, 500));
        }
        next(); return;
      }
      go(i + 1);
    });
  }
  go(0);
}

// ── 4. Живой поток: WebSocket ────────────────────────────────────────────
// Читаем не более пяти секунд и не более двадцати кадров. Ничего не шлём.
function wsTry(path, next) {
  if (typeof G.WebSocket !== 'function' || left() < 8000) {
    rep.answers['ws' + path] = 'пропущено'; next(); return;
  }
  var url = CTRL.replace(/^http/, 'ws') + path +
    (AUTH ? ((path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(String(AUTH).replace(/^Bearer\s+/i, ''))) : '');
  var frames = [], done = false, ws = null;
  function fin(why) {
    if (done) return; done = true;
    try { if (ws) ws.close(); } catch (e) {}
    rep.answers['ws' + path] = why + ', кадров ' + frames.length;
    if (frames.length) note('ws' + path + '_кадры', frames.slice(0, 3).map(function (f) { return cut(f, 300); }));
    next();
  }
  var t = setTimeout(function () { fin(frames.length ? 'поток идёт' : 'открылся, кадров нет'); }, 5000);
  try {
    ws = new WebSocket(url);
    ws.onopen = function () { rep.answers['ws' + path + '_открыт'] = true; };
    ws.onmessage = function (ev) {
      frames.push(String(ev && ev.data));
      if (frames.length >= 20) { clearTimeout(t); fin('поток идёт'); }
    };
    ws.onerror = function () { clearTimeout(t); fin('ошибка соединения'); };
    ws.onclose = function () { if (!done) { clearTimeout(t); fin('закрыт сервером'); } };
  } catch (e) { clearTimeout(t); fin('исключение: ' + String(e)); }
}

// ── Вывод ────────────────────────────────────────────────────────────────
function finish() {
  rep.answers['намеренно_не_проверены'] = SKIPPED;
  rep.total_ms = Date.now() - T0;
  var a = rep.answers;
  var lines = [
    'соединений: ' + (a['соединений'] != null ? a['соединений'] : '?') +
      ', имя хоста: ' + (a['ИМЯ_ХОСТА_ВИДНО'] || '?'),
    'уникальных хостов: ' + (a['уникальных_хостов'] != null ? a['уникальных_хостов'] : '?'),
    'из Surge есть: ' + ((a['из_Surge_есть_в_Stash'] || []).join(' ') || 'ничего'),
    'из Surge нет: ' + ((a['из_Surge_нет_в_Stash'] || []).join(' ') || '—'),
    'поток /logs: ' + (a['ws/logs'] || '?'),
    'кэш DNS: ' + (a['ДОМЕНОВ_В_КЭШЕ_DNS'] != null ? (a['ДОМЕНОВ_В_КЭШЕ_DNS'] + ' доменов по ' + a['кэш_DNS_путь']) : 'не найден'),
  ];
  console.log('[' + REV + '] ' + JSON.stringify(rep));
  try {
    $notification.post('RouteHub ' + REV + ' — лазейки Stash', lines[0],
      lines.slice(1).join('\n'), { clipboard: JSON.stringify(rep) });
  } catch (e) {}

  // Плитка Stash рисуется тем, что вернёт `$done`. Пустые поля не
  // обновляются, поэтому отдаём заголовок и содержимое всегда — и при
  // запуске плиткой, и по расписанию: лишние поля в cron безвредны.
  // Цвет несёт смысл: зелёный — имена хостов видны (главный вопрос пробы
  // закрыт), жёлтый — не видны, серый — смотреть было не на что.
  var color = '#8E8E93';
  var a2 = rep.answers['ИМЯ_ХОСТА_ВИДНО'];
  if (typeof a2 === 'string') {
    if (a2.indexOf('ДА') === 0) color = '#34C759';
    else if (a2 === 'НЕТ') color = '#FF9F0A';
  }
  try {
    $done({
      title: 'RouteHub ' + REV,
      content: lines.join('\n'),
      icon: 'key.viewfinder',
      backgroundColor: color,
    });
  } catch (e2) { try { $done(); } catch (e3) {} }
}

stepConnections(function () {
  stepDns(function () {
    walk(0, {}, function (map, reached) {
      rep.answers['карта_путей'] = map;
      rep.answers['путей_пройдено'] = reached + ' из ' + PATHS.length;
      wsTry('/logs', function () {
        wsTry('/connections', function () {
          wsTry('/traffic', finish);
        });
      });
    });
  });
});