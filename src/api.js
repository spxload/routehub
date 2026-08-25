// routehub — модуль api.js (фасад)
// Боевые эндпоинты устройства: /config, /nodes, /speed, /rkn, /status.
// Разделён из routehub-worker.js 2026-08-15 (v1.9.5). Логика не менялась.
// Синтаксис конфига с 2026-08-16 (v1.9.6) — в clients/loon.js, здесь только
// сбор контекста. История версий — CHANGELOG.md в корне репозитория.
//
// 2026-08-25 (ветка stash-client): файл перешагнул порог 15 КБ и разложен
// по src/api/*.js. Здесь остался только реэкспорт — внешние импорты
// (routehub-worker.js, __test) видят прежний набор имён.
//   api/config.js — /config
//   api/nodes.js  — /nodes, /refresh
//   api/speed.js  — /speed
//   api/misc.js   — /whoami, /status, /rkn

import { handleConfig } from './api/config.js';
import { handleRkn, handleStatus, handleWhoami } from './api/misc.js';
import { handleNodes, handleRefresh } from './api/nodes.js';
import { handleSpeed } from './api/speed.js';

export { handleConfig, handleNodes, handleRefresh, handleRkn, handleSpeed, handleStatus, handleWhoami };
