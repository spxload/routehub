# 📘 ДОКУМЕНТАЦИЯ LOON — полный перевод на русский

> Перевод официальной документатации Loon (nsloon.app/docs,
> репозиторий Loon0x00/LoonManual). Версия Loon 3.3.9.
> Переведено для проекта RouteHub. Технические термины, имена
> параметров и примеры кода оставлены как в оригинале.
> Структура повторяет оригинал: Введение, Узлы, Правила,
> Политики,复писи (Rewrite), Скрипты, Плагины, DNS, Общие
> настройки, Scheme.

---

# 1. ВВЕДЕНИЕ

Loon — мощный сетевой инструмент для iOS. Поддерживает разделение
трафика на основе доменов, IP, URL, правил SSID. Мощные комбинации
групп политик покрывают любые задачи маршрутизации. Loon может
перехватывать, сохранять и изменять HTTP/HTTPS-трафик; вместе с
JavaScript решает любые сложные задачи.

ВАЖНО: Loon не предоставляет прокси-серверы — их нужно покупать
или поднимать самому.

---

# 2. УЗЛЫ (节点 / ПРОКСИ-СЕРВЕРЫ)

Узел = один прокси-сервер. Можно добавить узел вручную или
скачать узлы через подписку. **Loon сам узлов не предоставляет.**

## 2.1 Узлы подписки
Узлы подписки — это набор узлов от провайдера. Loon только
скачивает и парсит их; редактировать узлы подписки в Loon
нельзя — за изменениями обращаться к провайдеру.

## 2.2 Информация о трафике подписки
Loon читает заголовок ответа подписки `Subscription-Userinfo`:
```
Subscription-Userinfo: upload=1111;download=111;total=123456;expire=1614527045
```
(отдача, скачивание, всего, срок).

## 2.3 Поддерживаемые протоколы
- ShadowSocks (stream/aead/2022)
  - ShadowSocks + shadow-tls2/3
  - ShadowSocks + simpleObfs
  - ShadowSocks + simpleObfs + shadow-tls2/3
- ShadowSocksR
  - ShadowSocksR + shadow-tls2/3
- VMESS (+ TLS, + WebSocket, + WebSocket+TLS, + HTTP, + HTTP+TLS)
- VLESS (+ WebSocket, + HTTP, + xtls-rprx-vision + reality)
- Trojan (+ WebSocket, + HTTP)
- HTTP
- HTTPS
- Socks5
- Wireguard
- Hysteria2
- Custom by JS (свой протокол на JavaScript)

ВАЖНО: на 3.2.1(727) среди поддерживаемых протоколов только
HTTP/S и Custom-by-JS НЕ поддерживают ретрансляцию UDP.
Остальные могут (через параметр `udp=true`).

## 2.4 Формат узла в конфиге
Если добавлять/изменять отдельный узел в конфиге вручную —
формат такой:

ShadowSocks:
```
ss1 = Shadowsocks,example.com,443,aes-128-gcm,"password",fast-open=false,udp=true
```
ShadowSocks + shadow-tls:
```
ss3 = Shadowsocks,example2.com,443,2022-blake3-aes-128-gcm,"...:...",fast-open=true,udp=true,shadow-tls-password=1,shadow-tls-sni=douyin.com,shadow-tls-version=3,udp-port=8396
```
ShadowSocks + simple obfs:
```
ssObfs1 = Shadowsocks,example.com,80,aes-128-gcm,"password",obfs-name=http,obfs-host=www.micsoft.com,obfs-uri=/,fast-open=true,udp=true
```
ShadowSocksR:
```
ssr1 = ShadowsocksR,example.com,443,aes-256-cfb,"password",protocol=origin,obfs=http_simple,obfs-param=download.windows.com,fast-open=false,udp=true
```
HTTP:
```
http1 = http,example.com,80
http2 = http,example.com,80,username,"password"
```
HTTPS:
```
https3 = https,example.com,443,username,"password",skip-cert-verify=true,sni=example.com,tls-pubkey-sha256=...,tls-cert-sha256=...
```
Socks5:
```
socks5 = socks5,example.com,443,username,"password",skip-cert-verify=true,sni=example.com,udp=true
```
VMESS+tcp:
```
vmess1 = vmess,example.com,10086,aes-128-gcm,"UUID",transport=tcp,alterId=0,over-tls=false,udp=true
```

Параметры узлов:
- `fast-open` — TCP Fast Open (нужна поддержка узла)
- `udp` — использовать ли узел для UDP (нужна поддержка узла)
- `udp-port` — для shadow-tls (не поддерживает UDP-переадресацию,
  здесь указывается исходный ss-порт для UDP)
- `skip-cert-verify` — пропустить проверку сертификата
- `sni` — SNI при TLS-рукопожатии (если не указан — хост узла)
- `tls-pubkey-sha256` / `tls-cert-sha256` — отпечатки сертификата

## 2.5 Парсер подписок (resource-parser)
Кроме официальных форматов Loon парсит большинство форматов
провайдеров. Если формат не поддержан — используется скрипт-
парсер подписок (обычно Sub-Store от Peng-YM):
```
resource-parser = https://github.com/sub-store-org/Sub-Store/releases/latest/download/sub-store-parser.loon.min.js
```
После настройки — включить парсер на странице добавления
подписки.

## 2.6 ФИЛЬТРАЦИЯ УЗЛОВ (筛选节点)
После добавления нескольких узлов/подписок их можно
классифицировать (например, все узлы Гонконга в одну группу).
Способы фильтрации:
- **NodeSelect** — ручной выбор узлов
- **NameKeyword** — фильтр по ключевому слову в имени
- **NameRegex** — фильтр регулярным выражением по имени

Настройка в App: страница конфигурации → «Фильтр узлов» →
добавить (по умолчанию выбираются все узлы).

Частые regex-шаблоны:
```
^.*(A|B)        = A или B
(A.*B|B.*A)     = есть A и есть B
^(?!.*A)        = не содержит A
^(?!.*?B).*A    = есть A, но не содержит B
```

---

# 3. ПРАВИЛА (规则)

Узлы перенаправляют трафик, а правила решают, какой узел
использовать. HTTP-правила применяются только к HTTP/HTTPS-
запросам.

## 3.1 Доменные правила

### DOMAIN — совпадение всего домена
```
DOMAIN,google.com,proxy
```

### DOMAIN-SUFFIX — совпадение суффикса домена
`apple.com` совпадёт с `icloud.apple.com`, `www.apple.com`,
но НЕ совпадёт с `app-apple.com`.
```
DOMAIN-SUFFIX,apple.com,proxy
```

### DOMAIN-KEYWORD — совпадение по ключевому слову
```
DOMAIN-KEYWORD,apple,proxy
```

## 3.2 IP-правила

### IP-CIDR (IPv4)
```
IP-CIDR,118.89.204.198/32,no-resolve
```

### IP-CIDR6 (IPv6)
```
IP-CIDR6,2402:4e00:1200:ed00:0:9089:6dac:96b6/128
```

### GEOIP — по стране IP (по базе mmdb)
```
geoip,cn,DIRECT
```

### IP-ASN — по провайдеру (автономной системе) IP
```
IP-ASN,4134,DIRECT,no-resolve
```

**Опция `no-resolve`**: если указана — правило срабатывает
только для адресов, которые УЖЕ являются IP. Для доменных
адресов DNS-резолвинг ради этого правила НЕ запускается.
Чтобы избежать лишних DNS-запросов, для чисто-IP-правил
всегда добавляйте `no-resolve`.

## 3.3 HTTP-правила
Применяются только к HTTP/HTTPS-запросам.

### URL-REGEX — регулярное выражение по URL
```
URL-REGEX,^http://google\.com,PROXY
```

### USER-AGENT — по заголовку user-agent (с подстановками)
```
USER-AGENT,Apple*,DIRECT
```

## 3.4 Правила портов (3.1.7+)
Совпадение по исходному или целевому порту.
- конкретный порт: `DEST-PORT,443,DIRECT`
- диапазон (закрытый интервал): `DEST-PORT,80-443,DIRECT`
- бесконечный интервал (`>, <, <=, >=`): `DEST-PORT,>=443,DIRECT`

### SRC-PORT — по исходному порту
```
SRC-PORT,443,DIRECT
SRC-PORT,80-443,DIRECT
SRC-PORT,>=443,DIRECT
```

### DEST-PORT — по целевому порту
```
DEST-PORT,443,DIRECT
DEST-PORT,80-443,DIRECT
DEST-PORT,>=443,DIRECT
```

## 3.5 Правила протоколов (3.1.7+)
Совпадение по типу протокола запроса. Поддерживаются:
`HTTP / HTTPS / TCP / QUIC / STUN / UDP`.

### PROTOCOL
```
PROTOCOL,STUN,REJECT
```

## 3.6 Логические правила (3.1.7+)
Объединяют несколько правил через ИЛИ / И / НЕ.
**Если в логическом правиле есть и домен, и IP — IP-подправило
ставить последним, чтобы избежать лишних DNS-запросов.**

### AND — совпадает, когда выполнены ВСЕ подправила
```
AND,((DOMAIN-SUFFIX,example),(DEST-PORT,443),(GEOIP,CN)),DIRECT
```

### OR — совпадает, когда выполнено ХОТЯ БЫ ОДНО
```
OR,((DOMAIN-SUFFIX,example),(DEST-PORT,443),(GEOIP,CN,no-resolve)),DIRECT
```

### NOT — совпадает, когда подправило НЕ выполнено (одно подправило)
```
NOT,((AND,((DOMAIN-SUFFIX,example),(DEST-PORT,443),(GEOIP,CN)))),DIRECT
```

## 3.7 Final — резервное правило
Используется, когда не совпало ни одно правило конфигурации.
```
final,DIRECT
```

## 3.8 Подписка на правила (Remote Rule)
```
https://raw.githubusercontent.com/Loon0x00/LoonExampleConfig/master/Rule/ExampleRule.list, PROXY
```
Loon выдерживает сотни тысяч правил без проблем с
производительностью, кэширует недавние результаты по алгоритму
LRU (время попадания в кэш ≈ 0 мс).

## 3.9 Приоритет сопоставления правил (важно)
С версии 3.0.3 алгоритм сопоставления:
- Если целевой адрес запроса — ДОМЕН: сначала проверяются
  доменные правила. Если совпало доменное правило — IP-правила
  НЕ проверяются. Если доменное не совпало — Loon делает
  локальный DNS-запрос и по результату проверяет IP-правила.
- Все остальные правила (кроме доменных и IP) сопоставляются
  в порядке их следования в конфиге: выше = выше приоритет.
- Приоритет источников: **локальные правила > правила плагина
  > правила подписки**. Если не совпало ничего — Final.
Причина такого алгоритма: избежать лишних DNS-запросов от
IP-правил без `no-resolve`.

ПРОИЗВОДИТЕЛЬНОСТЬ ПРАВИЛ (тест iPhone 15 Pro):
- `DOMAIN, DOMAIN-SUFFIX, IP-CIDR, IP-CIDR6, GEOIP, IPASN,
  SRC-PORT, DEST-PORT, PROTOCOL` — время поиска НЕ растёт с
  количеством правил.
- 100 000+ доменных правил — поиск <5 мс; 100 000+ IP-CIDR —
  <5 мс; 100 000+ IP-CIDR6 — <20 мс.
- `DOMAIN-KEYWORD, USER-AGENT, URL-REGEX` — время растёт с
  количеством (5000+ DOMAIN-KEYWORD — в пределах 10 мс).
- ВЫВОД: предпочитать первую группу типов правил.

---

# 4. ПОЛИТИКИ (策略)

Механизм движения трафика в Loon:
**запрос с телефона → совпадение правила → запрос политики,
указанной правилом → получение узла по политике**

Правило указывает на политику; политика определяет узел.
Политика может быть трёх видов: **узел, встроенная политика,
группа политик**.

## 4.1 Политика-узел
Когда политика — это узел, трафик идёт через этот узел.
Правило можно направить прямо на узел:
```
DOMAIN,google.com,香港01
```

## 4.2 Встроенные политики
Два типа: прямое соединение и отклонение.

### Прямое соединение (DIRECT)
Трафик идёт напрямую к цели, минуя прокси.
```
DOMAIN,apple.com,DIRECT
```

### Отклонение (REJECT)
Трафик не отправляется никуда (обычно для блокировки рекламы).
Виды:
- **REJECT** — возвращает 404 и пустое тело
- **REJECT-IMG** — возвращает 200 и тело: GIF 1 пиксель
- **REJECT-DICT** — возвращает 200 и пустой JSON-объект
- **REJECT-ARRY** — возвращает 200 и пустой JSON-массив
- **REJECT-DROP** — отклоняет и отбрасывает запрос, не возвращая
  ответа (некоторые программы при сбое соединения тут же
  агрессивно повторяют запрос — REJECT-DROP гасит такой
  «шторм запросов»)

## 4.3 Группы политик (策略组)
Группа политик — набор политик/групп; выбор политики из группы
делается вручную или автоматически. Объявляется в `[Proxy Group]`.
Группы можно вкладывать друг в друга.

### select — ручной выбор
Ручной тип: нужно вручную выбрать политику на странице политик.

### url-test — выбор быстрейшего
По заданному url каждый интервал тестирует все узлы группы,
выбирает самый быстрый.
Параметры:
- `url` — url для теста (Loon делает header-запрос)
- `interval` — интервал теста, секунды
- `tolerance` — допуск; если разница между новым лучшим узлом
  и прежним меньше tolerance — переключения не будет, мс

### fallback — первый доступный
По url каждый интервал тестирует узлы, выбирает первый
доступный.
Параметры:
- `url` — url для теста
- `interval` — интервал, секунды
- `max-timeout` — макс. таймаут; если узел тестируется дольше
  этого значения, считается недоступным, мс

### load-balance — балансировка нагрузки
По выбранному алгоритму автоматически выбирает подполитику.
Параметры:
- `url`, `interval`, `max-timeout` — как выше
- `algorithm` — алгоритм балансировки:
  - **Random** — случайный выбор подполитики
  - **PCC** — на основе Random, но PCC закрепляет запросы с
    одинаковым хостом за одним узлом
  - **Round-Robin** — выбор по кругу

---

# 5. ПЕРЕПИСЫВАНИЕ (复写 / Rewrite)

Переписывание обрабатывает HTTP/S-запросы: до отправки запроса
и после получения ответа изменяет данные — URL, заголовки,
тело запроса и тело/заголовки ответа. **Работает только в
HTTP-запросах или в HTTPS, расшифрованных через MITM.**
**Обработка переписывания идёт ДО сопоставления правил.**

(Примечание для RouteHub: переписывание используется только с
MITM, который проект не применяет. Раздел приведён для полноты.)

## 5.1 Приоритет
Как и у правил: переписывание в локальном конфиге > переписывание
в плагине. В одном файле — приоритет сверху вниз убывает.

## 5.2 URL-переписывание
```
^http://www\.google\.cn header http://www.google.com
```

## 5.3 Прямой ответ (редиректы)
302: `^http://example.com 302 https://example.com`
307: `^http://example.com 307 https://example.com`

reject-типы переписывания:
- `reject` — разрыв соединения
- `reject-200` — 200 + пустое тело
- `reject-img` — 200 + картинка 1 пиксель
- `reject-dict` — 200 + пустой JSON-объект `{}`
- `reject-array` — 200 + пустой JSON-массив `[]`

## 5.4 Переписывание заголовков запроса
```
^http://example.com header-add Connection keep-alive
^http://example.com header-del Cookie
^http://example.com header-replace User-Agent Unknown
^http://example.com header-replace-regex User-Agent regex replace-value
```
Если в параметре есть пробел — заменять на `\x20`.

## 5.5 Переписывание тела запроса (build 729+)
```
^http://example.com request-body-replace-regex regex1 value1
^http://example.com request-body-json-add data.apps[0] {...}
^http://example.com request-body-json-replace data.ad {}
^http://example.com request-body-json-del data.ad
^http://example.com request-body-json-jq 'del(.data.ad)'
```

## 5.6 Mock-тело (заглушки)
`mock-request-body` / `mock-response-body` — подставить
фейковые данные. Типы: json, text, css, html, javascript,
png, gif, jpeg и др.

## 5.7 Переписывание ответа (build 729+)
`response-header-add/del/replace`, `response-body-replace-regex`,
`response-body-json-add/replace/del/jq` — аналогично запросу.

---

# 6. СКРИПТЫ (脚本)

## 6.1 Типы скриптов

### http-request — срабатывает при HTTP-запросе
```
http-request ^https?:\/\/(www.)?(example)\.com script-path=localscript.js,tag=requestScript,requires-body=true,timeout=10,binary-body-mode=false,argument="1234",enable=true
```
Таймаут по умолчанию 10с. Доступны: все Script API, `$request`
(url, method, headers, body, h2_trailers), `$response`=undefined.
`$done()`: без параметров — отбросить запрос; `$done({})` —
продолжить без изменений; `$done({url,headers,node,...})` —
заменить параметры; `$done({response:{...}})` — вернуть
фейковый ответ.

### http-response — срабатывает при HTTP-ответе
```
http-response ^https?:\/\/(www.)?(example)\.com script-path=...,requires-body=true,tag=responseScript,enable=true
```
Доступны: все Script API, `$request`, `$response`
(status, headers, body, h2_trailers).

### cron — по расписанию
```
cron "0 8 * * *" script-path=cron.js,tag=cronScript,timeout=300,argument="1234",enable=true
```
Формат: `"мин час день месяц неделя"` или с секундами
`"сек мин час день месяц неделя"`. Таймаут по умолчанию 200с.

### network-changed — при смене сети
```
network-changed script-path=...,tag=changeModel,timeout=300,enable=true
```
**ВАЖНО: если есть несколько скриптов network-changed,
вызывается ТОЛЬКО первый в конфиге.** Таймаут по умолч. 200с.

### generic — общий, запускается вручную
```
generic script-path=...,tag=GeoLocation,timeout=10,img-url=location.fill.viewfinder.system,argument="1234",enable=true
```
Скрипт с узлом/группой/правилом как параметром, запускается
вручную из интерфейса. `$environment.params.node` /
`.nodeInfo` — данные узла.

## 6.2 Script API

### Базовое
- `console.log()` — печать
- `setTimeout(callback, ms, ...vars)` — асинхронный таймер;
  `$done()` вызывать ВНУТРИ callback после завершения задачи
- `$loon` — имя устройства, версия системы, версия и build app
- `$script.name` / `$script.startTime` — имя и время запуска

### $config
- `$config.getConfig()` — текущая конфигурация (JSON-строка):
  включает `running_model` (0 глоб.директ / 1 правила /
  2 глоб.прокси), `all_buildin_nodes` (["DIRECT","REJECT"]),
  `global_proxy` (узел глобального прокси), `all_policy_groups`
  (список всех групп), `ssid` (текущий Wi-Fi), `final`
  (политика FINAL), `policy_select` (выбранная подполитика
  каждой группы)
- `$config.getConfig(policyName, selectName)` — установить
  выбранную политику группы; true/false
- `$config.getSubPolicies(policyName, callback)` — получить
  подполитики группы (callback, массив строк)
- `$config.getSelectedPolicy(policyName)` — имя выбранной
  подполитики группы
- `$config.setRunningModel(model)` — режим Loon (int: 0/1/2)

### $persistentStore — локальное хранилище
- `$persistentStore.write(value, [key])` — сохранить; key и
  value — строки; без key — хэш имени скрипта; true/false
- `$persistentStore.read([key])` — прочитать
- `$persistentStore.remove()` — очистить все данные скрипт-API

### $notification
- `$notification.post(title, subtitle, content, attach, delay)`
  — локальное уведомление iOS; attach может быть строкой
  (ссылка перехода) или объектом `{openUrl, mediaUrl, clipboard}`

### $httpClient — сетевые запросы
- `$httpClient.get/post/head/delete/put/options/patch(params, callback)`
- params: `url`, `timeout`(мс, дефолт 5000), `headers`, `body`,
  `body-base64`, `node` (узел/группа/описание узла, через
  который слать), `binary-mode`, `auto-redirect`, `auto-cookie`,
  `alpn` (h1/h2; для нескольких запросов к одному хосту — h2)
- callback(errormsg, response, data): errormsg — причина ошибки
  (null при успехе); response — {status, headers, h2_trailers};
  data — тело ответа

### $utils — инструменты
- `$utils.geoip(ipStr)` — GEOIP IP (код ISO 3166)
- `$utils.ipasn(ipStr)` — ASN IP
- `$utils.ipaso(ipStr)` — ASO IP
- `$utils.ungzip(binary)` — распаковать gzip

### Прочее
- `$done()` — завершить скрипт, освободить ресурсы (обязательно)
- `$environment` — только для generic-скриптов

---

# 7. ПЛАГИНЫ (插件)

Плагин — набор правил, переписываний, скриптов; по сути
под-конфиг, обычно представляет одну расширенную функцию.

## 7.1 Модули, которые может содержать плагин
```
#!name= Имя плагина
#!desc= Описание плагина
#!author= Автор
#!homepage= Домашняя страница (переход со страницы плагина)
#!icon= Ссылка на иконку
#!system= iOS,iPadOS,tvOS,macOS — поддерживаемые системы
#!system_version= 15 — мин. версия системы (только iOS)
#!loon_version= 3.2.1(733) — мин. версия Loon
#!tag= Категория плагина

[Argument]
arg1 = input,"значение-по-умолчанию",tag=Заголовок,desc=Описание
arg2 = select,"вариант1","вариант2",tag=Заголовок,desc=Описание
arg3 = switch,true,tag=Заголовок,desc=Описание

[General]
[rule]
[rewrite]
[host]
[script]
[mitm]
```

## 7.2 [Argument] — параметры плагина (build 733+)
Объявляет параметры, которые показываются в UI плагина.
Формат: `имя = тип,"значения",tag=название_в_UI,desc=описание`
Три типа:
- **input** — пользователь вводит текст; значение после типа —
  значение по умолчанию (в двойных кавычках)
- **select** — пользователь выбирает; каждый вариант в кавычках;
  по умолчанию — первый
- **switch** — переключатель в UI; первое значение — значение
  по умолчанию (если не задано — false)

Использование параметров:
- передаются в скрипт через `argument`: `argument=[{arg1},{arg2}]`,
  в скрипте читаются как `$argument.arg1`
- для cron-скриптов параметром можно задать само расписание:
  `cron {arg1} script-path=...` (если формат cron в параметре
  битый — скрипт не запустится)
- параметром можно включать/выключать скрипт: `enable={arg1}`
  (тип параметра должен быть switch, иначе считается true)

## 7.3 Политики в правилах плагина
Правила внутри плагина могут указывать только на:
1. **DIRECT**
2. **REJECT-типы** (REJECT, REJECT-IMG, REJECT-DICT,
   REJECT-ARRY, REJECT-DROP)
3. **PROXY** — группа, которую пользователь выбирает вручную
   при настройке плагина (если выбрал PROXY, но плагин не
   настроен — поведёт себя как «группа не найдена», т.е.
   используется первый узел в глобале)

То есть правила плагина НЕ могут ссылаться на произвольную
именованную группу из главного конфига.

## 7.4 Репозиторий плагинов
github.com/Peng-YM/Loon-Gallery — плагины от сообщества.

---

# 8. DNS

Loon (с build 427) поддерживает 4 типа DNS-запросов:
- стандартный UDP-запрос
- DNS-over-HTTPS (DoH)
- DNS-over-QUIC (DoQ)
- DNS-over-HTTP3 (DoH3)

## 8.1 Конфигурация
```
[General]
dns-server = system,119.29.29.29,223.5.5.5
doh-server = https://example.com/dns-query
doq-server = quic://example.com:784
doh3-server = h3://example.com/dns-query
```

## 8.2 Логика запросов
Все DNS-запросы делятся на обычные и шифрованные (DoH/DoQ/DoH3).
Если настроены и шифрованные, и обычные серверы — выполняются
ТОЛЬКО шифрованные запросы; запрос идёт параллельно ко всем
действующим серверам, используется самый быстрый ответ.

## 8.3 Кэш DNS
LRU-кэш на 100 записей (на iOS15+ — 200). Действует во время
работы Loon; при закрытии кэш очищается.

## 8.4 Откат запроса
Если шифрованный DNS-запрос не удался — выполняется обычный
запрос. Можно отключить на странице DNS-серверов в App.

## 8.5 DNS-маппинг ([Host])
Когда для конкретного домена нужен особый DNS или фиксированный
IP. Режимы:
- домен → домен (заменить домен на другой)
- домен → IP (указать домену фиксированный IP)
- домен → DNS-сервер (этот домен резолвить через указанный DNS)
- DNS по конкретному SSID
- домен → ip-mode индивидуально

Примеры:
```
example.com = 192.168.1.20
example.com = example.com.cn
*.testflight.apple.com = server:8.8.4.4
*.apple.com = server:system
ssid:LOON's WIFI = server:system
ssid:LOON WIFI = server:https://example.com/dns-query
example.com = ip-mode:ipv4-only
```

---

# 9. ОБЩИЕ НАСТРОЙКИ ([General])

## bypass-tun
Трафик на iOS идёт в Loon двумя путями: HTTP Proxy и TUN
(виртуальный сетевой адаптер). bypass-tun относится к TUN:
указанные IP-диапазоны/домены НЕ передаются в Loon — система
обрабатывает их напрямую.
```
bypass-tun = 192.168.0.0/16,localhost,*.local
```

## skip-proxy
Аналогично, но для HTTP Proxy: указанные IP/домены не передаются
в Loon, обрабатываются системой.
```
skip-proxy = 192.168.0.0/16
```

## dns-server
UDP DNS-серверы, через запятую; `system` — системный DNS.
```
dns-server = system,1.1.1.1
```

## doh-server
DNS over HTTPS, через запятую.
```
doh-server = https://doh.dns.apple.com/dns-query
```

## doq-server
DNS over QUIC, через запятую, порт по умолчанию 784.
```
doq-server = quic://example.com, quic://example2.com
```

## doh3-server
DNS over HTTP3.
```
doh3-server = h3://223.6.6.6/dns-query
```

## ip-mode (3.2.3+ build 754)
Заменил устаревший `ipv6`. Типы:
- **ipv4-only** — только IPv4, без AAAA-запросов, отклоняет все
  IPv6-соединения
- **dual** — параллельные A и AAAA, используется самый быстрый
  ответ, без различения IPv4/IPv6
- **ipv4-preferred** — параллельные A и AAAA, приоритет IPv6,
  при отсутствии IPv6 — IPv4 (примечание: в оригинале описание
  именно такое)
- **ipv6-preferred** — параллельные A и AAAA, приоритет IPv4,
  при отсутствии IPv4 — IPv6
```
ip-mode = dual
```

## allow-wifi-access
Включить доступ к прокси из локальной сети.
```
allow-wifi-access = true
```

## wifi-access-http-port / wifi-access-socks5-port
HTTP / SOCKS5 порты при включённом доступе из локальной сети.
```
wifi-access-http-port = 8899
wifi-access-socks5-port = 8898
```

## proxy-test-url
URL для теста скорости узлов; используется, если у группы
политик нет своего тестового URL.
```
proxy-test-url = http://cp.cloudflare.com/generate_204
```

## internet-test-url
URL для проверки доступности сети; указывать URL, доступный
напрямую.
```
internet-test-url = http://wifi.vivo.com.cn/generate_204
```

## test-timeout
Таймаут при тесте скорости узлов, секунды.
```
test-timeout = 5
```

## switch-node-after-failure-times
**УСТАРЕЛО (3.2.3+ build 754).** Сейчас Loon автоматически
определяет доступность узла и переключает по контексту.

## resource-parser
Ссылка на парсер ресурсов подписки (рекомендуется sub-store
от Peng-YM).
```
resource-parser = https://github.com/sub-store-org/Sub-Store/releases/latest/download/sub-store-parser.loon.min.js
```

## ssid-trigger
При переключении на определённый Wi-Fi меняет режим трафика
Loon. Например `"loon-wifi5g":DIRECT` — в сети loon-wifi5g
использовать прямой режим; `"cellular":PROXY` — в сотовой сети
режим прокси; `"default":RULE` — по умолчанию режим правил.
```
ssid-trigger = "loon-wifi5g":DIRECT,"cellular":PROXY,"default":RULE
```

## real-ip
Некоторые приложения сами запрашивают DNS и получают IP, из-за
чего доменные правила не срабатывают. Loon использует FakeIP
(перехват DNS-запросов, возврат фейкового IP), но иногда система
кэширует фейковые IP. Для таких доменов real-ip заставляет
возвращать настоящий IP.
```
real-ip = *.apple.com,*.icloud.com
```

## hijack-dns (3.2.5 build 789+)
Некоторые приложения используют свой DNS-over-UDP. Можно указать
IP:порт для перехвата таких запросов с возвратом fakeip-ответа.
```
// *:53 — все запросы на порт 53
// *:0 — все
// 8.8.8.8 — все запросы к 8.8.8.8
hijack-dns = *:53,8.8.8.8
```

## interface-mode
Какой сетевой интерфейс использовать для трафика:
- **Auto** — система выбирает автоматически
- **Cellular** — при включённых Wi-Fi и сотовой — принудительно
  сотовая
- **Performance** — при включённых обоих — оптимальный интерфейс
- **Balance** — при включённых обоих — балансировка интерфейсов
```
interface-mode = Performance
```

## force-http-engine-hosts
**УСТАРЕЛО (3.2.3+ build 787).** Ранее заставлял Loon
обрабатывать сырой TCP как HTTP. Больше не используется.

## disable-udp-ports
Отключить UDP на некоторых портах.
```
disable-udp-ports = 443,80
```

## disable-stun
Отключить ли UDP-данные протокола STUN. Отключение эффективно
устраняет утечку IP через WebRTC.
```
disable-stun = true
```
ВАЖНО для RouteHub: STUN используется звонками (Этап I). Если
включить `disable-stun=true` — это может помешать звонкам.
Параметр НЕ включать, раз звонки критичны. Учесть на A.7/A.8.

## geoip-url
Кастомный адрес загрузки базы GeoIP.

## ipasn-url (3.2.3+ build 754)
Кастомный адрес загрузки базы ASN.

## udp-fallback-mode (3.2.0+ build 702)
Когда UDP-трафик совпал с узлом, но узел не поддерживает UDP
или UDP-переадресация не включена — запасная политика.
Варианты: `DIRECT`, `REJECT`.
```
udp-fallback-mode = REJECT
```

## domain-reject-mode (3.2.0+ build 702)
На каком этапе исполняется правило отклонения домена:
- **DNS** — блокировать на этапе DNS-запроса (LoopbackIP,
  No Answer или NXDomain)
- **Request** — блокировать на этапе пересылки запроса
```
domain-reject-mode = DNS
```

## dns-reject-mode (3.2.0+ build 702)
Способ отклонения домена на этапе DNS:
- **LOOPBACKIP** — возврат回环 IP
- **NOANSWER** — пустой DNS-ответ
- **NXDOMAIN** — DNS-ответ с кодом ошибки 3
```
dns-reject-mode = LOOPBACKIP
```

## skip-first-packet (3.3.3+ build 888)
Обычная модель: клиент шлёт запрос → сервер отвечает (HTTP,
DNS, gRPC). Но есть протоколы, где после установки соединения
сервер шлёт данные ПЕРВЫМ — почта (SMTP, POP3, IMAP), FTP,
IRC, Telnet. Loon ждёт первый пакет клиента для сопоставления
правил, поэтому такие сервисы могут работать неправильно.
Параметр пропускает разбор первого пакета — правила
сопоставляются сразу по домену/IP/порту.

---

# 10. SCHEME — URL-СХЕМЫ И ССЫЛКИ

Loon поддерживает URL-схемы для перехода в нужные разделы и
выполнения действий.

## 10.1 Схемы loon://
- `loon://switch` — включить/выключить Loon
- `loon://import` — импорт конфигурации
- `loon://editconfig` — открыть файл конфигурации Loon
- `loon://requestLists` — открыть недавние запросы
- `loon://LogLists` — открыть лог
- `loon://update?sub=all` — обновить подписки

Импорт конфигурации:
`loon://import?sub=url` (url — строка после Urlencode)
Импорт также: `?nodelist=`, `?rules=`, `?plugin=`, `?iconset=`,
`?geoip=`, `?parser=`

## 10.2 Универсальные ссылки (для перехода из веба)
- `https://www.nsloon.com/openloon/on` — включить
- `https://www.nsloon.com/openloon/off` — выключить
- `https://www.nsloon.com/openloon/editconfig`
- `https://www.nsloon.com/openloon/flowmodel=direct|filter|proxy`
- `https://www.nsloon.com/openloon/proxymode=tun|mix`
- `https://www.nsloon.com/openloon/import?sub=encode(url)`
- `.../import?nodelist=`, `?rules=`, `?plugin=`, `?iconset=`,
  `?geoip=`, `?parser=`
- `https://www.nsloon.com/openloon/update?sub=all`

---

# КОНЕЦ ДОКУМЕНТАЦИИ

Переведено для проекта RouteHub из официальной документации
Loon (nsloon.app/docs, версия 3.3.9). Технические термины и
примеры кода сохранены в оригинале. Разделы Rewrite и Scheme
включены для полноты (в RouteHub напрямую не используются:
Rewrite требует MITM, Scheme — для запуска извне).

---

# ПРИМЕЧАНИЕ О СВЕРКЕ

Этот перевод сверен с официальной документацией Loon тремя
способами:
1. Построчно с актуальными страницами сайта nsloon.app/docs.
2. С исходными файлами репозитория github.com/Loon0x00/LoonManual
   (полный архив docs/cn, все 27 файлов прочитаны построчно).

РЕЗУЛЬТАТ СВЕРКИ С АРХИВОМ:
Архив репозитория датирован мартом 2024 и СТАРЕЕ актуального
сайта. В архиве отсутствуют параметры, добавленные позже:
ip-mode (вместо устаревшего ipv6), hijack-dns, udp-fallback-mode,
domain-reject-mode, dns-reject-mode, skip-first-packet,
ipasn-url; в архиве нет VLESS+reality, нового синтаксиса
плагинов [Argument], полного Rewrite. Поэтому данный перевод
(построенный по актуальному сайту) НОВЕЕ и ПОЛНЕЕ архива.

Из архива добавлено одно уточнение, которого не было на
просмотренных страницах сайта: алгоритм приоритета
сопоставления правил (раздел 3.9) — доменные правила раньше
IP-правил, приоритет «локальные > плагин > подписка».

По итогам сверки [General] добавлены: disable-stun,
udp-fallback-mode, domain-reject-mode, dns-reject-mode,
skip-first-packet, geoip-url, ipasn-url. Исправлено:
force-http-engine-hosts и switch-node-after-failure-times
помечены УСТАРЕВШИМИ.

Документ актуален для Loon 3.3.9.

ВАЖНО для RouteHub: параметр `disable-stun` НЕ включать —
STUN нужен для звонков (Telegram/Discord/FaceTime), которые
для пользователя критичны. Отмечено в Этапе I плана.
