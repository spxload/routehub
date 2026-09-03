// routehub — модуль clients/stash.js
// КЛИЕНТСКИЙ СЛОЙ STASH, верхний ярус: ГРУППЫ ПОЛИТИК (секция `proxy-groups:`).
// Разбор ссылок подписки — clients/stash-nodes.js, сериализация YAML —
// clients/stash-yaml.js, порядок узлов и метка — clients/stash-order.js.
// Здесь раскладка по группам, форма членства и ОБЩИЙ СРЕЗ УЗЛОВ — он же
// выдача `proxies:` для поставщика прокси (см. nodeSet ниже). Каркас профиля
// (режим, DNS, поставщик, правила) — clients/stash-profile.js.
//
// СХЕМА (ADR-02_ГРУППЫ_STASH.md, вариант В). На каждую функцию — три группы:
//   RH-X-W  fallback, узлы в порядке композитного балла Wi-Fi
//   RH-X-C  fallback, ТЕ ЖЕ узлы в порядке балла сотовой
//   RH-X    select, дети [RH-X-W, RH-X-C] + ssid-policy {cellular, default}
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
import { parseNodeLink } from './stash-nodes.js';
import { aiRanker, collect, orderNames, rankAuto, rankCall } from './stash-order.js';
import { nodeToYaml, nodesToYaml } from './stash-yaml.js';

// Имя поставщика прокси по умолчанию — на него ссылается форма членства (Б).
const PROVIDER = 'RH-Lastdep';

// Тип содержимого выдачи /nodes для Stash: файл поставщика — это YAML.
const contentType = 'text/yaml; charset=utf-8';

// ── ЧЛЕНСТВО ГРУППЫ: ПЕРЕКЛЮЧАТЕЛЬ ─────────────────────────────────
// Интерфейс Stash подтвердил, что явный список имён и поставщик прокси
// сосуществуют в одной группе (СВЕРКА_STASH_ИНТЕРФЕЙС.md, раздел 4), поэтому
// выбор формы — переключатель, а не догадка:
//   (A) 'proxies'  — явные имена. По умолчанию: порядок задаём мы.
//   (B) 'provider' — use: [поставщик] + filter по точным именам. Состав тот
//       же, но ПОРЯДОК в этой форме, судя по документации Clash, задаёт
//       поставщик, а не мы. Это открытый вопрос стенда (раздел 11, пункт 1
//       сверки): пока он не закрыт, форма (Б) — запасная.

function reEsc(s) { return String(s).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'); }

// Фильтр по точным именам. Пустой список не должен превратиться в «все узлы
// поставщика», поэтому для него берётся заведомо непустой регексп, не
// совпадающий ни с чем. Класс «ни пробельный, ни непробельный» выбран потому,
// что его понимают и JavaScript, и RE2 (движок Go, на котором стоит ядро
// Clash-совместимых клиентов); отрицательный просмотр вперёд RE2 не умеет.
const NEVER = '[^\\s\\S]';

function nameFilter(names) {
  if (!names || !names.length) return NEVER;
  return '^(?:' + names.map(reEsc).join('|') + ')$';
}

// ── ЗАМЕР ЗАДЕРЖКИ ЯДРОМ ─────────────────────────────────────────────
// Stash меряет задержку сам (метод по умолчанию — HTTP HEAD) и делит
// результат между всеми группами, где узел состоит
// (stash.wiki/en/proxy-protocols/proxy-benchmark). Ключи ставятся НА УЗЕЛ,
// не на группу и не на поставщика: у поставщика их нет, и попытка задать
// их там была ошибкой S-draft-1, снятой в S-draft-2.
//
// Адрес — тот же, что у групп боевого Loon и у спидтеста (v1.9.8): проект
// уже отбраковал cp.cloudflare.com как ненадёжный. Один адрес на все замеры
// делает задержку ядра Stash и наш rtt сопоставимыми — это и проверяет ST9.
const BENCH_URL = 'http://connectivitycheck.gstatic.com/generate_204';
const BENCH_TIMEOUT = 3;

// ── ОДИН СРЕЗ УЗЛОВ НА ГРУППЫ И НА ВЫДАЧУ ──────────────────────────────
// ДОПУЩЕНИЕ, РАДИ КОТОРОГО ЭТО СДЕЛАНО ОДНОЙ ФУНКЦИЕЙ: имя узла в секции
// `proxies:` обязано совпадать с именем члена группы. Stash сопоставляет их
// строкой и НЕ сообщает об ошибке — член без описания просто исчезает, группа
// приезжает короче, чем задумано, и понять это по конфигу нельзя.
// Поэтому и состав, и имена берутся ИЗ ОДНОГО МЕСТА: collect() задаёт имена и
// порядок, parseNodeLink — описание. Строка, которую разбор не понял (чужая
// схема, транспорт не из {tcp, ws}), выбрасывается СРАЗУ, до раскладки по
// группам: узел, которого нельзя описать, не имеет права быть членом.
// Равенство двух множеств имён проверяется тестом, а не глазами.
function nodeSet(masterLines, state, opts) {
  const o = opts || {};
  const col = collect(masterLines, state, o.label);
  const items = [], nodes = [];
  let skipped = 0;
  col.items.forEach(function (it) {
    const node = parseNodeLink(it.line);
    if (!node) { skipped++; return; }
    node.name = it.display;             // единственный источник имени
    // ПРАВИЛО 1 ПРОЕКТА, ИСПОЛНЕННОЕ РОДНЫМ СРЕДСТВОМ. Обходные узлы стоят
    // в каждой рабочей группе (17 из 70), а группа с умолчанием interval
    // 600 с гоняет замер по всем членам.
    //
    // ⛔ S-draft-5 (03.09): `benchmark-disabled` С ОБХОДНЫХ УЗЛОВ СНЯТ.
    // Замер на устройстве: обходные узлы НЕ РАБОТАЛИ ВОВСЕ — ни задержки
    // при ручном тесте (даже не таймаут, а пусто), ни интернета, причём
    // при ручном выборе узла в ГЛОБАЛЬНОМ режиме и БЕЗ whitelist. То есть
    // ни `fallback`, ни правила, ни сеть тут ни при чём. Конвертер тоже
    // оправдан: обходной tcp-узел выходит структурно ИДЕНТИЧНЫМ рабочему
    // обычному (различаются только sni и fp), а 52 обычных узла при этом
    // меряются и качают. Единственное, чем профиль отличал обходной узел
    // от рабочего, — эта строка. Ключ документирован только для
    // `relay`-групп, а был применён на узле: ровно тот случай, про который
    // у проекта есть правило «недокументированные параметры не в боевой
    // контур без проверки».
    //
    // ПРАВИЛО 1 ТЕПЕРЬ ИСПОЛНЯЕТСЯ ИНТЕРВАЛОМ, А НЕ ОТКЛЮЧЕНИЕМ ЗАМЕРА.
    // Прежняя тревога («2 400 запросов в сутки через обход») считала
    // ЗАПРОСЫ, а не БАЙТЫ. Замер ядра — HTTP HEAD на generate_204, порядка
    // килобайта: при `interval` 3600 с (см. childGroup) это около 0,4 МБ
    // в сутки на все 16 обходных узлов вместе. Для сравнения, наш активный
    // замер скорости тратит около 200 МБ в сутки на обычных узлах. Обход
    // был выключен ради экономии, которой там нет, ценой неработающего
    // обхода — то есть ценой всего whitelist-сценария.
    node['benchmark-url'] = BENCH_URL;
    node['benchmark-timeout'] = BENCH_TIMEOUT;
    items.push(it);
    nodes.push(node);
  });
  return { items: items, nodes: nodes, maxW: col.maxW, maxC: col.maxC, skipped: skipped };
}

// Готовый файл поставщика прокси: секция `proxies:` и ничего больше.
// Именно это отдаёт /nodes контуру Stash (src/api/nodes.js). Base64, как у
// Loon, поставщик не принимает — только Clash-YAML с ключом `proxies:`.
function renderNodes(masterLines, state, opts) {
  return nodesToYaml(nodeSet(masterLines, state, opts).nodes);
}

// Период замера у рабочих групп. Умолчание Stash — 600 с; S-draft-5 поднял
// до часа, потому что замер снова идёт и по обходным узлам (см. nodeSet).
// Час выбран так, чтобы платный трафик остался пренебрежимым (порядка 0,4 МБ
// в сутки на все обходные узлы), а живость узлов всё же обновлялась: у
// `fallback` есть и вторая, событийная проверка — при отказе текущего члена.
const GROUP_INTERVAL = 3600;

function childGroup(name, names, membership, provider) {
  const g = { name: name, type: 'fallback', interval: GROUP_INTERVAL };
  if (membership === 'provider') { g.use = [provider]; g.filter = nameFilter(names); }
  else g.proxies = names;
  return g;
}

// ── СБОРКА ───────────────────────────────────────────────────────────
// opts: { membership: 'proxies' | 'provider', provider: <имя>, label: bool }
// Возвращает массив объектов групп в порядке: родитель, -W, -C — по каждой
// функции. Так же они идут в routehub.conf, и так же читаются глазами.

function buildGroups(masterLines, state, opts) {
  const o = opts || {};
  const membership = o.membership === 'provider' ? 'provider' : 'proxies';
  const provider = o.provider || PROVIDER;
  const col = nodeSet(masterLines, state, o);
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
    out.push(childGroup(w, orderNames(col.items, 'w', col.maxW, sp.rank), membership, provider));
    out.push(childGroup(c, orderNames(col.items, 'c', col.maxC, sp.rank), membership, provider));
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

export { BENCH_TIMEOUT, BENCH_URL, GROUP_INTERVAL, PROVIDER, buildGroups, childGroup, contentType, nameFilter, nodeSet, renderGroups, renderNodes };
export { nodeLabel } from './stash-order.js';
