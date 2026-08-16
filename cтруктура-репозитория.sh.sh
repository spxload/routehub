#!/usr/bin/env bash
# ============================================================================
# RouteHub — раскладка репозитория по папкам. 2026-08-16.
#
# ЧТО ДЕЛАЕТ: переносит документы в docs/ и docs/archive/. Код, скрипты
# устройства, конфиг и плагины НЕ ТРОГАЕТ — на них завязан боевой контур.
# Ничего не удаляет: только git mv.
#
# КАК ЗАПУСТИТЬ (на компьютере, где есть git):
#   git clone https://github.com/spxload/routehub.git
#   cd routehub
#   bash структура-репозитория.sh
#   # посмотреть, что получилось: git status
#   git push
#
# ЕСЛИ ЧТО-ТО ПОШЛО НЕ ТАК до push:
#   git reset --hard origin/main
# ============================================================================

set -e

if [ ! -f routehub-worker.js ]; then
  echo "Запускать из корня репозитория routehub (не вижу routehub-worker.js)"
  exit 1
fi

mkdir -p docs docs/archive

echo "→ Актуальные документы в docs/"
for f in \
  ADR-01_СХЕМА_КОНТУРОВ.md \
  ТЕХДОЛГ.md \
  ЗАМЕРЫ_И_ВЕСА.md \
  СВЕРКА_LOON_3.5.md \
  ДОКУМЕНТАЦИЯ_LOON_RU.md \
  ЭТАП_K_STASH.md \
  ЭТАП_K_STASH_СТЕНД.md \
  ЭТАП_F_ЗАМЕТКИ.md \
  ЭТАП_D_ФОРМУЛА.md \
  СРАВНЕНИЕ_КЛИЕНТОВ_И_WHITELIST.md \
  КАТАЛОГ_СПИСКОВ.md
do
  [ -f "$f" ] && git mv "$f" docs/ && echo "   docs/$f"
done

echo "→ История в docs/archive/"
for f in \
  ЭТАП_A_РЕЗУЛЬТАТЫ.md \
  ЭТАП_B_РЕШЕНИЯ.md \
  ЭТАП_D_ЛИЧНЫЕ_ПОДПИСКИ.md \
  ЭТАП_D_ПРОГРЕСС.md \
  ЭТАП_D_RESEARCH_ПРОМПТ.md \
  ЭТАП_DASH_ПРОГРЕСС.md \
  ЭТАП_E_ПРОГРЕСС.md \
  ЭТАП_K_EGERN.md \
  ИССЛЕДОВАНИЕ_GITHUB.md \
  ИНСТРУКЦИЯ_ПРОЕКТА.md \
  ДЛЯ_ДИАНЫ_инструкция_и_промпты.md \
  МИГРАЦИЯ_НА_WORKERS.md
do
  [ -f "$f" ] && git mv "$f" docs/archive/ && echo "   docs/archive/$f"
done

# Имена с Ё и Й записаны в NFD (буква + отдельный диакритический знак) —
# точное совпадение строки их не находит, берём глобом.
for f in СВЕРКА_С_ДОКУМЕНТАЦИ*.md; do
  [ -f "$f" ] && git mv "$f" docs/ && echo "   docs/$f"
done
for f in ОТЧ*_ПО_ПРОЕКТУ.md; do
  [ -f "$f" ] && git mv "$f" docs/archive/ && echo "   docs/archive/$f"
done

# Страховка: любой .md, оставшийся в корне и не входящий в список ниже,
# уезжает в архив — чтобы NFD-имена не оседали в корне молча.
for f in *.md; do
  case "$f" in
    README.md|CHANGELOG.md|СТАРТ.md) continue ;;
  esac
  [ -f "$f" ] && git mv "$f" docs/archive/ && echo "   docs/archive/$f  (добор)"
done

echo
echo "→ Что осталось в корне:"
ls -1 | grep -v '^docs$'

echo
echo "→ Проверка: конфиг ссылается на скрипты, они должны быть на месте"
ok=1
for f in $(grep -o "script-path=routehub-[a-z-]*\.js" routehub.conf | sed 's/script-path=//' | sort -u); do
  if [ -f "$f" ]; then echo "   OK  $f"; else echo "   ПОТЕРЯН  $f"; ok=0; fi
done
[ "$ok" = "1" ] || { echo "Ссылки конфига сломаны — НЕ пушить, откатиться: git reset --hard origin/main"; exit 1; }

echo
echo "→ Тесты"
node --test "tests/*.test.js" 2>&1 | grep -E "^# (tests|pass|fail)" || echo "   node не найден — прогнать тесты вручную"

git add -A
git commit -m "Структура: документы разложены по docs/ и docs/archive/"

echo
echo "Готово. Осталось: git push"
echo "После push скажи мне — поправлю ссылки на документы в README и ТЕХДОЛГ."
