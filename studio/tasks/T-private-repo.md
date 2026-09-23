# T-private-repo — приватный репозиторий через прокси Worker'а

Сложность: **сложная**. Один `executor-complex` на всю задачу, затем
`reviewer`, затем `tester`. Правки боевого Worker'а и боевого
`routehub.conf` — только с согласия Дианы (правило 5); без него задача
останавливается на шаге подготовки прокси и не доходит до перевода
репозитория в приватный.

## Зачем

Репозиторий `spxload/routehub` планируется сделать приватным. Сейчас три
независимых потребителя тянут файлы репозитория напрямую с
`raw.githubusercontent.com` без авторизации — после перевода в приватный
режим все три получат 404.

## Факты (сверено по коду 23.09.2026, ветка `main`)

1. **Сам Worker.** `wrangler.toml`:
   ```
   [vars]
   CONFIG_URL = "https://raw.githubusercontent.com/spxload/routehub/main/routehub.conf"
   ```
   `src/api.js`, `handleConfig`: `fetch(cfgUrl, ...)` без заголовка
   `Authorization` — Worker тянет `routehub.conf` неавторизованным запросом.
   То же в `[env.stash].vars.CONFIG_URL` для стенда.

2. **Скрипты устройства.** `src/api.js`, `handleConfig`:
   ```js
   scriptBase: env.CONFIG_URL.replace(/[^/]+$/, ''),
   ```
   — это база БЕЗ имени файла, то есть просто
   `https://raw.githubusercontent.com/spxload/routehub/main/`. Клиентский
   слой `src/clients/loon.js` подставляет её в относительные
   `script-path=probes/...` и `script-path=scripts/...` конфига:
   ```js
   out = out.replace(/script-path=((?:[\w.-]+\/)*routehub-[^,\s]+)/g,
     'script-path=' + ctx.scriptBase + '$1');
   ```
   Итог: устройство получает от Worker конфиг с уже подставленными прямыми
   `raw.githubusercontent.com`-ссылками и тянет скрипты САМО, без Worker'а и
   без токена устройства.

3. **`[Plugin]` в `routehub.conf`** — хардкод, не проходит через
   `renderConfig`/`scriptBase`:
   ```
   https://raw.githubusercontent.com/spxload/routehub/main/plugins/RouteHub-Dash.plugin, enabled=true
   https://raw.githubusercontent.com/spxload/routehub/main/plugins/RouteHub-FailLog.plugin, enabled=false
   ```
   Loon скачивает эти файлы напрямую с GitHub при установке/обновлении
   плагина.

4. **Ссылки ВНУТРИ `plugins/*.plugin` и `plugins/*.stoverride`** — тоже
   хардкод на `raw.githubusercontent.com/spxload/routehub/main/...`, например:
   - `plugins/RouteHub-FailLog.plugin`: `script-path=https://raw.githubusercontent.com/.../scripts/routehub-faillog.js`
   - `plugins/RouteHub-DNS-L12.plugin`: `script-path=https://raw.githubusercontent.com/.../probes/routehub-probe-dnstime.js`
   - `plugins/RouteHub-Stash-ST6.stoverride`, `plugins/RouteHub-Probe.stoverride`:
     `url: https://raw.githubusercontent.com/.../probes/routehub-probe-stash*.js`

   Эти файлы статичны (не рендерятся Worker'ом под конкретное устройство), в
   отличие от `routehub.conf`.

Итог: после перевода репозитория в приватный откажут (1) собственный запрос
Worker'а за конфигом, (2) прямая загрузка скриптов устройством, (3) прямая
загрузка плагинов Loon, (4) ссылки скриптов внутри самих плагинов.

## Решение

Worker проксирует файлы из приватного репозитория токеном ТОЛЬКО ДЛЯ ЧТЕНИЯ
(fine-grained personal access token, право `Contents: Read-only`, только на
`spxload/routehub`), лежащим в секретах Cloudflare (`wrangler secret put`, НЕ
в `wrangler.toml` — там только `[vars]`, стирается при каждом деплое, что и
нужно для секрета). Токен не кладётся на телефон (правило 3) — это отдельный
секрет Worker'а, отдельный от per-device токенов из реестра.

### Условия безопасности

- Прокси только под токеном устройства: `/t/<токен>/repo/<путь>`, тем же
  механизмом, что уже проверяет `PATH_TOKEN_RE` и `tokenGate` для `/nodes`
  (`src/const.js`, `src/store.js`).
- Белый список путей — ТОЛЬКО `routehub.conf`, `scripts/`, `probes/`,
  `plugins/`. Явно НИКОГДА: `docs/`, `Photo/`, `studio/`, `.github/`, корневые
  `CHANGELOG*.md`, `README.md`, `СТАРТ.md` — не то, что должно попадать на
  устройство.
- GitHub-токен используется ТОЛЬКО на стороне Worker (`fetch` к
  `api.github.com/repos/.../contents/<путь>` или к
  `raw.githubusercontent.com` с заголовком `Authorization`), никогда не
  уходит в ответ устройству.

### Открытый вопрос дизайна — решить в реализации, сверить на `reviewer`

`routehub.conf` рендерится `renderConfig` ПОД КОНКРЕТНОЕ устройство (у
каждого свой `reg[key].token`), поэтому подстановка `scriptBase` на
`/t/<токен-этого-устройства>/repo/` для скриптов и `[Plugin]`-ссылок внутри
конфига — прямая замена текущей строки.

Файлы `plugins/*.plugin` и `plugins/*.stoverride` — СТАТИЧНЫ, отдаются
Loon/Stash напрямую по URL без прохода через `renderConfig`, значит не имеют
«своего» устройства в момент запроса. Прокси в любом случае требует токен в
пути. Варианты (выбрать один, обосновать в диффе):
  а) зашить в статичные файлы токен ОДНОГО контрольного устройства (k1) —
     не нарушает правило 3 (это не GitHub-токен, а низкопривилегированный
     per-device токен доступа, уже живущий в конфиге ровно так же);
  б) завести отдельный «файловый» токен в реестре (запись без `key` устройства,
     только для чтения статичных файлов через `/t/<токен>/repo/plugins/...`).
Не выбирать вариант, требующий закладывать GitHub-токен или токен с правом
записи куда-либо на устройство.

### Порядок без простоя

1. Пока репозиторий ПУБЛИЧНЫЙ — добавить прокси-эндпоинт и переключить на
   него ВСЕ ссылки: `scriptBase` в `src/api.js`, `[Plugin]` в `routehub.conf`,
   ссылки внутри `plugins/*.plugin` и `plugins/*.stoverride`. Прокси уже
   работает (отдаёт те же файлы, репозиторий ещё публичный, GitHub-токен пока
   не обязателен, но добавляется сразу, чтобы не переделывать).
2. Диана обновляет боевой конфиг на устройстве и проверяет на телефоне: (а)
   скрипты (`RH-L10`, dash, netwatch и т. п.) тянутся и запускаются, (б)
   плагины `RouteHub-Dash`/`RouteHub-FailLog` устанавливаются/обновляются
   через новые ссылки.
3. Только после подтверждения Дианы — перевести репозиторий `spxload/routehub`
   в приватный (делает Диана, GitHub).

Плюс к прокси: `CONFIG_URL`, которым сам Worker тянет `routehub.conf`
(`wrangler.toml`, `src/api.js`), тоже переводится на авторизованный запрос тем
же GitHub-токеном — иначе после шага 3 сам Worker перестанет получать конфиг.

## Критерии приёмки

1. В секретах Cloudflare (`wrangler secret put`) заведён fine-grained
   GitHub PAT с правом `Contents: Read-only`, ограниченный `spxload/routehub`;
   имя секрета и факт заведения — в `CHANGELOG.md`, САМО ЗНАЧЕНИЕ токена — ни
   в одном файле репозитория, ни в диффе, ни в отчёте агента.
2. Worker получает `routehub.conf` авторизованным запросом; при отзыве или
   истечении токена `/config` отвечает понятной ошибкой, а не 404 без
   объяснения.
3. Новый маршрут прокси `/t/<токен>/repo/<путь>` (или эквивалент, сохраняющий
   схему `/t/<токен>/...`) отдаёт файл ТОЛЬКО если путь начинается с одного
   из четырёх разрешённых префиксов (`routehub.conf`, `scripts/`, `probes/`,
   `plugins/`); для любого другого пути — 403 или 404, не 200.
4. `scriptBase` в `src/api.js` указывает на прокси, а не на
   `raw.githubusercontent.com`; `renderConfig`/`clients/loon.js` не менялись
   в остальной логике, кроме источника базы.
5. `[Plugin]`-ссылки в боевом `routehub.conf` и внутренние ссылки в
   `plugins/*.plugin` и `plugins/*.stoverride` переписаны на прокси; выбранный
   вариант токена для статичных файлов (а/б выше) обоснован в диффе.
6. Тесты: `node --test tests/*.test.js` проходят на чистом клоне `main`
   (и `stash-client`, если правка туда переносится) — числа тестов до и
   после правки совпадают или растут, не падают.
7. Ни в одном из новых/изменённых файлов нет значения токена, секрета,
   значения нонса — проверено `grep` перед коммитом.
8. Порядок «без простоя» соблюдён: прокси заведён и проверен Дианой на
   устройстве ДО перевода репозитория в приватный, репозиторий переводится в
   приватный ПОСЛЕ подтверждения, отдельным действием Дианы (GitHub, не код).
