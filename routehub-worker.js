// =============================================================
// routehub-worker.js — Cloudflare Worker (Этап D, личные подписки)
// VERSION: worker v0.4.11 (2026-06-05)
//
// GET  /config?key=kN  -> персональный routehub.conf (узлы = nodes-kN.txt)
// POST /speed          -> приём {key,nonce,wifi[],cell[]}, пересборка nodes-kN
//
// Элемент wifi/cell: {name,down,rtt} (хороший) ИЛИ {name,dead:true} (нерабочий).
// Имя: "база · 📶<wifi>↓ 📱<cell>↓"; мёртвая сеть -> 📶⛔/📱⛔ вместо скорости.
// Сортировка по Wi-Fi скорости (мёртвые/без метрики — вниз).
// Хранилище: один секретный gist (GIST_ID). Имена матчатся по norm().
// env: GIST_TOKEN (secret), GIST_ID, GH_USER, MASTER_FILE, CONFIG_URL
// =============================================================

const METRIC_SEP = ' \u00B7 ';
const DEAD = '\u26D4';            // ⛔
const ICON_WIFI = '\uD83D\uDCF6'; // 📶
const ICON_CELL = '\uD83D\uDCF1'; // 📱
const GIST_API = 'https://api.github.com/gists/';
const KEY_RE = /^k\d+$/;

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

async function handleConfig(url, env) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return new Response('bad key', { status: 400 });

  const files = await gistGet(env);
  const reg = ensureRegistry(files);
  if (!reg[key]) return new Response('unknown key', { status: 403 });

  const nodesFile = 'nodes-' + key + '.txt';
  const patch = {};
  if (!fileContent(files, nodesFile)) patch[nodesFile] = fileContent(files, env.MASTER_FILE) || '';
  if (!fileContent(files, 'devices.json')) patch['devices.json'] = JSON.stringify(reg, null, 2);
  if (Object.keys(patch).length) await gistPatch(env, patch);

  const cr = await fetch(env.CONFIG_URL, { headers: { 'User-Agent': 'routehub-worker' } });
  if (!cr.ok) throw new Error('config fetch ' + cr.status);
  let conf = await cr.text();

  conf = conf.replace(/^Lastdep = .*$/m, 'Lastdep = ' + rawNodesUrl(env, key) + ',udp=true,enabled=true');
  const scriptBase = env.CONFIG_URL.replace(/[^/]+$/, '');
  const cb = '?v=' + Date.now();
  conf = conf.replace(/script-path=(routehub-[^,\s]+)/g, 'script-path=' + scriptBase + '$1' + cb);
  conf = conf.replace(/(tag=RH-Speed[^\n]*?)enabled=false/, '$1enabled=true');
  const opts = (reg[key] && reg[key].cell_unlim) ? 'cellall' : '';
  conf = conf.replace('tag=RH-Speed', 'tag=RH-Speed, argument=' + key + '|' + url.origin + '|' + opts);

  return new Response(conf, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

function toMap(arr) {
  const m = new Map();
  if (Array.isArray(arr)) {
    for (const s of arr) {
      if (!s || !s.name) continue;
      if (s.dead) m.set(matchKey(String(s.name)), { dead: true });
      else m.set(matchKey(String(s.name)), { down: Math.max(0, Math.round(+s.down || 0)), rtt: Math.max(0, Math.round(+s.rtt || 0)) });
    }
  }
  return m;
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

  const now = new Date().toISOString();
  const e = reg[key];
  if (e.status === 'free') {
    e.status = 'bound'; e.nonce = nonce; e.first_seen = now; e.last_seen = now;
    ensureFreeSpare(reg);
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

  const wifi = toMap(data.wifi);
  const cell = toMap(data.cell);

  const master = b64decode(fileContent(files, env.MASTER_FILE) || '')
    .split('\n').map(function (l) { return l.trim(); }).filter(Boolean);

  function part(icon, m) { return m.dead ? (icon + DEAD) : (icon + m.down + '\u2193'); }

  const tested = [], untested = [], bypass = [], masterKeys = [];
  for (const line of master) {
    const name = decodeName(fragOf(line));
    const tag = tagOf(name);
    if (tag === 'bypass') { bypass.push(line); continue; }
    const k = matchKey(name);
    if (tag === 'vpn' || tag === 'game') masterKeys.push(k);
    const w = wifi.get(k), c = cell.get(k);
    if ((w || c) && (tag === 'vpn' || tag === 'game')) {
      const parts = [];
      if (w) parts.push(part(ICON_WIFI, w));
      if (c) parts.push(part(ICON_CELL, c));
      const newName = norm(stripMetric(name)) + METRIC_SEP + parts.join(' ');
      const d = (w && !w.dead) ? w.down : ((c && !c.dead) ? c.down : 0);
      const rt = (w && !w.dead) ? w.rtt : ((c && !c.dead) ? c.rtt : 99999);
      tested.push({ line: withFrag(line, encodeURIComponent(newName)), down: d, rtt: rt });
    } else {
      untested.push(line);
    }
  }
  tested.sort(function (a, b) { return (b.down - a.down) || (a.rtt - b.rtt); });

  const out = tested.map(function (x) { return x.line; }).concat(untested, bypass).join('\n');

  const sentKeys = Array.from(new Set(Array.from(wifi.keys()).concat(Array.from(cell.keys()))));
  const unmatched = sentKeys.filter(function (x) { return masterKeys.indexOf(x) < 0; }).slice(0, 12);
  const dbg = { ts: now, wifi: wifi.size, cell: cell.size, master_vpn_game: masterKeys.length, tested: tested.length, unmatched_sent: unmatched };

  await gistPatch(env, {
    ['nodes-' + key + '.txt']: b64encode(out),
    ['debug-' + key + '.json']: JSON.stringify(dbg, null, 2),
    'devices.json': JSON.stringify(reg, null, 2),
  });

  return jsonResp({ ok: true, key: key, status: e.status, tested: tested.length, wifi: wifi.size, cell: cell.size });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/config') return await handleConfig(url, env);
      if (req.method === 'POST' && url.pathname === '/speed') return await handleSpeed(req, env);
      return new Response('routehub-worker: not found', { status: 404 });
    } catch (err) {
      return new Response('error: ' + (err && err.message ? err.message : 'unknown'), { status: 500 });
    }
  },
};
