// =============================================================
// routehub-worker.js — Cloudflare Worker (Этап D/E, личные подписки)
// VERSION: worker v0.8.4 (2026-06-08) — модель двух подписок: /config отдаёт
//          LastdepW(&net=wifi)+LastdepC(&net=cell); /nodes метит КАЖДЫЙ узел
//          иконкой сети (против дедупа); ai=fallback transform снят.
//
// GET  /config?key=kN        -> конфиг с двумя подписками (WiFi/Cell), script-path
//        переписан в raw-URL, RH-Speed/RH-Net получают argument=key|origin|opts.
// GET  /nodes?key=kN&net=wifi|cell -> узлы под сеть: метка ТОЛЬКО этой сети (🛜/📱)
//        на КАЖДОМ узле (протестированные — скорость, прочие — иконка+∅, обход —
//        иконка), сортировка по скорости; Cache-Control:no-store.
//        &dbg=1 -> пишет reg.nodes_ts/nodes_n (диагностика).
// POST /net            -> {key,nonce,net} (легаси; в модели двух подписок не нужен).
// GET  /status?key=kN  -> диагностика (net,net_ts,nodes_ts,nodes_n,last_seen).
// POST /speed          -> метрики (+ печёт nodes-kN.txt, легаси).
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
const FLAGS = ['cell_unlim', 'ewma', 'show_rtt', 'auto_refresh', 'ai_fallback'];
const CELL_HINTS = ['mts', 'mobile telesystems', 'megafon', 'vimpelcom', 'beeline',
  'tele2', 't2 mobile', 'yota', 'mobile', 'cellular', 'wireless', 'lte', 'gsm'];

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
function rawNodesUrl(env, key) {
  return 'https://gist.githubusercontent.com/' + env.GH_USER + '/' + env.GIST_ID + '/raw/nodes-' + key + '.txt';
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

async function handleConfig(url, env) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return new Response('bad key', { status: 400 });

  const files = await gistGet(env);
  const reg = ensureRegistry(files);
  if (!reg[key]) return new Response('unknown key', { status: 403 });
  const flagsChanged = ensureFlags(reg);

  const nodesFile = 'nodes-' + key + '.txt';
  const patch = {};
  if (!fileContent(files, nodesFile)) patch[nodesFile] = fileContent(files, env.MASTER_FILE) || '';
  if (flagsChanged || !fileContent(files, 'devices.json')) patch['devices.json'] = JSON.stringify(reg, null, 2);
  if (Object.keys(patch).length) await gistPatch(env, patch);

  const cr = await fetch(env.CONFIG_URL, { headers: { 'User-Agent': 'routehub-worker' } });
  if (!cr.ok) throw new Error('config fetch ' + cr.status);
  let conf = await cr.text();

  // две подписки: WiFi-набор и Cell-набор (Worker /nodes с &net=). Обе всегда
  // загружены; netwatch флипает родительские select-группы по текущей сети.
  const wifiSub = url.origin + '/nodes?key=' + key + '&net=wifi,udp=true,enabled=true';
  const cellSub = url.origin + '/nodes?key=' + key + '&net=cell,udp=true,enabled=true';
  conf = conf.replace(/^LastdepW = .*$/m, 'LastdepW = ' + wifiSub);
  conf = conf.replace(/^LastdepC = .*$/m, 'LastdepC = ' + cellSub);
  // script-path -> абсолютный raw-URL
  const scriptBase = env.CONFIG_URL.replace(/[^/]+$/, '');
  conf = conf.replace(/script-path=(routehub-[^,\s]+)/g, 'script-path=' + scriptBase + '$1');
  // argument спидтесту: key|origin|opts (cellall,ewma)
  const sFlags = [];
  if (reg[key].cell_unlim) sFlags.push('cellall');
  if (reg[key].ewma) sFlags.push('ewma');
  conf = conf.replace('tag=RH-Speed', 'tag=RH-Speed, argument=' + key + '|' + url.origin + '|' + sFlags.join(','));
  // argument netwatch: key|origin|opts — origin нужен для /whoami
  const nOpts = reg[key].auto_refresh ? 'autorefresh' : '';
  conf = conf.replace('tag=RH-Net', 'tag=RH-Net, argument=' + key + '|' + url.origin + '|' + nOpts);

  return new Response(conf, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// --- POST /net: легаси (в модели двух подписок не используется) ---
async function handleNet(req, env) {
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }
  const key = (data && data.key) || '';
  const nonce = String((data && data.nonce) || '');
  const net = (data && data.net) || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  if (net !== 'wifi' && net !== 'cell') return jsonResp({ error: 'bad net' }, 400);

  const files = await gistGet(env);
  const reg = ensureRegistry(files);
  if (!reg[key]) return jsonResp({ error: 'unknown key' }, 403);
  const e = reg[key];
  if (e.status !== 'bound' || e.nonce !== nonce) return jsonResp({ ok: true, ignored: true });
  e.net = net;
  e.net_ts = new Date().toISOString();
  await gistPatch(env, { 'devices.json': JSON.stringify(reg, null, 2) });
  return jsonResp({ ok: true, net: net, net_ts: e.net_ts });
}

// --- GET /status: диагностика ---
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

// рендер узлов под ОДНУ сеть (wifi|cell): метка сети на КАЖДОМ узле (против дедупа)
function renderNodes(masterLines, state, net, showRtt) {
  const slot = (net === 'cell') ? 'c' : 'w';
  const icon = (net === 'cell') ? ICON_CELL : ICON_WIFI;
  const bypass = [], untested = [], items = [];
  let max = 0;
  for (const line of masterLines) {
    const name = decodeName(fragOf(line));
    const tag = tagOf(name);
    if (tag === 'bypass') {
      // метка сети и на обход — чтобы имена различались между подписками
      const bn = norm(stripMetric(name)) + METRIC_SEP + icon;
      bypass.push(withFrag(line, encodeURIComponent(bn)));
      continue;
    }
    const st = (tag === 'vpn' || tag === 'game') ? state[matchKey(name)] : null;
    const m = st ? st[slot] : null;
    if (m) {
      if (!m.dead && m.down > max) max = m.down;
      items.push({ line: line, name: name, m: m });
    } else {
      // непротестированные: метка сети + ∅ (имя уникально на сеть -> нет дедупа)
      const un = norm(stripMetric(name)) + METRIC_SEP + icon + NODATA;
      untested.push(withFrag(line, encodeURIComponent(un)));
    }
  }
  const tested = [];
  for (const it of items) {
    const m = it.m;
    let label;
    if (m.dead) { label = icon + DEAD; }
    else {
      const pct = max > 0 ? Math.round(m.down / max * 100) : 0;
      label = icon + speedBlock(m.down) + ' ' + supNum(pct) + (showRtt ? (' ' + m.down + '\u2193' + m.rtt) : '');
    }
    const newName = norm(stripMetric(it.name)) + METRIC_SEP + label;
    const d = m.dead ? -1 : m.down;
    const rt = m.dead ? 99999 : m.rtt;
    tested.push({ line: withFrag(it.line, encodeURIComponent(newName)), down: d, rtt: rt });
  }
  tested.sort(function (a, b) { return (b.down - a.down) || (a.rtt - b.rtt); });
  return tested.map(function (x) { return x.line; }).concat(untested, bypass).join('\n');
}

// --- GET /nodes: узлы под сеть (net из URL; иначе reg.net; иначе wifi), no-store ---
async function handleNodes(url, env) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return new Response('bad key', { status: 400 });
  const files = await gistGet(env);
  const reg = ensureRegistry(files);
  if (!reg[key]) return new Response('unknown key', { status: 403 });
  const qNet = url.searchParams.get('net');
  const net = (qNet === 'wifi' || qNet === 'cell') ? qNet : ((reg[key].net === 'cell') ? 'cell' : 'wifi');
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
  const out = renderNodes(masterLines, state, net, showRtt);
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

  const showRtt = !!e.show_rtt;

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

  const master = b64decode(fileContent(files, env.MASTER_FILE) || '')
    .split('\n').map(function (l) { return l.trim(); }).filter(Boolean);

  const bypass = [], untested = [], items = [];
  let maxW = 0, maxC = 0;
  for (const line of master) {
    const name = decodeName(fragOf(line));
    const tag = tagOf(name);
    if (tag === 'bypass') { bypass.push(line); continue; }
    const st = (tag === 'vpn' || tag === 'game') ? state[matchKey(name)] : null;
    if (st && (st.w || st.c)) {
      if (st.w && !st.w.dead && st.w.down > maxW) maxW = st.w.down;
      if (st.c && !st.c.dead && st.c.down > maxC) maxC = st.c.down;
      items.push({ line: line, name: name, st: st });
    } else {
      untested.push(line);
    }
  }

  function part(icon, m, max) {
    if (m.dead) return icon + DEAD;
    const blk = speedBlock(m.down);
    const pct = max > 0 ? Math.round(m.down / max * 100) : 0;
    return icon + blk + ' ' + supNum(pct) + (showRtt ? (' ' + m.down + '\u2193' + m.rtt) : '');
  }

  const tested = [];
  let labeled = 0;
  for (const it of items) {
    const st = it.st, parts = [];
    if (st.w) parts.push(part(ICON_WIFI, st.w, maxW));
    if (st.c) parts.push(part(ICON_CELL, st.c, maxC));
    const newName = norm(stripMetric(it.name)) + METRIC_SEP + parts.join(' ');
    const d = (st.w && !st.w.dead) ? st.w.down : ((st.c && !st.c.dead) ? st.c.down : 0);
    const rt = (st.w && !st.w.dead) ? st.w.rtt : ((st.c && !st.c.dead) ? st.c.rtt : 99999);
    tested.push({ line: withFrag(it.line, encodeURIComponent(newName)), down: d, rtt: rt });
    labeled++;
  }
  tested.sort(function (a, b) { return (b.down - a.down) || (a.rtt - b.rtt); });

  const out = tested.map(function (x) { return x.line; }).concat(untested, bypass).join('\n');

  await gistPatch(env, {
    [metricsFile]: JSON.stringify(state),
    ['nodes-' + key + '.txt']: b64encode(out),
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
      if (req.method === 'POST' && url.pathname === '/net') return await handleNet(req, env);
      return new Response('routehub-worker: not found', { status: 404 });
    } catch (err) {
      return new Response('error: ' + (err && err.message ? err.message : 'unknown'), { status: 500 });
    }
  },
};
