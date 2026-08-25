// routehub — модуль admin/mylist.js
// Личный список RH-RU из панели: /admin/mylist.
// Выделен из src/admin.js 2026-08-25 (ветка stash-client): файл перешагнул
// порог 15 КБ. Логика НЕ менялась — только раскладка по файлам.
// История версий — CHANGELOG.md в корне репозитория.

import { DOMAIN_RE, KEY_RE } from '../const.js';
import { kvPutJSON, loadMylist, loadRegistry } from '../store.js';
import { jsonResp } from '../util.js';
import { adminGate } from './session.js';

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

export { handleAdminMylist };
