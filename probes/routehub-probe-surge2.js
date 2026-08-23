/*
 * RouteHub — ВТОРАЯ ПРОБА SURGE. Ревизия SG2.
 * ===========================================================================
 * SG1 сняла опись среды и карту путей: 963 глобальных имени, 13 `$`-объектов,
 * HTTP API на 6171 отвечает по 30 путям из 30. Теперь надо не «есть ли путь»,
 * а ЧТО В НЁМ ЛЕЖИТ. SG2 читает тела ключевых эндпоинтов и отвечает на четыре
 * вопроса, ради которых стенд и заводился.
 *
 * ВОПРОС 1. Видны ли ИМЕНА ХОСТОВ в журнале запросов.
 *   `/v1/requests/recent` отдал 34 615 байт. Если там есть имена, а не только
 *   IP — закрывается давняя задача проекта «журнал незагрузившихся доменов»,
 *   и закрывается БЕЗ MITM. Это то, ради чего MITM вообще обсуждался.
 *
 * ВОПРОС 2. Что такое smart-группа на самом деле.
 *   Единственное, чему в Stash заведомо нет замены. Смотрим состав групп и
 *   их тип: есть ли `smart`, что она показывает про свой выбор.
 *
 * ВОПРОС 3. Есть ли узлы вообще.
 *   `/v1/policies` отдал всего 73 байта — подозрительно мало. Похоже, узлы
 *   подписки не импортировались. От этого зависит, можно ли на Surge вообще
 *   что-то мерить, и поддержан ли VLESS, которым отдаёт Lastdep.
 *
 * ВОПРОС 4. Что умеет `$httpAPI`.
 *   Функция с четырьмя параметрами, найдена SG1, в Stash аналога нет. Если
 *   она ходит в API напрямую, минуя сеть, — это дешевле и надёжнее, чем
 *   $httpClient на 127.0.0.1.
 *
 * ТОЛЬКО ЧТЕНИЕ. Ни одна функция `$surge.set*` не вызывается. Все запросы к
 * API — GET. Через обходные узлы трафик не идёт. MITM не включается.
 * Из `$surge` вызывается единственная читающая функция — selectGroupDetails.
 *
 * ЗАПУСК: та же плитка, что у SG1, или Surge → Скрипты → Выполнить.
 * АРГУМЕНТ: apikey=<ключ> обязателен — без него API отвечает 401.
 *   hosts=<N>   сколько имён хостов показать (по умолчанию 40)
 *   raw=1       не обрезать тела ответов (отчёт станет очень длинным)
 */

var REV = 'SG2';
var BUDGET_MS = 25000;
var T0 = Date.now();
var rep = { rev: REV, ts: new Date().toISOString(), answers: {}, steps: {}, errors: [] };

function left() { return BUDGET_MS - (Date.now() - T0); }
function note(k, v) { rep.steps[k] = v; }
function err(k, e) { rep.errors.push(k + ': ' + String((e && e.message) || e)); }

function parseArg() {
  var raw = (typeof $argument === 'undefined') ? '' : $argument;
  if (raw && typeof raw === 'object') return raw;
  var out = {}, parts = String(raw || '').split('&');
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].split('=');
    if (kv[0]) out[kv[0].trim()] = kv.slice(1).join('=').trim();
  }
  return out;
}
var ARG = parseArg();
var APIKEY = String(ARG.apikey || '');
var HOSTS_N = Math.max(5, Math.min(200, parseInt(ARG.hosts, 10) || 40));
var RAW = String(ARG.raw || '') === '1';
var BASE = 'http://127.0.0.1:6171';

function cut(s, n) { s = String(s == null ? '' : s); return (RAW || s.length <= n) ? s : s.slice(0, n) + '…<+' + (s.length - n) + '>'; }

function api(path, cb) {
  var done = false;
  var t = setTimeout(function () { if (!done) { done = true; cb(null, 'timeout'); } }, 3000);
  try {
    $httpClient.get({ url: BASE + path, headers: { 'X-Key': APIKEY }, timeout: 3 },
      function (e, r, b) {
        if (done) return; done = true; clearTimeout(t);
        if (e) { cb(null, String(e)); return; }
        cb({ status: (r && r.status) || null, body: b == null ? '' : String(b) }, null);
      });
  } catch (e2) { if (!done) { done = true; clearTimeout(t); cb(null, String(e2)); } }
}

function json(s) { try { return JSON.parse(s); } catch (e) { return null; } }

// ── ВОПРОС 3. Узлы и группы ───────────────────────────────────────────────
function stepPolicies(next) {
  api('/v1/policies', function (r, e) {
    if (!r) { err('policies', e); next(); return; }
    note('policies_raw', cut(r.body, 1200));
    var j = json(r.body);
    if (j) {
      // Форма ответа заранее неизвестна — описываем то, что пришло.
      var keys = [];
      try { keys = Object.keys(j); } catch (e2) {}
      var counts = {};
      for (var i = 0; i < keys.length; i++) {
        var v = j[keys[i]];
        counts[keys[i]] = Array.isArray(v) ? (v.length + ' шт') : typeof v;
      }
      note('policies_shape', { keys: keys, counts: counts });
      // Ищем среди значений что-нибудь похожее на список имён узлов.
      var all = [];
      for (var k in j) if (Array.isArray(j[k])) all = all.concat(j[k]);
      rep.answers['узлов_видно'] = all.length;
      rep.answers['имена_узлов_первые'] = all.slice(0, 12);
      // Узел подписки узнаётся по флагу страны или по слову VPN в имени.
      var withFlag = 0;
      for (var m = 0; m < all.length; m++) {
        var s = String(all[m]);
        if (/[\uD83C][\uDDE6-\uDDFF]/.test(s) || s.indexOf('VPN') >= 0) withFlag++;
      }
      rep.answers['узлов_подписки_похоже'] = withFlag;
    }
    next();
  });
}

function stepGroups(next) {
  api('/v1/policy_groups', function (r, e) {
    if (!r) { err('policy_groups', e); next(); return; }
    note('policy_groups_raw', cut(r.body, 1500));
    var j = json(r.body);
    if (j) {
      var names = [];
      try { names = Object.keys(j); } catch (e2) {}
      rep.answers['группы'] = names;
      // Тип группы читаем через $surge.selectGroupDetails — единственная
      // читающая функция $surge, которую здесь вызываем.
      try {
        if (typeof $surge !== 'undefined' && $surge.selectGroupDetails) {
          var d = $surge.selectGroupDetails();
          note('selectGroupDetails', cut(JSON.stringify(d), 1500));
          var smart = [];
          try {
            var gs = (d && d.groups) ? d.groups : d;
            for (var g in gs) {
              var t = gs[g] && (gs[g].type || gs[g].policyType);
              if (t) { if (String(t).toLowerCase().indexOf('smart') >= 0) smart.push(g); }
            }
          } catch (e3) {}
          rep.answers['smart_группы'] = smart.length ? smart : 'не найдено в selectGroupDetails';
        } else {
          rep.answers['smart_группы'] = 'нет $surge.selectGroupDetails';
        }
      } catch (e4) { err('selectGroupDetails', e4); }
    }
    next();
  });
}

// ── ВОПРОС 1. Имена хостов в журнале запросов ─────────────────────────────
function stepRequests(next) {
  api('/v1/requests/recent', function (r, e) {
    if (!r) { err('requests_recent', e); next(); return; }
    var j = json(r.body);
    if (!j) { note('requests_recent_raw', cut(r.body, 600)); next(); return; }
    var list = j.requests || j.list || (Array.isArray(j) ? j : []);
    var hosts = {}, withHost = 0, failed = [], fields = [];
    try { if (list.length) fields = Object.keys(list[0]); } catch (e2) {}
    for (var i = 0; i < list.length; i++) {
      var q = list[i] || {};
      var h = q.URL || q.url || q.host || q.remoteAddress || '';
      // Из URL вытаскиваем только имя хоста — путь и параметры не нужны и
      // могут содержать личное.
      var m = String(h).match(/^[a-z]+:\/\/([^\/:?#]+)/i);
      var name = m ? m[1] : (q.host || '');
      if (name && !/^\d+\.\d+\.\d+\.\d+$/.test(name)) { withHost++; hosts[name] = (hosts[name] || 0) + 1; }
      // Незагрузившееся: статус ошибки либо нулевой объём ответа.
      var st = q.status || q.completed || '';
      if (/fail|error|reject|timeout/i.test(String(st))) {
        failed.push((name || h) + ' · ' + st);
      }
    }
    var uniq = Object.keys(hosts).sort(function (a, b) { return hosts[b] - hosts[a]; });
    rep.answers['записей_в_журнале'] = list.length;
    rep.answers['поля_записи'] = fields;
    rep.answers['ИМЕНА_ХОСТОВ_ВИДНЫ'] = withHost > 0 ? ('да, у ' + withHost + ' из ' + list.length) : 'НЕТ';
    rep.answers['уникальных_хостов'] = uniq.length;
    rep.answers['хосты_топ'] = uniq.slice(0, HOSTS_N);
    rep.answers['похоже_на_незагрузившиеся'] = failed.slice(0, 20);
    next();
  });
}

// ── ВОПРОС 4. Что умеет $httpAPI ──────────────────────────────────────────
function stepHttpAPI(next) {
  if (typeof $httpAPI !== 'function') { rep.answers['$httpAPI'] = 'нет'; next(); return; }
  var done = false;
  var t = setTimeout(function () {
    if (!done) { done = true; rep.answers['$httpAPI'] = 'вызов не вернулся за 3 с'; next(); }
  }, 3000);
  try {
    // Порядок параметров предполагается (метод, путь, тело, обратный вызов) —
    // длина функции 4. Если предположение неверно, вернётся ошибка, и это
    // тоже ответ. Запрос читающий.
    $httpAPI('GET', '/v1/traffic', null, function (result) {
      if (done) return; done = true; clearTimeout(t);
      rep.answers['$httpAPI'] = 'работает без ключа и без сети';
      note('httpAPI_result', cut(JSON.stringify(result), 600));
      next();
    });
  } catch (e) {
    if (!done) { done = true; clearTimeout(t); rep.answers['$httpAPI'] = 'ошибка вызова: ' + String(e); next(); }
  }
}

// ── Прочее: состояние фич и профиль ───────────────────────────────────────
var SMALL = ['/v1/features/mitm', '/v1/features/capture', '/v1/features/rewrite',
  '/v1/features/scripting', '/v1/outbound', '/v1/traffic', '/v1/modules'];

function stepSmall(i, next) {
  if (i >= SMALL.length || left() < 5000) { next(); return; }
  api(SMALL[i], function (r) {
    note('body' + SMALL[i], r ? cut(r.body, 400) : 'нет ответа');
    stepSmall(i + 1, next);
  });
}

function stepProfile(next) {
  api('/v1/profiles/current', function (r) {
    if (!r) { next(); return; }
    var b = r.body;
    // Из профиля берём только структуру: какие секции есть и сколько в них
    // строк. Сам профиль может содержать адрес подписки — его не выгружаем.
    var secs = {};
    try {
      var lines = String(b).split('\\n');
      var cur = '(до секций)';
      for (var i = 0; i < lines.length; i++) {
        var L = lines[i];
        var m = L.match(/^\s*\[([^\]]+)\]/);
        if (m) { cur = m[1]; secs[cur] = 0; continue; }
        if (L.trim()) secs[cur] = (secs[cur] || 0) + 1;
      }
    } catch (e) {}
    rep.answers['секции_профиля'] = secs;
    rep.answers['размер_профиля'] = String(b).length;
    next();
  });
}

// ── Сеть, как её видит Surge ──────────────────────────────────────────────
function stepNetwork() {
  try {
    if (typeof $network !== 'undefined') {
      var n = JSON.parse(JSON.stringify($network));
      rep.answers['сеть'] = {
        ssid: (n.wifi && n.wifi.ssid) || null,
        v4: (n.v4 && n.v4.primaryAddress) || null,
        интерфейс: (n.v4 && n.v4.primaryInterface) || null,
        сотовая: (n['cellular-data'] && n['cellular-data'].radio) || null,
      };
      // SSID из скрипта — то, чего НЕТ в Stash ($config отсутствует, ST2).
      rep.answers['SSID_из_скрипта'] = (n.wifi && n.wifi.ssid) ? 'да' : 'нет';
    }
  } catch (e) { err('network', e); }
}

function finish() {
  rep.total_ms = Date.now() - T0;
  var a = rep.answers;
  var lines = [
    'узлов видно: ' + (a['узлов_видно'] != null ? a['узлов_видно'] : '?') +
      ', похожих на подписку: ' + (a['узлов_подписки_похоже'] != null ? a['узлов_подписки_похоже'] : '?'),
    'группы: ' + ((a['группы'] || []).join(', ') || '—'),
    'smart: ' + (a['smart_группы'] || '?'),
    'имена хостов в журнале: ' + (a['ИМЕНА_ХОСТОВ_ВИДНЫ'] || '?') +
      ' (уникальных ' + (a['уникальных_хостов'] != null ? a['уникальных_хостов'] : '?') + ')',
    '$httpAPI: ' + (a['$httpAPI'] || '?'),
    'SSID из скрипта: ' + (a['SSID_из_скрипта'] || '?'),
  ];
  console.log('[' + REV + '] ' + JSON.stringify(rep));
  try { $notification.post('RouteHub ' + REV, lines[0], lines.slice(1).join('\n')); } catch (e) {}
  try { $done({ title: 'RouteHub ' + REV, content: lines.join('\n'), icon: 'magnifyingglass' }); }
  catch (e) { try { $done(); } catch (e2) {} }
}

if (!APIKEY) {
  rep.errors.push('не передан apikey — без него API отвечает 401');
  stepNetwork();
  stepHttpAPI(finish);
} else {
  stepNetwork();
  stepPolicies(function () {
    stepGroups(function () {
      stepRequests(function () {
        stepHttpAPI(function () {
          stepProfile(function () {
            stepSmall(0, finish);
          });
        });
      });
    });
  });
}
