// =============================================================
// routehub-health.js — RouteHub, здоровье AI-узла (Этап D, шаг D.6)
var VERSION = 'health v0.1.3 (2026-06-06)';
//
// Тип: cron (КАЖДЫЕ 5 МИН, tag=RH-Health — интервал в routehub.conf).
// ОБЛАСТЬ: только RH-AI (select, сама не чинится). url-test/fallback Loon чинит сам.
// ЛОГИКА: проба ТЕКУЩЕГО узла RH-AI. Жив — тихий выход. Мёртв -> штраф
//   (rh_ai_penalty) + переключение на зелёный ТОЙ ЖЕ страны (защита от бана);
//   нет в стране -> резерв (freshPick); пуш.
// СТРАНА — ПО ИМЕНИ узла (флаг 🇩🇪 ИЛИ слово), НЕ GeoIP rating.country (он врёт).
//   Согласовано с core v0.6.1.
// Матч имён: matchKey = norm(stripProvider(stripMetric(name))).
// Переключение: setSelectPolicy primary, getConfig fallback.
// =============================================================

var GROUP = 'RH-AI';
var RATINGS_URLS = [
  'https://raw.githubusercontent.com/spxload/routehub/main/routehub-ratings.json',
  'https://cdn.jsdelivr.net/gh/spxload/routehub@main/routehub-ratings.json'
];
var PREFERRED_COUNTRY = 'DE';
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

var PROBE_URL = 'http://cp.cloudflare.com/generate_204';
var PROBE_TRIES = 3;
var PROBE_TIMEOUT = 8000;

var PENALTY_KEY = 'rh_ai_penalty';
var PEN_CAP = 100;
var STATE_KEY = 'rh_core_state';
var RCACHE_KEY = 'rh_ratings_cache';
var WIFI_KEY = 'rh_speed_wifi';
var CELL_KEY = 'rh_speed_cell';
var MAX_FAILS = 5;
var METRIC_SEP = ' \u00B7 ';
var HTTP_TIMEOUT = 15000;
var LOCK_KEY = 'RH_script_lock';
var LOCK_FRESH_MS = 60 * 1000;

var now = function () { return Date.now(); };
function log(m) { console.log('[RH-Health] ' + m); }
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
async function probe(node) {
  for (var i = 0; i < PROBE_TRIES; i++) {
    var r = await new Promise(function (resolve) {
      $httpClient.get({ url: PROBE_URL + '?t=' + Date.now(), node: node, timeout: PROBE_TIMEOUT },
        function (err, resp) { resolve(!err && resp && (resp.status === 204 || resp.status === 200)); });
    });
    if (r) return true;
  }
  return false;
}

async function main() {
  log('=== ' + VERSION + ' ===');
  var state = readJSON(STATE_KEY, { sel: null });
  var cur = state.sel;
  if (!cur || !cur.live) { log('нет активного узла (ядро не выбрало) — выход'); $done({}); return; }

  var lk = parseInt($persistentStore.read(LOCK_KEY) || '0', 10) || 0;
  if (lk && (now() - lk) < LOCK_FRESH_MS) { log('RH_script_lock занят — выход'); $done({}); return; }

  var alive = await probe(cur.live);
  if (alive) { log('\u2713 [' + cur.k + '] жив'); $done({}); return; }

  log('\u26A0 [' + cur.k + '] не отвечает (' + PROBE_TRIES + ' проб) — переключаю');

  var pen = readJSON(PENALTY_KEY, {});
  pen[cur.k] = { p: PEN_CAP, ts: now() };
  writeJSON(PENALTY_KEY, pen);

  var data = await getRatings();
  var subs = await getSubPolicies(GROUP);
  if (!data || !data.nodes || !subs.length) {
    $notification.post('\uD83E\uDD16 RouteHub AI', 'Узел AI не отвечает', 'Нет рейтинга/пула для замены — ядро переберёт позже.');
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
    all.push({ live: live, k: k, country: countryFromName(live), stability: r.stability || 0, score: aiScore(m) });
  }
  if (!all.length) {
    $notification.post('\uD83E\uDD16 RouteHub AI', 'Узел AI мёртв', 'Нет других зелёных узлов. Проверьте сеть/подписку.');
    $done({}); return;
  }

  var sameC = all.filter(function (c) { return c.country === cur.country; });
  var pick = (sameC.length ? bestIn(sameC) : freshPick(all));

  var applied = setPolicy(GROUP, pick.live);
  state.sel = { k: pick.k, live: pick.live, country: pick.country, score: Math.round(pick.score), reason: 'health: узел умер', lastSwitched: now() };
  writeJSON(STATE_KEY, state);
  log((applied ? '\u26A1 ' : 'x ') + '-> [' + pick.country + '] ' + pick.k);

  $notification.post('\uD83E\uDD16 RouteHub AI',
    'Узел AI заменён (' + cur.country + (pick.country === cur.country ? '' : ' \u2192 ' + pick.country) + ')',
    pick.k + (applied ? '' : '  (применить не удалось)'));
  $done({});
}

main().catch(function (err) { log('КРАШ: ' + ((err && err.message) || err)); $done({}); });
