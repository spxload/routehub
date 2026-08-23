/*
 * RouteHub — ТРЕТЬЯ ПРОБА SURGE. Ревизия SG3: «что тут вообще можно».
 * ===========================================================================
 * СМЕНА ЗАДАЧИ. Первые две пробы шли к тому, чтобы Surge заработал как
 * прокси. Это не нужно: VLESS у Surge не поддержан по официальной
 * документации, узлы Lastdep он не возьмёт, и мерить на нём нечего.
 *
 * Настоящая задача другая: Surge — образец того, ЧТО КЛИЕНТ ВООБЩЕ УМЕЕТ.
 * Всё, что здесь найдётся, дальше ищется у Stash пробой ST6 и у Egern.
 * Если приём есть у обоих — он переносится в наш стенд бесплатно.
 * Если только у Surge — становится известной ценой отказа.
 *
 * Поэтому узлы не нужны. Пустой профиль даже удобнее: ничего не мешает.
 *
 * ЧТО СНИМАЕТ
 *   1. `$httpAPI` целиком: какие методы и пути она принимает, работает ли
 *      без ключа, отличается ли её ответ от ответа по сети. SG2 доказала,
 *      что GET работает; здесь — границы.
 *   2. `$surge.logbook` — журнал из скрипта. Что отдаёт, есть ли там
 *      домены и решения маршрутизации.
 *   3. `$utils`: `geoip`, `ipasn`, `ipaso`, `ungzip` на реальных данных.
 *      В Stash своего `$utils` нет вовсе — если эти функции полезны, это
 *      кандидат на «сделать самим в Worker'е».
 *   4. Тела `/v1/events`, `/v1/dns`, `/v1/rules`, `/v1/scripting` — что
 *      клиент вообще готов рассказать о себе.
 *   5. Живые потоки WebSocket на 6171.
 *   6. `$input` и `$trigger` — контекст запуска панели. Мелочь, но именно
 *      её не хватало Loon: там ручной запуск есть, а параметров у него нет.
 *
 * ТОЛЬКО ЧТЕНИЕ. Ни одна `$surge.set*` не вызывается. Через `$httpAPI`
 * идут только GET. Пути, звучащие как действие, не запрашиваются.
 *
 * ЗАПУСК: плитка RouteHub SG3 либо Surge → Скрипты → Выполнить.
 * АРГУМЕНТ: apikey=<ключ> — для сетевых запросов; `$httpAPI` ключа не требует.
 */

var REV = 'SG3';
var BUDGET_MS = 25000;
var T0 = Date.now();
var rep = { rev: REV, ts: new Date().toISOString(), answers: {}, steps: {}, errors: [] };

var G = (typeof globalThis !== 'undefined') ? globalThis : this;
function left() { return BUDGET_MS - (Date.now() - T0); }
function note(k, v) { rep.steps[k] = v; }
function err(k, e) { rep.errors.push(k + ': ' + String((e && e.message) || e)); }
function cut(s, n) { s = String(s == null ? '' : s); return s.length <= n ? s : s.slice(0, n) + '…<+' + (s.length - n) + '>'; }

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
var APIKEY = String(parseArg().apikey || '');

// ── 1. Границы $httpAPI ───────────────────────────────────────────────────
// SG2 показала: `$httpAPI('GET', '/v1/traffic', null, cb)` работает без
// ключа и без сети. Здесь выясняем, на что она ещё отвечает. ТОЛЬКО GET:
// та же функция четвёртым аргументом умеет и менять состояние, но мы этого
// не делаем — правило проекта.
var API_PATHS = ['/v1/events', '/v1/dns', '/v1/rules', '/v1/scripting',
  '/v1/modules', '/v1/policies', '/v1/requests/recent', '/v1/profiles/current'];

function apiCall(path, cb) {
  if (typeof $httpAPI !== 'function') { cb(null, 'нет $httpAPI'); return; }
  var done = false;
  var t = setTimeout(function () { if (!done) { done = true; cb(null, 'не вернулась за 3 с'); } }, 3000);
  try {
    $httpAPI('GET', path, null, function (result) {
      if (done) return; done = true; clearTimeout(t);
      cb(result, null);
    });
  } catch (e) { if (!done) { done = true; clearTimeout(t); cb(null, String(e)); } }
}

function walkApi(i, acc, next) {
  if (i >= API_PATHS.length || left() < 6000) { next(acc, i); return; }
  apiCall(API_PATHS[i], function (res, e) {
    if (e) { acc[API_PATHS[i]] = '— ' + e; walkApi(i + 1, acc, next); return; }
    var s = '';
    try { s = JSON.stringify(res); } catch (e2) { s = String(res); }
    acc[API_PATHS[i]] = s.length + ' Б';
    note('api' + API_PATHS[i], cut(s, 700));
    walkApi(i + 1, acc, next);
  });
}

// ── 2. $surge.logbook ────────────────────────────────────────────────────
function stepLogbook(next) {
  if (typeof $surge === 'undefined' || typeof $surge.logbook !== 'function') {
    rep.answers['logbook'] = 'нет'; next(); return;
  }
  // Вызов читающий: имя говорит «журнал». Если он окажется пишущим,
  // единственное последствие — запись в собственный журнал клиента.
  var done = false;
  var t = setTimeout(function () { if (!done) { done = true; rep.answers['logbook'] = 'не вернулась за 3 с'; next(); } }, 3000);
  try {
    var r = $surge.logbook(function (data) {
      if (done) return; done = true; clearTimeout(t);
      var s = ''; try { s = JSON.stringify(data); } catch (e) { s = String(data); }
      rep.answers['logbook'] = 'вернул ' + s.length + ' Б';
      note('logbook', cut(s, 900));
      next();
    });
    // Часть реализаций возвращает значение сразу, без обратного вызова.
    if (r !== undefined && !done) {
      done = true; clearTimeout(t);
      var s2 = ''; try { s2 = JSON.stringify(r); } catch (e) { s2 = String(r); }
      rep.answers['logbook'] = 'синхронно, ' + s2.length + ' Б';
      note('logbook', cut(s2, 900));
      next();
    }
  } catch (e) {
    if (!done) { done = true; clearTimeout(t); rep.answers['logbook'] = 'ошибка: ' + String(e); next(); }
  }
}

// ── 3. $utils на реальных данных ─────────────────────────────────────────
// Берём общеизвестные публичные адреса, чтобы результат можно было
// проверить глазами. Ничего личного сюда не подставляется.
function stepUtils() {
  if (typeof $utils === 'undefined') { rep.answers['$utils'] = 'нет'; return; }
  var probes = { '8.8.8.8': null, '1.1.1.1': null };
  var out = {};
  for (var ip in probes) {
    var row = {};
    try { row.geoip = $utils.geoip ? $utils.geoip(ip) : 'нет функции'; } catch (e) { row.geoip = 'ошибка: ' + String(e); }
    try { row.ipasn = $utils.ipasn ? $utils.ipasn(ip) : 'нет функции'; } catch (e2) { row.ipasn = 'ошибка: ' + String(e2); }
    try { row.ipaso = $utils.ipaso ? $utils.ipaso(ip) : 'нет функции'; } catch (e3) { row.ipaso = 'ошибка: ' + String(e3); }
    out[ip] = row;
  }
  rep.answers['$utils_на_примерах'] = out;
  // Такой набор в Stash отсутствует целиком: там `$utils` нет среди шести
  // объектов среды (замер ST2). Если функции работают локально, без сети,
  // это кандидат на «повторить в Worker'е» — у нас уже есть страновые тиеры.
}

// ── 4. Контекст запуска ──────────────────────────────────────────────────
function stepContext() {
  var o = {};
  try { o.trigger = (typeof $trigger !== 'undefined') ? $trigger : 'нет'; } catch (e) {}
  try { o.input = (typeof $input !== 'undefined') ? JSON.parse(JSON.stringify($input)) : 'нет'; } catch (e2) {}
  try { o.script = (typeof $script !== 'undefined') ? JSON.parse(JSON.stringify($script)) : 'нет'; } catch (e3) {}
  rep.answers['контекст_запуска'] = o;
  // Зачем это. В Loon ручной запуск есть (generic), но параметров у него
  // нет; в Stash плитка тоже без `$argument`. У Surge же панель сообщает
  // скрипту и своё имя, и позицию, и способ запуска. Если такое поле
  // найдётся у Stash — одна проба сможет работать в нескольких режимах.
}

// ── 5. Живые потоки ──────────────────────────────────────────────────────
function wsTry(path, next) {
  if (typeof G.WebSocket !== 'function' || left() < 8000) { rep.answers['ws' + path] = 'пропущено'; next(); return; }
  var url = 'ws://127.0.0.1:6171' + path;
  var frames = [], done = false, ws = null;
  function fin(why) {
    if (done) return; done = true;
    try { if (ws) ws.close(); } catch (e) {}
    rep.answers['ws' + path] = why + ', кадров ' + frames.length;
    if (frames.length) note('ws' + path + '_кадры', frames.slice(0, 3).map(function (f) { return cut(f, 250); }));
    next();
  }
  var t = setTimeout(function () { fin(frames.length ? 'поток идёт' : 'открылся, кадров нет'); }, 4000);
  try {
    ws = new WebSocket(url);
    ws.onmessage = function (ev) { frames.push(String(ev && ev.data)); if (frames.length >= 15) { clearTimeout(t); fin('поток идёт'); } };
    ws.onerror = function () { clearTimeout(t); fin('ошибка соединения'); };
    ws.onclose = function () { if (!done) { clearTimeout(t); fin('закрыт сервером'); } };
  } catch (e) { clearTimeout(t); fin('исключение'); }
}

function finish() {
  rep.total_ms = Date.now() - T0;
  var a = rep.answers;
  var lines = [
    '$httpAPI: ' + (a['httpAPI_путей_ответило'] || '?'),
    'logbook: ' + (a['logbook'] || '?'),
    '$utils: ' + (a['$utils_на_примерах'] ? 'работает' : 'нет'),
    'поток /v1/events: ' + (a['ws/v1/events'] || '?'),
  ];
  console.log('[' + REV + '] ' + JSON.stringify(rep));
  try { $notification.post('RouteHub ' + REV + ' — что умеет Surge', lines[0], lines.slice(1).join('\n')); } catch (e) {}
  try { $done({ title: 'RouteHub ' + REV, content: lines.join('\n'), icon: 'key' }); }
  catch (e2) { try { $done(); } catch (e3) {} }
}

stepContext();
stepUtils();
walkApi(0, {}, function (map, reached) {
  rep.answers['httpAPI_карта'] = map;
  var ok = 0;
  for (var k in map) if (/^\d/.test(map[k])) ok++;
  rep.answers['httpAPI_путей_ответило'] = ok + ' из ' + API_PATHS.length;
  stepLogbook(function () {
    wsTry('/v1/events', function () {
      wsTry('/v1/traffic', finish);
    });
  });
});
