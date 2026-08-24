# RouteHub

Маршрутизация трафика в Loon на iPhone: держит AI-сервисы на стабильных узлах,
обходит блокировки, экономит платный трафик обходных узлов. Подписка одна,
узлы раздаёт Cloudflare Worker, выбор внутри группы делает сам Loon.

**Состояние на 2026-08-17:** Worker `v1.10.1`, конфиг `C-draft-41`,
спидтест `v0.6.4`, панель устройства `dash v0.7.0`, админ-панель `p3`. Проверить живой Worker: `curl https://<worker>/version`.

## Карта репозитория

| Где | Что лежит |
|---|---|
| корень | `routehub-worker.js` (роутинг), `routehub.conf` (боевой конфиг), `wrangler.toml`, `README`, `CHANGELOG` + `CHANGELOG_ARCHIVE` |
| `src/` | ядро Worker'а: `const util store sub ai api dash admin` |
| `src/clients/` | клиентский слой, пока один — `loon.js` (рендер конфига) |
| `tests/` | `harness.js` + наборы тестов Worker'а и прогон проб в песочнице |
| `scripts/` | скрипты устройства: speedtest, netwatch, viewer, dash, dashcache, faillog, rkn |
| `probes/` | разовые пробы: L10 контекст, L11 хранилище, Stash, Surge |
| `plugins/` | `.plugin` для Loon и `.stoverride` для Stash |
| `web/` | `routehub-admin.html`, `routehub-dash.html` |
| `docs/` | актуальные документы |
| `docs/archive/` | история этапов, читать только как хронику |

## С чего начать

| Файл | Зачем |
|---|---|
| `CHANGELOG.md` | что менялось в Worker'е и конфиге, с причинами (старое — в `CHANGELOG_ARCHIVE.md`) |
| `docs/ADR-01_СХЕМА_КОНТУРОВ.md` | почему один код, но несколько Worker-сервисов |
| `docs/ADR-02_ГРУППЫ_STASH.md` | как в Stash снимаются пара `-W`/`-C` и дублирование узлов |
| `docs/ЭТАП_K_SURGE.md` | семь дней пробного Surge: что меряем и зачем |
| `docs/ТЕХДОЛГ.md` | что накопилось и в каком порядке разбирать |
| `docs/ЗАМЕРЫ_И_ВЕСА.md` | почему веса балла не рычаг, а замеры — да |
| `docs/СВЕРКА_LOON_3.5.md` | что подтвердилось в документации Loon, что разошлось |

## Как это устроено

```
подписка Lastdep
      │
      ▼
Cloudflare Worker (routehub-worker.js + src/*.js)
   ├── ядро src/*.js          считает баллы, хранит в D1, кэширует подписку
   └── src/clients/loon.js    рендерит конфиг под синтаксис Loon
      │
      ▼
routehub.conf на устройстве  →  Loon выбирает узел внутри fallback-группы
      ▲
      └── scripts/ на устройстве: speedtest (метрики), netwatch (смена сети),
          viewer, dash, dashcache; probes/ — ручная проба контекста L10
```

Стенды разворачиваются из этой же ветки через `[env.*]` в `wrangler.toml`:
`npx wrangler deploy --env stash`. Ветка на клиента больше не заводится.

## Актуальность документов

Часть документов описывает решения, которые уже заменены. Они лежат в
`docs/archive/` как история — читать их как описание текущего состояния нельзя.

| Документ | Статус |
|---|---|
| `docs/archive/ЭТАП_E_ПРОГРЕСС.md` | **устарел**: `RH-Прямой = select` заменён в C-draft-25 на fallback-группы |
| `docs/archive/ИНСТРУКЦИЯ_ПРОЕКТА.md` | **устарела**: 58 узлов, старая раскладка файлов, отменённые запреты |
| `docs/archive/ДЛЯ_ДИАНЫ_инструкция_и_промпты.md` | **устарела**: вторая инструкция, расходится с первой |
| `docs/archive/ЭТАП_D_RESEARCH_ПРОМПТ.md` | исполнен, ценность историческая |
| `docs/archive/МИГРАЦИЯ_НА_WORKERS.md` | выполнено 2026-06-08 |
| `docs/archive/ЭТАП_K_EGERN.md` и ветка `egern` | исследование закрыто: управления политиками из скрипта у Egern нет |
| `docs/ДОКУМЕНТАЦИЯ_LOON_RU.md` | перевод версии **3.3.9**, на устройстве 3.5.0 — сверка в `docs/СВЕРКА_LOON_3.5.md` |

Актуальные: `CHANGELOG.md`, `CHANGELOG_ARCHIVE.md`, `docs/ADR-01_СХЕМА_КОНТУРОВ.md`,
`docs/ADR-02_ГРУППЫ_STASH.md`, `docs/ТЕХДОЛГ.md`,
`docs/ЗАМЕРЫ_И_ВЕСА.md`, `docs/СВЕРКА_LOON_3.5.md`, `docs/ЭТАП_K_STASH.md`,
`docs/ЭТАП_K_STASH_СТЕНД.md`, `docs/СРАВНЕНИЕ_КЛИЕНТОВ_И_WHITELIST.md`,
`docs/ЭТАП_F_ЗАМЕТКИ.md`, `docs/КАТАЛОГ_СПИСКОВ.md`.

## Разработка

```bash
git clone --depth 1 https://github.com/spxload/routehub.git
node --test "tests/*.test.js"          # 92 теста, CI нет намеренно
npx wrangler deploy --env="" --dry-run # боевое окружение
npx wrangler deploy --env stash --dry-run
```

`git push` из облачной сессии не работает (прокси, баг claude-code #76248) —
правки идут через GitHub API, по одному файлу, с обязательной сверкой чистым
клоном после заливки.

Боевой контур меняется только с согласия владельца: `routehub.conf`, Worker,
скрипты устройства. Записи в D1 и отвязка ключей — тоже.
