// =============================================================
// routehub-worker.js — Cloudflare Worker (Этап D, личные подписки)
//
// Эндпоинты:
//   GET  /config?key=kN  -> персональный routehub.conf (узлы = nodes-kN.txt)
//   POST /speed          -> приём скорости {key,nonce,speeds[]}, пересборка nodes-kN
//
// Хранилище: ОДИН секретный gist (GIST_ID):
//   - эталон узлов  : MASTER_FILE (lastdep-nodes.txt, base64 подписки)
//   - узлы по ключу : nodes-kN.txt (base64; создаёт/пересобирает Worker)
//   - реестр        : devices.json (free/bound/conflict + nonce)
//
// ВАЖНО: содержимое подписки — base64 от «\n»-склеенных vless-ссылок
//   (так пишет publish_nodes.py). И эталон, и nodes-kN — base64, чтобы
//   Loon декодировал их одинаково.
//
// env (Cloudflare -> Worker -> Settings -> Variables and Secrets):
//   GIST_TOKEN (secret), GIST_ID, GH_USER, MASTER_FILE, CONFIG_URL
//
// Токен GitHub существует только здесь. На телефоне — keyed-URL + nonce.
// =============================================================

const METRIC_SEP = ' \u00B7 ';            // " · " — разделитель имя/метрика
const GIST_API = 'https://api.github.com/gists/';
const KEY_RE = /^k\d+$/;

function ghHeaders(token) {
  return {
    'Authorization': 'token ' + token,
    'User-Agent': 'routehub-worker',
    'Accept': 'application/vnd.github+json',
  };
}

function rawNodesUrl(env, key) {
  return 'https://gist.githubusercontent.com/' + env.GH_USER + '/' + env.GIST_ID +
         '/raw/nodes-' + key + '.txt';
}

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// --- gist I/O ---
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
function fileContent(files, name) {
  return files[name] && typeof files[name].content === 'string' ? files[name].content : null;
}

// --- base64 (содержимое ASCII: vless-ссылки с percent-encoded именами) ---
function b64decode(s) { try { return atob((s || '').replace(/\s+/g, '')); } catch (e) { return ''; } }
function b64encode(s) { return btoa(s); }

// --- разбор имён узлов ---
function fragOf(line) {
  const i = line.indexOf('#');
  return i >= 0 ? line.slice(i + 1) : '';
}
function withFrag(line, frag) {
  const i = line.indexOf('#');
  const head = i >= 0 ? line.slice(0, i) : line;
  return head + '#' + frag;
}
function decodeName(frag) { try { return decodeURIComponent(frag); } catch (e) { return frag; } }
function stripMetric(name) {
  const i = name.indexOf(METRIC_SEP);
  return (i >= 0 ? name.slice(0, i) : name).trim();
}
function tagOf(name) {
  if (name.indexOf('[\u041E\u0431\u0445\u043E\u0434') >= 0) return 'bypass'; // [Обход
  if (name.indexOf('[VPN]') >= 0) return 'vpn';
  if (name.indexOf('\u0418\u0433\u0440\u044B') >= 0) return 'game';        // Игры
  return 'other';
}

// --- реестр ---
function ensureRegistry(files) {
  const raw = fileContent(files, 'devices.json');
  if (raw) { try { return JSON.parse(raw); } catch (e) { /* битый — пересоздаём */ } }
  return { k1: { status: 'free' } };
}
function ensureFreeSpare(reg) {
  for (const k in reg) if (reg[k].status === 'free') return;
  let max = 0;
  for (const k in reg) { const n = parseInt(k.slice(1), 10); if (n > max) max = n; }
  reg['k' + (max + 1)] = { status: 'free' };
}

// --- GET /config?key=kN ---
async function handleConfig(url, env) {
  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return new Response('bad key', { status: 400 });

  const files = await gistGet(env);
  const reg = ensureRegistry(files);
  if (!reg[key]) return new Response('unknown key', { status: 403 });

  // гарантируем, что nodes-kN.txt существует (иначе ссылка в конфиге мертва).
  // копия эталона — уже base64, Loon декодирует.
  const nodesFile = 'nodes-' + key + '.txt';
  const patch = {};
  if (!fileContent(files, nodesFile)) {
    patch[nodesFile] = fileContent(files, env.MASTER_FILE) || '';
  }
  if (!fileContent(files, 'devices.json')) {
    patch['devices.json'] = JSON.stringify(reg, null, 2);
  }
  if (Object.keys(patch).length) await gistPatch(env, patch);

  const cr = await fetch(env.CONFIG_URL, { headers: { 'User-Agent': 'routehub-worker' } });
  if (!cr.ok) throw new Error('config fetch ' + cr.status);
  let conf = await cr.text();

  // 1) подмена ссылки на узлы (персональный список) в [Remote Proxy]
  conf = conf.replace(/^Lastdep = .*$/m,
    'Lastdep = ' + rawNodesUrl(env, key) + ',udp=true,enabled=true');
  // 2) bare-имена скриптов RouteHub -> полные raw-URL (тот же репо, что CONFIG_URL)
  const scriptBase = env.CONFIG_URL.replace(/[^/]+$/, '');
  conf = conf.replace(/script-path=(routehub-[^,\s]+)/g, 'script-path=' + scriptBase + '$1');
  // 3) на время Этапа D включить строку спидтеста (в базовом конфиге enabled=false).
  //    На D.9 enabled=true пропишется в сам routehub.conf, этот форс уберём.
  conf = conf.replace(/(tag=RH-Speed[^\n]*?)enabled=false/, '$1enabled=true');
  // 4) ключ устройства + адрес воркера -> аргумент спидтест-скрипта ("<key>|<origin>")
  conf = conf.replace('tag=RH-Speed', 'tag=RH-Speed, argument=' + key + '|' + url.origin);

  return new Response(conf, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

// --- POST /speed ---
async function handleSpeed(req, env) {
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }

  const key = (data && data.key) || '';
  const nonce = String((data && data.nonce) || '');
  const speeds = data && Array.isArray(data.speeds) ? data.speeds : [];
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

  // карта измеренной скорости по БАЗОВОМУ имени (без нашей метрики)
  const sp = new Map();
  for (const s of speeds) {
    if (!s || !s.name) continue;
    sp.set(stripMetric(String(s.name)), {
      down: Math.max(0, Math.round(+s.down || 0)),
      rtt: Math.max(0, Math.round(+s.rtt || 0)),
    });
  }

  // эталон в гисте — base64: декодируем в список vless-ссылок
  const master = b64decode(fileContent(files, env.MASTER_FILE) || '')
    .split('\n').map(function (l) { return l.trim(); }).filter(Boolean);

  const tested = [], untested = [], bypass = [];
  for (const line of master) {
    const name = decodeName(fragOf(line));
    const tag = tagOf(name);
    if (tag === 'bypass') { bypass.push(line); continue; }
    const m = sp.get(stripMetric(name));
    if (m && (tag === 'vpn' || tag === 'game')) {
      const metric = m.down + '\u2193 ' + m.rtt + 'ms';        // "45↓ 38ms"
      const newName = stripMetric(name) + METRIC_SEP + metric; // имя без старой метрики + новая
      tested.push({ line: withFrag(line, encodeURIComponent(newName)), down: m.down, rtt: m.rtt });
    } else {
      untested.push(line); // непротестированные — без метрики, в исходном порядке
    }
  }
  // быстрейшие первыми: down по убыванию, при равенстве — rtt по возрастанию
  tested.sort(function (a, b) { return (b.down - a.down) || (a.rtt - b.rtt); });

  const out = tested.map(function (x) { return x.line; }).concat(untested, bypass).join('\n');

  // nodes-kN тоже base64 (Loon декодирует так же, как эталон)
  await gistPatch(env, {
    ['nodes-' + key + '.txt']: b64encode(out),
    'devices.json': JSON.stringify(reg, null, 2),
  });

  return jsonResp({ ok: true, key: key, status: e.status, tested: tested.length });
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
