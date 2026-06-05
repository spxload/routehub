# ЭТАП D — ПРОГРЕСС и «грабли» (для продолжения)

> Читать вместе с `ЭТАП_D_ЛИЧНЫЕ_ПОДПИСКИ.md` (архитектура) и `СТАРТ.md`.
> Состояние на 2026-06-05.

## Статус
- **D.0 закрыт** (решения зафиксированы в `ЭТАП_D_ЛИЧНЫЕ_ПОДПИСКИ.md`).
- **D.1–D.4 готовы и проверены на устройстве** (Wi-Fi и сотовая).
- **Дальше: D.5** (`routehub-core.js`, AI-селектор), затем D.6 health,
  D.7 netwatch, D.8 кнопки, D.9 правка конфига, D.10 тест.

## Живая инфраструктура
- **Worker:** `https://routehub.proton4iker.workers.dev`
  - `GET /config?key=kN` — персональный конфиг (узлы = nodes-kN).
  - `POST /speed` — приём скорости, пересборка nodes-kN.
  - **Авто-деплой:** Worker привязан к репозиторию (Workers Builds),
    деплоит при любом push в `main`. wrangler.toml в репо. Несекретные
    env — в wrangler.toml [vars]; `GIST_TOKEN` — Secret в дашборде.
    Проверка деплоя: Cloudflare MCP `workers_list` -> `modified_on`.
- **Гист** `GIST_ID=b14194982ad9d058c21d393d0f342147` (владелец spxload):
  - `lastdep-nodes.txt` — эталон узлов, **base64** (publish_nodes.py).
  - `nodes-kN.txt` — узлы профиля, **base64**, пересобирает Worker.
  - `devices.json` — реестр ключей (free/bound/conflict, nonce, cell_unlim).
  - `debug-kN.json` — ВРЕМЕННАЯ диагностика (sent/tested/unmatched).
- **Ключ k1** забиндан (телефон Дианы). k2 — free (для жены).

## ГРАБЛИ (подтверждено на устройстве — не наступать заново)
1. **Подписка/узлы — base64**, не построчный текст. Worker декодирует
   эталон и кодирует nodes-kN обратно (atob/btoa, контент ASCII).
2. **Имена узлов Loon нормализует** (схлопывает пробелы, режет ведущий).
   Сопоставление имён — по `norm = s.replace(/\s+/g,' ').trim()`.
   Иначе `tested:0` (двойные/ведущие пробелы в эталоне не совпадают).
3. **`$config.getSubPolicies(group, cb)` отдаёт JSON-СТРОКУ**, не массив.
   Парсить `JSON.parse`. Элементы: `{"type":"node","name":"..."}`. Имя в
   `.name`. Без парсинга скрипт идёт по СИМВОЛАМ строки.
4. **Проба `$httpClient` на `__down?bytes=0` -> "Empty response data"**
   (пустое тело Loon считает ошибкой). Мерить отклик на `bytes=1`.
5. **`ssid` из `$config.getConfig()` часто пуст** (iOS не отдаёт SSID без
   геолокации Loon). Детект сети по ssid ненадёжен. Пока: пусто -> 'cell'.
   Надёжный детект сети — задача D.7 (netwatch) либо иной сигнал.
6. **Loon кэширует remote-скрипты по URL.** Worker добавляет `?v=<ts>` к
   `script-path` -> Loon тянет свежий скрипт. ВРЕМЕННО (снять в D.9).
   Обновление доходит до Loon с задержкой ~3–5 мин (raw GitHub + кэш).
7. **Версия в логе каждого скрипта** (`var VERSION; console.log`) —
   обязательна, видно, обновился ли скрипт. Бамп при каждой правке.
8. **nodes-kN отражает сеть ПОСЛЕДНЕГО теста** (телефон шлёт полный кэш
   текущей сети: rh_speed_wifi / rh_speed_cell). Wi-Fi мерит все узлы;
   сотовая — 5, либо все при `cell_unlim`. Метки в именах меняются
   wifi<->cell — by design. Освежение при смене сети — netwatch (D.7).
9. **`cell_unlim`** — поле в `devices.json` у ключа (правится в гисте на
   GitHub). Worker прокидывает `opts=cellall` в argument спидтеста ->
   сотовая мерит все узлы у этого профиля. Поле переживает записи Worker.

## Контракты (для D.5+)
- **Аргумент спидтеста** (впечатывает Worker): `"<key>|<origin>|<opts>"`.
- **Метрика в имени узла:** ` · <down>↓ <rtt>ms` (разделитель ` · `).
  `baseName/stripMetric` срезают её; стабильный ключ узла — имя без метрики.
- **Локальный кэш скорости на телефоне:** `rh_speed_wifi`, `rh_speed_cell`
  в `$persistentStore`: `{ baseName: {down, rtt, ts} }`.
- **Переключение группы (A.12):** лог подтвердил рабочий API групп
  (`getSubPolicies` отдаёт `{type,name}`). В D.5 переключать `select`
  через `$config.getConfig(policyName, selectName)` (true/false) —
  подтвердить на устройстве при первом запуске core.

## ВРЕМЕННОЕ — снять/зафиксировать на D.9
- `debug-kN.json` в Worker (диагностика) — убрать.
- `?v=<ts>` cache-buster для script-path — заменить на стабильную версию.
- Форс `enabled=true` строки RH-Speed в Worker (в базовом routehub.conf
  она `enabled=false`) — прописать enabled=true в сам конфиг.

## Файлы Этапа D в репозитории
- `routehub-worker.js` (v0.4.7) — Worker.
- `routehub-speedtest.js` (v0.4.7) — спидтест (cron).
- `wrangler.toml` — конфиг авто-деплоя Worker.

## D.5 — план (следующий шаг)
`routehub-core.js` (cron, AI-селектор):
- Источник AI-пула: фильтр `[VPN]` (группа `RH-AI`, select).
- Страны: Германия всегда + 2 резервные (динамически: >3 узлов, по числу
  узлов; см. вывод 9 в СТАРТ.md). Только основные VPN (не обход/игры).
- Узел внутри страны — по локальной скорости (метка) + rtt.
- Sticky + hysteresis (+15 «якорь»), cooldown ~30 мин (не дёргать сессию).
- Живость/страна — из `routehub-ratings.json` (сервер). Скорость — локально.
- Race-condition флаг `RH_script_lock` (Раздел 17 плана).
- VERSION в логе. Имя узла матчить по стабильной части (до ` · `).
