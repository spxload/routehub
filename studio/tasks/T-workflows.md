# T-workflows — CI-прогон тестов и точечная правка текста

Сложность: **простая**, разовая заливка двух файлов. Файлы `.github/workflows/`
токен GitHub MCP не заливает (403, проверено ранее в проекте) — их заливает
ПЕРВАЯ сессия Claude Code с подключённым репозиторием, нативным `git push`.
Готовое содержимое обоих файлов — ниже, копировать как есть в
`.github/workflows/tests.yml` и `.github/workflows/patch-text.yml`.

## Факты, проверенные по коду 23.09.2026

- Тесты — `node --test tests/*.test.js` (так и запускаются вручную сейчас,
  см. `tests/routehub-worker.test.js`: «Запуск: node --test "tests/*.test.js"»,
  «CI нет намеренно — прогон ручной, перед коммитом»; этот workflow меняет
  это решение на автоматический прогон, оставляя ручной как и был).
- Версия Node НЕ ЗАФИКСИРОВАНА в репозитории — ни `package.json`, ни
  `.nvmrc` нет. Проверено запуском на Node **v22.22.2**: `main` —
  149 тестов, все проходят, ветка `stash-client` — 311 тестов, все проходят;
  оба набора используют `import`/`node:test`/`node:assert` без
  `"type": "module"` в `package.json` — на Node 22 это работает через
  автоматическое определение модуля (доступно из коробки, начиная с веток
  Node 20.19+/22.7+). Рекомендация: закрепить `node-version: '22'` в
  workflow явно, а не полагаться на `lts/*`, пока в репозитории нет своего
  `.nvmrc`.
- Полный прогон обеих веток занял ~10 с (`main`) и ~20 с (`stash-client`) —
  сильно меньше лимита бесплатных раннеров.
- Стоимость: у ПУБЛИЧНОГО репозитория раннеры GitHub Actions бесплатны без
  ограничения минут. У ПРИВАТНОГО (после задачи `studio/tasks/T-private-repo.md`)
  — 2000 минут/месяц на бесплатном плане; при прогоне ~15–20 с на пуш и это
  многократный запас.

## Файл 1 — `.github/workflows/tests.yml`

```yaml
name: Тесты

on:
  push:
    branches: [main, stash-client]
  pull_request:
    branches: [main, stash-client]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: node --test
        run: node --test tests/*.test.js
```

## Файл 2 — `.github/workflows/patch-text.yml`

Перенос из `spxload/Teach` (`.github/workflows/patch-text.yml`), без правок —
логика не зависит от конкретного репозитория:

```yaml
name: Точечная правка текста

# Замена одного фрагмента в текстовом файле репозитория без пересылки файла целиком.
on:
  workflow_dispatch:
    inputs:
      path:
        description: 'Путь к файлу'
        required: true
      old:
        description: 'Точный фрагмент (должен встречаться ровно один раз)'
        required: true
      new:
        description: 'Новый фрагмент'
        required: true
      message:
        description: 'Описание правки'
        required: false
        default: 'Точечная правка'

permissions:
  contents: write

jobs:
  patch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Замена
        env:
          P: ${{ inputs.path }}
          OLD: ${{ inputs.old }}
          NEW: ${{ inputs.new }}
        run: |
          python3 - <<'EOF'
          import os, sys
          p, old, new = os.environ['P'], os.environ['OLD'], os.environ['NEW']
          t = open(p, encoding='utf-8').read()
          c = t.count(old)
          if c != 1:
              sys.exit(f'Фрагмент найден {c} раз — нужен ровно 1')
          open(p, 'w', encoding='utf-8').write(t.replace(old, new))
          print('OK')
          EOF
      - name: Сохранить
        env:
          MSG: ${{ inputs.message }}
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git commit -am "$MSG" && git push
```

## Критерии приёмки

1. Оба файла лежат в `.github/workflows/` в ветке `main` (залиты первой
   сессией Claude Code, нативным `git push`, не через GitHub MCP).
2. `tests.yml` реально запускается на push и на PR в `main` и `stash-client`
   (проверить вкладкой Actions после первого пуша) и завершается зелёным.
3. `patch-text.yml` запускается вручную (`workflow_dispatch`) и на тестовом
   файле подтверждает: фрагмент, встречающийся не ровно 1 раз, workflow
   останавливает с ошибкой, а не молча ломает файл.
4. Ни один из файлов не содержит секретов — оба используют только встроенный
   `GITHUB_TOKEN`/checkout, без личных токенов.
