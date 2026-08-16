# Миграция рантайма на Cloudflare Workers + приватный репозиторий

> Статус: ЗАПЛАНИРОВАНО. Делать ПОСЛЕ полевого подтверждения Этапа E
> и обновления документации. Один этап = один чат.
> Решение принято Дианой 2026-06-08.

## Цель
Убрать гист и GitHub Actions, сделать репозиторий приватным. GitHub
остаётся только ПРИВАТНЫМ хранилищем кода + авто-деплоем Worker'а.
Весь рантайм — на Cloudflare.

## Целевая архитектура (после миграции)
- **GitHub (private):** исходники (worker, conf, Loon-скрипты, доки) +
  авто-деплой Worker'а в Cloudflare (GitHub-приложение Cloudflare
  работает и с приватными репозиториями).
- **Cloudflare Worker:** отдача `/config`, `/nodes`, `/whoami`,
  `/status`, `/speed` + публикация узлов по cron + хранилище KV.
- **Гист и GitHub Actions — удалены.**

## Что переносится
1. **conf + Loon-скрипты** (`speedtest`, `netwatch`) → отдаёт сам Worker
   (встроенные строки или KV). Убирается зависимость от public
   `raw.githubusercontent.com`. Это ОБЯЗАТЕЛЬНОЕ условие приватности
   репо: при private публичные raw-ссылки перестают работать, Loon не
   может авторизоваться.
2. **Гист → Cloudflare KV:** `lastdep-nodes.txt` (мастер),
   `metrics-kN.json`, `devices.json`.
3. **GitHub Actions** (`publish_nodes.py`, cron 2 ч) → **Cron Trigger
   воркера** (`scheduled`). Порт `publish_nodes.py` на JS: fetch
   подписки Lastdep (UA `Shadowrocket/3274` + `X-HWID`), декод base64,
   сортировка по флагу (DE первой, дальше по числу `[VPN]`-узлов),
   запись мастера в KV.
4. После п.1–3 — репозиторий в **private**.

## Порядок (черновой; детали — на старте чата миграции)
1. Создать KV-namespace, привязать в `wrangler.toml`.
2. Разовый сид: скопировать из гиста в KV `master`/`metrics`/`devices`.
3. Worker: чтения `master`/`metrics`/`devices` с гиста → на KV; `/speed`
   пишет метрики в KV.
4. Worker: встроить шаблон conf (убрать `fetch(CONFIG_URL)`); отдавать
   Loon-скрипты Worker'ом (эндпоинт вида `/s/<name>`); `script-path`
   переписывать на Worker-URL.
5. Worker: `scheduled`-обработчик публикации (порт `publish_nodes`) →
   мастер в KV; удалить `.github/workflows/` и `publish_nodes.py`.
6. Проверка на k1: conf грузится, скрипты с Worker, подписка из KV,
   спидтест пишет в KV, флип сети работает.
7. Репозиторий → private. Секреты `SUBSCRIPTION_URL`/`SUB_HWID` → в env
   Worker'а (`wrangler secret`); `GIST_*` убрать; variable `VERIFY_AI`
   уже не нужен.

## Лимиты (оценка; точные цифры свериться перед стартом)
- Нагрузка семьи из 2 устройств: < 1000 запросов/день — запас на
  бесплатном плане огромный.
- KV: чтений сотни/день, записей < 200/день, хранилище десятки КБ
  (при типичных лимитах 100k чтений / 1k записей / 1 ГБ).
- CPU ~10 мс/запрос на free — текущие операции (`/config`, `/nodes`)
  укладываются; следить при росте числа узлов до сотен.
- Точные лимиты/цены Cloudflare со временем меняются — сверить на
  актуальной странице перед стартом.

## Риски / оговорки
- У KV-данных нет git-бэкапа (`devices.json` — ключи/nonce). Возможен
  периодический экспорт.
- Перенос метрик/реестра в KV без потери привязки устройства (nonce) —
  разовая аккуратная миграция.
- Под whitelist РКН `*.workers.dev` недоступен — перенос на Worker
  этого НЕ меняет (public raw GitHub так же недоступен). Уже
  загруженное в Loon работает; обновление conf/скриптов в whitelist
  невозможно при любой схеме.

## НЕ делать до
Полевого подтверждения Этапа E (флип сети `-W`/`-C`; список узлов не
схлопывается, ≈158) и обновления документации.

## Текущее состояние (на момент решения, 2026-06-08)
- Модель ОДНОЙ подписки, динамические постраные AI-тиеры
  (Worker v0.9.2, conf C-draft-17).
- Мёртвый код удалён: `core`/`health`/`ai-bad`/`viewer`/`ai-watch`/
  `ai-region-switch`/`ai-switch-viewer`/`lastdep-headers`/`config.lcf`/
  `diag_ai` + серверная ветка (`server.py`/`geo.py`/`config.json`/
  `ratings`/`history`).
- `check.yml` ужат до одного шага `publish_nodes.py`.
- Гист: `nodes-kN.txt` больше не пишется (удалить вручную); живы
  `lastdep-nodes.txt`, `metrics-kN.json`, `devices.json`.
- Активные скрипты Loon: `RH-Speed` (спидтест), `RH-Net` (netwatch).
