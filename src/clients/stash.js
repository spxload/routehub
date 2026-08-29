// routehub — модуль clients/stash.js
// КЛИЕНТСКИЙ СЛОЙ STASH, верхний ярус: ГРУППЫ ПОЛИТИК (секция `proxy-groups:`).
// Разбор ссылок подписки — clients/stash-nodes.js, сериализация YAML —
// clients/stash-yaml.js, порядок узлов и метка — clients/stash-order.js.
// Здесь только раскладка по группам и форма членства. Каркас профиля
// (правила, DNS, поставщик прокси) и выдача узлов в модуль НЕ входят.
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
import { aiRanker, collect, orderNames, rankAuto, rankCall } from './stash-order.js';
import { nodeToYaml } from './stash-yaml.js';

// Имя поставщика прокси по умолчанию — на него ссылается форма членства (Б).
const PROVIDER = 'RH-Lastdep';

// ── ЧЛЕНСТВО ГРУППЫ: ПЕРЕКЛЮЧАТЕЛЬ ─────────────────────────────────────
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

function childGroup(name, names, membership, provider) {
  const g = { name: name, type: 'fallback' };
  if (membership === 'provider') { g.use = [provider]; g.filter = nameFilter(names); }
  else g.proxies = names;
  return g;
}

// ── СБОРКА ──────────────────────────────────────────────────────────────
// opts: { membership: 'proxies' | 'provider', provider: <имя>, label: bool }
// Возвращает массив объектов групп в порядке: родитель, -W, -C — по каждой
// функции. Так же они идут в routehub.conf, и так же читаются глазами.

function buildGroups(masterLines, state, opts) {
  const o = opts || {};
  const membership = o.membership === 'provider' ? 'provider' : 'proxies';
  const provider = o.provider || PROVIDER;
  const col = collect(masterLines, state, o.label);
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

export { PROVIDER, buildGroups, nameFilter, renderGroups };
export { nodeLabel } from './stash-order.js';
