// =============================================================
// routehub-worker.js — Cloudflare Worker (Этап D, личные подписки)
// VERSION: worker v0.4.16 (2026-06-06)
//
// GET  /config?key=kN  -> персональный routehub.conf
// POST /speed          -> {key,nonce,wifi[],cell[]}, MERGE в metrics-kN.json,
//                         пересборка nodes-kN с ТИРАМИ-полосками
// GET  /whoami         -> детект сети по request.cf (нужен прямой запрос)
//
// Тиры (спека ЭТАП_D_ФОРМУЛА.md): абсолютная достаточность СКОРОСТИ, 3-сегментная
//   полоска ▰▰▰/▰▰▱/▰▱▱/▱▱▱; мёртвый ⛔. Имя: "база · 🛜▰▰▱ 📱▰▱▱".
//   show_rtt -> добавляет цифры (down↓rtt). Метрики jit/bl хранятся для селектора (D.5).
// Сортировка nodes-kN — по down (умный выбор узла делает селектор по баллу группы).
// env: GIST_TOKEN (secret), GIST_ID, GH_USER, MASTER_FILE, CONFIG_URL
// =============================================================

const METRIC_SEP = ' \u00B7 ';
const DEAD = '\u26D4';                 // ⛔
const ICON_WIFI = '\uD83D\uDEDC';      // 🛜
const ICON_CELL = '\uD83D\uDCF1';      // 📱
const BAR_F = '\u25B0';                // ▰
const BAR_E = '\u25B1';                // ▱
const GIST_API = 'https://api.github.com/gists/';
const KEY_RE = /^k\d+$/;
const FLAGS = ['cell_unlim', 'ewma', 'show_rtt', 'auto_refresh'];
const CELL_HINTS = ['mts', 'mobile telesystems', 'megafon', 'vimpelcom', 'beeline',
  'tele2', 't2 mobile', 'yota', 'mobile', 'cellular', 'wireless', 'lte', 'gsm'];

// тир достаточности скорости (абсолютные пороги, Мбит/с): 0..3 заполненных сегмента
function speedTier(down) { if (down >= 15) return 3; if (down >= 6) return 2; if (down >= 2) return 1; return 0; }
function tierBar(t) { return BAR_F.repeat(t) + BAR_E.repeat(3 - t); }

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

  conf = conf.replace(/^Lastdep = .*$/m, 'Lastdep = ' + rawNodesUrl(env, key) + ',udp=true,enabled=true');
  const scriptBase = env.CONFIG_URL.replace(/[^/]+$/, '');
  const cb = '?v=' + Date.now();
  conf = conf.replace(/script-path=(routehub-[^,\s]+)/g, 'script-path=' + scriptBase + '$1' + cb);
  conf = conf.replace(/(tag=RH-Speed[^\n]*?)enabled=false/, '$1enabled=true');
  const flags = [];
  if (reg[key].cell_unlim) flags.push('cellall');
  if (reg[key].ewma) flags.push('ewma');
  const opts = flags.join(',');
  conf = conf.replace('tag=RH-Speed', 'tag=RH-Speed, argument=' + key + '|' + url.origin + '|' + opts);

  return new Response(conf, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// {name,...} -> {down,rtt,jit,bl} | {dead:true}
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

  // MERGE
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

  function part(icon, m) {
    if (m.dead) return icon + DEAD;
    const bar = tierBar(speedTier(m.down));
    return icon + bar + (showRtt ? (' ' + m.down + '\u2193' + m.rtt) : '');
  }

  const tested = [], untested = [], bypass = [];
  let labeled = 0;
  for (const line of master) {
    const name = decodeName(fragOf(line));
    const tag = tagOf(name);
    if (tag === 'bypass') { bypass.push(line); continue; }
    const st = (tag === 'vpn' || tag === 'game') ? state[matchKey(name)] : null;
    if (st && (st.w || st.c)) {
      const parts = [];
      if (st.w) parts.push(part(ICON_WIFI, st.w));
      if (st.c) parts.push(part(ICON_CELL, st.c));
      const newName = norm(stripMetric(name)) + METRIC_SEP + parts.join(' ');
      const d = (st.w && !st.w.dead) ? st.w.down : ((st.c && !st.c.dead) ? st.c.down : 0);
      const rt = (st.w && !st.w.dead) ? st.w.rtt : ((st.c && !st.c.dead) ? st.c.rtt : 99999);
      tested.push({ line: withFrag(line, encodeURIComponent(newName)), down: d, rtt: rt });
      labeled++;
    } else {
      untested.push(line);
    }
  }
  tested.sort(function (a, b) { return (b.down - a.down) || (a.rtt - b.rtt); });

  const out = tested.map(function (x) { return x.line; }).concat(untested, bypass).join('\n');
  const dbg = { ts: now, sent_wifi: sentW, sent_cell: sentC, state_nodes: Object.keys(state).length, labeled: labeled, show_rtt: showRtt };

  await gistPatch(env, {
    [metricsFile]: JSON.stringify(state),
    ['nodes-' + key + '.txt']: b64encode(out),
    ['debug-' + key + '.json']: JSON.stringify(dbg, null, 2),
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
      if (req.method === 'POST' && url.pathname === '/speed') return await handleSpeed(req, env);
      return new Response('routehub-worker: not found', { status: 404 });
    } catch (err) {
      return new Response('error: ' + (err && err.message ? err.message : 'unknown'), { status: 500 });
    }
  },
};
