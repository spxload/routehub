# MAP.md — карта репозитория RouteHub

Срез на 2026-09-23 (процесс Claude Code дополнен 24.09), ветка `main` (боевой Loon: Worker v1.12.0, конфиг
C-draft-43, `routehub-speedtest.js` v0.7.1, `routehub-dash.js` v0.8.0).
Читать этот файл первым, дальше — только файлы под задачу.

## С чего начать под задачу

| Задача | Что открыть |
|---|---|
| Правка `routehub.conf` | `routehub.conf`, `src/clients/loon.js`, `CHANGELOG.md`, `tests/config.test.js` |
| Правка Worker'а | `routehub-worker.js`, нужный `src/*.js`, `tests/routehub-worker.test.js`, `CHANGELOG.md` |
| Новый файл в `scripts/`, `probes/`, `plugins/` | строка в `src/files.js`, сторож `tests/files-manifest.test.js` |
| Скрипт устройства Loon | нужный `scripts/*.js`, `routehub.conf`, `tests/probes-smoke.test.js` |
| Проба (probe) | нужный `probes/*`, его `plugins/*`, `tests/probe-*.test.js`, `docs/ЭТАП_K_*.md` |
| Профиль/слой Stash | ветка `stash-client` (`src/clients/stash-*.js`), `docs/ADR-02`, `ЭТАП_K_STASH_СТЕНД.md` |
| Тесты | `tests/harness.js`, `tests/mock-d1.js`, нужный `tests/*.test.js` |
| Документация | нужный файл `docs/`, таблица актуальности README, `CHANGELOG.md` |
| Процесс, агенты, скиллы | `CLAUDE.md`, `studio/README.md`, `.claude/agents/` |

## Корень

| Файл | За что отвечает |
|---|---|
| `CLAUDE.md` | правила для сессий Claude Code: жёсткие правила 1–5, процедуры, git и согласие |
| `routehub-worker.js` | точка входа, только роутинг; импортирует все `src/*.js` и `web/routehub-admin.html` |
| `routehub.conf` | боевой конфиг Loon, C-draft-43; рендерится шаблоном `src/clients/loon.js` |
| `wrangler.toml` | деплой: боевой (`routehub-db`), `[env.stash]` (`routehub-stash-db`), cron 2 ч; правила Text для встроенных файлов |
| `README.md` | вход в репозиторий: карта, «с чего начать», актуальность docs |
| `CHANGELOG.md` | версии Worker'а/конфига с v1.9.4/C-draft-41, с причинами |
| `CHANGELOG_ARCHIVE.md` | версии до границы выше, дословно |
| `СТАРТ.md` | заглушка: статус — в Файлах проекта Claude, не в репозитории |

## src/ — ядро Worker'а (граф импортов ацикличен, сверху вниз)

| Файл | Отвечает за | Зависит от |
|---|---|---|
| `const.js` | имена узлов, регионы, `BYPASS_WORD`, веса `SCORE_W*`, токены | — |
| `util.js` | разбор имён, `scoreOf`, `metricOf`, `tagOf` | const |
| `store.js` | D1 (`kv`), реестр устройств, `nonce`, токены | const, util |
| `sub.js` | подписка Lastdep: загрузка, кэш, наборы 🛜/📱 | const, store, util |
| `ai.js` | расчёт AI-тиеров (каскады); рендер — в `clients/*` | const, util |
| `api.js` | `/config /nodes /speed /rkn /status` | ai, clients/loon, const, files, repo, store, sub, util |
| `dash.js` | данные `rh.box`, личный список доменов | const, store, util |
| `admin.js` | админ-панель: сессия HMAC, устройства | const, store, sub, util |
| `files.js` | манифест файлов, встроенных в сборку (Text): конфиг, скрипты, пробы, плагины | — |
| `repo.js` | `/t/<токен>/repo/<путь>`: гейт токена, белый список, переписчик ссылок | files, store |
| `clients/loon.js` | `aiBlocks`, `subParamsFromConf`, `renderConfig` | const, util |

`src/clients/stash-*.js` в `main` нет — код в ветке `stash-client`.

## tests/ — `node --test "tests/*.test.js"`, CI намеренно нет

| Файл | Что проверяет |
|---|---|
| `harness.js`, `mock-d1.js`, `text-loader.mjs` | не тесты: загрузка Worker'а, мок D1 (`kv` на `Map`), хук модулей Text |
| `routehub-worker.test.js` | ядро: маршруты, реестр |
| `clients-loon.test.js` | `renderConfig` — плейсхолдеры и аргументы скриптов |
| `config.test.js` | сквозной `GET /config` на встроенном `routehub.conf`: ключ, токен, тиры, `conf_ver`, ни одного fetch |
| `repo.test.js` | прокси `/t/<токен>/repo/`: 403 без токена, 404 вне белого списка, байт в байт с переписанными ссылками |
| `files-manifest.test.js` | сторож `src/files.js`: каждый файл встроен и совпадает с диском; правила Text в `wrangler.toml` |
| `endpoints.test.js` | простые маршруты без ключа (`/version`) |
| `metrics.test.js` | `POST /speed` и композитный балл |
| `nonce.test.js` | чужой `nonce` при привязке ключа |
| `bypass.test.js` | признак обхода — слово «Обход» где угодно, не `[Обход` |
| `upload.test.js` | `up` (ADR-05): не влияет на балл, 0 ≠ отсутствие замера |
| `probe-dnstime.test.js` | арифметика L12 (имя−IP) с виртуальными часами |
| `probes-smoke.test.js` | каждая проба `probes/*` доходит до `$done` |
| `speedtest-ewma.test.js` | EWMA α=0.2 — вес нового замера, флаг `ewma` |
| `speedtest-jitter.test.js` | `RTT_SAMPLES=5`, джиттер — усечённый размах |
| `guard-prod.test.js` | хук правила 5: боевые пути → `ask`, прочие молча; `../`, симлинки, сбой → `ask` |
| `context-watch.test.js` | монитор контекста: ступени 50/65/80, память ступени, хвост транскрипта, сбой → тишина; SessionStart, PreCompact |
| `studio-roles.test.js` | frontmatter ролей и скиллов: поля по документации, `model: opus`, наблюдатели без `Write`/`Edit` |

## scripts/ — код на устройстве (Loon)

| Файл | Отвечает за |
|---|---|
| `routehub-speedtest.js` | cron: down/rtt/jitter/bl + `up`, `POST /speed` |
| `routehub-netwatch.js` | `network-changed`: сеть/whitelist, флип групп `-W/-C`, heartbeat |
| `routehub-rkn.js` | cron: детект whitelist/block по живости узлов |
| `routehub-viewer.js` | ручной просмотр метрик, тот же балл, что Worker |
| `routehub-dash.js` | перехват `http://rh.box`, панель устройства |
| `routehub-dashcache.js` | cron: кэш `/dashboard` в `$persistentStore` (фолбэк) |
| `routehub-faillog.js` | сбор доменов упавших соединений в `rh_faillog` |

## probes/ — разовые пробы (только чтение, в маршрутизацию не пишут)

| Файл | Отвечает за |
|---|---|
| `routehub-probe-context.js` | L10: сеть + whitelist + живость выбранных узлов (RH-L10) |
| `routehub-probe-dnstime.js` | L12: время резолва DNS под whitelist |
| `routehub-probe-store.js` | L11: `nonce` и кэши спидтеста в `$persistentStore` |
| `routehub-probe-stash.js` | ST1: опись среды Stash |
| `routehub-probe-stash6.js` | ST6: тело `/connections`, WebSocket, сверка с Surge |
| `routehub-probe-stash7.js` | ST7: виден ли хост в `/connections` |
| `routehub-probe-surge.js` | SG1: опись имён и HTTP API Surge |
| `routehub-probe-surge2.js` | SG2: тела эндпоинтов Surge |
| `routehub-probe-surge3.js` | SG3: границы возможностей Surge |
| `routehub-stash-probe.yaml` | конфиг-стенд Stash для ST5 (запись в контроллер) |
| `routehub-surge-stand.conf` | стенд Surge (SG-draft-1), без Worker'а |
| `RouteHub-Surge.sgmodule` | установщик плиток SG1–SG3 |

Пробы Stash ST8–ST17 — в ветке `stash-client`, в `main` не переносились.

## plugins/ — установка проб и панели на устройство

| Файл | Отвечает за |
|---|---|
| `RouteHub-Dash.plugin` | иконка входа в `rh.box` (логика — в `scripts/routehub-dash.js`) |
| `RouteHub-FailLog.plugin` | сборщик доменов, MITM вручную, по умолчанию выключен |
| `RouteHub-DNS-L12.plugin` | ручная плитка пробы L12 |
| `RouteHub-Probe.stoverride` | Stash: проба ST1 |
| `RouteHub-Stash.stoverride` | Stash: пробы ST7+ST5 по расписанию |
| `RouteHub-Stash-ST6.stoverride` | Stash: проба ST6, raw GitHub |
| `RouteHub-Stash-ST6-cdn.stoverride` | то же ST6, зеркало jsDelivr |

## tools/ и web/

| Файл | Отвечает за |
|---|---|
| `tools/build-st6-inline.mjs` | генерирует inline-override ST6 из `probes/routehub-probe-stash6.js` |
| `web/routehub-admin.html` | админ-панель, бандлится в Worker (`import ADMIN_HTML`) |
| `web/routehub-dash.html` | шаблон панели устройства, тянет `routehub-dash.js` отдельно |

## docs/ — актуальные документы

| Документ | Статус |
|---|---|
| `ADR-01_СХЕМА_КОНТУРОВ.md` | актуален |
| `ADR-02_ГРУППЫ_STASH.md` | актуален |
| `ADR-03_ЖУРНАЛ_ПО_ПРИЛОЖЕНИЮ.md` | актуален |
| `ADR-05_ЗАМЕР_ОТДАЧИ.md` | актуален |
| `ЗАМЕРЫ_И_ВЕСА.md` | актуален |
| `ТЕХДОЛГ.md` | актуален |
| `КАТАЛОГ_СПИСКОВ.md` | актуален |
| `СВЕРКА_LOON_3.5.md` | актуален |
| `СВЕРКА_STASH_ИНТЕРФЕЙС.md` | актуален |
| `СРАВНЕНИЕ_КЛИЕНТОВ_И_WHITELIST.md` | актуален |
| `ЭТАП_F_ЗАМЕТКИ.md` | актуален |
| `ЭТАП_K_STASH.md` | актуален |
| `ЭТАП_K_STASH_СТЕНД.md` | актуален |
| `ЭТАП_K_SURGE.md` | актуален, в процессе (SG1/3 прогнана) |
| `ДОКУМЕНТАЦИЯ_LOON_RU.md` | устарел, см. `СВЕРКА_LOON_3.5.md` (перевод 3.3.9, устройство 3.5.0) |
| `ЭТАП_D_ФОРМУЛА.md` | устарел, см. `ЗАМЕРЫ_И_ВЕСА.md` (веса); версия в тексте v0.4.13, позади v0.7.1 |
| `СВЕРКА_С_ДОКУМЕНТАЦИЕЙ.md` | архив — ссылается на несуществующий `ПЛАН_РЕАЛИЗАЦИИ_v2.md` |

## docs/archive/ — история, не описание текущего состояния

| Документ | Одной строкой |
|---|---|
| `ИНСТРУКЦИЯ_ПРОЕКТА.md` | 58 узлов, старая раскладка, отменённые запреты |
| `ДЛЯ_ДИАНЫ_инструкция_и_промпты.md` | вторая инструкция для чатов, расходится с первой |
| `ИССЛЕДОВАНИЕ_GITHUB.md` | обзор решений GitHub 30.05, исполнено |
| `МИГРАЦИЯ_НА_WORKERS.md` | план миграции на Workers, выполнено 08.06 |
| `ОТЧЁТ_ПО_ПРОЕКТУ.md` | ранний отчёт («AI Region Switch») |
| `ЭТАП_A_РЕЗУЛЬТАТЫ.md` | промежуточные итоги этапа A, 29.05 |
| `ЭТАП_B_РЕШЕНИЯ.md` | архитектурные решения этапа B |
| `ЭТАП_DASH_ПРОГРЕСС.md` | здесь похоронен баг `routehub-rkn.js` |
| `ЭТАП_D_RESEARCH_ПРОМПТ.md` | промпт Research по формуле узлов, исполнен |
| `ЭТАП_D_ЛИЧНЫЕ_ПОДПИСКИ.md` | черновик архитектуры личных подписок |
| `ЭТАП_D_ПРОГРЕСС.md` | этап D завершён: подписки, AI-селектор, спидтест |
| `ЭТАП_E_ПРОГРЕСС.md` | `RH-Прямой=select` заменён в C-draft-25 |
| `ЭТАП_K_EGERN.md` | исследование Egern закрыто |

## .claude/ и studio/ — процесс работы Claude Code

| Файл | Отвечает за |
|---|---|
| `.claude/agents/executor-simple.md` | роль: простые задачи пачкой |
| `.claude/agents/executor-medium.md` | роль: 1–3 связанные задачи |
| `.claude/agents/executor-complex.md` | роль: одна сложная задача |
| `.claude/agents/reviewer.md` | роль: ревью диффа до коммита, без записи |
| `.claude/agents/tester.md` | роль: независимая проверка после исполнителей |
| `.claude/agents/researcher.md` | роль: факты по документации с URL |
| `.claude/agents/ideator.md` | роль: простые и нестандартные идеи, оптимизация; без записи, вызывается сама |
| `.claude/skills/handoff/SKILL.md` | скилл: передача дел в `studio/handoff/` вместо `/compact` |
| `.claude/skills/diagnosing-bugs/SKILL.md` | скилл: диагностика поломки, L10 прежде вывода |
| `.claude/skills/grill-me/SKILL.md` | скилл: все вопросы одним списком с ответами по умолчанию |
| `.claude/skills/context-audit/SKILL.md` | скилл: опись контекста в начале сессии и что отключить под задачу |
| `.claude/skills/prove-blocked/SKILL.md` | скилл: лестница доказательств перед выводом «невозможно», контрольный опыт |
| `.claude/skills/ideas/SKILL.md` | скилл: 1–3 строки «что улучшить» в конце закрытой задачи, иначе молчать |
| `.claude/settings.json` | хуки: `PreToolUse` (guard-prod); `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreCompact` (context-watch) |
| `.claude/hooks/guard-prod.js` | правка боевого контура → запрос подтверждения (правило 5) |
| `.claude/hooks/context-watch.js` | монитор контекста → ступени и `/handoff`; аудит при старте; первый ручной `/compact` → блок |
| `studio/README.md` | порядок работы, роли, экономия лимитов |
| `studio/tasks/BACKLOG.md` | незакрытые пункты бэклога 1–52 |
| `studio/tasks/T-private-repo.md` | бриф: приватный репозиторий через прокси Worker'а |
| `studio/tasks/T-workflows.md` | бриф первой сессии: `/context`, проверка хука, CI |
| `studio/handoff/2026-09-24-pereezd-v-code.md` | передача дел: переезд из Cowork в Claude Code, порядок дальнейших задач |

## Photo/

Скриншоты интерфейса Stash от 25.08, 54 файла; перед переводом репозитория
в приватный не открывать как источник секретов.

## Ветки

`main` — боевой Loon, единственная правда для Worker'а и конфига.
`stash-client` — активная разработка слоя Stash (`src/clients/stash-*.js`,
`src/admin/*`, `src/api/*` мельче нарезаны, пробы ST8–ST17, ADR-04); не слита.
`egern` — архив закрытого исследования, в боевой контур не тянуть.
`release/v1.10.1`, `st16-batch` — рабочие/промежуточные, здесь не описаны.
