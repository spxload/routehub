// routehub — модуль clients/stash.js
// КЛИЕНТСКИЙ СЛОЙ STASH, верхний ярус: ГРУППЫ ПОЛИТИК (секция `proxy-groups:`).
// Разбор ссылок подписки — clients/stash-nodes.js, сериализация YAML —
// clients/stash-yaml.js, порядок узлов и метка — clients/stash-order.js.
// Здесь раскладка по группам. Форма членства и дочерний fallback —
// clients/stash-members.js; ОБЩИЙ СРЕЗ УЗЛОВ — он же выдача `proxies:` для
// поставщика прокси (nodeSet) — и замер задержки ядром —
// clients/stash-nodeset.js (оба выделены отсюда по правилу «модуль < 15 КБ»,
// экспорты реэкспортируются ниже). Каркас профиля (режим, DNS, поставщик,
// правила) — clients/stash-profile.js.
//
// СХЕМА (ADR-02_ГРУППЫ_STASH.md, вариант В + обёртка S-draft-8). На каждую
// функцию — пять групп:
//   RH-X          select, дети [RH-X-W, RH-X-C] + ssid-policy {cellular, default}
//   RH-X-W-Ручной select, рабочие узлы в порядке балла Wi-Fi, БЕЗ обхода
//   RH-X-W        fallback: [RH-X-W-Ручной, узлы в порядке балла Wi-Fi, обход]
//   RH-X-C-Ручной select, то же по баллу сотовой
//   RH-X-C        fallback: [RH-X-C-Ручной, ТЕ ЖЕ узлы по баллу сотовой, обход]
// Ручная группа, её состав и граничные случаи — clients/stash-manual.js.
// Узел описан ровно один раз; два набора имён, как в Loon, больше не нужны.
// Переключение по сети делает сам Stash через ssid-policy, поэтому
// scripts/routehub-netwatch.js в контур Stash НЕ переносится и в выдаче
// этого модуля не появляется.
//
// ИМЕНА ГРУПП взяты из routehub.conf ([Proxy Group], C-draft-41), а не
// придуманы: RH-AI, RH-АВТО, RH-Звонки — те же три функции с парой -W/-C.
// Служебные группы Loon (RH-Все, RH-Обход, RH-RU, RH-Главный, RH-Проба-VPN)
// живут в каркасе профиля вместе с правилами и сюда не относятся.
//
// ЗДОРОВЬЕ УЗЛОВ: url теста и интервал в группы не пишем — по интерфейсу они
// задаются на уровне поставщика прокси, один раз на подписку
// (СВЕРКА_STASH_ИНТЕРФЕЙС.md, раздел 5).
// История версий — CHANGELOG.md в корне репозитория.

import { buildAiTiers } from '../ai.js';
import { netPair, workingOnly } from './stash-manual.js';
import { GROUP_INTERVAL, PROVIDER, childGroup, nameFilter, withMembers } from './stash-members.js';
import { BENCH_TIMEOUT, BENCH_TIMEOUT_BYPASS, BENCH_URL, nodeSet, renderNodes } from './stash-nodeset.js';
import { aiRanker, orderNames, rankAuto, rankCall } from './stash-order.js';
import { nodeToYaml } from './stash-yaml.js';

// Тип содержимого выдачи /nodes для Stash: файл поставщика — это YAML.
const contentType = 'text/yaml; charset=utf-8';

// ── СБОРКА ───────────────────────────────────────────────────────────
// opts: { membership: 'proxies' | 'provider', provider: <имя>, label: bool }
// Возвращает массив объектов групп в порядке: родитель, -W-Ручной, -W,
// -C-Ручной, -C — по каждой функции. Родитель, -W, -C идут так же, как в
// routehub.conf; ручная группа — перед своим fallback, как в пробе ST19.

function buildGroups(masterLines, state, opts) {
  const o = opts || {};
  const membership = o.membership === 'provider' ? 'provider' : 'proxies';
  const provider = o.provider || PROVIDER;
  const col = nodeSet(masterLines, state, o);
  // Форма членства замкнута здесь: clients/stash-manual.js получает её
  // функциями, а не импортом (обратный импорт дал бы цикл модулей).
  const fill = function (g, names) { return withMembers(g, names, membership, provider); };
  const child = function (name, names, head) { return childGroup(name, names, membership, provider, head); };
  const specs = [
    { name: 'RH-AI', rank: aiRanker(buildAiTiers(masterLines || [], state || {})) },
    { name: 'RH-АВТО', rank: rankAuto },
    { name: 'RH-Звонки', rank: rankCall },
  ];
  const out = [];
  specs.forEach(function (sp) {
    const w = sp.name + '-W', c = sp.name + '-C';
    out.push({
      name: sp.name,
      type: 'select',
      proxies: [w, c],
      'ssid-policy': { cellular: c, default: w },
    });
    const work = workingOnly(sp.rank);
    [['w', w, col.maxW], ['c', c, col.maxC]].forEach(function (x) {
      netPair(x[1], orderNames(col.items, x[0], x[2], sp.rank),
        orderNames(col.items, x[0], x[2], work), fill, child)
        .forEach(function (g) { out.push(g); });
    });
  });
  return out;
}

// Готовый блок `proxy-groups:` для профиля. Пустой список групп даёт «[]»:
// ключ без значения Stash прочитает как null и откажет в разборе — то же
// соглашение, что у `proxies:` в clients/stash-yaml.js.
// ГРАНИЧНЫЙ СЛУЧАЙ, который здесь НЕ лечится: если узлов нет вовсе, у детей
// пустой список членов, а yBlock пустой массив не выводит — группа приедет
// без ключа `proxies`. Боевого пути к этому нет (getSub падает, не найдя
// узлов в подписке), и подменять пустую группу на DIRECT значило бы менять
// маршрутизацию из сериализатора. Вызывающий обязан не рендерить профиль,
// не имея узлов.
function renderGroups(masterLines, state, opts) {
  const groups = buildGroups(masterLines, state, opts);
  if (!groups.length) return 'proxy-groups: []\n';
  return 'proxy-groups:\n' + groups.map(function (g) { return nodeToYaml(g, 2); }).join('\n') + '\n';
}

// Прежний набор экспортов сохранён: реестр клиентов и routehub-worker.js
// берут модуль целиком (import * as STASH), тесты — через T.STASH.
export { BENCH_TIMEOUT, BENCH_TIMEOUT_BYPASS, BENCH_URL, GROUP_INTERVAL, PROVIDER, buildGroups, childGroup, contentType, nameFilter, nodeSet, renderGroups, renderNodes };
export { nodeLabel } from './stash-order.js';
export { MANUAL_SUFFIX, manualName } from './stash-manual.js';
