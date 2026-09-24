// routehub — модуль api/config.js
// Эндпоинт /config: сбор контекста и рендер конфига клиентским слоем.
// Выделен из src/api.js 2026-08-25 (ветка stash-client): файл перешагнул
// порог 15 КБ. Логика НЕ менялась — только раскладка по файлам.
// Worker v1.11.0 (перенос T-private-repo из main v1.12.0): шаблон Loon — из
// сборки (files.js), ссылки на файлы репозитория — на прокси /t/<токен>/repo/.
// История версий — CHANGELOG.md в корне репозитория.

import { buildAiTiers } from '../ai.js';
import { pickClient } from '../clients/registry.js';
import { KEY_RE } from '../const.js';
import { FILES } from '../files.js';
import { repoBase, rewriteRepoLinks } from '../repo.js';
import { ensureFlags, kvGetJSON, kvPutJSON, loadRegistry, tokenGate } from '../store.js';
import { getSub } from '../sub.js';
import { confVersion } from '../util.js';

async function handleConfig(url, env, tok) {
  // РАЗВИЛКА ПО КЛИЕНТУ (ADR-01). Переменной CLIENT нет или значение
  // незнакомое — работает Loon: боевой конфиг важнее строгости, см. шапку
  // clients/registry.js. Проверка стоит первой, чтобы клиент, у которого
  // слоя /config ещё нет, не ходил в реестр и в подписку впустую.
  // У Loon и Stash слой есть; 501 остаётся для СЛЕДУЮЩЕГО клиента, которого
  // заведут в реестре раньше, чем напишут ему рендер.
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

  // ШАБЛОН НУЖЕН НЕ ВСЕМ. Loon правит готовый routehub.conf из репозитория;
  // профиль Stash собирается кодом целиком, шаблона для него нет.
  // Признак объявляет сам клиентский слой (usesTemplate), а не эта функция.
  const usesTemplate = client.config.usesTemplate !== false;
  let conf = '';
  if (usesTemplate) {
    // v1.11.0: шаблон из сборки (files.js), не с GitHub — репозиторий
    // становится приватным. CONFIG_URL больше не читается.
    conf = FILES['routehub.conf'];
    const cv = confVersion(conf);
    if (cv && reg[key].conf_ver !== cv) reg[key].conf_ver = cv;
  } else if (client.config.VERSION && reg[key].conf_ver !== client.config.VERSION) {
    // Версию профиля объявляет сам слой — иначе в панели у стенда пусто.
    reg[key].conf_ver = client.config.VERSION;
  }
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
    // Скрипты — через прокси файлов с токеном устройства (repo.js).
    scriptBase: repoBase(url.origin, reg[key].token),
    // Клиенту, который собирает профиль сам, нужны исходные данные, а не
    // только посчитанные блоки. Loon эти поля игнорирует.
    masterLines: masterLines,
    state: state,
  });

  // [Plugin] и другие прямые ссылки шаблона на spxload/routehub — на прокси.
  // Профиль Stash собирается кодом и таких ссылок не содержит (сторож —
  // tests/config.test.js), его выдача здесь не трогается.
  if (usesTemplate) conf = rewriteRepoLinks(conf, url.origin, reg[key].token);

  const ct = client.config.contentType || 'text/plain; charset=utf-8';
  // no-store: в ссылках токен устройства (как у /repo) — и у Loon, и у Stash.
  return new Response(conf, { headers: { 'Content-Type': ct, 'Cache-Control': 'no-store' } });
}

export { handleConfig };
