// routehub — модуль clients/stash-profile.js
// КЛИЕНТСКИЙ СЛОЙ STASH, КАРКАС ПРОФИЛЯ: режим ядра, DNS, поставщик прокси,
// служебные группы и сборка целого YAML. Группы функций (RH-AI, RH-АВТО,
// RH-Звонки) собирает clients/stash.js, правила — clients/stash-rules.js.
// Секция `dns:` — clients/stash-dns.js, служебные группы —
// clients/stash-service.js (выделены отсюда по правилу «модуль < 15 КБ»,
// экспорты реэкспортируются ниже).
// Этот модуль — то, что реестр клиентов отдаёт как слой /config.
//
// ШАБЛОНА У STASH НЕТ. Loon получает routehub.conf из репозитория и Worker
// подставляет в него блоки; профиль Stash собирается кодом целиком. Причина
// не в лени: половина профиля (узлы, порядок, тиеры) считается на сервере, а
// вторая половина — константы, которым в отдельном файле делать нечего, пока
// их некому редактировать. Поэтому usesTemplate = false, и src/api/config.js
// для Stash не берёт шаблон routehub.conf из сборки (src/files.js) — профиль
// собирается кодом целиком.
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
//  4. Группам не задан url теста: ЗАМЕР ЖИВЁТ НА УЗЛЕ (`benchmark-url` и
//     `benchmark-timeout` в clients/stash-nodeset.js). Дублировать его по группам
//     незачем — документация Stash говорит прямо: «If a proxy is referenced
//     by multiple policy groups, the delay testing results for this proxy
//     will be shared among the policy groups». Это же снимает вопрос о
//     многократном счёте: обходной узел состоит в семи группах, но меряется
//     один раз. `interval` группам задан (GROUP_INTERVAL), вопреки прежней
//     записи здесь — она была неверна с S-draft-5.
//  5. ⛔ ЗАПИСЬ ОТМЕНЕНА S-draft-5. Стояло: «`lazy: true` у RH-Обход плюс
//     `benchmark-disabled` у обходных узлов». Оба ключа сняты — обход на
//     устройстве не работал вовсе (вывод 22). Правило 1 держит интервал.
//  6. S-draft-7, НОВОЕ ДОПУЩЕНИЕ И НОВЫЙ РИСК. RH-Главный переведена в
//     `fallback`, то есть FINAL теперь переключается сам. Документация
//     разрешает группу внутри группы («If the strategy group contains
//     another strategy group, the test will be performed recursively»), но
//     НЕ описывает, как ядро считает здоровье члена-ГРУППЫ и чем оно
//     проверяет DIRECT: узлом DIRECT не является, `benchmark-*` у него
//     нет, url группам не задан. ЦЕНА ОШИБКИ СИММЕТРИЧНА прежней: раньше
//     худшим исходом было «сидим на мёртвом DIRECT, пока не переключат
//     руками», теперь появился «DIRECT ошибочно сочли мёртвым, и ВЕСЬ
//     прочий иностранный трафик молча ушёл на узлы, включая обходные».
//     Поэтому правка живёт на стенде Stash и в боевой Loon не переносится.
//  7. S-draft-9: наблюдательная RH-Часы (clients/stash-watch.js) правилами
//     не используется; `lazy: false` — проверяет стенд (проба ST21). Узел
//     `type: direct` с benchmark-* — только в override Lab, не здесь.
// История версий — CHANGELOG.md в корне репозитория.

import { PROVIDER } from './stash-members.js';
import { BENCH_TIMEOUT, BENCH_URL, nodeSet } from './stash-nodeset.js';
import { DNS_BOOT, DNS_BYPASS_NS, DNS_FAKE_IP_FILTER, DNS_MAIN, DNS_NS_POLICY, bypassNsPolicy } from './stash-dns.js';
import { G_BYPASS, G_MAIN, G_RU, profileGroups, rankBypass, serviceGroups } from './stash-service.js';
import { buildRules } from './stash-rules.js';
import { buildProviders, buildSetRules } from './stash-sets.js';
import { watchGroups } from './stash-watch.js';
import { nodeToYaml, nodesToYaml, yBlock } from './stash-yaml.js';

// Версия профиля. Аналог C-draft-NN у Loon: её видно в админ-панели
// (поле conf_ver) и в первой строке профиля.
const VERSION = 'S-draft-11';

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
// Значения живут в clients/stash-nodeset.js рядом с местом применения; здесь
// переэкспортируются под прежними именами, чтобы не ломать тесты и ссылки.
const TEST_URL = BENCH_URL;
const TEST_TIMEOUT = BENCH_TIMEOUT;

// ── СБОРКА ПРОФИЛЯ ──────────────────────────────────────────────────────
// ctx: { key, base, masterLines, state, membership, provider, label }
// base — origin с встроенным токеном, из него строится адрес поставщика.

// S-draft-11: строки `#SUBSCRIBED <адрес>` (S-draft-10) в выдаче НЕТ. Worker
// отдавал одну, а в файле на устройстве их оказалось две: вторую Stash
// дописывает сам, сохраняя профиль, скачанный по ссылке, — он и так считает
// его подписанным, наша строка лишняя. Обновление профиля по сроку
// работает только на переднем плане (экран «Ресурсы»); в фоне — поставщики
// прокси и наборы правил (опыт ST22).
function renderProfile(ctx) {
  const o = ctx || {};
  const provider = o.provider || PROVIDER;
  const lines = o.masterLines || [];
  const state = o.state || {};
  // Узлы В ПРОФИЛЕ (см. пункт 1 шапки). Берутся тем же nodeSet, что и выдача
  // /nodes, — значит имена в `proxies:` и имена членов групп заведомо одни и
  // те же, и тихий отказ по расхождению имён невозможен по построению.
  const set = nodeSet(lines, state, o);
  // S-draft-9: «часы» (clients/stash-watch.js) — в КОНЕЦ секции: правила на
  // них не ссылаются, рабочие группы их не содержат, и в интерфейсе они не
  // заслоняют рабочие.
  const groups = profileGroups(lines, state, o).concat(watchGroups());
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
    yBlock({
      dns: {
        'default-nameserver': DNS_BOOT,
        nameserver: DNS_MAIN,
        // S-draft-9: к постоянным зонам — имена обходных серверов
        // (clients/stash-dns.js, bypassNsPolicy; ключ proxy-server-nameserver
        // НЕ задаётся — почему, там же).
        'nameserver-policy': Object.assign({}, DNS_NS_POLICY, bypassNsPolicy(set)),
        'fake-ip-filter': DNS_FAKE_IP_FILTER,
      },
    }, 0),
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
  DNS_BOOT, DNS_BYPASS_NS, DNS_FAKE_IP_FILTER, DNS_MAIN, DNS_NS_POLICY, G_BYPASS, G_MAIN, G_RU,
  PROVIDER_INTERVAL, PROVIDER_PATH,
  TEST_TIMEOUT, TEST_URL, VERSION, aiBlocks, bypassNsPolicy, contentType, profileGroups,
  rankBypass, renderConfig, renderProfile, serviceGroups, subParamsFromConf, usesTemplate,
};
