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
//  1. ⛔ ДОПУЩЕНИЕ ОПРОВЕРГНУТО НА УСТРОЙСТВЕ 31.08. Стояло: «группа
//     ссылается на узлы поставщика ПО ИМЕНИ (форма членства А)». Stash
//     отверг профиль целиком: «proxy group[0]: '<имя узла>' not found».
//     Поставщик при этом РАБОТАЕТ — карточка подписки в приложении собрана
//     из заголовка subscription-userinfo нашей выдачи /nodes. То есть Stash
//     просто не ищет членов группы среди узлов поставщика: к ним ведёт
//     только `use:` + `filter`.
//     Форму Б не включили, потому что она теряет ПОРЯДОК: фильтр — это
//     регулярное выражение, порядок членов из него не следует, и -W с -C
//     стали бы одинаковыми, а ради их различия схема и затевалась (ADR-02).
//     S-draft-4: узлы описываются В ПРОФИЛЕ, поставщик из профиля убран.
//     ПОБОЧНОЕ СЛЕДСТВИЕ, которое стоило увидеть раньше: поставщик и не мог
//     освежать ПОРЯДОК — порядок живёт в `proxy-groups`, то есть в профиле,
//     и обновляется только вместе с ним. Поставщик освежал лишь ОПИСАНИЯ
//     узлов, значит отказом от него потерян только состав, но не порядок.
//     Код формы Б оставлен: opts.membership = 'provider' возвращает
//     поставщика в профиль. Пригодится, если найдётся способ задать порядок.
//  2. Тест поставщика НЕ ПЕРЕОПРЕДЕЛЯЕТСЯ: ключи benchmark-* сняты, см.
//     комментарий у TEST_URL ниже.
//  3. «Слабый DIRECT»: RH-RU — fallback с DIRECT первым, обход вторым.
//     В Loon проверено, что fallback пробивает DIRECT и уходит дальше при
//     whitelist. Для Stash это НЕ проверено.
//  4. Группам не задан ни url теста, ни interval: по документации они не
//     обязательны, значение по умолчанию 600 с. ЗАМЕР ЖИВЁТ НА УЗЛЕ
//     (`benchmark-url`/`benchmark-timeout` в clients/stash.js), а не на
//     группе: результат узла ядро делит между всеми группами, где узел
//     состоит, поэтому дублировать настройку по группам незачем.
//  5. `lazy: true` у RH-Обход: пока группа не используется, ядро не гоняет
//     по ней замер. Обходные узлы вдобавок помечены `benchmark-disabled`,
//     так что это второй рубеж, а не единственный.
// История версий — CHANGELOG.md в корне репозитория.

import { BENCH_TIMEOUT, BENCH_URL, GROUP_INTERVAL, PROVIDER, buildGroups, childGroup, nodeSet } from './stash.js';
import { orderNames } from './stash-order.js';
import { buildRules } from './stash-rules.js';
import { buildProviders, buildSetRules } from './stash-sets.js';
import { nodeToYaml, nodesToYaml, yBlock } from './stash-yaml.js';

// Версия профиля. Аналог C-draft-NN у Loon: её видно в админ-панели
// (поле conf_ver) и в первой строке самого профиля.
const VERSION = 'S-draft-5';

// Поставщик прокси. interval — как часто Stash перечитывает файл узлов;
// 600 с выбрано потому, что ПОРЯДОК членов групп меняется перевыдачей
// конфига, а состав — перевыдачей файла поставщика (ADR-02, трейд-офф).
const PROVIDER_PATH = './providers/rh-lastdep.yaml';
const PROVIDER_INTERVAL = 600;
// Адрес и тайм-аут проверки. S-draft-3: ТЕПЕРЬ ПОПАДАЮТ В ПРОФИЛЬ — но на
// УЗЕЛ, а не на поставщика. У поставщика прокси документация Stash знает
// только url, path, interval, filter, headers, и попытка задать там
// benchmark-* была ошибкой S-draft-1. На уровне узла ключи `benchmark-url` и
// `benchmark-timeout` документированы прямо
// (stash.wiki/en/proxy-protocols/proxy-benchmark), их и ставит nodeSet.
// Значения живут в clients/stash.js рядом с местом применения; здесь
// переэкспортируются под прежними именами, чтобы не ломать тесты и ссылки.
const TEST_URL = BENCH_URL;
const TEST_TIMEOUT = BENCH_TIMEOUT;

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
    : { name: G_BYPASS, type: 'fallback', proxies: ['DIRECT'], interval: GROUP_INTERVAL };
  // ⛔ S-draft-5 (03.09): `lazy` СНЯТ вместе с `benchmark-disabled` у узлов.
  // Он вводился вторым рубежом под то же правило 1, а обход в итоге не
  // работал вовсе (см. комментарий в clients/stash.js). Пока причина не
  // подтверждена окончательно, оба недокументированных-для-нашего-случая
  // ключа снимаются разом: разбирать, какой из двух виноват, имеет смысл
  // только после того, как обход заработает хоть в каком-то виде.
  // Правило 1 исполняется интервалом замера (GROUP_INTERVAL, час).
  return [
    // FINAL: прочий иностранный. Норма — DIRECT, под whitelist Диана
    // переключает на RH-АВТО руками (в Loon то же самое, тип select).
    { name: G_MAIN, type: 'select', proxies: ['DIRECT', 'RH-АВТО'] },
    // РФ-сервисы и GEOIP-RU: норма DIRECT, whitelist -> обход.
    { name: G_RU, type: 'fallback', proxies: ['DIRECT', G_BYPASS], interval: GROUP_INTERVAL },
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
  // Узлы В ПРОФИЛЕ (см. пункт 1 шапки). Берутся тем же nodeSet, что и выдача
  // /nodes, — значит имена в `proxies:` и имена членов групп заведомо одни и
  // те же, и тихий отказ по расхождению имён невозможен по построению.
  const set = nodeSet(lines, state, o);
  const groups = profileGroups(lines, state, o);
  const useProvider = (o.membership === 'provider');
  const prov = {};
  prov[provider] = {
    url: String(o.base || '') + '/nodes?key=' + String(o.key || ''),
    path: PROVIDER_PATH,
    interval: PROVIDER_INTERVAL,
  };
  const out = [
    '# RouteHub — профиль Stash, ' + VERSION,
    '# Собран Worker\'ом для ключа ' + String(o.key || '') + '. Правки в этом файле',
    '# не переживут следующую перевыдачу: менять надо src/clients/stash-*.js.',
    '',
    yBlock({ mode: 'rule', 'log-level': 'info' }, 0),
    '',
    yBlock({ dns: { 'default-nameserver': DNS_BOOT, nameserver: DNS_MAIN } }, 0),
    '',
    useProvider ? yBlock({ 'proxy-providers': prov }, 0) : nodesToYaml(set.nodes).replace(/\n$/, ''),
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
