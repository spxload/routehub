// routehub — модуль admin.js (фасад)
// Админ-панель: сессия, состояние, устройства, настройки.
// Разделён из routehub-worker.js 2026-08-15 (v1.9.5). Логика не менялась.
// История версий — CHANGELOG.md в корне репозитория.
//
// 2026-08-25 (ветка stash-client): файл перешагнул порог 15 КБ и разложен
// по src/admin/*.js. Здесь остался только реэкспорт — внешние импорты
// (routehub-worker.js, __test) видят прежний набор имён.
//   admin/session.js — вход, сессионная cookie, гейт, /admin
//   admin/state.js   — /admin/state, /admin/keys, каскад
//   admin/device.js  — /admin/device, /admin/settings, /admin/action
//   admin/mylist.js  — /admin/mylist

import { handleAdminAction, handleAdminDevice, handleAdminSettings } from './admin/device.js';
import { handleAdminMylist } from './admin/mylist.js';
import { adminGate, b64url, handleAdminLogin, handleAdminLogout, handleAdminPage, makeSession, readCookie, sessionCookie, signSession, sleep, timingEq, verifySession } from './admin/session.js';
import { cascadeOf, deviceRow, handleAdminKeys, handleAdminState } from './admin/state.js';

export { adminGate, b64url, cascadeOf, deviceRow, handleAdminAction, handleAdminDevice, handleAdminKeys, handleAdminLogin, handleAdminLogout, handleAdminMylist, handleAdminPage, handleAdminSettings, handleAdminState, makeSession, readCookie, sessionCookie, signSession, sleep, timingEq, verifySession };
