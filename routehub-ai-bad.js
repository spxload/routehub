// =============================================================
// routehub-ai-bad.js — RouteHub, кнопка «AI не работает» (Этап D, шаг D.8)
var VERSION = 'ai-bad v0.1.3 (2026-06-06)';
//
// Тип: generic (запуск ВРУЧНУЮ из интерфейса Loon). Аргумент не нужен.
//   1. ШТРАФ текущему AI-узлу — rh_ai_penalty[k] += PEN_STEP (до PEN_CAP).
//      Вычитается из балла в ядре, затухает 6ч.
//   2. ПЕРЕХОД (логика как у health, sticky): другой зелёный узел ТОЙ ЖЕ страны;
//      смена СТРАНЫ — только если в текущей стране нет других зелёных (freshPick).
//      Решение Дианы: ручная кнопка = health+sticky, страну менять лишь когда
//      все узлы текущей страны мертвы (защита AI-аккаунтов от бана за смену IP).
// Рейтинг: кэш ядра rh_ratings_cache; если пуст — raw/jsdelivr.
// Матч имён: matchKey = norm(stripProvider(stripMetric(name))).
// Переключение: setSelectPolicy primary (подтверждён рабочим), getConfig fallback.
// =============================================================

var GROUP = 'RH-AI';
var RATINGS_URLS = [
  'https://raw.githubusercontent.com/spxload/routehub/main/routehub-ratings.json',
  'https://cdn.jsdelivr.net/gh/spxload/routehub@main/routehub-ratings.json'
];
var PREFERRED_COUNTRY = 'DE';
var COUNTRY_PRIORITY = ['DE','NL','CH','BE','FR','AT','GB','FI','SE','NO',
  'PL','EE','LV','LT','CZ','ES','IE','US','CA','JP','SG','KR'];

var PENALTY_KEY = 'rh_ai_penalty';
var PEN_STEP = 40;
var PEN_CAP = 100;
var STATE_KEY = 'rh_core_state';
var RCACHE_KEY = 'rh_ratings_cache';
var WIFI_KEY = 'rh_speed_wifi';
var CELL_KEY = 'rh_speed_cell';
var MAX_FAILS = 5;
var METRIC_SEP = ' \u00B7 ';
var HTTP_TIMEOUT = 15000;

var now = function () { return Date.now(); };
function log(m) { console.log('[RH-AIbad] ' + m); }
function readJSON(k, d) { try { var s = $persistentStore.read(k); return s ? JSON.parse(s) : d; } catch (e) { return d; } }
function writeJSON(k, o) { try { $persistentStore.write(JSON.stringify(o), k); } catch (e) {} }

function stripMetric(n) { var i = n.indexOf(METRIC_SEP); return i >= 0 ? n.slice(0, i) : n; }
function stripProvider(s) { return String(s).replace(/^\s*\[[^\]]*\]\s+/, ''); }
function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function matchKey(n) { return norm(stripProvider(stripMetric(n))); }
function looksLikeNode(n) { return typeof n === 'string' && n.length >= 5 && n.indexOf('[') >= 0; }
function nameOf(el) {
  if (typeof el === 'string') return el;
  if (el && typeof el === 'object') return el.name || el.policy || el.policyName || el.title || el.tag || '';
  return '';
}
function cpIdx(c) { var i = COUNTRY_PRIORITY.indexOf(c); return i < 0 ? 999 : i; }

function ptsRtt(x) { if (x < 10) return 20; if (x < 20) return 10; if (x < 50) return 5; if (x < 100) return 0; if (x < 500) return -10; return -20; }
function ptsJit(x) { if (x < 10) return 10; if (x < 20) return 5; if (x < 100) return 0; if (x < 500) return -10; return -20; }
function sDown(d, cap) { var v = d / cap; return v > 1 ? 1 : v; }
function aiScore(m) {
  if (!m) return 0;
  var blPts = (m.bl == null) ? 0 : ptsRtt(m.bl);
  return 2 * ptsRtt(m.rtt || 0) + 1.5 * ptsJit(m.jit || 0) + 1 * blPts + 0.5 * sDown(m.down || 0, 3);
}
function buildSpeedIdx(key) {
  var c = readJSON(key, {}), idx = {};
  for (var nm in c) {
    if (!c.hasOwnProperty(nm) || !looksLikeNode(nm)) continue;
    var e = c[nm];
    if ((e.fails || 0) >= MAX_FAILS || !(e.down > 0)) continue;
    idx[matchKey(nm)] = e;
  }
  return idx;
}
function bestIn(pool) {
  var p = pool.slice();
  p.sort(function (a, b) { return (b.score - a.score) || (b.stability - a.stability) || (cpIdx(a.country) - cpIdx(b.country)); });
  return p[0];
}
function freshPick(cands) {
  var de = cands.filter(function (c) { return c.country === PREFERRED_COUNTRY; });
  if (de.length) return bestIn(de);
  var byC = {};
  cands.forEach(function (c) { (byC[c.country] = byC[c.country] || []).push(c); });
  var countries = Object.keys(byC).sort(function (a, b) { return (byC[b].length - byC[a].length) || (cpIdx(a) - cpIdx(b)); });
  return bestIn(byC[countries[0]]);
}
// setSelectPolicy primary (подтверждён рабочим); getConfig — читающий, fallback
function setPolicy(group, node) {
  try { var r = $config.setSelectPolicy(group, node); if (r === true || r === undefined) return true; } catch (e) {}
  try { return $config.getConfig(group, node) !== false; } catch (e2) { return false; }
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
function getSubPolicies(group) {
  return new Promise(function (resolve) {
    try { $config.getSubPolicies(group, function (s) { var a = s; if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = []; } } resolve(Array.isArray(a) ? a : []); }); }
    catch (e) { resolve([]); }
  });
}
function detectNet() {
  var ssid = ''; try { var cfg = JSON.parse($config.getConfig()); ssid = cfg && cfg.ssid ? String(cfg.ssid) : ''; } catch (e) {}
  return ssid ? 'wifi' : 'cell';
}

async function main() {
  log('=== ' + VERSION + ' ===');
  var state = readJSON(STATE_KEY, { sel: null });
  var cur = state.sel;
  if (!cur || !cur.k) {
    $notification.post('\uD83E\uDD16 RouteHub AI', 'Нет активного узла', 'Ядро ещё не выбрало узел. Запустите RH-Core.');
    $done({}); return;
  }

  var pen = readJSON(PENALTY_KEY, {});
  var e = pen[cur.k] || { p: 0, ts: 0 };
  e.p = Math.min(PEN_CAP, (e.p || 0) + PEN_STEP);
  e.ts = now();
  pen[cur.k] = e;
  writeJSON(PENALTY_KEY, pen);
  log('штраф [' + cur.k + '] p=' + e.p);

  var data = await getRatings();
  var subs = await getSubPolicies(GROUP);
  if (!data || !data.nodes || !subs.length) {
    $notification.post('\uD83E\uDD16 RouteHub AI', 'Узел оштрафован', 'Переход отложен (нет рейтинга/пула). Ядро переберёт само.');
    $done({}); return;
  }
  var rat = data.nodes, ratIdx = {};
  for (var nm in rat) { if (rat.hasOwnProperty(nm)) ratIdx[matchKey(nm)] = rat[nm]; }
  var net = detectNet();
  var spdP = buildSpeedIdx(net === 'wifi' ? WIFI_KEY : CELL_KEY);
  var spdA = buildSpeedIdx(net === 'wifi' ? CELL_KEY : WIFI_KEY);

  var all = [];
  for (var i = 0; i < subs.length; i++) {
    var live = nameOf(subs[i]);
    if (!looksLikeNode(live)) continue;
    if (live.indexOf('[\u041E\u0431\u0445\u043E\u0434') >= 0 || live.indexOf('\u0418\u0433\u0440\u044B') >= 0) continue;
    var k = matchKey(live);
    if (k === cur.k) continue;
    var r = ratIdx[k];
    if (!r || r.light !== 'green') continue;
    var m = spdP[k] || spdA[k] || null;
    all.push({ live: live, k: k, country: r.country || '??', stability: r.stability || 0, score: aiScore(m) });
  }
  if (!all.length) {
    $notification.post('\uD83E\uDD16 RouteHub AI', 'Узел оштрафован', 'Нет других зелёных узлов для перехода.');
    $done({}); return;
  }

  // sticky: другой узел ТОЙ ЖЕ страны; смена страны только если в стране пусто
  var sameC = all.filter(function (c) { return c.country === cur.country; });
  var pick = (sameC.length ? bestIn(sameC) : freshPick(all));

  var applied = setPolicy(GROUP, pick.live);
  state.sel = { k: pick.k, live: pick.live, country: pick.country, score: Math.round(pick.score), reason: 'кнопка «не работает»', lastSwitched: now() };
  writeJSON(STATE_KEY, state);
  log((applied ? '\u26A1 ' : 'x ') + '-> [' + pick.country + '] ' + pick.k);

  $notification.post('\uD83E\uDD16 RouteHub AI',
    'Узел AI заменён (' + cur.country + (pick.country === cur.country ? '' : ' \u2192 ' + pick.country) + ')',
    pick.k + (applied ? '' : '  (применить не удалось)'));
  $done({});
}

main().catch(function (err) { log('КРАШ: ' + ((err && err.message) || err)); $done({}); });
