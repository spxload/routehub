# 🔍 ИССЛЕДОВАНИЕ GITHUB — решения по 10 направлениям плана

> Дата: 2026-05-30. Широкое исследование открытых решений на
> GitHub по всем компонентам RouteHub (включая малозвёздные
> проекты «умельцев»). Цель — найти лучшие приёмы по каждому
> направлению плана и зафиксировать вердикт «брать / на
> рассмотрение / не брать».
>
> Звёзды и даты — на момент 2026-05-30, со временем меняются.
> Все ссылки — реальные, проверенные на эту дату.

---

## 🎯 ГЛАВНЫЙ АРХИТЕКТУРНЫЙ ВЫВОД

Все сильные проекты автотестирования (subs-check, clash-speedtest,
xykt/*) делают тяжёлую проверку **на сервере**, а клиент
(телефон) потребляет готовый рейтинг. Это ровно то, что заложено
в Этап B RouteHub. Подтверждает курс:

- **Сервер (GitHub Actions, каждые 2 ч):** детекция AI, гео, тип
  IP, скорость → JSON-рейтинг со скором стабильности (EWMA).
- **Loon-конфиг:** remote-rule списки + proxy-group
  (url-test/fallback) + ssid-триггеры.
- **Loon-скрипты (минимум):** панель статуса + автопереключение
  группы по серверному рейтингу.

Безопаснее (нет MITM на чувствительные домены), предсказуемее
(всё в документированном API Loon), легче чинить хрупкие маркеры
детекции (живут на сервере).

---

## 1. ДЕТЕКЦИЯ AI-СЕРВИСОВ (анонимно, без логина)

**Вывод:** «гениев» с готовым переключателем именно по
ChatGPT/Claude НЕТ НИГДЕ, даже среди малозвёздных. Всё сильное —
тем же анонимным методом, что у нас (потолок без логина).
Готовые переключатели существуют только для стриминга.

| Проект | ★ | Что | Вердикт |
|---|---|---|---|
| xykt/IPQuality | 8705 | Shell, медиа-анлок (вкл. ChatGPT) + 400+ blacklist-баз + тип IP. Push 2026-05-20 | **референс** |
| xykt/RegionRestrictionCheck | — | форк lmc999, ChatGPT + стриминг, docker | **референс** |
| lmc999/RegionRestrictionCheck | 5048 | эталон (изучен целиком). ChatGPT через compliance/cookie_requirements; Claude через редирект на anthropic.com/app-unavailable-in-region; Gemini маркер `45631641,null,true` | **референс** |
| xykt/NetQuality | 4942 | сетевое качество/маршруты (не AI) | на рассмотрение |
| NyanChanMeow/region_restriction_check-go | — | Go-порт lmc999, удобен для CI | на рассмотрение |

**Метод-потолок (подтверждён эталоном):** страна выхода + тип IP +
стабильность. Реальную доступность AI ПОД АККАУНТОМ сервер не
определяет принципиально (это видно только в авторизованной
сессии на телефоне — Этап D).

**Точные маркеры эталона (держать на сервере, легко чинить):**
- ChatGPT: `api.openai.com/compliance/cookie_requirements` →
  `unsupported_country` = блок. Надёжнее нашего POST chat-requirements.
- Claude: GET `claude.ai/`, редирект на
  `anthropic.com/app-unavailable-in-region` = блок. Точнее cdn-cgi/trace.
- Gemini: маркер `45631641,null,true` = регион ОК; код страны из
  паттерна `,2,1,200,"XXX"`. Только IP-регион, не аккаунт.

---

## 2. ГЕОЛОКАЦИЯ И ТИП IP

| Проект | ★ | Что | Вердикт |
|---|---|---|---|
| P3TERX/GeoLite.mmdb | 4839 | зеркало MaxMind GeoLite2 (Country/City/ASN) БЕЗ ключа, релизы 2×/нед | **БЕРЁМ** (уже внедрено в Этап B) |
| X4BNet/lists_vpn | 836 | datacenter/VPN ASN-списки, авто-обновление. Push 2026-05-30 | **БЕРЁМ** (для проблемы Gemini) |
| josephrocca/is-vpn | — | бинарь, X4BNet + ipsum, порог ≥3 флага, ~0.2 мс/запрос | **БЕРЁМ** |
| Xorlent/ASN-ThreatFeed | — | на базе IP2Location Lite | на рассмотрение |

**Голосование источников (уже в routehub-geo.py):** ip-api,
ipinfo, ipwho.is, ipapi.co, freeipapi + Cloudflare trace + MaxMind
локально → мажоритарная страна. Поля hosting/proxy/mobile + ASN —
тип IP. reverse-DNS (коды OVH/Hetzner/IATA в PTR) — доп. эвристика
города.

**Предел точности (честно):** страна ~99%; город хуже (датацентр
часто пусто, PTR спасает OVH/Hetzner); тип «датацентр» надёжен по
ASN; «VPN vs резидент» 100% недостижимо.

---

## 3. РЕЙТИНГ-СИСТЕМЫ И ИСТОРИЯ

| Проект | Что | Вердикт |
|---|---|---|
| VividCortex/ewma | каноничная EWMA, alpha=2/(N+1) | **БЕРЁМ как алгоритм** (уже в server) |
| Peak EWMA (Twitter Finagle) | взвешивание RTT числом активных запросов | на рассмотрение (для load-balance) |
| beck-8/subs-check | пайплайн: дедуп → alive → анлок+переименование → speedtest → all.yaml | **референс архитектуры** |
| sub-store-org/Sub-Store | менеджер подписок Loon/QX/Surge, параметр-ссылки | **БЕРЁМ** (parser — стандарт Loon) |
| ZeroDeng01/sublinkPro | самохостинг с автотестом задержки/скорости | на рассмотрение |

**История:** JSON в репозитории (как routehub-history.json) либо
sqlite на сервере; uptime — скользящим окном за 24 ч.

---

## 4. СПИДТЕСТ УЗЛОВ (Этап H)

| Проект | Что | Вердикт |
|---|---|---|
| faceair/clash-speedtest | Go, mihomo core; фильтры скорость/задержка/потери; rename по гео+скорости; output filtered.yaml; early-stop | **БЕРЁМ как основу Этапа H** |
| vpei/node (NodeSpeedTest) | сортировка по скорости, Netflix/UDP/ping | на рассмотрение |
| i-abc/Speedtest | bash с таблицей узлов | на рассмотрение |

**Приём «ночь Wi-Fi / день сотовый»:** два файла скорости
(speed_wifi.json / speed_cellular.json), выбор по ssid-триггеру
в Loon.

---

## 5. КОНФИГУРАЦИЯ LOON (Этап C)

| Проект | ★ | Что | Вердикт |
|---|---|---|---|
| Loon0x00/LoonExampleConfig | — | офиц. пример; типы скриптов, $httpClient params (node, alpn, auto-redirect/cookie) | **БЕРЁМ как базу синтаксиса** |
| luestr/ProxyResource | 4593 | плагины/правила/иконки, English-config. Push 2026-05-28 | **БЕРЁМ** (готовые плагины) |
| luestr/ShuntRules | — | объединённые правила Loon/Clash (один файл) | **БЕРЁМ** |
| fmz200/wool_scripts (Loon.conf) | — | готовые Proxy Group (AI/抖音/Telegram/WeChat) | референс групп |
| Moli-X/Resources (loon.conf) | — | General: skip-proxy, real-ip, proxy-test-url, geoip-url/ipasn-url, sub-store parser | **БЕРЁМ настройки General** |

**Приёмы:** url-test (interval=300,tolerance=100); fallback
(interval=180); ssid (default=/cellular=/HomeWifi=DIRECT);
логические AND/OR/NOT. PROTOCOL (HTTP/HTTPS/TCP/QUIC/STUN/UDP) и
SRC-PORT/DEST-PORT — с Loon 3.1.7 (665). QUIC-fallback protection
(REJECT QUIC при совпадении SNI с MITM-листом) — по умолчанию.

---

## 6. СКРИПТЫ LOON (Этап D)

| Проект | ★ | Что | Вердикт |
|---|---|---|---|
| fmz200/wool_scripts → Scripts/tools/NodeUnlockDetection.js | 5137 | панель детекции AI+стриминг через $httpClient.get({node}). Push 2026-05-30 | **БЕРЁМ как основу панели** |
| KOP-XIAO/QuantumultX → Scripts/geo_location.js | 2964 | каноничная GeoIP-панель через api.ip.sb/geoip, policy=узел. Push 2026-05-29 | **БЕРЁМ для гео-панели** |
| Keywos/rule → loon/jcloon.js, ipapi2.js | 169 | IP-инфо + анлок-панели через inputParams.node. Push 2026-05-30 | **БЕРЁМ** |
| Loon0x00/LoonScript → MediaCheck/check.js | — | origin-референс per-node теста (устарел 2023, но первоисточник идеи) | на рассмотрение (идея, не код) |

**API-приёмы:** `$config.getConfig()` → ssid, running_model,
all_policy_groups, policy_select; `$config.setSelectPolicy(group,
policy)`; `$config.setRunningModel(0/1/2)`; `$httpClient.get({url,
node, timeout, alpn})`; `$persistentStore.read/write`;
`$notification.post`; `$environment.params.node`.

**Важно:** готового ChatGPT-driven переключателя НЕТ — есть
только стриминговые (Orz-3 Bili_Auto_Regions.js, Peng-YM
auto-policy.js). Паттерн «тест → setSelectPolicy» берём у них,
саму AI-логику пишем сами.

---

## 7. РЕЖИМ РКН (Этап F)

**Ключевое разделение блокировок на ДВА типа:**

| Проект | ★ | Тип | Вердикт |
|---|---|---|---|
| 1andrevich/Re-filter-lists | 1191 | ВНУТРЕННИЕ (РКН режет наружу). Python, релизы ежедневно, сверка с реестром РКН | **БЕРЁМ** |
| dartraiden/no-russia-hosts | — | ВНЕШНИЕ (сервисы сами режут RU-IP: AI, Intel, Dell). hosts.txt | **БЕРЁМ** |
| misha-tgshv/shadowrocket-configuration-file | — | переупаковка Re:filter в готовый формат | **БЕРЁМ** (удобный формат) |

Вместе закрывают обе причины «сайт не открывается»: РКН +
самоблокировка сервисами. Детектор маяков — на сервере;
в Loon — применение результата (переключение группы).

---

## 8. TIKTOK (Этап J)

| Проект | ★ | Что | Вердикт |
|---|---|---|---|
| Semporia/TikTok-Unlock | 11819 | MITM на домены TikTok + URL Rewrite региона. Push 2025-09-18 (8 мес назад), 370 issue | **⚠️ НЕ БЕРЁМ** (MITM, ломкий, устарел, против принципа) |

**Альтернатива (берём):** маршрутизировать TikTok-домены на узел
нужной страны БЕЗ MITM и без переписывания региона. Домены:
tiktokv.com, byteoversea.com, ibytedtos.com, musical.ly,
tiktokcdn.com. Проще, предсказуемее, без риска для аккаунта.

---

## 9. ЗВОНКИ (Этап I)

**Приём (подтверждён):** правила `PROTOCOL,STUN` / `PROTOCOL,UDP`
в Loon 3.1.7+ → отдельная группа звонков с UDP-узлами;
`allow-udp-proxy = true`; real-ip для stun-доменов. Голос
(Telegram/WhatsApp/Discord) = STUN (NAT-traversal) + UDP/SRTP.

Антипаттерн: SS-узлы без UDP-релея звонки НЕ пропускают —
учесть при отборе узлов в группу. Готовые группы Telegram есть
в fmz200/wool_scripts и fanmingming/Rules.

---

## 10. СПИСКИ ПРАВИЛ

| Проект | ★ | Что | Вердикт |
|---|---|---|---|
| blackmatrix7/ios_rule_script | 26349 | OpenAI/Claude/Gemini/Telegram/YouTube/Apple раздельно, для Loon. Push 2026-05-29 | **БЕРЁМ (база)** |
| viewer12/OverseasAI.list | — | catch-all海外AI (все нужные нам AI), daily sync + NXDOMAIN-проверки | **БЕРЁМ (основной AI catch-all)** |
| szkane/ClashRuleSet | — | AI + QUIC-reject приём `AND,((NETWORK,UDP),(DST-PORT,443)),REJECT` | на рассмотрение (QUIC-reject полезен для AI) |
| Loyalsoldier/surge-rules | — | reject/direct RULE-SET | на рассмотрение |

Полный каталог списков с проверкой — в `КАТАЛОГ_СПИСКОВ.md`.

---

## ⚠️ ЧЕГО НЕ БЕРЁМ (риск/мусор)

- MITM на AI-домены и на TikTok — против принципа проекта,
  риск бана, ломается при обновлениях.
- Раздача чужих cookie/токенов — небезопасно (pull_request_target).
- jailbreak/«обход цензуры модели» репозитории (ShadowHackrs
  и подобные) — нерелевантны и небезопасны.
- Авторизованная проверка AI по узлам — impossible-travel-бан,
  отвергнута окончательно (Этап B).

---

## 📌 ПЛАН ПРИМЕНЕНИЯ (по этапам)

- **Этап B (сервер, идёт):** EWMA + P3TERX/GeoLite + X4BNet +
  is-vpn + голосование API. Точные маркеры lmc999 (ChatGPT/Claude/
  Gemini) — на рассмотрении к внедрению.
- **Этап C (конфиг):** General от Moli-X; группы от fmz200;
  правила blackmatrix7 + viewer12 + Re:filter + no-russia-hosts.
- **Этап D (скрипты):** панель на NodeUnlockDetection.js +
  geo_location.js; AI-переключатель пишем сами по паттерну
  «тест → setSelectPolicy».
- **Этап H (спидтест):** faceair/clash-speedtest, два файла
  скорости.
- **Этап F (РКН):** Re-filter (внутренние) + no-russia-hosts
  (внешние).
- **Этап I (звонки):** PROTOCOL,STUN/UDP + UDP-узлы.
- **Этап J (TikTok):** маршрутизация доменов без MITM.

---

## ССЫЛКИ (проверены 2026-05-30)

- xykt/IPQuality: github.com/xykt/IPQuality
- xykt/RegionRestrictionCheck: github.com/xykt/RegionRestrictionCheck
- lmc999/RegionRestrictionCheck: github.com/lmc999/RegionRestrictionCheck
- P3TERX/GeoLite.mmdb: github.com/P3TERX/GeoLite.mmdb
- X4BNet/lists_vpn: github.com/X4BNet/lists_vpn
- josephrocca/is-vpn: github.com/josephrocca/is-vpn
- VividCortex/ewma: github.com/VividCortex/ewma
- beck-8/subs-check: github.com/beck-8/subs-check
- sub-store-org/Sub-Store: github.com/sub-store-org/Sub-Store
- faceair/clash-speedtest: github.com/faceair/clash-speedtest
- Loon0x00/LoonExampleConfig: github.com/Loon0x00/LoonExampleConfig
- luestr/ProxyResource: github.com/luestr/ProxyResource
- luestr/ShuntRules: github.com/luestr/ShuntRules
- fmz200/wool_scripts: github.com/fmz200/wool_scripts
- KOP-XIAO/QuantumultX: github.com/KOP-XIAO/QuantumultX
- Keywos/rule: github.com/Keywos/rule
- 1andrevich/Re-filter-lists: github.com/1andrevich/Re-filter-lists
- dartraiden/no-russia-hosts: github.com/dartraiden/no-russia-hosts
- blackmatrix7/ios_rule_script: github.com/blackmatrix7/ios_rule_script
- viewer12/OverseasAI.list: github.com/viewer12/OverseasAI.list
- szkane/ClashRuleSet: github.com/szkane/ClashRuleSet
- Semporia/TikTok-Unlock: github.com/Semporia/TikTok-Unlock (⚠️ MITM)
