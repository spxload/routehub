// routehub — модуль clients/stash.js
// КЛИЕНТСКИЙ СЛОЙ STASH, верхний ярус: ГРУППЫ ПОЛИТИК (секция `proxy-groups:`).
// Разбор ссылок подписки — clients/stash-nodes.js, сериализация YAML —
// clients/stash-yaml.js, порядок узлов и метка — clients/stash-order.js.
// Здесь раскладка по группам, форма членства и ОБЩИЙ СРЕЗ УЗЛОВ — он же
// выдача `proxies:` для поставщика прокси (см. nodeSet ниже). Каркас профиля
// (режим, DNS, поставщик, правила) — clients/stash-profile.js.
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
import { parseNodeLink } from './stash-nodes.js';
import { netPair, workingOnly } from './stash-manual.js';
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
// S-draft-7: 3 -> 5 с. Пять секунд — ЗНАЧЕНИЕ ИЗ ПРИМЕРА документации
// (stash.wiki/en/proxy-protocols/proxy-benchmark: `benchmark-timeout: 5 #
// Delay test timeout, in seconds`). Умолчания этого ключа документация НЕ
// называет — не выдавать пример за умолчание. Довод ниже самодостаточен.
// ПРИЧИНА. Три секунды мы поставили сами, ниже умолчания, и это тот самый
// дефект, который проект ловил ТРИЖДЫ под именем ST14: собственный короткий
// тайм-аут выдаёт живой узел за мёртвый. У Stash единственный документированный
// способ пометить узел нездоровым — таймаут замера («Proxies that time out
// during delay testing will be marked as unhealthy»), других нет. Значит цена
// заниженного порога — ложные переключения, то есть ровно жалоба «работает не
// так, как в правилах». ADR-04 §3 держал это открытым пунктом: Польша упиралась
// в 3034–3040 мс, то есть промахивалась мимо порога на тридцать миллисекунд.
const BENCH_TIMEOUT = 5;
// ОТДЕЛЬНЫЙ ТАЙМ-АУТ ДЛЯ ОБХОДА — по замеру ST14 (04.09).
// Обходные узлы кратно медленнее рабочих, и трёх секунд им мало не «в
// теории», а по числам: рабочий узел ответил за 70 мс, живой обходной — за
// 729 мс (по стенке 1128 мс), то есть в десять раз дольше; полевой замер
// 11.08 давал обходу 388–505 мс против 89–99 у обычных узлов. Отсюда и
// жалоба «делаешь ещё раз — таймаут у других узлов»: замер ходит около
// порога, и попадание в него случайно.
// Десять секунд выбраны как заведомый запас над наблюдённым максимумом, а не
// как круглое число: при 729 мс медианы даже пятикратный выброс укладывается.
// Цена нулевая — тайм-аут тратится только на узлах, которые и так молчат.
const BENCH_TIMEOUT_BYPASS = 10;

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
    // килобайта: при `interval` 600 с (GROUP_INTERVAL, S-draft-7) это
    // 16 × 86400/600 = 2304 замера в сутки, около 2,3 МБ на все 16 обходных
    // узлов вместе. ОГОВОРКА: «порядка килобайта» — оценка, а не измерение;
    // каждый замер поднимает новое соединение, и с рукопожатием REALITY
    // реальная цифра может быть в несколько раз выше. Даже при пятикратном
    // промахе это около 12 МБ против примерно 200 МБ в сутки, которые
    // тратит наш активный замер скорости на обычных узлах. Обход
    // был выключен ради экономии, которой там нет, ценой неработающего
    // обхода — то есть ценой всего whitelist-сценария.
    node['benchmark-url'] = BENCH_URL;
    node['benchmark-timeout'] = (it.tag === 'bypass') ? BENCH_TIMEOUT_BYPASS : BENCH_TIMEOUT;
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

// Период замера у рабочих групп.
//
// S-draft-7: 3600 -> 600, то есть ВОЗВРАТ К УМОЛЧАНИЮ Stash.
// ЧТО ОКАЗАЛОСЬ НЕВЕРНЫМ В ПРЕЖНЕМ ОБОСНОВАНИИ. Там стояло: «у `fallback`
// есть и вторая, событийная проверка — при отказе текущего члена». Это
// ДОПУЩЕНИЕ, а не факт: документация Stash описывает ровно один способ
// пометить члена нездоровым — таймаут периодического замера
// (stash.wiki/en/proxy-protocols/proxy-benchmark), а страница групп
// (stash.wiki/en/proxy-protocols/proxy-groups) про `fallback` говорит только
// «Unhealthy proxies will be skipped» и о событийной проверке молчит.
// СЛЕДСТВИЕ, которое и стало полевой жалобой 08.09: при часе окно, в течение
// которого мёртвый DIRECT ещё числится живым, доходит до ЧАСА. Приложение всё
// это время висит на нём до своего таймаута — «App Store грузил секунд
// тридцать, перезашёл — открылось».
// ЦЕНА. Замер ядра — HTTP HEAD на generate_204, порядка килобайта. При часе
// это было около 0,4 МБ в сутки на все 16 обходных узлов; при 600 с — около
// 2,3 МБ. Правило 1 не нарушается: наш активный замер скорости тратит около
// 200 МБ в сутки, то есть обходной замер остаётся на два порядка меньше.
// Ниже 600 с не опускаемся: 300 с дали бы окно 5 минут ценой вдвое большего
// расхода и постоянного пробуждения телефона, а окно всё равно осталось бы —
// его убирает не интервал, а тип группы (S-draft-7 перевёл RH-Главный
// в `fallback`, см. clients/stash-profile.js).
const GROUP_INTERVAL = 600;

// head — группы перед узлами (ручная, см. clients/stash-manual.js); в форме
// (Б) они идут явным `proxies:` рядом с use + filter.
function withMembers(g, names, membership, provider, head) {
  if (membership === 'provider') {
    if (head && head.length) g.proxies = head;
    g.use = [provider]; g.filter = nameFilter(names);
  } else g.proxies = (head || []).concat(names);
  return g;
}

function childGroup(name, names, membership, provider, head) {
  return withMembers({ name: name, type: 'fallback', interval: GROUP_INTERVAL }, names, membership, provider, head);
}

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

export { BENCH_TIMEOUT, BENCH_TIMEOUT_BYPASS, BENCH_URL, GROUP_INTERVAL, PROVIDER, buildGroups, childGroup, contentType, nameFilter, nodeSet, renderGroups, renderNodes };
export { nodeLabel } from './stash-order.js';
export { MANUAL_SUFFIX, manualName } from './stash-manual.js';
