// routehub — модуль clients/stash-profile.js
// КЛИЕНТСКИЙ СЛОЙ STASH, КАРКАС ПРОФИЛЯ: режим ядра, DNS, поставщик прокси,
// служебные группы и сборка целого YAML. Группы функций (RH-AI, RH-АВТО,
// RH-Звонки) собирает clients/stash.js, правила — clients/stash-rules.js.
// Этот модуль — то, что реестр клиентов отдаёт как слой /config.
//
// ШАБЛОНА У STASH НЕТ. Loon получает routehub.conf из репозитория и Worker
// подставляет в него блоки; профиль Stash собирается кодом целиком. Причина
// не в лени: половина профиля (узлы, порядок, тиеры) считается на сервере, а
// вторая половина — константы, которым в отдельном файле делать нечего, пока
// их некому редактировать. Поэтому usesTemplate = false, и src/api/config.js
// для Stash НЕ ходит за CONFIG_URL (иначе стенд падал бы на 404
// routehub-stash.yaml, которого в репозитории нет).
//
// ДОПУЩЕНИЯ, КОТОРЫЕ ЗАКРЫВАЕТ ТОЛЬКО СТЕНД (полностью — в
// docs/ЭТАП_K_STASH_ПРАВИЛА.md, раздел 3):
//  1. Группа ссылается на узлы поставщика ПО ИМЕНИ (форма членства «А»).
//     Так подтвердил интерфейс Stash; документация описывает другой путь —
//     include-all + filter. Если имена не разрешатся, переключить сборку в
//     форму «Б» (opts.membership = 'provider') — она уже реализована.
//  2. Тест поставщика НЕ ПЕРЕОПРЕДЕЛЯЕТСЯ: ключи benchmark-* сняты, см.
//     комментарий у TEST_URL ниже.
//  3. «Слабый DIRECT»: RH-RU — fallback с DIRECT первым, обход вторым.
//     В Loon проверено, что fallback пробивает DIRECT и уходит дальше при
//     whitelist. Для Stash это НЕ проверено.
//  4. Группам не задан ни url теста, ни interval: по документации они не
//     обязательны, значение по умолчанию 600 с.
// История версий — CHANGELOG.md в корне репозитория.

import { PROVIDER, buildGroups, childGroup, nodeSet } from './stash.js';
import { orderNames } from './stash-order.js';
import { buildRules } from './stash-rules.js';
import { buildProviders, buildSetRules } from './stash-sets.js';
import { nodeToYaml, yBlock } from './stash-yaml.js';

// Версия профиля. Аналог C-draft-NN у Loon: её видно в админ-панели
// (поле conf_ver) и в первой строке самого профиля.
const VERSION = 'S-draft-2';

// Поставщик прокси. interval — как часто Stash перечитывает файл узлов;
// 600 с выбрано потому, что ПОРЯДОК членов групп меняется перевыдачей
// конфига, а состав — перевыдачей файла поставщика (ADR-02, трейд-офф).
const PROVIDER_PATH = './providers/rh-lastdep.yaml';
const PROVIDER_INTERVAL = 600;
// Адрес и тайм-аут проверки — из [General] боевого конфига: proxy-test-url
// и test-timeout (секунды). В ПРОФИЛЬ НЕ ПОПАДАЮТ. Раньше писались как
// benchmark-url / benchmark-timeout у поставщика, но эти имена придуманы по
// аналогии с Clash: документация Stash для поставщика прокси знает только
// url, path, interval, filter, headers. Возможность в приложении есть (экран
// поставщика, «Переопределить параметры теста производительности»), имён
// ключей мы не знаем — до проверки на стенде работает умолчание Stash.
// Константы оставлены готовыми, не удалять: docs/ЭТАП_K_STASH_ПРАВИЛА.md, р. 5.
const TEST_URL = 'http://connectivitycheck.gstatic.com/generate_204';
const TEST_TIMEOUT = 3;

// DNS. Перенос [General]: dns-server = system,1.1.1.1,77.88.8.8 и
// doh-server = cloudflare,google. Раскладка по секциям Stash: DoH — рабочие
// резолверы (nameserver), plain — начальная загрузка (default-nameserver).
// Яндекс (77.88.8.8) остаётся ТОЛЬКО plain-резервом: в DoH его не добавлять
// (отравление РКН — пометка в routehub.conf).
const DNS_BOOT = ['system', '1.1.1.1', '77.88.8.8'];
const DNS_MAIN = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'];

// Служебные группы. В Loon они живут в [Proxy Group] конфига; здесь их негде
// держать, кроме кода. Имена — те же, на них ссылаются правила.
const G_MAIN = 'RH-Главный', G_RU = 'RH-RU', G_BYPASS = 'RH-Обход';

// Ранг для RH-Обход: только обходные узлы, порядок — как пришли из подписки.
// Обходные узлы НЕ замеряются (платный трафик), поэтому балла у них нет и
// сортировать их нечем — orderNames оставит исходный порядок.
function rankBypass(it) { return it.tag === 'bypass' ? 0 : -1; }

function serviceGroups(masterLines, state, opts) {
  const o = opts || {};
  const set = nodeSet(masterLines, state, o);
  const names = orderNames(set.items, 'w', set.maxW, rankBypass);
  // Обходных узлов в подписке нет — группа обязана остаться непустой, иначе
  // Stash не разберёт профиль. DIRECT здесь не «маршрутизация вместо обхода»,
  // а единственный член, который заведомо существует.
  const bypass = names.length
    ? childGroup(G_BYPASS, names, o.membership, o.provider || PROVIDER)
    : { name: G_BYPASS, type: 'fallback', proxies: ['DIRECT'] };
  return [
    // FINAL: прочий иностранный. Норма — DIRECT, под whitelist Диана
    // переключает на RH-АВТО руками (в Loon то же самое, тип select).
    { name: G_MAIN, type: 'select', proxies: ['DIRECT', 'RH-АВТО'] },
    // РФ-сервисы и GEOIP-RU: норма DIRECT, whitelist -> обход.
    { name: G_RU, type: 'fallback', proxies: ['DIRECT', G_BYPASS] },
    bypass,
  ];
}

// Секция proxy-groups целиком: служебные группы, затем три функции.
function profileGroups(masterLines, state, opts) {
  return serviceGroups(masterLines, state, opts).concat(buildGroups(masterLines, state, opts));
}

// ── СБОРКА ПРОФИЛЯ ──────────────────────────────────────────────────────
// ctx: { key, base, masterLines, state, membership, provider, label }
// base — origin с встроенным токеном, из него строится адрес поставщика.

function renderProfile(ctx) {
  const o = ctx || {};
  const provider = o.provider || PROVIDER;
  const lines = o.masterLines || [];
  const state = o.state || {};
  const prov = {};
  prov[provider] = {
    url: String(o.base || '') + '/nodes?key=' + String(o.key || ''),
    path: PROVIDER_PATH,
    interval: PROVIDER_INTERVAL,
  };
  const groups = profileGroups(lines, state, o);
  const out = [
    '# RouteHub — профиль Stash, ' + VERSION,
    '# Собран Worker\'ом для ключа ' + String(o.key || '') + '. Правки в этом файле',
    '# не переживут следующую перевыдачу: менять надо src/clients/stash-*.js.',
    '',
    yBlock({ mode: 'rule', 'log-level': 'info' }, 0),
    '',
    yBlock({ dns: { 'default-nameserver': DNS_BOOT, nameserver: DNS_MAIN } }, 0),
    '',
    yBlock({ 'proxy-providers': prov }, 0),
    '',
    yBlock({ 'rule-providers': buildProviders(o.base, o.key) }, 0),
    '',
    'proxy-groups:',
    groups.map(function (g) { return nodeToYaml(g, 2); }).join('\n'),
    '',
    yBlock({ rules: buildRules(buildSetRules()) }, 0),
    '',
  ];
  return out.join('\n');
}

// ── ИНТЕРФЕЙС КЛИЕНТСКОГО СЛОЯ /config ──────────────────────────────────
// Тот же набор имён, что у clients/loon.js: реестр и src/api/config.js
// обращаются к слою одинаково, не зная, какой клиент активен.

// Шаблона нет — параметрам подписки Loon взяться неоткуда.
function subParamsFromConf() { return ''; }

// Ядро считает тиеры; Stash-группам они нужны в исходном виде, а не текстом.
function aiBlocks(tiers) { return tiers; }

function renderConfig(conf, ctx) { return renderProfile(ctx); }

const usesTemplate = false;
const contentType = 'text/yaml; charset=utf-8';

export {
  DNS_BOOT, DNS_MAIN, G_BYPASS, G_MAIN, G_RU, PROVIDER_INTERVAL, PROVIDER_PATH,
  TEST_TIMEOUT, TEST_URL, VERSION, aiBlocks, contentType, profileGroups,
  rankBypass, renderConfig, renderProfile, serviceGroups, subParamsFromConf, usesTemplate,
};
