// Сборка «вшитого» override для Stash: проба кладётся в YAML полем `payload`,
// и клиенту НЕЧЕГО СКАЧИВАТЬ.
//
// ЗАЧЕМ ЭТО ВООБЩЕ НУЖНО. Обычный override ссылается на скрипт по URL
// (`script-providers[].url`), а файл лежит на `raw.githubusercontent.com`.
// Когда этот адрес с телефона недоступен — под whitelist РКН он недоступен
// заведомо (замер 11.08), а 04.09 не скачался и без него — Stash пишет в
// журнал «script is not ready, skip cron» и пропускает КАЖДЫЙ запуск. Со
// стороны это выглядит как «проба не работает», хотя она даже не начиналась.
// Вшитый вариант снимает зависимость от сети целиком.
//
// ЗАЧЕМ ГЕНЕРАТОР, А НЕ ГОТОВЫЙ ФАЙЛ В РЕПОЗИТОРИИ. Вшитый вариант — та же
// проба, вложенная в YAML. Вторая копия тех же 15–20 КБ разошлась бы с
// оригиналом при первой же правке: так уже дважды терялись байты при ручном
// переносе. Источник истины один — файл пробы; результат в .gitignore.
// Обобщён из tools/build-st6-inline.mjs (24.08), где это делалось для одной
// пробы: третий такой случай означал бы третью копию одного и того же кода.
//
// ЗАПУСК:
//   node tools/build-inline-override.mjs <проба.js> <имя> <cron> [тайм-аут]
// например:
//   node tools/build-inline-override.mjs probes/routehub-probe-stash14.js rh-st14 '*/5 * * * *' 90
// РЕЗУЛЬТАТ: plugins/<имя>-inline.stoverride
//
// ФОРМАТ ПРОВЕРЕН ПО ДОКУМЕНТАЦИИ STASH: `payload` — поле `script-providers`
// (iOS/tvOS 3.2.5+), НЕ `tiles`; имя задания в `cron.script[].name` обязано
// совпадать с ключом провайдера, иначе Stash молча отбрасывает задание.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const [src, name, cron, timeout] = process.argv.slice(2);
if (!src || !name || !cron) {
  console.error('нужно: <проба.js> <имя> <cron> [тайм-аут]');
  process.exit(1);
}
const SRC = path.resolve(ROOT, src);
const OUT = path.join(ROOT, 'plugins', name.toUpperCase() + '-inline.stoverride');
const TO = Number(timeout || 90);

const HEAD = `name: "RouteHub ${name} (вшитый)"
desc: "Проба ${name}, вшитая в файл: ничего не скачивается, работает без доступа к raw.githubusercontent.com. ТОЛЬКО ЧТЕНИЕ контроллера."
author: "RouteHub"
category: "RouteHub"

# ============================================================================
# ЭТОТ ФАЙЛ СОБРАН АВТОМАТИЧЕСКИ: tools/build-inline-override.mjs
# Править здесь бесполезно — правится ${src}
#
# ПОЧЕМУ ВШИТЫЙ. Обычный override качает скрипт с raw.githubusercontent.com.
# Если этот адрес с телефона недоступен, Stash пишет в журнал
# «script is not ready, skip cron» и пропускает каждый запуск — проба даже не
# начинается. Здесь скачивать нечего.
#
# УСТАНОВКА: сохранить файл на телефон → Stash → Настройки → Override →
# добавить из файла. Ссылка не нужна.
#
# ТРЕБОВАНИЕ: Stash iOS 3.2.5 и новее (раньше поля payload не было) и
# поднятый туннель — плановые задания без него не запускаются.
#
# ПОСЛЕ РАЗБОРА OVERRIDE ВЫКЛЮЧИТЬ.
# ============================================================================

script-providers:
  ${name}:
    interval: 86400
    payload: |
`;

const TAIL = `
cron:
  script:
    - name: ${name}
      cron: '${cron}'
      timeout: ${TO}
`;

const js = fs.readFileSync(SRC, 'utf8');
// Блочный скаляр YAML: непустые строки сдвигаются на 6 пробелов, пустые
// остаются по-настоящему пустыми — иначе появятся хвостовые пробелы, и
// разбор YAML на устройстве может повести себя иначе, чем локально.
const body = js.replace(/\n+$/, '').split('\n')
  .map((ln) => (ln.trim() ? '      ' + ln : '')).join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, HEAD + body + '\n' + TAIL);
console.log('собран', path.relative(ROOT, OUT), fs.statSync(OUT).size, 'Б');
