// =============================================================
// routehub-viewer.js — RouteHub, экран состояния (Этап D)
var VERSION = 'viewer v0.1.0 (2026-06-06)';
//
// Тип: generic (запуск ВРУЧНУЮ из Loon). Аргумент не нужен. Ничего НЕ меняет.
// ПОКАЗЫВАЕТ (читает $persistentStore + кэш рейтинга):
//   1. Выбранный AI-узел (страна, балл, причина, когда переключён/проверен).
//   2. Состояние сети (wifi/cell/whitelist, ssid, оператор).
//   3. Светофор по странам (зел/жёл/крас по имени страны).
//   4. Метки скорости ВСЕХ узлов (wifi/cell down↓rtt) + штрафы.
// Полный отчёт — в ЛОГ скрипта (виден при ручном запуске). Сводка — в уведомлении.
// Страна — по ИМЕНИ узла (согласовано с core/health/netwatch/ai-bad).
// =============================================================

var RATINGS_URLS = [
  'https://raw.githubusercontent.com/spxload/routehub/main/routehub-ratings.json',
  'https://cdn.jsdelivr.net/gh/spxload/routehub@main/routehub-ratings.json'
];
var COUNTRY_PRIORITY = ['DE','NL','CH','BE','FR','AT','GB','FI','SE','NO',
  'PL','EE','LV','LT','CZ','ES','IE','US','CA','JP','SG','KR'];
var NAME_COUNTRY = [
  ['\u0413\u0435\u0440\u043C\u0430\u043D\u0438\u044F', 'DE'],
  ['\u0424\u0438\u043D\u043B\u044F\u043D\u0434\u0438\u044F', 'FI'],
  ['\u041D\u0438\u0434\u0435\u0440\u043B\u0430\u043D\u0434\u044B', 'NL'],
  ['\u041F\u043E\u043B\u044C\u0448\u0430', 'PL'],
  ['\u042D\u0441\u0442\u043E\u043D\u0438\u044F', 'EE'],
  ['\u0422\u0443\u0440\u0446\u0438\u044F', 'TR'],
  ['\u0421\u0428\u0410', 'US'],
  ['\u0412\u0435\u043B\u0438\u043A\u043E\u0431\u0440\u0438\u0442\u0430\u043D\u0438\u044F', 'GB'],
  ['\u0420\u0443\u043C\u044B\u043D\u0438\u044F', 'RO'],
  ['\u0424\u0440\u0430\u043D\u0446\u0438\u044F', 'FR'],
  ['\u0428\u0432\u0435\u0439\u0446\u0430\u0440\u0438\u044F', 'CH'],
  ['\u0428\u0432\u0435\u0446\u0438\u044F', 'SE'],
  ['\u041D\u043E\u0440\u0432\u0435\u0433\u0438\u044F', 'NO'],
  ['\u0427\u0435\u0445\u0438\u044F', 'CZ'],
  ['\u0410\u0432\u0441\u0442\u0440\u0438\u044F', 'AT'],
  ['\u041B\u0430\u0442\u0432\u0438\u044F', 'LV'],
  ['\u041A\u0430\u0437\u0430\u0445\u0441\u0442\u0430\u043D', 'KZ'],
  ['\u0410\u0440\u043C\u0435\u043D\u0438\u044F', 'AM'],
  ['\u0411\u0435\u043B\u0430\u0440\u0443\u0441\u044C', 'BY'],
  ['\u0418\u0441\u043F\u0430\u043D\u0438\u044F', 'ES'],
  ['\u041D\u0438\u0433\u0435\u0440\u0438\u044F', 'NG'],
  ['\u0418\u0440\u043B\u0430\u043D\u0434\u0438\u044F', 'IE'],
  ['\u0422\u0430\u0439\u043B\u0430\u043D\u0434', 'TH'],
  ['\u0418\u043D\u0434\u0438\u044F', 'IN'],
  ['\u041E\u0410\u042D', 'AE'],
  ['\u041A\u0430\u043D\u0430\u0434\u0430', 'CA'],
  ['\u0410\u0440\u0433\u0435\u043D\u0442\u0438\u043D\u0430', 'AR'],
  ['\u0421\u0438\u043D\u0433\u0430\u043F\u0443\u0440', 'SG'],
  ['\u0411\u0440\u0430\u0437\u0438\u043B\u0438\u044F', 'BR'],
  ['\u042F\u043F\u043E\u043D\u0438\u044F', 'JP'],
  ['\u042E\u0436\u043D\u0430\u044F \u041A\u043E\u0440\u0435\u044F', 'KR'],
  ['\u0420\u043E\u0441\u0441\u0438\u044F', 'RU']
];
var LIGHT = { green: '\uD83D\uDFE2', yellow: '\uD83D\uDFE1', red: '\uD83D\uDD34', unknown: '\u26AA' };

var STATE_KEY = 'rh_core_state';
var NET_KEY = 'rh_net_state';
var RCACHE_KEY = 'rh_ratings_cache';
var WIFI_KEY = 'rh_speed_wifi';
var CELL_KEY = 'rh_speed_cell';
var PENALTY_KEY = 'rh_ai_penalty';
var CHECKED_KEY = 'rh_ai_checked';
var PEN_DECAY_MS = 6 * 3600 * 1000;
var MAX_FAILS = 5;
var METRIC_SEP = ' \u00B7 ';
var HTTP_TIMEOUT = 15000;

var now = function () { return Date.now(); };
function log(m) { console.log(m); }
function readJSON(k, d) { try { var s = $persistentStore.read(k); return s ? JSON.parse(s) : d; } catch (e) { return d; } }
function stripMetric(n) { var i = n.indexOf(METRIC_SEP); return i >= 0 ? n.slice(0, i) : n; }
function stripProvider(s) { return String(s).replace(/^\s*\[[^\]]*\]\s+/, ''); }
function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function matchKey(n) { return norm(stripProvider(stripMetric(n))); }
function looksLikeNode(n) { return typeof n === 'string' && n.length >= 5 && n.indexOf('[') >= 0; }
function cpIdx(c) { var i = COUNTRY_PRIORITY.indexOf(c); return i < 0 ? 999 : i; }
function flagToISO(s) {
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var cp = s.codePointAt(i);
    if (cp >= 0x1F1E6 && cp <= 0x1F1FF) { out += String.fromCharCode(65 + (cp - 0x1F1E6)); i++; if (out.length === 2) return out; }
    else if (out.length) break;
  }
  return out.length === 2 ? out : '';
}
function countryFromName(name) {
  var iso = flagToISO(name);
  if (iso) return iso;
  for (var i = 0; i < NAME_COUNTRY.length; i++) { if (name.indexOf(NAME_COUNTRY[i][0]) >= 0) return NAME_COUNTRY[i][1]; }
  return '??';
}
function penaltyNow(pen, key) {
  var e = pen && pen[key];
  if (!e || !e.p) return 0;
  var age = now() - (e.ts || 0);
  if (age >= PEN_DECAY_MS) return 0;
  return e.p * (1 - age / PEN_DECAY_MS);
}
function ago(ts) {
  if (!ts) return '\u2014';
  var m = Math.round((now() - ts) / 60000);
  if (m < 1) return '<1\u043C';
  if (m < 60) return m + '\u043C';
  return Math.round(m / 60) + '\u0447';
}
function buildSpeedIdx(key) {
  var c = readJSON(key, {}), idx = {};
  for (var nm in c) { if (c.hasOwnProperty(nm) && looksLikeNode(nm)) idx[matchKey(nm)] = c[nm]; }
  return idx;
}
function spd(e) {
  if (!e) return '';
  if ((e.fails || 0) >= MAX_FAILS) return '\u26D4';
  if (!(e.down > 0)) return '?';
  return e.down + '\u2193' + (e.rtt || 0);
}
function httpGet(url) {
  return new Promise(function (resolve) {
    $httpClient.get({ url: url, timeout: HTTP_TIMEOUT, headers: { 'Cache-Control': 'no-cache' } },
      function (err, resp, body) { resolve((err || !resp) ? { ok: false } : { ok: true, status: resp.status, body: body || '' }); });
  });
}
async function getRatings() {
  var c = readJSON(RCACHE_KEY, null);
  if (c && c.nodes) return c;
  for (var i = 0; i < RATINGS_URLS.length; i++) {
    var r = await httpGet(RATINGS_URLS[i]);
    if (r.ok && r.status === 200 && r.body) { try { var d = JSON.parse(r.body); if (d && d.nodes) return d; } catch (e) {} }
  }
  return null;
}

async function main() {
  var L = [];
  L.push('\u2550\u2550\u2550 RouteHub \u2014 \u0441\u043e\u0441\u0442\u043e\u044f\u043d\u0438\u0435 \u2550\u2550\u2550');
  L.push(VERSION);

  // --- AI-узел ---
  var state = readJSON(STATE_KEY, { sel: null });
  var sel = state.sel;
  var lastChk = parseInt($persistentStore.read(CHECKED_KEY) || '0', 10) || 0;
  L.push('');
  L.push('\uD83E\uDD16 AI-\u0443\u0437\u0435\u043b:');
  if (sel && sel.k) {
    L.push('  ' + sel.k);
    L.push('  \u0441\u0442\u0440\u0430\u043d\u0430=' + (sel.country || '?') + ' \u0431\u0430\u043b\u043b=' + (sel.score != null ? sel.score : '?') + ' (' + (sel.reason || '?') + ')');
    L.push('  \u043f\u0435\u0440\u0435\u043a\u043b\u044e\u0447\u0451\u043d ' + ago(sel.lastSwitched) + ' \u043d\u0430\u0437\u0430\u0434, \u043f\u0440\u043e\u0432\u0435\u0440\u0435\u043d ' + ago(lastChk) + ' \u043d\u0430\u0437\u0430\u0434');
  } else {
    L.push('  \u2014 \u044f\u0434\u0440\u043e \u0435\u0449\u0451 \u043d\u0435 \u0432\u044b\u0431\u0440\u0430\u043b\u043e (\u0437\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u0435 RH-Core)');
  }
  if (state.lastRun) L.push('  RH-Core: \u043f\u0440\u043e\u0433\u043e\u043d ' + ago(state.lastRun) + ' \u043d\u0430\u0437\u0430\u0434, \u0437\u0435\u043b\u0451\u043d\u044b\u0445 \u0432 \u043f\u0443\u043b\u0435=' + (state.poolGreen != null ? state.poolGreen : '?') + ', \u0440\u0435\u0439\u0442\u0438\u043d\u0433 ' + (state.dataAgeMin != null ? state.dataAgeMin + '\u043c\u0438\u043d' : '?'));

  // --- Сеть ---
  var net = readJSON(NET_KEY, null);
  L.push('');
  L.push('\uD83C\uDF10 \u0421\u0435\u0442\u044c:');
  if (net) {
    L.push('  ' + (net.net || '?') + (net.ssid ? ' [' + net.ssid + ']' : '') + (net.whitelist ? ' \u26A0 WHITELIST' : ''));
    L.push('  \u043e\u043f\u0435\u0440\u0430\u0442\u043e\u0440=' + (net.operator || '?') + ' (' + ago(net.ts) + ' \u043d\u0430\u0437\u0430\u0434)');
  } else {
    L.push('  \u2014 netwatch \u0435\u0449\u0451 \u043d\u0435 \u0441\u0440\u0430\u0431\u0430\u0442\u044b\u0432\u0430\u043b');
  }

  // --- Данные узлов ---
  var data = await getRatings();
  var pen = readJSON(PENALTY_KEY, {});
  var spW = buildSpeedIdx(WIFI_KEY), spC = buildSpeedIdx(CELL_KEY);
  var net0 = net && net.net === 'wifi' ? 'wifi' : 'cell';

  if (!data || !data.nodes) {
    L.push('');
    L.push('\u2014 \u0440\u0435\u0439\u0442\u0438\u043d\u0433 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d');
    log(L.join('\n'));
    $notification.post('\uD83D\uDCCA RouteHub', sel && sel.k ? sel.k : '\u0443\u0437\u0435\u043b \u043d\u0435 \u0432\u044b\u0431\u0440\u0430\u043d', '\u0420\u0435\u0439\u0442\u0438\u043d\u0433 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d. \u041f\u043e\u043b\u043d\u044b\u0439 \u043e\u0442\u0447\u0451\u0442 \u2014 \u0432 \u043b\u043e\u0433\u0435 \u0441\u043a\u0440\u0438\u043f\u0442\u0430.');
    $done({}); return;
  }

  // сбор узлов + светофор по странам
  var nodes = [];
  var byC = {};
  for (var nm in data.nodes) {
    if (!data.nodes.hasOwnProperty(nm)) continue;
    var r = data.nodes[nm];
    var ctry = countryFromName(nm);
    var k = matchKey(nm);
    var lite = r.light || 'unknown';
    if (!byC[ctry]) byC[ctry] = { g: 0, y: 0, rd: 0, u: 0 };
    if (lite === 'green') byC[ctry].g++; else if (lite === 'yellow') byC[ctry].y++; else if (lite === 'red') byC[ctry].rd++; else byC[ctry].u++;
    nodes.push({
      nm: nm, base: norm(stripProvider(stripMetric(nm))), ctry: ctry, light: lite,
      w: spW[k] || null, c: spC[k] || null, pen: penaltyNow(pen, k),
      down: (net0 === 'wifi' ? (spW[k] && spW[k].down) : (spC[k] && spC[k].down)) || 0
    });
  }

  // светофор по странам
  L.push('');
  L.push('\uD83D\uDEA6 \u0421\u0432\u0435\u0442\u043e\u0444\u043e\u0440 \u043f\u043e \u0441\u0442\u0440\u0430\u043d\u0430\u043c (\u043f\u043e \u0438\u043c\u0435\u043d\u0438):');
  var countries = Object.keys(byC).sort(function (a, b) { return (byC[b].g - byC[a].g) || (cpIdx(a) - cpIdx(b)); });
  for (var ci = 0; ci < countries.length; ci++) {
    var cc = countries[ci], s = byC[cc];
    var seg = [];
    if (s.g) seg.push('\uD83D\uDFE2' + s.g);
    if (s.y) seg.push('\uD83D\uDFE1' + s.y);
    if (s.rd) seg.push('\uD83D\uDD34' + s.rd);
    if (s.u) seg.push('\u26AA' + s.u);
    L.push('  ' + cc + ': ' + seg.join(' '));
  }
  if (data.stats) L.push('  \u0438\u0442\u043e\u0433\u043e: ' + (data.stats.total || '?') + ' \u0443\u0437\u043b\u043e\u0432, \uD83D\uDFE2' + (data.stats.green || 0) + ' \uD83D\uDFE1' + (data.stats.yellow || 0) + ' \uD83D\uDD34' + (data.stats.red || 0));

  // все узлы со скоростью (сорт: страна по приоритету, внутри — скорость убыв.)
  nodes.sort(function (a, b) { return (cpIdx(a.ctry) - cpIdx(b.ctry)) || (b.down - a.down); });
  L.push('');
  L.push('\uD83D\uDCCF \u0423\u0437\u043b\u044b \u0438 \u0441\u043a\u043e\u0440\u043e\u0441\u0442\u044c (\uD83D\uDEDC wifi / \uD83D\uDCF1 cell, down\u2193rtt):');
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    var sp = [];
    if (n.w) sp.push('\uD83D\uDEDC' + spd(n.w));
    if (n.c) sp.push('\uD83D\uDCF1' + spd(n.c));
    var penTxt = n.pen > 0 ? '  \u26A0' + Math.round(n.pen) : '';
    L.push('  ' + (LIGHT[n.light] || '\u26AA') + ' ' + n.ctry + ' ' + n.base + (sp.length ? '  ' + sp.join(' ') : '') + penTxt);
  }

  log(L.join('\n'));

  // сводка в уведомление
  var penList = [];
  for (var pk in pen) { var pv = penaltyNow(pen, pk); if (pv > 0) penList.push(pk + '(' + Math.round(pv) + ')'); }
  var fast = nodes.filter(function (x) { return x.down > 0; }).slice(0, 5)
    .map(function (x) { return x.ctry + ' ' + x.down + '\u2193'; });
  var body = [];
  body.push('\u0421\u0435\u0442\u044c: ' + (net ? net.net : '?') + (net && net.operator ? ' / ' + net.operator : ''));
  if (data.stats) body.push('\u0423\u0437\u043b\u044b: \uD83D\uDFE2' + (data.stats.green || 0) + ' \uD83D\uDFE1' + (data.stats.yellow || 0) + ' \uD83D\uDD34' + (data.stats.red || 0));
  if (fast.length) body.push('\u0411\u044b\u0441\u0442\u0440\u044b\u0435: ' + fast.join(', '));
  if (penList.length) body.push('\u0428\u0442\u0440\u0430\u0444\u044b: ' + penList.join(', '));
  body.push('\u041f\u043e\u043b\u043d\u044b\u0439 \u043e\u0442\u0447\u0451\u0442 \u2014 \u0432 \u043b\u043e\u0433\u0435 \u0441\u043a\u0440\u0438\u043f\u0442\u0430.');

  $notification.post('\uD83D\uDCCA RouteHub \u2014 AI: ' + (sel && sel.country ? sel.country : '?'),
    sel && sel.k ? sel.k : '\u0443\u0437\u0435\u043b \u043d\u0435 \u0432\u044b\u0431\u0440\u0430\u043d',
    body.join('\n'));
  $done({});
}

main().catch(function (err) { log('[RH-Viewer] \u041a\u0420\u0410\u0428: ' + ((err && err.message) || err)); $done({}); });
