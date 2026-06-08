// =============================================================
// routehub-worker.js — Cloudflare Worker (Этап E, личные подписки)
// VERSION: worker v0.9.2 (2026-06-08) — модель ОДНОЙ подписки. Чистка:
//   убраны /net, rawNodesUrl, запись/сидинг nodes-kN.txt, флаг ai_fallback.
//   /nodes отдаёт оба набора в одном ответе: блок 🛜 (по wifi-скорости),
//   блок 📱 (по cell-скорости), затем обход одной записью (отсортирован
//   DE -> по числу узлов -> остальные; RU оставлен). Фильтры режут по метке.
//   /config считает узлы по флагу и СТРОИТ постраные AI-фильтры и группы
//   (DE первой, дальше по числу узлов; тай-брейк скорость -> близость к DE;
//   одиночные — catch-all без RU/BY И стран тиров), подставляя в плейсхолдеры.
//
// GET  /config?key=kN  -> конфиг: Lastdep -> /nodes; AI-тиеры подставлены;
//        script-path -> raw-URL; RH-Speed/RH-Net получают argument=key|origin|opts.
// GET  /nodes?key=kN   -> оба набора (🛜+📱) + обход; base64; Cache-Control:no-store.
//        &dbg=1 -> пишет reg.nodes_ts/nodes_n.
// GET  /status?key=kN  -> диагностика.
// POST /speed          -> метрики устройства (скорость wifi/cell).
// GET  /whoami         -> детект сети/оператора по request.cf.
// env: GIST_TOKEN (secret), GIST_ID, GH_USER, MASTER_FILE, CONFIG_URL
// =============================================================

const METRIC_SEP = ' \u00B7 ';
const DEAD = '\u26D4';                 // ⛔
const ICON_WIFI = '\uD83D\uDEDC';      // 🛜
const ICON_CELL = '\uD83D\uDCF1';      // 📱
const NODATA = '\u2205';               // ∅
const BLK = ['\u2581', '\u2583', '\u2585', '\u2587', '\u2588']; // ▁▃▅▇█
const SUP_PLUS = '\u207A';             // ⁺
const SUP_DIG = ['\u2070', '\u00B9', '\u00B2', '\u00B3', '\u2074', '\u2075', '\u2076', '\u2077', '\u2078', '\u2079'];
const GIST_API = 'https://api.github.com/gists/';
const KEY_RE = /^k\d+$/;
const FLAGS = ['cell_unlim', 'ewma', 'show_rtt', 'auto_refresh'];
const CELL_HINTS = ['mts', 'mobile telesystems', 'megafon', 'vimpelcom', 'beeline',
  'tele2', 't2 mobile', 'yota', 'mobile', 'cellular', 'wireless', 'lte', 'gsm'];

const DE = '\uD83C\uDDE9\uD83C\uDDEA'; // 🇩🇪
const RU = '\uD83C\uDDF7\uD83C\uDDFA'; // 🇷🇺
const BY = '\uD83C\uDDE7\uD83C\uDDFE'; // 🇧🇾
const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;
// близость к Германии (меньше = ближе): тай-брейк при равном числе узлов
const PROX = {
  '\uD83C\uDDE9\uD83C\uDDEA': 0,  '\uD83C\uDDF3\uD83C\uDDF1': 1,  '\uD83C\uDDE8\uD83C\uDDFF': 2,
  '\uD83C\uDDE6\uD83C\uDDF9': 3,  '\uD83C\uDDF5\uD83C\uDDF1': 4,  '\uD83C\uDDEB\uD83C\uDDF7': 5,
  '\uD83C\uDDE7\uD83C\uDDEA': 6,  '\uD83C\uDDE8\uD83C\uDDED': 7,  '\uD83C\uDDE9\uD83C\uDDF0': 8,
  '\uD83C\uDDF8\uD83C\uDDEA': 9,  '\uD83C\uDDF3\uD83C\uDDF4': 10, '\uD83C\uDDEB\uD83C\uDDEE': 11,
  '\uD83C\uDDEA\uD83C\uDDEA': 12, '\uD83C\uDDF1\uD83C\uDDFB': 13, '\uD83C\uDDF1\uD83C\uDDF9': 14,
  '\uD83C\uDDEC\uD83C\uDDE7': 15, '\uD83C\uDDEE\uD83C\uDDEA': 16, '\uD83C\uDDEA\uD83C\uDDF8': 17,
  '\uD83C\uDDEE\uD83C\uDDF9': 18, '\uD83C\uDDF7\uD83C\uDDF4': 19, '\uD83C\uDDE7\uD83C\uDDFE': 20,
  '\uD83C\uDDF9\uD83C\uDDF7': 22, '\uD83C\uDDF7\uD83C\uDDFA': 23, '\uD83C\uDDF0\uD83C\uDDFF': 24,
  '\uD83C\uDDE6\uD83C\uDDF2': 25, '\uD83C\uDDE6\uD83C\uDDEA': 26, '\uD83C\uDDEE\uD83C\uDDF3': 27,
  '\uD83C\uDDF8\uD83C\uDDEC': 28, '\uD83C\uDDF9\uD83C\uDDED': 29, '\uD83C\uDDEF\uD83C\uDDF5': 30,
  '\uD83C\uDDF0\uD83C\uDDF7': 31, '\uD83C\uDDFA\uD83C\uDDF8': 32, '\uD83C\uDDE8\uD83C\uDDE6': 33,
  '\uD83C\uDDE7\uD83C\uDDF7': 34, '\uD83C\uDDE6\uD83C\uDDF7': 35, '\uD83C\uDDF3\uD83C\uDDEC': 36,
};
function proxOf(fl) { return (fl in PROX) ? PROX[fl] : 99; }

function speedBlock(down) {
  if (down < 1) return BLK[0];
  if (down < 2) return BLK[1];
  if (down < 5) return BLK[2];
  if (down < 15) return BLK[3];
  if (down < 25) return BLK[4];
  return BLK[4] + SUP_PLUS;
}
function supNum(n) {
  n = Math.round(n); if (n < 0) n = 0; if (n > 999) n = 999;
  return String(n).split('').map(function (d) { return SUP_DIG[+d]; }).join('');
}

function ghHeaders(token) {
  return { 'Authorization': 'token ' + token, 'User-Agent': 'routehub-worker', 'Accept': 'application/vnd.github+json' };
}
function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

async function gistGet(env) {
  const r = await fetch(GIST_API + env.GIST_ID, { headers: ghHeaders(env.GIST_TOKEN) });
  if (!r.ok) throw new Error('gist read ' + r.status);
  const j = await r.json();
  return j.files || {};
}
async function gistPatch(env, filesObj) {
  const body = { files: {} };
  for (const name in filesObj) body.files[name] = { content: filesObj[name] };
  const r = await fetch(GIST_API + env.GIST_ID, {
    method: 'PATCH',
    headers: Object.assign(ghHeaders(env.GIST_TOKEN), { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('gist write ' + r.status);
}
function fileContent(files, name) { return files[name] && typeof files[name].content === 'string' ? files[name].content : null; }

function b64decode(s) { try { return atob((s || '').replace(/\s+/g, '')); } catch (e) { return ''; } }
function b64encode(s) { return btoa(s); }

function fragOf(line) { const i = line.indexOf('#'); return i >= 0 ? line.slice(i + 1) : ''; }
function withFrag(line, frag) { const i = line.indexOf('#'); const head = i >= 0 ? line.slice(0, i) : line; return head + '#' + frag; }
function decodeName(frag) { try { return decodeURIComponent(frag); } catch (e) { return frag; } }
function stripMetric(name) { const i = name.indexOf(METRIC_SEP); return (i >= 0 ? name.slice(0, i) : name); }
function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }
function matchKey(name) { return norm(stripMetric(name)); }
function flagOf(name) { const m = String(name).match(FLAG_RE); return m ? m[0] : ''; }
function tagOf(name) {
  if (name.indexOf('[\u041E\u0431\u0445\u043E\u0434') >= 0) return 'bypass';
  if (name.indexOf('[VPN]') >= 0) return 'vpn';
  if (name.indexOf('\u0418\u0433\u0440\u044B') >= 0) return 'game';
  return 'other';
}
function classifyNet(asOrg) {
  const s = (asOrg || '').toLowerCase();
  for (const h of CELL_HINTS) if (s.indexOf(h) >= 0) return 'cell';
  return 'wifi';
}

function ensureRegistry(files) {
  const raw = fileContent(files, 'devices.json');
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  return { k1: { status: 'free' } };
}
function ensureFreeSpare(reg) {
  for (const k in reg) if (reg[k].status === 'free') return;
  let max = 0;
  for (const k in reg) { const n = parseInt(k.slice(1), 10); if (n > max) max = n; }
  reg['k' + (max + 1)] = { status: 'free' };
}
function ensureFlags(reg) {
  let ch = false;
  for (const k in reg) {
    const e = reg[k];
    for (const f of FLAGS) if (typeof e[f] !== 'boolean') { e[f] = false; ch = true; }
  }
  return ch;
}

function handleWhoami(req) {
  const cf = req.cf || {};
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const aso = cf.asOrganization || '';
  return jsonResp({ ip: ip, asn: cf.asn || null, aso: aso, country: cf.country || null, net: classifyNet(aso) });
}

// --- AI-тиеры: страны по числу [VPN]-узлов (флаг из имени), DE первой,
//     тай-брейк скорость -> близость к DE; RU/BY исключены. Singles -> catch-all. ---
function buildAiTiers(masterLines, state) {
  const cnt = {}, spd = {};
  for (const line of masterLines) {
    const name = decodeName(fragOf(line));
    if (tagOf(name) !== 'vpn') continue;
    const fl = flagOf(name);
    if (!fl) continue;
    cnt[fl] = (cnt[fl] || 0) + 1;
    let s = 0;
    const st = state[matchKey(name)];
    if (st) {
      if (st.w && !st.w.dead) s = Math.max(s, +st.w.down || 0);
      if (st.c && !st.c.dead) s = Math.max(s, +st.c.down || 0);
    }
    if (!(fl in spd) || s > spd[fl]) spd[fl] = s;
  }
  const others = Object.keys(cnt).filter(function (f) { return f !== DE && f !== RU && f !== BY; });
  const multi = others.filter(function (f) { return cnt[f] >= 2; }).sort(function (a, b) {
    return (cnt[b] - cnt[a]) || ((spd[b] || 0) - (spd[a] || 0)) || (proxOf(a) - proxOf(b));
  });
  const tiers = [];
  if (cnt[DE]) tiers.push(DE);
  for (const f of multi) tiers.push(f);
  return tiers;
}
function aiBlocks(tiers) {
  const fW = [], fC = [], gW = [], gC = [];
  tiers.forEach(function (fl, i) {
    const id = (i + 1 < 10 ? '0' : '') + (i + 1);
    fW.push('RH-Filter-W-AI' + id + ' = NameRegex, Lastdep, FilterKey = ' + fl + '.*\\[VPN\\].*' + ICON_WIFI);
    fC.push('RH-Filter-C-AI' + id + ' = NameRegex, Lastdep, FilterKey = ' + fl + '.*\\[VPN\\].*' + ICON_CELL);
    gW.push('RH-Filter-W-AI' + id);
    gC.push('RH-Filter-C-AI' + id);
  });
  // AIrest = одиночные: исключаем RU/BY И все страны тиров (Loon не дедупит фильтры группы)
  const exclAlt = [RU, BY].concat(tiers).join('|');
  fW.push('RH-Filter-W-AIrest = NameRegex, Lastdep, FilterKey = ^(?!.*(' + exclAlt + ')).*\\[VPN\\].*' + ICON_WIFI);
  fC.push('RH-Filter-C-AIrest = NameRegex, Lastdep, FilterKey = ^(?!.*(' + exclAlt + ')).*\\[VPN\\].*' + ICON_CELL);
  gW.push('RH-Filter-W-AIrest');
  gC.push('RH-Filter-C-AIrest');
  const filters = fW.join('\n') + '\n' + fC.join('\n');
  const u = 'url=http://cp.cloudflare.com/generate_204, interval=600';
  const groups =
    'RH-AI = select, RH-AI-W, RH-AI-C, img-url=https://cdn.jsdelivr.net/gh/Orz-3/mini@master/Color/AI.png\n' +
    'RH-AI-W = fallback, ' + gW.join(', ') + ', RH-Filter-Обход, ' + u + '\n' +
    'RH-AI-C = fallback, ' + gC.join(', ') + ', RH-Filter-Обход, ' + u;
  return { filters: filters, groups: groups };
}

async function handleConfig(url, env) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return new Response('bad key', { status: 400 });

  const files = await gistGet(env);
  const reg = ensureRegistry(files);
  if (!reg[key]) return new Response('unknown key', { status: 403 });
  const flagsChanged = ensureFlags(reg);
  if (flagsChanged || !fileContent(files, 'devices.json')) {
    await gistPatch(env, { 'devices.json': JSON.stringify(reg, null, 2) });
  }

  const cr = await fetch(env.CONFIG_URL, { headers: { 'User-Agent': 'routehub-worker' } });
  if (!cr.ok) throw new Error('config fetch ' + cr.status);
  let conf = await cr.text();

  // постраные AI-тиеры (динамически по текущему составу узлов)
  const masterLines = b64decode(fileContent(files, env.MASTER_FILE) || '')
    .split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  let state = {};
  const sraw = fileContent(files, 'metrics-' + key + '.json');
  if (sraw) { try { state = JSON.parse(sraw) || {}; } catch (e) { state = {}; } }
  const blocks = aiBlocks(buildAiTiers(masterLines, state));
  conf = conf.replace('# __RH_AI_FILTERS__', blocks.filters);
  conf = conf.replace('# __RH_AI_GROUPS__', blocks.groups);

  // одна подписка: оба набора в /nodes
  const sub = url.origin + '/nodes?key=' + key + ',udp=true,enabled=true';
  conf = conf.replace(/^Lastdep = .*$/m, 'Lastdep = ' + sub);
  // script-path -> абсолютный raw-URL
  const scriptBase = env.CONFIG_URL.replace(/[^/]+$/, '');
  conf = conf.replace(/script-path=(routehub-[^,\s]+)/g, 'script-path=' + scriptBase + '$1');
  // argument спидтесту: key|origin|opts
  const sFlags = [];
  if (reg[key].cell_unlim) sFlags.push('cellall');
  if (reg[key].ewma) sFlags.push('ewma');
  conf = conf.replace('tag=RH-Speed', 'tag=RH-Speed, argument=' + key + '|' + url.origin + '|' + sFlags.join(','));
  // argument netwatch: key|origin|opts
  const nOpts = reg[key].auto_refresh ? 'autorefresh' : '';
  conf = conf.replace('tag=RH-Net', 'tag=RH-Net, argument=' + key + '|' + url.origin + '|' + nOpts);

  return new Response(conf, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// --- GET /status ---
async function handleStatus(url, env) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const files = await gistGet(env);
  const reg = ensureRegistry(files);
  const e = reg[key];
  if (!e) return jsonResp({ error: 'unknown key' }, 403);
  return jsonResp({
    key: key, status: e.status || null, net: e.net || null,
    net_ts: e.net_ts || null, nodes_ts: e.nodes_ts || null, nodes_n: e.nodes_n || 0,
    last_seen: e.last_seen || null, server_now: new Date().toISOString(),
  });
}

// рендер ОДНОЙ метки для протестированного узла
function labelOf(icon, m, max, showRtt) {
  if (m.dead) return icon + DEAD;
  const pct = max > 0 ? Math.round(m.down / max * 100) : 0;
  return icon + speedBlock(m.down) + ' ' + supNum(pct) + (showRtt ? (' ' + m.down + '\u2193' + m.rtt) : '');
}

// одна подписка: оба набора (🛜 по wifi-скорости, 📱 по cell), затем обход
function renderNodesBoth(masterLines, state, showRtt) {
  const bypassRaw = [];
  const wTested = [], cTested = [], wUntested = [], cUntested = [];
  let maxW = 0, maxC = 0;
  for (const line of masterLines) {
    const name = decodeName(fragOf(line));
    const tag = tagOf(name);
    if (tag === 'bypass') { bypassRaw.push({ line: line, name: name, flag: flagOf(name) }); continue; }
    const base = norm(stripMetric(name));
    const st = (tag === 'vpn' || tag === 'game') ? state[matchKey(name)] : null;
    const mw = st ? st.w : null;
    const mc = st ? st.c : null;
    if (mw) { if (!mw.dead && mw.down > maxW) maxW = mw.down; wTested.push({ line: line, base: base, m: mw }); }
    else { wUntested.push(withFrag(line, encodeURIComponent(base + METRIC_SEP + ICON_WIFI + NODATA))); }
    if (mc) { if (!mc.dead && mc.down > maxC) maxC = mc.down; cTested.push({ line: line, base: base, m: mc }); }
    else { cUntested.push(withFrag(line, encodeURIComponent(base + METRIC_SEP + ICON_CELL + NODATA))); }
  }
  function buildBlock(items, icon, max) {
    const arr = [];
    for (const it of items) {
      const nm = it.base + METRIC_SEP + labelOf(icon, it.m, max, showRtt);
      arr.push({ line: withFrag(it.line, encodeURIComponent(nm)), down: it.m.dead ? -1 : it.m.down, rtt: it.m.dead ? 99999 : it.m.rtt });
    }
    arr.sort(function (a, b) { return (b.down - a.down) || (a.rtt - b.rtt); });
    return arr.map(function (x) { return x.line; });
  }
  const wifiBlock = buildBlock(wTested, ICON_WIFI, maxW).concat(wUntested);
  const cellBlock = buildBlock(cTested, ICON_CELL, maxC).concat(cUntested);
  // обход: DE первой, дальше по числу узлов, потом остальные (RU оставлен, скорости нет)
  const bcnt = {};
  for (const b of bypassRaw) if (b.flag) bcnt[b.flag] = (bcnt[b.flag] || 0) + 1;
  bypassRaw.sort(function (a, b) {
    if (a.flag === DE && b.flag !== DE) return -1;
    if (b.flag === DE && a.flag !== DE) return 1;
    return ((bcnt[b.flag] || 0) - (bcnt[a.flag] || 0)) || (proxOf(a.flag) - proxOf(b.flag));
  });
  const bypassOut = bypassRaw.map(function (b) { return withFrag(b.line, encodeURIComponent(norm(stripMetric(b.name)))); });
  return wifiBlock.concat(cellBlock, bypassOut).join('\n');
}

// --- GET /nodes: оба набора + обход, no-store ---
async function handleNodes(url, env) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return new Response('bad key', { status: 400 });
  const files = await gistGet(env);
  const reg = ensureRegistry(files);
  if (!reg[key]) return new Response('unknown key', { status: 403 });
  const showRtt = !!reg[key].show_rtt;
  if (url.searchParams.get('dbg') === '1') {
    reg[key].nodes_ts = new Date().toISOString();
    reg[key].nodes_n = (reg[key].nodes_n || 0) + 1;
    try { await gistPatch(env, { 'devices.json': JSON.stringify(reg, null, 2) }); } catch (e) {}
  }
  const masterLines = b64decode(fileContent(files, env.MASTER_FILE) || '')
    .split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  let state = {};
  const sraw = fileContent(files, 'metrics-' + key + '.json');
  if (sraw) { try { state = JSON.parse(sraw) || {}; } catch (e) { state = {}; } }
  const out = renderNodesBoth(masterLines, state, showRtt);
  return new Response(b64encode(out), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function metricOf(s) {
  if (s.dead) return { dead: true };
  return {
    down: Math.max(0, Math.round(+s.down || 0)),
    rtt: Math.max(0, Math.round(+s.rtt || 0)),
    jit: Math.max(0, Math.round(+s.jit || 0)),
    bl: (s.bl == null ? null : Math.max(0, Math.round(+s.bl))),
  };
}

async function handleSpeed(req, env) {
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }

  const key = (data && data.key) || '';
  const nonce = String((data && data.nonce) || '');
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  if (!nonce) return jsonResp({ error: 'no nonce' }, 400);

  const files = await gistGet(env);
  const reg = ensureRegistry(files);
  if (!reg[key]) return jsonResp({ error: 'unknown key' }, 403);
  ensureFlags(reg);

  const now = new Date().toISOString();
  const e = reg[key];
  if (e.status === 'free') {
    e.status = 'bound'; e.nonce = nonce; e.first_seen = now; e.last_seen = now;
    ensureFreeSpare(reg); ensureFlags(reg);
  } else if (e.status === 'bound') {
    if (e.nonce !== nonce) {
      e.status = 'conflict';
      await gistPatch(env, { 'devices.json': JSON.stringify(reg, null, 2) });
      return jsonResp({ error: 'nonce conflict' }, 409);
    }
    e.last_seen = now;
  } else {
    return jsonResp({ error: 'key in conflict' }, 409);
  }

  const metricsFile = 'metrics-' + key + '.json';
  let state = {};
  const sraw = fileContent(files, metricsFile);
  if (sraw) { try { state = JSON.parse(sraw) || {}; } catch (er) { state = {}; } }
  let sentW = 0, sentC = 0;
  function apply(arr, slot) {
    if (!Array.isArray(arr)) return;
    for (const s of arr) {
      if (!s || !s.name) continue;
      const k = matchKey(String(s.name));
      if (!state[k]) state[k] = {};
      state[k][slot] = metricOf(s);
      if (slot === 'w') sentW++; else sentC++;
    }
  }
  apply(data.wifi, 'w');
  apply(data.cell, 'c');

  let labeled = 0;
  for (const k in state) if (state[k] && (state[k].w || state[k].c)) labeled++;

  await gistPatch(env, {
    [metricsFile]: JSON.stringify(state),
    'devices.json': JSON.stringify(reg, null, 2),
  });

  return jsonResp({ ok: true, key: key, status: e.status, labeled: labeled, sent_wifi: sentW, sent_cell: sentC });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/whoami') return handleWhoami(req);
      if (req.method === 'GET' && url.pathname === '/config') return await handleConfig(url, env);
      if (req.method === 'GET' && url.pathname === '/nodes') return await handleNodes(url, env);
      if (req.method === 'GET' && url.pathname === '/status') return await handleStatus(url, env);
      if (req.method === 'POST' && url.pathname === '/speed') return await handleSpeed(req, env);
      return new Response('routehub-worker: not found', { status: 404 });
    } catch (err) {
      return new Response('error: ' + (err && err.message ? err.message : 'unknown'), { status: 500 });
    }
  },
};
