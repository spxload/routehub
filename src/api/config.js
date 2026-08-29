// routehub — модуль api/config.js
// Эндпоинт /config: сбор контекста и рендер конфига клиентским слоем.
// Выделен из src/api.js 2026-08-25 (ветка stash-client): файл перешагнул
// порог 15 КБ. Логика НЕ менялась — только раскладка по файлам.
// История версий — CHANGELOG.md в корне репозитория.

import { buildAiTiers } from '../ai.js';
import { pickClient } from '../clients/registry.js';
import { KEY_RE } from '../const.js';
import { ensureFlags, kvGetJSON, kvPutJSON, loadRegistry, tokenGate } from '../store.js';
import { getSub } from '../sub.js';
import { confVersion } from '../util.js';

async function handleConfig(url, env, tok) {
  // РАЗВИЛКА ПО КЛИЕНТУ (ADR-01). Переменной CLIENT нет или значение
  // незнакомое — работает Loon: боевой конфиг важнее строгости, см. шапку
  // clients/registry.js. Проверка стоит первой, чтобы клиент, у которого
  // слоя /config ещё нет, не ходил в реестр и в подписку впустую.
  const client = pickClient(env);
  if (!client.config) {
    return new Response('client ' + client.id + ': /config не реализован', { status: 501 });
  }

  const key = url.searchParams.get('key') || '';
  if (!KEY_RE.test(key)) return new Response('bad key', { status: 400 });

  const reg = await loadRegistry(env);
  if (!reg[key]) return new Response('unknown key', { status: 403 });
  const bad = await tokenGate(env, reg, key, tok, true); if (bad) return bad;
  ensureFlags(reg);
  reg[key].last_config_ts = new Date().toISOString();

  // Обход кэша: no-store (кэш Workers) + ?t=now (CDN GitHub считает ресурс новым)
  const cfgUrl = env.CONFIG_URL + (env.CONFIG_URL.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
  const cr = await fetch(cfgUrl, { headers: { 'User-Agent': 'routehub-worker' }, cache: 'no-store' });
  if (!cr.ok) throw new Error('config fetch ' + cr.status);
  let conf = await cr.text();
  const cv = confVersion(conf);
  if (cv && reg[key].conf_ver !== cv) reg[key].conf_ver = cv;
  // Одна запись реестра на запрос (раньше при смене C-draft писалось дважды).
  try { await kvPutJSON(env, 'devices', reg); } catch (e) {}

  // Параметры подписки берём ИЗ КОНФИГА ДО переписывания строки Lastdep.
  const subParams = client.config.subParamsFromConf(conf);
  // База со встроенным токеном: скрипты на устройстве строят запрос как
  // ORIGIN + '/путь', поэтому токен доезжает до них без правки самих скриптов.
  const base = url.origin + '/t/' + reg[key].token;

  const sub = await getSub(env, false);
  const masterLines = sub.text.split('\n').filter(Boolean);
  const state = (await kvGetJSON(env, 'metrics:' + key)) || {};
  // Ядро посчитало тиеры; синтаксис конфига — забота клиентского слоя.
  conf = client.config.renderConfig(conf, {
    key: key,
    base: base,
    dev: reg[key],
    blocks: client.config.aiBlocks(buildAiTiers(masterLines, state)),
    subParams: subParams,
    scriptBase: env.CONFIG_URL.replace(/[^/]+$/, ''),
  });

  return new Response(conf, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

export { handleConfig };
