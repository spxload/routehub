// routehub — модуль clients/stash-rules.js
// КЛИЕНТСКИЙ СЛОЙ STASH: секция `rules:` профиля.
// Перенос секции [Rule] боевого routehub.conf (C-draft-41). Правила лежат
// ЗДЕСЬ, а не читаются из конфига Loon: синтаксис у клиентов разный, а
// «разобрать чужой конфиг регэкспом» — источник тихих расхождений. Порядок
// строк повторяет routehub.conf сверху вниз; в Stash, как и в Loon, побеждает
// первое совпавшее правило.
//
// ЧТО ПЕРЕНЕСЕНО МЕХАНИЧЕСКИ (соответствие однозначное, типы подтверждены
// stash.wiki/en/rules/rule-types): DOMAIN-SUFFIX, IP-CIDR (+ no-resolve),
// GEOIP, PROTOCOL, FINAL -> MATCH.
//
// СЕКЦИЯ [Remote Rule] ПЕРЕНЕСЕНА отдельным модулем clients/stash-sets.js:
// одиннадцать удалённых наборов плюс личный список становятся поставщиками
// правил (`rule-providers:`) и строками `RULE-SET,<набор>,<политика>`. Эти
// строки вставляются НИЖЕ локальных правил и ВЫШЕ MATCH — ровно так, как в
// боевом конфиге, где [Rule] идёт целиком до [Remote Rule].
//
// ЧТО НЕ ПЕРЕНЕСЕНО и почему — docs/ЭТАП_K_STASH_ПРАВИЛА.md, раздел 3.2:
// [Host], [URL Rewrite], [Script], [Plugin], [MITM]. Ни одна из них не
// превращается в правило Stash сама собой, и придумывать им замену в профиль
// нельзя — профиль поедет на устройство.
//
// ЧТО У STASH ЕСТЬ, НО НАМИ ПОКА НЕ ИСПОЛЬЗУЕТСЯ (stash.wiki/en/rules/
// rule-types, срез 29.08.2026): DOMAIN-WILDCARD, DOMAIN-REGEX, USER-AGENT,
// URL-REGEX, IP-ASN, NETWORK, DST-PORT, GEOSITE, AND/OR/NOT. Перечислены
// НАРОЧНО: в боевом [Rule] их нет, но закрывать дорогу будущим правкам
// умолчанием не следует.
//
// ЧТО НЕПРИМЕНИМО, и это подтверждено:
// PROCESS-NAME и PROCESS-PATH в Stash есть, но ТОЛЬКО для macOS: на iOS
// неприменимо. SCRIPT,<имя>,POLICY принимает выражение на PYTHON
// (script.shortcuts), не JavaScript, поэтому маршрутизировать по нашему
// композитному баллу через SCRIPT нельзя — балл считает Worker, и он задаёт
// ПОРЯДОК в группе.
// История версий — CHANGELOG.md в корне репозитория.

// Имена политик. Служебные группы (RH-RU, RH-Главный, RH-Обход) собирает
// clients/stash-profile.js; функциональные (RH-AI, RH-АВТО, RH-Звонки) —
// clients/stash.js. Правило, сославшееся на несуществующую группу, Stash
// не примет, поэтому имена держатся одним списком.
const P_AI = 'RH-AI';
const P_AUTO = 'RH-АВТО';
const P_CALL = 'RH-Звонки';
const P_RU = 'RH-RU';
const P_MAIN = 'RH-Главный';

// AI-сервисы. Локальные правила приоритетнее любых удалённых наборов —
// в Stash это обеспечивается тем, что они стоят выше по списку.
const AI_SUFFIX = [
  'openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com',
  'anthropic.com', 'claude.ai',
  'gemini.google.com', 'bard.google.com', 'aistudio.google.com',
  'generativelanguage.googleapis.com',
  'x.ai', 'grok.com', 'perplexity.ai',
];

// YouTube и соцсети — на прокси (заблокировано в РФ либо деградирует).
const PROXY_SUFFIX = ['youtube.com', 'googlevideo.com', 'instagram.com'];

// Личные исключения Дианы: домены, которым нужен обход даже под whitelist
// РКН. Список ведётся руками; в Loon он стоит первым в [Rule], здесь тоже.
const PERSONAL = [['DOMAIN-SUFFIX', 'samokat.ru', 'DIRECT']];

function rule(parts) { return parts.join(','); }

// Итоговый список строк `rules:`. MATCH обязан быть последним и ровно один:
// это единственное правило без условия, всё после него недостижимо.
//   remote — строки RULE-SET из clients/stash-sets.js. Отдельный аргумент, а
//   не импорт: так порядок «локальные -> наборы -> MATCH» виден в одном
//   месте, а список наборов остаётся проверяемым сам по себе.
function buildRules(remote) {
  const out = [];
  PERSONAL.forEach(function (r) { out.push(rule(r)); });
  // Apple Push: норма DIRECT, whitelist -> обход (Apple под whitelist не идёт).
  out.push(rule(['IP-CIDR', '17.0.0.0/8', P_RU, 'no-resolve']));
  // Локальные REJECT: мультикаст.
  out.push(rule(['IP-CIDR', '224.0.0.0/4', 'REJECT', 'no-resolve']));
  out.push(rule(['IP-CIDR', '239.0.0.0/8', 'REJECT', 'no-resolve']));
  // Звонки: STUN. В Loon это PROTOCOL,STUN; в Stash тип PROTOCOL тоже есть
  // и среди значений документирован STUN — соответствие однозначное.
  out.push(rule(['PROTOCOL', 'STUN', P_CALL]));
  AI_SUFFIX.forEach(function (d) { out.push(rule(['DOMAIN-SUFFIX', d, P_AI])); });
  // DeepSeek: норма DIRECT, whitelist -> обход.
  out.push(rule(['DOMAIN-SUFFIX', 'deepseek.com', P_RU]));
  PROXY_SUFFIX.forEach(function (d) { out.push(rule(['DOMAIN-SUFFIX', d, P_AUTO])); });
  // Российские IP: то, что не поймали домены.
  out.push(rule(['GEOIP', 'RU', P_RU]));
  // Удалённые наборы: в боевом конфиге [Remote Rule] стоит после [Rule]
  // целиком, поэтому здесь они идут ниже всех локальных правил.
  (remote || []).forEach(function (r) { out.push(String(r)); });
  out.push(rule(['MATCH', P_MAIN]));
  return out;
}

export { AI_SUFFIX, PERSONAL, PROXY_SUFFIX, P_AI, P_AUTO, P_CALL, P_MAIN, P_RU, buildRules };
