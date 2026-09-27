// routehub — модуль clients/stash-service.js
// КЛИЕНТСКИЙ СЛОЙ STASH: СЛУЖЕБНЫЕ ГРУППЫ (RH-Главный, RH-RU, RH-Обход) и
// секция proxy-groups профиля целиком. Выделен из clients/stash-profile.js по
// правилу проекта «модуль < 15 КБ»; логика не менялась. Группы функций —
// clients/stash.js, профиль — clients/stash-profile.js.
// История версий — CHANGELOG.md в корне репозитория.

import { buildGroups } from './stash.js';
import { GROUP_INTERVAL, PROVIDER, childGroup } from './stash-members.js';
import { nodeSet } from './stash-nodeset.js';
import { orderNames } from './stash-order.js';

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
  // работал вовсе (см. комментарий в clients/stash-nodeset.js). Пока причина не
  // подтверждена окончательно, оба недокументированных-для-нашего-случая
  // ключа снимаются разом: разбирать, какой из двух виноват, имеет смысл
  // только после того, как обход заработает хоть в каком-то виде.
  // Правило 1 исполняется интервалом замера (GROUP_INTERVAL, 600 с).
  return [
    // FINAL: прочий иностранный. Норма — DIRECT, под whitelist — RH-АВТО.
    // S-draft-7: `select` -> `fallback`. Прежде переключение было РУЧНЫМ, и
    // это был источник ручной работы номер один: whitelist включается и
    // выключается без предупреждения, а группа до вмешательства оставалась
    // на мёртвом DIRECT. Решение проекта — автоматика, даже ценой окна
    // ожидания (окно сокращено в clients/stash-members.js: GROUP_INTERVAL 3600 -> 600).
    // ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ LOON: там RH-Главный остаётся `select`, потому
    // что у Loon переключение делает netwatch по смене сети. У Stash своего
    // netwatch нет, а писать в маршрутизацию из скрипта запрещает правило 2
    // проекта — значит штатная автоматика единственная доступная.
    { name: G_MAIN, type: 'fallback', proxies: ['DIRECT', 'RH-АВТО'], interval: GROUP_INTERVAL },
    // РФ-сервисы и GEOIP-RU: норма DIRECT, whitelist -> обход.
    { name: G_RU, type: 'fallback', proxies: ['DIRECT', G_BYPASS], interval: GROUP_INTERVAL },
    bypass,
  ];
}

// Секция proxy-groups целиком: служебные группы, затем три функции.
function profileGroups(masterLines, state, opts) {
  return serviceGroups(masterLines, state, opts).concat(buildGroups(masterLines, state, opts));
}

export { G_BYPASS, G_MAIN, G_RU, profileGroups, rankBypass, serviceGroups };
