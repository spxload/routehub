// routehub — модуль clients/stash-sets.js
// КЛИЕНТСКИЙ СЛОЙ STASH: удалённые наборы правил. Отдаёт две вещи —
// секцию `rule-providers:` профиля и строки `RULE-SET,<набор>,<политика>`
// для секции `rules:` (их вставляет clients/stash-rules.js).
// Перенос секции [Remote Rule] боевого routehub.conf (C-draft-41).
// Разбор переноса — docs/ЭТАП_K_STASH_ПРАВИЛА.md, разделы 3.1 и 5.
//
// ПОРЯДОК ЗАПИСЕЙ НЕСУЩИЙ. Он повторяет [Remote Rule] сверху вниз:
// реклама -> личный список -> три whitelist на жёсткий DIRECT -> банки и
// Apple -> AI catch-all -> Telegram и refilter. Побеждает первое совпавшее
// правило, поэтому перестановка строк меняет маршрутизацию, а не оформление.
// Целиком наборы стоят НИЖЕ локальных правил — ровно так, как в боевом
// конфиге, где [Rule] идёт до [Remote Rule].
//
// BEHAVIOR И FORMAT ОПРЕДЕЛЕНЫ ПО СОДЕРЖИМОМУ ФАЙЛОВ (срез 2026-08-29), а не
// по расширению и не по догадке:
//  * `.list` у forg-lib, misha-tgshv и OverseasAI — строки вида
//    `DOMAIN-SUFFIX,ipify.org`, комментарии `#`, пустые строки. Это
//    classical в текстовом виде: format: text, behavior: classical.
//    Даже whitelist-ips.list, где все 6710 строк — `IP-CIDR,…,no-resolve`:
//    behavior ipcidr ждёт ГОЛЫЕ подсети, а тут префикс типа, то есть
//    classical. Clash-варианта у forg-lib и misha-tgshv нет вовсе.
//  * у blackmatrix7 есть родной для Stash каталог rule/Clash/<Имя>/, оттуда
//    берём `.yaml` (format: yaml). Privacy.yaml — это ТОЛЬКО ключевые слова и
//    IP (39 записей), а 39 897 доменов лежат отдельным Privacy_Domain.yaml с
//    голыми доменами — behavior: domain. Поэтому наборов два, как и в Loon.
//  * вариант `_No_Resolve` взят там, где набор содержит IP (Privacy,
//    Telegram): без него Stash резолвит домен, чтобы сверить адрес.
//
// ЧЕГО ЗДЕСЬ НЕТ СОЗНАТЕЛЬНО:
//  * ключа `type` — документация Stash для поставщика правил перечисляет
//    только url, path, interval, headers, behavior, format. Придумывать
//    восьмой ключ по аналогии с Clash — та же ошибка, что benchmark-* у
//    поставщика прокси (см. шапку clients/stash-profile.js);
//  * суффикса `no-resolve` у строк RULE-SET — он допустим лишь для наборов
//    behavior: ipcidr, а таких у нас нет. В classical-наборах no-resolve
//    стоит внутри самих строк файла.
// История версий — CHANGELOG.md в корне репозитория.

const RAW = 'https://raw.githubusercontent.com/';
const BM7 = RAW + 'blackmatrix7/ios_rule_script/master/rule/Clash/';
const FORG = RAW + 'forg-lib-lov/roscomvpn-shadowrocket/main/lists/';
const MISHA = RAW + 'misha-tgshv/shadowrocket-configuration-file/main/rules/';
// У OverseasAI каталоги Loon и Clash содержат побайтово один и тот же файл
// (md5 сверен 2026-08-29). Берём путь Clash: он родной для семейства Stash.
const OVERSEAS = RAW + 'viewer12/OverseasAI.list/main/rule/Clash/OverseasAI/';

// Как часто Stash перечитывает файл набора, секунды. Сутки, а не 600: списки
// внешние и меняются раз в день, а whitelist-ips.list весит 242 КБ и
// domains_refilter.list — 2,4 МБ. Личный список — исключение, см. MYLIST_INTERVAL.
const INTERVAL = 86400;
// Личный список отдаёт наш же Worker, он маленький и пополняется кнопкой
// панели. 60 с — то же значение, что update-interval у Loon в [Remote Rule].
const MYLIST_INTERVAL = 60;

// Имя набора — ключ YAML и адрес ссылки из правила. Только латиница: имена
// политик кириллические по историческим причинам, плодить это в ключах
// незачем. Имя тега Loon сохранено в комментарии рядом.
const SETS = [
  // 1-2. Реклама и трекеры. Стоят выше РФ-DIRECT: режут и российские трекеры.
  // REJECT-DROP у Stash НЕ ПРОВЕРЕН на стенде (раздел 5 документа правил).
  { name: 'rh-ads', policy: 'REJECT-DROP', behavior: 'classical', format: 'yaml',
    url: BM7 + 'Privacy/Privacy_No_Resolve.yaml' },
  { name: 'rh-ads-domains', policy: 'REJECT-DROP', behavior: 'domain', format: 'yaml',
    url: BM7 + 'Privacy/Privacy_Domain.yaml' },
  // 3. Личный список Дианы. URL подставляет Worker: адрес зависит от ключа
  // устройства и от встроенного токена, в статике его быть не может.
  // Выше forg-lib whitelist: домены отсюда нужны в обход, даже когда
  // whitelist-набор ставит им DIRECT.
  { name: 'rh-mylist', policy: 'RH-RU', behavior: 'classical', format: 'text',
    interval: MYLIST_INTERVAL, mylist: true },
  // 4-6. РКН-whitelist -> ЖЁСТКИЙ DIRECT. Обход по этим доменам ВРЕДЕН:
  // анти-VPN отдаёт «выключите ВПН» (замер 2026-06-12, вывод 3 памяти проекта).
  { name: 'rh-wl-domains', policy: 'DIRECT', behavior: 'classical', format: 'text',
    url: FORG + 'whitelist-domains.list' },
  { name: 'rh-wl-mobile', policy: 'DIRECT', behavior: 'classical', format: 'text',
    url: FORG + 'hxehex-whitelist.list' },
  { name: 'rh-wl-ips', policy: 'DIRECT', behavior: 'classical', format: 'text',
    url: FORG + 'whitelist-ips.list' },
  // 7-9. Мелкие банки, Apple, банки ЦБ -> RH-RU (норма DIRECT, whitelist -> обход).
  { name: 'rh-ru-banks', policy: 'RH-RU', behavior: 'classical', format: 'text',
    url: FORG + 'category-ru.list' },
  { name: 'rh-apple', policy: 'RH-RU', behavior: 'classical', format: 'text',
    url: FORG + 'apple.list' },
  { name: 'rh-banks-cbr', policy: 'RH-RU', behavior: 'classical', format: 'text',
    url: MISHA + 'domains_banking.list' },
  // 10. AI catch-all. Локальные DOMAIN-SUFFIX выше по списку всё равно
  // приоритетнее — этот набор ловит остаток.
  { name: 'rh-ai-catchall', policy: 'RH-AI', behavior: 'classical', format: 'text',
    url: OVERSEAS + 'OverseasAI.list' },
  // 11. Заблокированное в РФ -> прокси.
  { name: 'rh-telegram', policy: 'RH-АВТО', behavior: 'classical', format: 'yaml',
    url: BM7 + 'Telegram/Telegram_No_Resolve.yaml' },
  // 12-14. ЗАМЕНА ОТКЛЮЧЁННОМУ refilter, заведена 02.09 по жалобе «Discord
  // не работает, а в Loon работает». Разбор: Discord лежал ИМЕННО в
  // `domains_refilter.list` — 64 записи, — то есть отключение того набора
  // было не косметикой, а потерей покрытия для всего, что заблокировано в
  // РФ. В Loon набор работает, потому что Loon переваривает 81 758 строк.
  // Это цена хвоста 3, и её надо было увидеть сразу.
  // У ТОГО ЖЕ АВТОРА нашлись точечные файлы: 31 строка на Discord и 179 на
  // YouTube. Они заведомо ниже порога и лечат симптом надёжно.
  { name: 'rh-discord', policy: 'RH-АВТО', behavior: 'classical', format: 'text',
    url: MISHA + 'domains_discord.list' },
  // YouTube: набор ПОЛНЕЕ наших пяти локальных доменов (есть ggpht.cn и
  // ключевые слова). Локальные правила оставлены — они выше по списку и
  // потому быстрее, а набор ловит остаток.
  { name: 'rh-youtube', policy: 'RH-АВТО', behavior: 'classical', format: 'text',
    url: MISHA + 'domains_youtube.list' },
  // ⚗️ ЭКСПЕРИМЕНТ НА ПОРОГ, а не готовое решение. Тот же список
  // заблокированного в РФ, но у первоисточника и ГОЛЫМИ доменами:
  // 81 061 строка, 1 327 481 байт против 2 483 144 у refilter. Строк
  // столько же, байт вдвое меньше. Мы знаем, что 39 916 записей проходят, а
  // 81 758 — нет, но НЕ знаем, во что именно упирается Stash: в число строк
  // или в объём. Этот набор разводит две гипотезы: даст ненулевой
  // `ruleCount` — предел по байтам и замена найдена; даст ноль — предел по
  // строкам, и список придётся резать на части.
  // ПРОВЕРЯЕТ ПРОБА ST8. До ответа набор считать неработающим.
  { name: 'rh-rkn-domains', policy: 'RH-АВТО', behavior: 'domain', format: 'text',
    url: 'https://raw.githubusercontent.com/1andrevich/Re-filter-lists/main/domains_all.lst' },
  // 15. ⛔ ОТКЛЮЧЁН 31.08 ПО ЗАМЕРУ, НЕ ПО ДОГАДКЕ.
  // `domains_refilter.list` — 2 483 144 байта, 81 758 строк. Проба ST8
  // показала у него `ruleCount: 0`: Stash взял набор молча пустым.
  // ФОРМАТ НИ ПРИ ЧЁМ. Строки те же самые, `DOMAIN-SUFFIX,<домен>`, и
  // `rh-banks-cbr` ИЗ ТОГО ЖЕ репозитория того же автора доехал целиком
  // (1036 правил). Больше того, `rh-ads-domains` доехал с 39 916 записями.
  // Значит дело в размере, и предел лежит МЕЖДУ 39 916 и 81 752 записями;
  // точное значение не меряли и придумывать его не следует.
  // Пока набор давал НОЛЬ правил, он был чистой тратой: 2,4 МБ качались
  // каждые сутки ради пустоты. Отключение не меняет маршрутизацию — менять
  // там было нечему. Вернуть можно одной строкой, когда найдётся вариант
  // списка поменьше либо когда предел будет измерен.
  // { name: 'rh-refilter', policy: 'RH-АВТО', behavior: 'classical', format: 'text',
  //   url: MISHA + 'domains_refilter.list' },
];

// Локальный путь кэша набора. Расширение следует формату, чтобы файл в папке
// профиля читался глазами так же, как его читает Stash.
function setPath(s) { return './rules/' + s.name + (s.format === 'yaml' ? '.yaml' : '.list'); }

// Адрес личного списка — тот же, что подставляется в Loon вместо
// плейсхолдера __RH_MYLIST_URL__ (см. clients/loon.js).
function mylistUrl(base, key) { return String(base || '') + '/mylist?key=' + String(key || ''); }

// Секция rule-providers целиком. Порядок ключей в объекте = порядок SETS.
function buildProviders(base, key) {
  const out = {};
  SETS.forEach(function (s) {
    out[s.name] = {
      url: s.mylist ? mylistUrl(base, key) : s.url,
      path: setPath(s),
      interval: s.interval || INTERVAL,
      behavior: s.behavior,
      format: s.format,
    };
  });
  return out;
}

// Строки правил, ссылающиеся на наборы. Порядок тот же и по той же причине.
function buildSetRules() {
  return SETS.map(function (s) { return 'RULE-SET,' + s.name + ',' + s.policy; });
}

export { INTERVAL, MYLIST_INTERVAL, SETS, buildProviders, buildSetRules, mylistUrl, setPath };
