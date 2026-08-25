// routehub — модуль admin/session.js
// Сессия и вход: подпись cookie, гейт доступа, /admin, /admin/login, /admin/logout.
// Выделен из src/admin.js 2026-08-25 (ветка stash-client): файл перешагнул
// порог 15 КБ. Логика НЕ менялась — только раскладка по файлам.
// История версий — CHANGELOG.md в корне репозитория.

import { ADMIN_COOKIE, ADMIN_SESSION_MS, ADMIN_SESSION_TAG } from '../const.js';
import { jsonResp } from '../util.js';

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

export { adminGate, b64url, handleAdminLogin, handleAdminLogout, handleAdminPage, makeSession, readCookie, sessionCookie, signSession, sleep, timingEq, verifySession };
