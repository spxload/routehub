// routehub — модуль admin/device.js
// Действия над устройством и настройки: /admin/device, /admin/settings, /admin/action.
// Выделен из src/admin.js 2026-08-25 (ветка stash-client): файл перешагнул
// порог 15 КБ. Логика НЕ менялась — только раскладка по файлам.
// История версий — CHANGELOG.md в корне репозитория.

import { FLAGS, KEY_RE } from '../const.js';
import { ensureFlags, ensureFreeSpare, kvPutJSON, loadRegistry, loadSettings, makeToken, saveSettings } from '../store.js';
import { fetchUpstream } from '../sub.js';
import { jsonResp } from '../util.js';
import { adminGate } from './session.js';
import { deviceRow } from './state.js';

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

export { handleAdminAction, handleAdminDevice, handleAdminSettings };
