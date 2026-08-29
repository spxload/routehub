// routehub — модуль clients/stash-order.js
// КЛИЕНТСКИЙ СЛОЙ STASH, порядок узлов: сбор узлов из строк подписки, метка
// с метриками и РАНГИ КАСКАДОВ, задающие порядок внутри группы.
// Выделен из clients/stash.js по правилу проекта «модуль до 10 КБ»: раскладка
// по группам и порядок внутри группы — две независимые задачи.
//
// Порядок повторяет каскад фильтров Loon (routehub.conf, [Proxy Group]):
// там фильтры отбирали узлы по региону и маркерам, а порядок внутри фильтра
// задавала выдача /nodes, отсортированная по композитному баллу. Здесь то же
// самое выражено одним плоским списком: сначала ранг каскада, внутри ранга —
// балл по убыванию.
//
// ЯДРО НЕ МЕНЯЕТСЯ (ADR-02): scoreOf, voiceOk, regionOf и разбор имён взяты
// как есть. История версий — CHANGELOG.md в корне репозитория.

import { DEAD, METRIC_SEP, NODATA, REGION_AM, REGION_EU, REGION_RU } from '../const.js';
import { decodeName, flagOf, fragOf, matchKey, norm, regionOf, scoreOf, stripMetric, tagOf, voiceOk } from '../util.js';

// Балл непроверенного узла. scoreOf отдаёт -1 для мёртвого, поэтому
// непроверенный обязан быть строго ниже: в Loon такие узлы шли хвостом
// после протестированных (renderNodesBoth в src/sub.js) — сохраняем.
const UNTESTED = -2;

// Границы управляющих символов — числами, а не escape-классом регэкспа:
// JSON-транспорт GitHub API разворачивает escape в сам символ, и файл
// становится бинарным для git (то же соглашение, что в stash-nodes.js).
const CTRL_MAX = 0x20, CTRL_DEL = 0x7f, CTRL_NEL = 0x85;

// Имя узла для YAML. Управляющий символ и NEL (U+0085) заменяются пробелом:
// в одинарной строке YAML первый недопустим, а второй разборщик YAML 1.1
// молча сворачивает в пробел — и то, и другое рвёт разбор или имя.
// U+2028/U+2029 схлопывает сам norm (в JS они входят в \\s), он же обрезает
// края. ИМЯ ОТСЮДА — ЕДИНСТВЕННОЕ: clients/stash.js nodeSet() ставит его и
// члену группы, и узлу в `proxies:`, поэтому разойтись им негде.
function cleanName(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    out += (c < CTRL_MAX || c === CTRL_DEL || c === CTRL_NEL) ? ' ' : ch;
  }
  return norm(out);
}

// ── МЕТКА УЗЛА ───────────────────────────────────────────────────
// Обе метрики в одном имени: «🇩🇪 Германия · 21↓68 / 7↓96» — сначала Wi-Fi,
// потом сотовая. Вариант 1 из ADR-02, временный: когда метрики переедут в
// панель (вариант 2, предпочтительный), достаточно перестать вызывать
// nodeLabel — сборка групп от формата имени больше нигде не зависит.
// ВАЖНО: выдача узлов (`proxies:`) обязана звать ЭТУ ЖЕ функцию, иначе имена
// в группах не совпадут с именами узлов и Stash молча потеряет членов.

function metricText(m) {
  if (!m) return NODATA;
  if (m.dead) return DEAD;
  const down = Math.max(0, Math.round(+m.down || 0));
  const rtt = Math.max(0, Math.round(+m.rtt || 0));
  return down + '↓' + rtt;
}

function nodeLabel(base, w, c) {
  if (!w && !c) return base;            // ни одного замера — имя остаётся чистым
  return base + METRIC_SEP + metricText(w) + ' / ' + metricText(c);
}

// ── СБОР УЗЛОВ ─────────────────────────────────────────────────
// Из строк подписки собираем плоский список: базовое имя, тег, флаг и две
// метрики. Максимумы скорости нужны scoreOf и считаются по каждой сети
// отдельно — ровно как в src/sub.js.
// Уникальность имён повторяет правило stash-nodes.js (суффикс « (2)»):
// Stash различает узлы по имени, а член группы — это ссылка по имени.
// Поле line — ИСХОДНАЯ строка подписки: по ней clients/stash.js разбирает
// описание узла для секции `proxies:`. Держать её здесь дешевле, чем второй
// раз обходить masterLines и надеяться, что фильтры совпали.

function collect(masterLines, state, label) {
  const items = [];
  const st = state || {};
  let maxW = 0, maxC = 0;
  (masterLines || []).forEach(function (line) {
    const name = decodeName(fragOf(String(line == null ? '' : line)));
    const tag = tagOf(name);
    if (tag === 'other') return;        // не узел нашей подписки
    const base = cleanName(stripMetric(name));
    const rec = (tag === 'vpn' || tag === 'game') ? st[matchKey(name)] : null;
    const w = (rec && rec.w) ? rec.w : null;
    const c = (rec && rec.c) ? rec.c : null;
    if (w && !w.dead && +w.down > maxW) maxW = +w.down;
    if (c && !c.dead && +c.down > maxC) maxC = +c.down;
    items.push({
      line: String(line == null ? '' : line), base: base, tag: tag,
      flag: flagOf(base), w: w, c: c, display: base,
    });
  });
  const seen = Object.create(null);
  items.forEach(function (it) {
    const first = label === false ? it.base : nodeLabel(it.base, it.w, it.c);
    let nm = first, n = 1;
    while (seen[nm]) { n++; nm = first + ' (' + n + ')'; }
    seen[nm] = true;
    it.display = nm;
  });
  return { items: items, maxW: maxW, maxC: maxC };
}

// ── РАНГИ КАСКАДОВ ──────────────────────────────────────────────
// Ранг -1 = узел в эту функцию не входит. Меньший ранг стоит выше.

// RH-АВТО: EU -> AM -> СНГ -> прочие -> игры -> обход (routehub.conf, RH-АВТО-W).
function rankAuto(it) {
  if (it.tag === 'bypass') return 5;
  if (it.tag === 'game') return 4;
  return regionOf(it.flag);            // 0 EU, 1 AM, 2 СНГ, 3 прочие
}

// RH-Звонки: годные для голоса (☎) -> VPN без ☎ -> обход (RH-Звонки-W).
// Первый фильтр Loon «🛜.*☎» ловит и игровой узел, если тот прошёл пороги, —
// повторяем это; игровой узел без ☎ в группу не попадает.
function rankCall(it, side) {
  if (it.tag === 'bypass') return 2;
  if (voiceOk(it[side])) return 0;
  return it.tag === 'vpn' ? 1 : -1;
}

// RH-AI: DE -> тиры Европы -> остаток Европы -> тиры Америки -> остаток
// Америки -> тиры прочих -> общий остаток -> обход. СНГ исключён везде,
// игровые узлы в AI не входят (aiBlocks в clients/loon.js).
// Тиры считает ядро (buildAiTiers); здесь только раскладка по рангам.
function aiRanker(tiers) {
  const rank = Object.create(null);
  const byRegion = function (r) {
    return (tiers || []).filter(function (f) { return regionOf(f) === r; });
  };
  let n = 0;
  byRegion(0).forEach(function (f) { rank[f] = n++; });
  const euRest = n++;
  byRegion(1).forEach(function (f) { rank[f] = n++; });
  const amRest = n++;
  byRegion(3).forEach(function (f) { rank[f] = n++; });
  const rest = n++, bypass = n++;
  return function (it) {
    if (it.tag === 'bypass') return bypass;
    if (it.tag !== 'vpn') return -1;
    if (it.flag in rank) return rank[it.flag];
    if (REGION_RU.indexOf(it.flag) >= 0) return -1;
    if (REGION_EU.indexOf(it.flag) >= 0) return euRest;
    if (REGION_AM.indexOf(it.flag) >= 0) return amRest;
    return rest;
  };
}

// Упорядоченный список имён для одной группы. side — 'w' (Wi-Fi) или 'c'.
// Сортировка по (ранг, балл по убыванию, исходный порядок): третий ключ задан
// явно, чтобы выдача не зависела от стабильности sort в рантайме.
function orderNames(items, side, max, rankOf) {
  const arr = [];
  (items || []).forEach(function (it, i) {
    const r = rankOf(it, side);
    if (r < 0) return;
    const m = it[side];
    arr.push({ i: i, r: r, s: m ? scoreOf(m, max) : UNTESTED, name: it.display });
  });
  arr.sort(function (a, b) { return (a.r - b.r) || (b.s - a.s) || (a.i - b.i); });
  return arr.map(function (x) { return x.name; });
}

export { UNTESTED, aiRanker, cleanName, collect, nodeLabel, orderNames, rankAuto, rankCall };
