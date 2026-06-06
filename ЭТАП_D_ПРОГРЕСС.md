# ЭТАП D — ЗАВЕРШЁН (личные подписки, AI-селектор, спидтест, иконки)

> Источники: `ЭТАП_D_ФОРМУЛА.md` (метрики/иконки), `ЭТАП_D_ЛИЧНЫЕ_ПОДПИСКИ.md`
> (архитектура), `СТАРТ.md`. Состояние 2026-06-06.

## Статус: D.0–D.10 ГОТОВЫ и проверены на устройстве. Временные хаки сняты.
Дальше — Этапы E (Wi-Fi/сотовая), F (РКН-обход), I (звонки), J (TikTok): новые чаты.

## Что работает (подтверждено на k1)
- **core v0.6.1** (cron 30м): гейт green → балл AIM − штраф → **Германия-якорь
  АБСОЛЮТНЫЙ по ИМЕНИ узла** (флаг 🇩🇪 ИЛИ слово «Германия»), sticky внутри страны,
  возврат на якорь если узел увели. `setSelectPolicy` переключает (подтверждено).
- **health v0.1.4** (cron 5м): проба текущего AI-узла; мёртв → штраф + узел той
  же страны (по имени). ДЕБАУНС: читает `rh_ai_checked`; если узел проверяли <4.5 мин
  назад — пропускает тик; после пробы пишет `rh_ai_checked`.
- **netwatch v0.2.0** (network-changed): детект сети слоями (ssid→маяки/Яндекс→
  оператор), whitelist РКН, autorefresh. **+ ХУК проверки AI-узла при смене сети**:
  пробует текущий узел, мёртв → штраф + узел той же страны; защита от гонки
  (`lockBusy`), дебаунс 30с, пишет `rh_ai_checked`. async/await в Loon РАБОТАЕТ.
- **ai-bad v0.1.4** (generic, ВРУЧНУЮ): штраф +40 (затух. 6ч) + sticky-переход в той
  же стране (по имени); смена страны только если в стране нет зелёных.
- **viewer v0.1.0** (generic, ВРУЧНУЮ): экран состояния — выбранный AI-узел
  (страна/балл/причина/когда переключён/проверен), состояние сети, светофор по
  странам, метки скорости всех узлов, штрафы. Полный отчёт — в логе скрипта,
  сводка — в уведомлении. Ничего не меняет.
- **speedtest v0.4.13** (cron 20м): метрики down/rtt/jit/bl → POST.
- **worker v0.6.0**: /config (абсолютный URL скриптов + argument key|origin|opts),
  /speed (merge + иконки), /whoami. Иконки: блок ▁▃▅▇█+█⁺ (насыщ. 25=4K) + надстрочный
  % от быстрейшего узла сети. Сортировка nodes-kN по download.
- **conf C-draft-11**: RH-AI=select; RH-АВТО=fallback (по скорости); RH-Звонки/Обход=
  fallback; RH-Apple=select; **RH-Все**=select (ручной тест). Health 5м, Speed 20м, Core 30м,
  Net network-changed, кнопка RH-AI-плохо (generic), RH-Просмотр (generic).

## Защита AI-узла — три слоя, синхронизированы
- **core** (30м): план/якорь Германия.
- **health** (5м): проба текущего узла.
- **netwatch** (смена сети): мгновенная проба текущего узла (хук).
- **Синхронизация:** общий штамп `rh_ai_checked` (пишут health И netwatch) +
  `RH_script_lock` (один переключатель за раз). Если netwatch проверил узел при смене
  сети, health пропускает свой тик ближайшие 4.5 мин — не дублируют друг друга.
- **Кнопка** ai-bad (вручную): штраф + sticky-переход. **viewer** (вручную): только показ.

## КЛЮЧЕВОЙ УРОК D (зафиксировать)
- **Страна узла берётся ИЗ ИМЕНИ (флаг/слово), НЕ из GeoIP `rating.country`.** GeoIP
  выходного IP ВРЁТ: напр. «🇫🇮 Финляндия [VPN]» имеет country=DE; «🇬🇧 Великобритания»
  → RO; «🇦🇲 Армения» → PH. Функция `countryFromName` (flagToISO + словарь слов) — в
  core/health/netwatch/ai-bad/viewer одинаково. GeoIP оставлен только справкой.
- **Переключение группы: `$config.setSelectPolicy(group, node)`** (РАБОТАЕТ).
  `$config.getConfig(group,node)` — ЧИТАЮЩИЙ (возвращает весь конфиг), НЕ переключает.
- **async/await + Promise в Loon** (cron/network-changed/generic) — работают.
- **matchKey = norm(stripProvider(stripMetric(name)))**: stripProvider срезает ведущий
  `[Lastdep] ` — ключи рейтинга с префиксом, имена из getSubPolicies без. Без этого
  рейтинг матчился пусто.
- **Cron-таймер в Loon сбросить нельзя** (нет API). Синхронизация скриптов — через
  общий штамп `rh_ai_checked` + `RH_script_lock`, не через перепланирование cron.
- ssid на iOS появляется при разрешении «Локация: Всегда» (дом fh_86bd02_5G запомнен).

## Финальная зачистка (сделана)
- worker v0.6.0: убраны `?v=` кэш-сбиватель, форс RH-Speed, запись debug-kN.json.
- conf: RH-Speed enabled=true. Старые ai-region-switch.js/ai-switch-viewer.js — помечены
  устаревшими (можно удалить через веб-GitHub).
- Следствие: обновления скриптов теперь доходят по обычному кэшу Loon (~3-5 мин), без ?v=.

## Осталось проверить «в поле» (не блокирует закрытие D)
- **netwatch на сотовой вне дома**: строка оператора (whoami/ipaso) и поведение при
  whitelist. `ECHO_URL=https://yandex.ru/internet/` — подтвердить, отдаёт ли IP в теле;
  если нет — оператор «?», слои 1–2 работают.

## Выдача k2 жене
1. Дать жене ссылку конфига `https://routehub.proton4iker.workers.dev/config?key=k2`.
2. Её Loon добавляет как удалённый конфиг → первый спидтест сделает POST → Worker
   забиндит k2 (status free→bound, nonce её устройства), заведёт nodes-k2/metrics-k2.
3. Флаги k2 (cell_unlim/ewma/show_rtt/auto_refresh) — править в `devices.json` гиста.
4. Метки скорости у неё — свои (другой оператор/Wi-Fi), считаются на её телефоне.

## Файлы Этапа D (финальные версии)
worker v0.6.0, core v0.6.1, health v0.1.4, netwatch v0.2.0, ai-bad v0.1.4,
viewer v0.1.0, speedtest v0.4.13, conf C-draft-11, ЭТАП_D_ФОРМУЛА.md, wrangler.toml.

## Хранилище телефона ($persistentStore)
rh_speed_wifi/rh_speed_cell (кэш метрик), rh_core_state (sel:{k,live,country,score,
reason,lastSwitched}), rh_ai_penalty ({matchKey:{p,ts}}), rh_ratings_cache,
rh_net_state, rh_home_ssids, rh_home_aso, rh_ai_checked (общий штамп пробы AI-узла,
health+netwatch), rh_last_net, RH_script_lock.
