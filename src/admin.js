// routehub — модуль admin.js
// Админ-панель: сессия, состояние, устройства, настройки.
// Разделён из routehub-worker.js 2026-08-15 (v1.9.5). Логика не менялась.
// История версий — CHANGELOG.md в корне репозитория.

import { ADMIN_COOKIE, ADMIN_SESSION_MS, ADMIN_SESSION_TAG, BY, CASCADE_TIERS, DOMAIN_RE, FLAGS, FRESH_MS, KEY_RE, WORKER_VER } from './const.js';
import { ensureFlags, ensureFreeSpare, kvGetJSON, kvPutJSON, loadMylist, loadRegistry, loadSettings, makeToken, saveSettings } from './store.js';
import { fetchUpstream } from './sub.js';
import { decodeName, flagOf, fragOf, jsonResp, matchKey, parseUserinfo, regionOf, tagOf } from './util.js';

function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// Сравнение за постоянное время: посимвольный XOR без раннего выхода.
// Разная длина отвергается сразу — длина секретом не является.

function timingEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return d === 0;
}

async function signSession(secret, exp) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(ADMIN_SESSION_TAG + '|' + exp));
  return b64url(new Uint8Array(sig));
}

async function makeSession(secret) {
  const exp = Date.now() + ADMIN_SESSION_MS;
  return exp + '.' + (await signSession(secret, exp));
}
// Любая невнятность (нет точки, срок истёк, подпись не сошлась) -> false.

async function verifySession(secret, val) {
  const s = String(val || '');
  const i = s.indexOf('.');
  if (i <= 0) return false;
  const exp = Number(s.slice(0, i));
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  return timingEq(s.slice(i + 1), await signSession(secret, exp));
}

function readCookie(req, name) {
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const p = part.trim();
    const i = p.indexOf('=');
    if (i > 0 && p.slice(0, i) === name) return p.slice(i + 1);
  }
  return '';
}
// Path=/admin — на эндпоинты устройств (/config, /nodes, /speed) cookie не уходит.
// SameSite=Strict закрывает CSRF, HttpOnly прячет значение от скриптов страницы.

function sessionCookie(value, maxAgeSec) {
  return ADMIN_COOKIE + '=' + value + '; Path=/admin; Max-Age=' + maxAgeSec +
    '; HttpOnly; Secure; SameSite=Strict';
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Гейт: X-Admin-Key (панель шлёт его только при входе) -> ?key= (ручные заходы)
// -> сессионная cookie. Async из-за пересчёта HMAC.

async function adminGate(req, url, env) {
  if (!env.ADMIN_KEY) return jsonResp({ error: 'admin disabled' }, 403);
  const key = req.headers.get('X-Admin-Key') || url.searchParams.get('key') || '';
  if (key && timingEq(key, env.ADMIN_KEY)) return null;
  const c = readCookie(req, ADMIN_COOKIE);
  if (c && await verifySession(env.ADMIN_KEY, c)) return null;
  return jsonResp({ error: 'forbidden' }, 403);
}

// Обмен ADMIN_KEY на сессию. Неверный ключ — 403 с задержкой ~300 мс: грубая
// помеха перебору. Счётчики попыток не заводились намеренно — они потребовали
// бы записи в D1 на КАЖДЫЙ запрос, а ключ и без того длинный секрет.

async function handleAdminLogin(req, env) {
  if (!env.ADMIN_KEY) return jsonResp({ error: 'admin disabled' }, 403);
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }
  const key = String((data && data.key) || '');
  if (!key || !timingEq(key, env.ADMIN_KEY)) {
    await sleep(300);
    return jsonResp({ error: 'forbidden' }, 403);
  }
  const val = await makeSession(env.ADMIN_KEY);
  return new Response(JSON.stringify({
    ok: true, expires: new Date(Date.now() + ADMIN_SESSION_MS).toISOString(),
  }), { status: 200, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Set-Cookie': sessionCookie(val, Math.round(ADMIN_SESSION_MS / 1000)),
  } });
}

// Погасить сессию в этом браузере. Гейт не нужен: операция ничего не открывает.

function handleAdminLogout() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Set-Cookie': sessionCookie('', 0),
  } });
}

// Страница панели. Без гейта: сама разметка секретов не содержит, ключ вводится
// в ней и уходит в /admin/login. HTML вбирается в бандл при сборке и приходит
// сюда параметром из точки входа (правило Text в wrangler.toml действует только
// на статический импорт).

function handleAdminPage(ADMIN_HTML) {
  return new Response(ADMIN_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function deviceRow(url, k, e) {
  const flags = {};
  for (const f of FLAGS) flags[f] = !!e[f];
  return {
    key: k, status: e.status || null,
    first_seen: e.first_seen || null, last_seen: e.last_seen || null,
    last_config_ts: e.last_config_ts || null, last_nodes_ts: e.last_nodes_ts || null,
    conf_ver: e.conf_ver || null, nodes_n: e.nodes_n || 0,
    token: e.token || null, flags: flags,
    config_url: url.origin + '/t/' + e.token + '/config?key=' + k,
    dashboard_url: url.origin + '/t/' + e.token + '/dashboard?key=' + k,
    refresh_url: url.origin + '/t/' + e.token + '/refresh?key=' + k,
  };
}

// Готовые ссылки по устройствам — отсюда Диана берёт строку для нового телефона.
// Токен показывается ТОЛЬКО здесь и в /admin/state, и только под ADMIN_KEY.

async function handleAdminKeys(req, url, env) {
  const denied = await adminGate(req, url, env); if (denied) return denied;
  const reg = await loadRegistry(env);
  const st = await loadSettings(env);
  const out = [];
  for (const k in reg) out.push(deviceRow(url, k, reg[k]));
  return jsonResp({ ok: true, token_required: st.token_required, devices: out });
}

// Каскад регионов конфига: сколько узлов в каждом тире и сколько из них живых
// по метрикам выбранного устройства. Порядок тиров совпадает с [Proxy Group]
// главного конфига (RH-АВТО): EU -> AM -> RU/СНГ -> прочие -> игры -> обход.

function cascadeOf(masterLines, state) {
  const out = {};
  for (const t of CASCADE_TIERS) out[t] = { total: 0, live: 0 };
  for (const line of masterLines) {
    const name = decodeName(fragOf(line));
    const tag = tagOf(name);
    let tier;
    if (tag === 'bypass') tier = 'BYPASS';
    else if (tag === 'game') tier = 'GAME';
    else if (tag === 'vpn') tier = CASCADE_TIERS[regionOf(flagOf(name))];
    else continue;
    out[tier].total++;
    const st = state[matchKey(name)];
    const m = st ? (st.w || st.c) : null;
    if (m && !m.dead) out[tier].live++;
  }
  return out;
}

// Сводка для панели: один GET на всё, чтобы не плодить обращения к D1.
// ?dev=kN — устройство, по которому считаются каскад, метрики и личный список;
// по умолчанию первое привязанное.

async function handleAdminState(req, url, env) {
  const denied = await adminGate(req, url, env); if (denied) return denied;
  const reg = await loadRegistry(env);
  const st = await loadSettings(env);
  const c = await kvGetJSON(env, 'sub_cache');
  const masterLines = (c && c.text) ? c.text.split('\n').filter(Boolean) : [];

  let dev = url.searchParams.get('dev') || '';
  if (!reg[dev]) {
    dev = '';
    for (const k in reg) if (reg[k].status === 'bound') { dev = k; break; }
    if (!dev) for (const k in reg) { dev = k; break; }
  }
  const state = dev ? ((await kvGetJSON(env, 'metrics:' + dev)) || {}) : {};
  const mylist = dev ? await loadMylist(env, dev) : [];
  const rkn = dev ? ((await kvGetJSON(env, 'rkn:' + dev)) || null) : null;

  const devices = [];
  for (const k in reg) devices.push(deviceRow(url, k, reg[k]));

  // Раздел «хранилище»: тот же запрос, что стоял в снятом /admin/verify.
  let storage = [];
  try {
    const rows = await env.RH_DB.prepare(
      'SELECT key, LENGTH(value) AS len, updated_at FROM kv ORDER BY key').all();
    storage = (rows.results || []).map(function (r) {
      return { key: r.key, len: r.len, updated_at: r.updated_at || null };
    });
  } catch (e) { storage = []; }

  return jsonResp({
    ok: true, worker: WORKER_VER,
    token_required: st.token_required,
    dev: dev || null,
    sub: {
      ts: c ? new Date(c.ts).toISOString() : null,
      age_min: c ? Math.round((Date.now() - c.ts) / 60000) : null,
      nodes: c ? (c.n || masterLines.length) : 0,
      fresh_min: Math.round(FRESH_MS / 60000),
      traffic: c ? parseUserinfo(c.meta || {}) : null,
    },
    cascade: cascadeOf(masterLines, state),
    metrics_n: Object.keys(state).length,
    mylist: mylist, rkn: rkn,
    devices: devices, storage: storage,
    server_now: new Date().toISOString(),
  });
}

// Настройки устройства: флаги (заменяют правку SQL в консоли D1), перевыпуск
// токена, отвязка. Две последние операции способны отрезать устройство —
// панель запрашивает подтверждение.

async function handleAdminDevice(req, url, env) {
  const denied = await adminGate(req, url, env); if (denied) return denied;
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }
  const key = (data && data.key) || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  const e = reg[key];
  if (!e) return jsonResp({ error: 'unknown key' }, 404);
  ensureFlags(reg);

  const flags = (data && data.flags) || null;
  if (flags) for (const f of FLAGS) if (typeof flags[f] === 'boolean') e[f] = flags[f];

  const action = String((data && data.action) || '');
  if (action === 'regen_token') e.token = makeToken();
  else if (action === 'unbind') { e.status = 'free'; delete e.nonce; }
  else if (action && action !== 'flags') return jsonResp({ error: 'bad action' }, 400);

  ensureFreeSpare(reg);
  await kvPutJSON(env, 'devices', reg);
  return jsonResp({ ok: true, device: deviceRow(url, key, e) });
}

// Переключатель фазы 2 токенов. Значение живёт в D1, деплой не требуется.

async function handleAdminSettings(req, url, env) {
  const denied = await adminGate(req, url, env); if (denied) return denied;
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }
  if (!data || typeof data.token_required !== 'boolean') return jsonResp({ error: 'bad settings' }, 400);
  const st = await loadSettings(env);
  st.token_required = data.token_required;
  await saveSettings(env, st);
  return jsonResp({ ok: true, settings: st });
}

// Действия панели. Пока одно: обновить подписку немедленно.

async function handleAdminAction(req, url, env) {
  const denied = await adminGate(req, url, env); if (denied) return denied;
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }
  const action = String((data && data.action) || '');
  if (action !== 'refresh_sub') return jsonResp({ error: 'bad action' }, 400);
  try {
    const fresh = await fetchUpstream(env);
    await kvPutJSON(env, 'sub_cache', fresh);
    return jsonResp({ ok: true, nodes: fresh.n, updated: new Date(fresh.ts).toISOString() });
  } catch (e) {
    return jsonResp({ ok: false, error: String(e && e.message || e) }, 502);
  }
}

// Личный список RH-RU из панели. Модель та же, что у POST /addrule /delrule:
// один ключ mylist:<kN> = массив доменов. add=false — удаление.

async function handleAdminMylist(req, url, env) {
  const denied = await adminGate(req, url, env); if (denied) return denied;
  let data;
  try { data = await req.json(); } catch (e) { return jsonResp({ error: 'bad json' }, 400); }
  const key = (data && data.key) || '';
  if (!KEY_RE.test(key)) return jsonResp({ error: 'bad key' }, 400);
  const reg = await loadRegistry(env);
  if (!reg[key]) return jsonResp({ error: 'unknown key' }, 404);
  const domain = String((data && data.domain) || '').trim().toLowerCase();
  if (!DOMAIN_RE.test(domain)) return jsonResp({ error: 'bad domain' }, 400);
  let list = await loadMylist(env, key);
  if (data.add === false) list = list.filter(function (d) { return d !== domain; });
  else if (list.indexOf(domain) < 0) list.push(domain);
  await kvPutJSON(env, 'mylist:' + key, list);
  return jsonResp({ ok: true, key: key, domains: list });
}

export { adminGate, b64url, cascadeOf, deviceRow, handleAdminAction, handleAdminDevice, handleAdminKeys, handleAdminLogin, handleAdminLogout, handleAdminMylist, handleAdminPage, handleAdminSettings, handleAdminState, makeSession, readCookie, sessionCookie, signSession, sleep, timingEq, verifySession };
