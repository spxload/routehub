// routehub — модуль repo.js
// Раздача встроенных файлов репозитория устройству: /t/<токен>/repo/<путь>
// и переписчик ссылок на них (T-private-repo; в main — v1.12.0, в ветке
// stash-client — перенос, Worker v1.11.0). Сами тексты — в манифесте
// files.js; здесь только доступ, белый список путей и ссылки.
//
// ЗАЧЕМ. После перевода spxload/routehub в приватный режим прямые ссылки
// raw.githubusercontent.com и jsDelivr на его файлы отдают 404. Устройство
// теперь берёт те же файлы у Worker'а под своим токеном.
//
// БЕЗОПАСНОСТЬ.
//   1. Токен в пути ОБЯЗАТЕЛЕН всегда, независимо от фазы token_required:
//      файлы приватного репозитория не отдаются анонимно. Токен ищется среди
//      токенов реестра (любой ключ) — ключа в запросе нет, поэтому tokenGate
//      (проверка по ключу) здесь не годится. Реестр только читается: прокси
//      в D1 не пишет. Нет или чужой токен — 403.
//   2. Путь сверяется строгой регуляркой с СЫРЫМ путём запроса (req.url до
//      разбора): только routehub.conf или scripts|probes|plugins/<имя> без
//      вложенных каталогов, без «%», без «..». Затем путь обязан быть в
//      манифесте. Иначе 404. docs/, Photo/, studio/, .github/, README — нет
//      в манифесте и не проходят регулярку.
//   3. Ссылки на spxload/routehub внутри отдаваемого файла переписываются на
//      /t/<токен ЗАПРОСИВШЕГО>/repo/<путь> — только для путей из манифеста.
//      Файлы в git не меняются, токены в git не попадают.

import { FILES } from './files.js';
import { kvGetJSON } from './store.js';

// Сырой путь: /t/<токен>/repo/<путь>. Имя файла начинается с буквы/цифры —
// «.» и «..» как имя не проходят даже до манифеста.
const REPO_RAW_RE = /^\/t\/([A-Za-z0-9]{16,64})\/repo\/(routehub\.conf|(?:scripts|probes|plugins)\/\w[\w.-]*)$/;

// Прямые ссылки на файлы репозитория: raw GitHub и зеркало jsDelivr, ветки
// main И stash-client. Override-файлы стенда ссылаются на обе: ST13–ST17,
// Stash-Probes, Stash-Collect — на stash-client; ST6, ST6-cdn, Probe, Stash,
// FailLog и [Plugin] в routehub.conf — на main.
// Ссылка на main отдаётся КОПИЕЙ ЭТОЙ ВЕТКИ. Это допустимо: все файлы, на
// которые в ветке есть ссылки с ref main (probes/routehub-probe-stash.js,
// -stash6.js, -stash7.js, scripts/routehub-faillog.js,
// plugins/RouteHub-Dash.plugin, plugins/RouteHub-FailLog.plugin), на момент
// переноса 24.09 совпадают с main байт в байт (git diff origin/main
// origin/stash-client -- <пути> пуст); routehub.conf обязан совпадать всегда
// (сторож tests/clients-stash-sets.test.js). Прочие файлы ветки на main-копии
// не ссылаются. Если main-адресат разойдётся с веткой, стенд отдаст версию
// ветки — для стенда это и есть рабочая версия.
const REPO_LINK_RE = /(https:\/\/link\.stash\.ws\/install-override\/|https:\/\/)(?:raw\.githubusercontent\.com\/spxload\/routehub\/(?:main|stash-client)|cdn\.jsdelivr\.net\/gh\/spxload\/routehub@(?:main|stash-client))\/([\w./-]+)/g;

function inManifest(p) { return Object.prototype.hasOwnProperty.call(FILES, p); }

function repoBase(origin, tok) { return origin + '/t/' + tok + '/repo/'; }

// Переписать ссылки на файлы репозитория в ссылки прокси с токеном tok.
// Путь вне манифеста не трогается: такой ссылки прокси всё равно не отдаст.
// Ссылка установки Stash (link.stash.ws/install-override/<хост>/…) несёт адрес
// БЕЗ схемы — её тоже ведём на прокси, иначе после перевода репозитория в
// приватный установить override будет неоткуда (замечание тестировщика 24.09).
function rewriteRepoLinks(text, origin, tok) {
  const base = repoBase(origin, tok);
  return String(text).replace(REPO_LINK_RE, function (m, pre, p) {
    if (!inManifest(p)) return m;
    return pre === 'https://' ? base + p : pre + base.replace(/^https?:\/\//, '') + p;
  });
}

// Путь из req.url, а не из разобранного url.pathname. req.url уже
// нормализован средой («\\» → «/», «..» и «%2e%2e» схлопнуты), %-кодирование
// прочих символов сохраняется; окончательная защита — манифест FILES.
function rawPath(req) {
  return String(req.url).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/)[0];
}

async function tokenKnown(env, tok) {
  if (!tok) return false;
  const reg = await kvGetJSON(env, 'devices');
  if (!reg) return false;
  for (const k in reg) if (reg[k] && reg[k].token === tok) return true;
  return false;
}

function textResp(body, status) {
  return new Response(body, { status: status, headers: {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}

// tok — токен ИЗ ПУТИ /t/<токен>/ (не из ?token=): ссылки прокси строятся
// только в таком виде. Пустой tok — отказ без обращения к D1.
async function handleRepo(req, url, env, tok) {
  if (!(await tokenKnown(env, tok))) {
    return textResp('RouteHub: файлы отдаются только по ссылке с токеном устройства.\n' +
      'Обнови конфиг (/t/<token>/config?key=kN) — ссылки на скрипты и плагины в нём уже с токеном.', 403);
  }
  const m = rawPath(req).match(REPO_RAW_RE);
  if (!m || m[1] !== tok || !inManifest(m[2])) return textResp('routehub-worker: not found', 404);
  // Ответ только из сборки: ни fetch, ни редиректа.
  return textResp(rewriteRepoLinks(FILES[m[2]], url.origin, tok), 200);
}

export { REPO_RAW_RE, handleRepo, repoBase, rewriteRepoLinks };
