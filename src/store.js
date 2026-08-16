// routehub — модуль store.js
// Хранилище D1 (таблица kv), реестр устройств, токены доступа.
// Разделён из routehub-worker.js 2026-08-15 (v1.9.5). Логика не менялась.
// История версий — CHANGELOG.md в корне репозитория.

import { FLAGS, KV_UPSERT, SETTINGS_KEY, TOKEN_ALPHABET, TOKEN_LEN, TOKEN_RE, TOKEN_REQUIRED_DEFAULT } from './const.js';
import { jsonResp } from './util.js';

async function kvGetJSON(env, k) {
  const r = await env.RH_DB.prepare('SELECT value FROM kv WHERE key = ?').bind(k).first();
  if (!r || r.value == null) return null;
  try { return JSON.parse(r.value); } catch (e) { return null; }
}

async function kvPutJSON(env, k, o) {
  await env.RH_DB.prepare(KV_UPSERT).bind(k, JSON.stringify(o), Date.now()).run();
}
// Несколько записей одним обращением к D1 (транзакция: пройдут все или ни одной).
// На расход квоты НЕ влияет — каждая строка считается отдельно; выигрыш в
// задержке и атомарности (раньше два независимых await могли разъехаться).

async function kvPutManyJSON(env, pairs) {
  const stmt = env.RH_DB.prepare(KV_UPSERT);
  const now = Date.now();
  await env.RH_DB.batch(pairs.map(function (p) { return stmt.bind(p[0], JSON.stringify(p[1]), now); }));
}

async function loadMylist(env, key) { return (await kvGetJSON(env, 'mylist:' + key)) || []; }

// Настройки Worker'а (ключ settings в D1). Пока единственная — token_required.
// Читается ТОЛЬКО когда запрос пришёл без токена, поэтому по новым ссылкам
// дополнительных обращений к D1 не возникает.

async function loadSettings(env) {
  const s = await kvGetJSON(env, SETTINGS_KEY);
  return { token_required: (s && typeof s.token_required === 'boolean') ? s.token_required : TOKEN_REQUIRED_DEFAULT };
}

async function saveSettings(env, s) { await kvPutJSON(env, SETTINGS_KEY, s); }

async function loadRegistry(env) {
  let reg = await kvGetJSON(env, 'devices');
  if (reg) {
    // Разовая доводка: у старых ключей токена нет — выдать и сохранить.
    if (ensureTokens(reg)) { try { await kvPutJSON(env, 'devices', reg); } catch (e) {} }
    return reg;
  }
  reg = { k1: { status: 'free' } };
  ensureTokens(reg);
  await kvPutJSON(env, 'devices', reg);
  return reg;
}

function ensureFreeSpare(reg) {
  for (const k in reg) if (reg[k].status === 'free') return;
  let max = 0;
  for (const k in reg) { const n = parseInt(k.slice(1), 10); if (n > max) max = n; }
  reg['k' + (max + 1)] = { status: 'free', token: makeToken() };
}

// Токен устройства: 32 символа без похожих (0/O/l/1) — читаемо при переносе руками.

function makeToken() {
  const buf = new Uint8Array(TOKEN_LEN);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < TOKEN_LEN; i++) out += TOKEN_ALPHABET[buf[i] % TOKEN_ALPHABET.length];
  return out;
}
// Выдать токен каждому ключу, у которого его ещё нет. true -> реестр изменён.

function ensureTokens(reg) {
  let ch = false;
  for (const k in reg) {
    if (!TOKEN_RE.test(String(reg[k].token || ''))) { reg[k].token = makeToken(); ch = true; }
  }
  return ch;
}
// Проверка доступа. Возвращает null если можно, иначе Response с отказом.
// ФАЗА 1: токен не передан -> пропускаем. Передан и не совпал -> отказ всегда.

async function tokenGate(env, reg, key, tok, asText) {
  const want = reg[key] && reg[key].token;
  if (tok) return (want && tok === want) ? null : denyToken(asText, 'токен не подходит');
  const st = await loadSettings(env);
  if (!st.token_required) return null;
  return denyToken(asText, 'ссылка устарела');
}

function denyToken(asText, why) {
  const hint = 'RouteHub: ' + why + '.\n' +
    'Нужна новая ссылка с токеном. Открой /admin/keys?key=<ADMIN_KEY> и скопируй строку своего устройства.\n' +
    'Формат: <origin>/t/<token>/config?key=kN';
  if (asText) return new Response(hint, { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return jsonResp({ error: why, hint: hint }, 403);
}

function ensureFlags(reg) {
  let ch = false;
  for (const k in reg) {
    const e = reg[k];
    for (const f of FLAGS) if (typeof e[f] !== 'boolean') { e[f] = false; ch = true; }
  }
  return ch;
}

export { denyToken, ensureFlags, ensureFreeSpare, ensureTokens, kvGetJSON, kvPutJSON, kvPutManyJSON, loadMylist, loadRegistry, loadSettings, makeToken, saveSettings, tokenGate };
