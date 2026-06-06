// =============================================================
// routehub-core.js — RouteHub, AI-селектор (Этап D, шаг D.5)
var VERSION = 'core v0.6.0 (2026-06-06)';
//
// Тип: cron (каждые 30 мин). Аргумент НЕ нужен (рейтинг — публичный raw).
// Назначает ОДИН узел группе RH-AI (все 5 AI идут через него).
//
// ДВА слоя данных (ЭТАП_D_ФОРМУЛА.md):
//   ГЕЙТ — routehub-ratings.json: light=green (фильтр, не слагаемое).
//   БАЛЛ — локальные метрики: 2*rtt_pts+1.5*jit_pts+1*bl_pts+0.5*s(CAP=3) − штраф D.8.
//
// ВЫБОР (решение Дианы — вар.1, ЯКОРЬ АБСОЛЮТНЫЙ):
//   1. Приоритетная страна = Германия, ЕСЛИ в ней есть зелёные узлы; иначе
//      резерв (страна по числу зелёных, затем COUNTRY_PRIORITY).
//   2. AI всегда в приоритетной стране, НЕЗАВИСИМО от баллов других стран.
//      Балл/штраф решают лишь, КАКОЙ узел внутри приоритетной страны.
//   3. Если текущий узел НЕ в приоритетной стране (увели вручную/кнопкой) —
//      немедленный возврат на лучший узел приоритетной страны.
//   4. Sticky/hysteresis/cooldown — только МЕЖДУ узлами приоритетной страны
//      (защита AI-аккаунтов от частых смен IP).
//   Уйти из Германии можно лишь когда в ней НЕТ зелёных (все red/исчезли).
//
// Матч имён: matchKey = norm(stripProvider(stripMetric(name))) — рейтинг с
//   префиксом '[Lastdep] ', getSubPolicies без него. Выбор — ЖИВЫМ именем.
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

var COOLDOWN_MS = 30 * 60 * 1000;
var HYSTERESIS = 15;
var DATA_WARN_MS = 12 * 3600 * 1000;
var DATA_HARD_MS = 24 * 3600 * 1000;
var MAX_FAILS = 5;

var STATE_KEY = 'rh_core_state';
var WIFI_KEY = 'rh_speed_wifi';
var CELL_KEY = 'rh_speed_cell';
var PENALTY_KEY = 'rh_ai_penalty';
var PEN_DECAY_MS = 6 * 3600 * 1000;
var LOCK_KEY = 'RH_script_lock';
var LOCK_FRESH_MS = 60 * 1000;
var LOCK_STALE_MS = 2 * 60 * 1000;

var METRIC_SEP = ' \u00B7 ';
var HTTP_TIMEOUT = 15000;

var now = function () { return Date.now(); };

function stripMetric(name) { var i = name.indexOf(METRIC_SEP); return i >= 0 ? name.slice(0, i) : name; }
function stripProvider(s) { return String(s).replace(/^\s*\[[^\]]*\]\s+/, ''); }
function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function matchKey(name) { return norm(stripProvider(stripMetric(name))); }
function looksLikeNode(n) { return typeof n === 'string' && n.length >= 5 && n.indexOf('[') >= 0; }
function nameOf(el) {
  if (typeof el === 'string') return el;
  if (el && typeof el === 'object') return el.name || el.policy || el.policyName || el.title || el.tag || '';
  return '';
}
function cpIdx(c) { var i = COUNTRY_PRIORITY.indexOf(c); return i < 0 ? 999 : i; }

function log(m) { console.log('[RH-Core] ' + m); }

function readJSON(key, def) { try { var s = $persistentStore.read(key); return s ? JSON.parse(s) : def; } catch (e) { return def; } }
function writeJSON(key, obj) { try { $persistentStore.write(JSON.stringify(obj), key); } catch (e) {} }

function penaltyNow(pen, key) {
  var e = pen && pen[key];
  if (!e || !e.p) return 0;
  var age = now() - (e.ts || 0);
  if (age >= PEN_DECAY_MS) return 0;
  return e.p * (1 - age / PEN_DECAY_MS);
}

function httpGet(url) {
  return new Promise(function (resolve) {
    $httpClient.get({ url: url, timeout: HTTP_TIMEOUT, headers: { 'Cache-Control': 'no-cache' } },
      function (err, resp, body) {
        if (err || !resp) resolve({ ok: false, error: String(err) });
        else resolve({ ok: true, status: resp.status, body: body || '' });
      });
  });
}

async function fetchRatings() {
  for (var i = 0; i < RATINGS_URLS.length; i++) {
    var r = await httpGet(RATINGS_URLS[i]);
    if (r.ok && r.status === 200 && r.body) {
      try { var d = JSON.parse(r.body); if (d && d.nodes) return d; } catch (e) { log('JSON err: ' + e.message); }
    } else { log('источник недоступен (' + (r.status || r.error) + ')'); }
  }
  return null;
}

function buildRatIdx(nodes) {
  var idx = {};
  for (var name in nodes) { if (nodes.hasOwnProperty(name)) idx[matchKey(name)] = nodes[name]; }
  return idx;
}
function buildSpeedIdx(key) {
  var c = readJSON(key, {}); var idx = {};
  for (var nm in c) {
    if (!c.hasOwnProperty(nm) || !looksLikeNode(nm)) continue;
    var e = c[nm];
    if ((e.fails || 0) >= MAX_FAILS) continue;
    if (!(e.down > 0)) continue;
    idx[matchKey(nm)] = e;
  }
  return idx;
}

function ptsRtt(x) { if (x < 10) return 20; if (x < 20) return 10; if (x < 50) return 5; if (x < 100) return 0; if (x < 500) return -10; return -20; }
function ptsBl(x) { return ptsRtt(x); }
function ptsJit(x) { if (x < 10) return 10; if (x < 20) return 5; if (x < 100) return 0; if (x < 500) return -10; return -20; }
function sDown(d, cap) { var v = d / cap; return v > 1 ? 1 : v; }

function aiScore(m) {
  if (!m) return 0;
  var rtt = m.rtt || 0, jit = m.jit || 0, down = m.down || 0;
  var blPts = (m.bl == null) ? 0 : ptsBl(m.bl);
  return 2 * ptsRtt(rtt) + 1.5 * ptsJit(jit) + 1 * blPts + 0.5 * sDown(down, 3);
}

function bestIn(pool) {
  var p = pool.slice();
  p.sort(function (a, b) {
    return (b.score - a.score) || (b.stability - a.stability) || (cpIdx(a.country) - cpIdx(b.country));
  });
  return p[0];
}

// приоритетная страна: Германия, если в ней есть зелёные; иначе резерв
// (по числу зелёных узлов, затем COUNTRY_PRIORITY)
function pickCountry(cands) {
  var de = cands.filter(function (c) { return c.country === PREFERRED_COUNTRY; });
  if (de.length) return PREFERRED_COUNTRY;
  var byC = {};
  cands.forEach(function (c) { (byC[c.country] = byC[c.country] || []).push(c); });
  var countries = Object.keys(byC).sort(function (a, b) {
    return (byC[b].length - byC[a].length) || (cpIdx(a) - cpIdx(b));
  });
  return countries[0];
}

// setSelectPolicy primary (подтверждён рабочим на устройстве); getConfig — читающий, fallback
function setPolicy(group, node) {
  try { var r = $config.setSelectPolicy(group, node); if (r === true || r === undefined) return true; } catch (e) { log('setSelectPolicy err: ' + e.message); }
  try { return $config.getConfig(group, node) !== false; } catch (e2) { log('getConfig err: ' + e2.message); return false; }
}

function getSubPolicies(group) {
  return new Promise(function (resolve) {
    try {
      $config.getSubPolicies(group, function (subs) {
        var arr = subs;
        if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = []; } }
        resolve(Array.isArray(arr) ? arr : []);
      });
    } catch (e) { resolve([]); }
  });
}

function detectNet() {
  var ssid = '';
  try { var cfg = JSON.parse($config.getConfig()); ssid = cfg && cfg.ssid ? String(cfg.ssid) : ''; } catch (e) {}
  return ssid ? 'wifi' : 'cell';
}

function lockBusy() {
  var lk = parseInt($persistentStore.read(LOCK_KEY) || '0', 10) || 0;
  if (!lk) return false;
  var age = now() - lk;
  if (age < LOCK_FRESH_MS) return true;
  if (age > LOCK_STALE_MS) return false;
  return false;
}

async function main() {
  log('=== ' + VERSION + ' ===');

  var data = await fetchRatings();
  if (!data) { log('рейтинг недоступен — выбор не трогаю'); $done({}); return; }
  writeJSON('rh_ratings_cache', data);

  var ageMs = now() - (data.updated || 0) * 1000;
  var ageMin = Math.round(ageMs / 60000);
  if (ageMs > DATA_HARD_MS) { log('рейтинг старше 24ч — выбор не трогаю'); $done({}); return; }
  if (ageMs > DATA_WARN_MS) log('внимание: рейтинг ' + Math.round(ageMin / 60) + 'ч');

  var ratIdx = buildRatIdx(data.nodes);
  var net = detectNet();
  var spdPrim = buildSpeedIdx(net === 'wifi' ? WIFI_KEY : CELL_KEY);
  var spdAlt = buildSpeedIdx(net === 'wifi' ? CELL_KEY : WIFI_KEY);
  var pen = readJSON(PENALTY_KEY, {});
  log('сеть=' + net + ' метрик(' + net + ')=' + Object.keys(spdPrim).length + ' рейтинг=' + Object.keys(ratIdx).length);

  var subs = await getSubPolicies(GROUP);
  if (!subs.length) { log('пул RH-AI пуст/недоступен'); $done({}); return; }

  var cands = [];
  var seenRat = 0, seenGreen = 0;
  for (var i = 0; i < subs.length; i++) {
    var live = nameOf(subs[i]);
    if (!looksLikeNode(live)) continue;
    if (live.indexOf('[\u041E\u0431\u0445\u043E\u0434') >= 0) continue;
    if (live.indexOf('\u0418\u0433\u0440\u044B') >= 0) continue;
    var k = matchKey(live);
    var r = ratIdx[k];
    if (!r) continue;
    seenRat++;
    if (r.light !== 'green') continue;
    seenGreen++;
    var m = spdPrim[k] || spdAlt[k] || null;
    cands.push({
      live: live, k: k, country: r.country || '??',
      stability: (typeof r.stability === 'number') ? r.stability : 0,
      score: aiScore(m) - penaltyNow(pen, k), hasMetrics: !!m
    });
  }

  if (!cands.length) {
    log('нет зелёных AI-узлов в пуле (совпало с рейтингом ' + seenRat + ', green ' + seenGreen + ')');
    $notification.post('\uD83E\uDD16 RouteHub AI', 'Нет доступных узлов', 'Совпало с рейтингом: ' + seenRat + ', зелёных: ' + seenGreen + '.');
    $done({}); return;
  }

  // приоритетная страна (Германия-якорь абсолютный) + пул её узлов
  var country = pickCountry(cands);
  var pool = cands.filter(function (c) { return c.country === country; });

  var state = readJSON(STATE_KEY, { version: VERSION, lastRun: 0, sel: null });
  var prev = state.sel;
  // текущий узел учитывается, ТОЛЬКО если он в приоритетной стране
  var cur = prev ? pool.filter(function (c) { return c.k === prev.k; })[0] : null;

  var pick, reason;
  if (cur) {
    // sticky между узлами приоритетной страны
    var others = pool.filter(function (c) { return c.k !== cur.k; });
    var best = others.length ? bestIn(others) : null;
    var cooldownOk = !prev.lastSwitched || (now() - prev.lastSwitched) >= COOLDOWN_MS;
    if (best && (best.score - cur.score) > HYSTERESIS && cooldownOk) {
      pick = best; reason = 'апгрейд в ' + country;
    } else {
      pick = cur; reason = 'sticky ' + country;
    }
  } else {
    // текущего нет в приоритетной стране (увели вручную/кнопкой) или холодный старт
    pick = bestIn(pool);
    reason = prev ? 'возврат на якорь ' + country : 'старт ' + country;
  }

  var changed = !prev || prev.k !== pick.k;

  var applied = false;
  if (lockBusy()) {
    log('RH_script_lock занят — переключение пропущено');
  } else {
    $persistentStore.write(String(now()), LOCK_KEY);
    applied = setPolicy(GROUP, pick.live);
    $persistentStore.write('', LOCK_KEY);
  }

  state.version = VERSION;
  state.lastRun = now();
  state.dataAgeMin = ageMin;
  state.net = net;
  state.poolGreen = cands.length;
  state.sel = {
    k: pick.k, live: pick.live, country: pick.country,
    score: Math.round(pick.score), reason: reason,
    lastSwitched: (changed && applied) ? now() : (prev && prev.lastSwitched) || now()
  };
  writeJSON(STATE_KEY, state);

  log((changed ? '\u26A1 ' : '\u2713 ') + '[' + pick.country + '] ' + pick.k +
    ' балл=' + Math.round(pick.score) + ' (' + reason + ', применено=' + applied + ')');

  if (changed && applied) {
    $notification.post('\uD83E\uDD16 RouteHub AI',
      'Узел AI: ' + pick.country + ' \u00B7 зелёных ' + cands.length + ' \u00B7 ' + ageMin + 'мин',
      pick.k + '  (' + reason + ')');
  }

  $done({});
}

main().catch(function (err) {
  var msg = (err && err.message) || String(err);
  log('КРАШ: ' + msg);
  try { $persistentStore.write('', LOCK_KEY); } catch (e) {}
  $done({});
});
