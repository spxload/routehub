// =============================================================
// RouteHub — Cloudflare Worker, точка входа.
// Версия v1.9.5 (2026-08-15). ИСТОРИЯ ВЕРСИЙ — CHANGELOG.md в корне.
//
// ЗАЧЕМ РАЗДЕЛЁН НА МОДУЛИ. Файл вырос до 76 КБ и перестал передаваться
// инструментами целиком: git push из облачной сессии блокирует прокси.
// Каждый модуль ниже меньше 15 КБ, то есть правится по отдельности. При
// разделении логика НЕ менялась — только раскладка по файлам.
//
// КАРТА МОДУЛЕЙ (граф импортов ацикличен, сверху вниз — по зависимостям):
//   src/const.js — константы: разметка имён, регионы, токены, иконка
//   src/util.js  — чистые функции: разбор имён, баллы, ответы      (const)
//   src/store.js — D1 (таблица kv), реестр устройств, токены       (const, util)
//   src/sub.js   — подписка Lastdep: загрузка, кэш, два набора     (const, store, util)
//   src/ai.js    — AI-тиеры и региональные остатки                 (const, util)
//   src/api.js   — /config, /nodes, /speed, /rkn, /status          (все выше)
//   src/dash.js  — дашборд rh.box и личный список доменов          (const, store, util)
//   src/admin.js — админ-панель                                    (const, store, sub, util)
//
// МОДЕЛЬ ОДНОЙ ПОДПИСКИ: /nodes отдаёт оба набора (🛜/📱); каждая функция —
// select-родитель из двух fallback-детей (-W/-C); netwatch флипает родителя по
// сети. AI — страновые тиеры, строит Worker. Выбор узла делает fallback внутри
// Loon, а не скрипт.
// =============================================================

import ADMIN_HTML from './routehub-admin.html';

import * as CONST from './src/const.js';
import * as UTIL from './src/util.js';
import * as STORE from './src/store.js';
import * as SUB from './src/sub.js';
import * as AI from './src/ai.js';
import * as API from './src/api.js';
import * as DASH from './src/dash.js';
import * as ADMIN from './src/admin.js';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // Токен: префикс пути /t/<token>/... (так его получают скрипты через ORIGIN)
    // либо ?token=... для ручных заходов из браузера. Префикс срезаем и дальше
    // маршрутизируем как раньше — все обработчики видят прежние пути.
    let tok = '';
    const pm = url.pathname.match(CONST.PATH_TOKEN_RE);
    if (pm) { tok = pm[1]; url.pathname = pm[2] || '/'; }
    else {
      const qt = url.searchParams.get('token') || '';
      if (CONST.TOKEN_RE.test(qt)) tok = qt;
    }
    try {
      if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
          'Access-Control-Max-Age': '86400',
        } });
      }
      if (req.method === 'GET' && (url.pathname === '/icon.svg' || url.pathname === '/icon.png' || url.pathname === '/apple-touch-icon.png')) return UTIL.iconResp();
      if (req.method === 'GET' && url.pathname === '/whoami') return API.handleWhoami(req);
      if (req.method === 'GET' && url.pathname === '/config') return await API.handleConfig(url, env, tok);
      if (req.method === 'GET' && url.pathname === '/nodes') return await API.handleNodes(url, env, tok);
      if (req.method === 'GET' && url.pathname === '/refresh') return await API.handleRefresh(url, env, tok);
      if (req.method === 'GET' && url.pathname === '/dashboard') return await DASH.handleDashboard(url, env, tok);
      if (req.method === 'GET' && url.pathname === '/mylist') return await DASH.handleMylist(url, env, tok);
      if (req.method === 'GET' && url.pathname === '/status') return await API.handleStatus(url, env, tok);
      if (req.method === 'GET' && url.pathname === '/admin') return ADMIN.handleAdminPage(ADMIN_HTML);
      if (req.method === 'POST' && url.pathname === '/admin/login') return await ADMIN.handleAdminLogin(req, env);
      if (req.method === 'POST' && url.pathname === '/admin/logout') return ADMIN.handleAdminLogout();
      if (req.method === 'GET' && url.pathname === '/admin/state') return await ADMIN.handleAdminState(req, url, env);
      if (req.method === 'GET' && url.pathname === '/admin/keys') return await ADMIN.handleAdminKeys(req, url, env);
      if (req.method === 'POST' && url.pathname === '/admin/device') return await ADMIN.handleAdminDevice(req, url, env);
      if (req.method === 'POST' && url.pathname === '/admin/settings') return await ADMIN.handleAdminSettings(req, url, env);
      if (req.method === 'POST' && url.pathname === '/admin/action') return await ADMIN.handleAdminAction(req, url, env);
      if (req.method === 'POST' && url.pathname === '/admin/mylist') return await ADMIN.handleAdminMylist(req, url, env);
      if (req.method === 'POST' && url.pathname === '/rkn') return await API.handleRkn(req, env, tok);
      if (req.method === 'POST' && url.pathname === '/addrule') return await DASH.handleRule(req, env, true, tok);
      if (req.method === 'POST' && url.pathname === '/delrule') return await DASH.handleRule(req, env, false, tok);
      if (req.method === 'POST' && url.pathname === '/speed') return await API.handleSpeed(req, env, tok);
      return new Response('routehub-worker: not found', { status: 404 });
    } catch (err) {
      return new Response('error: ' + (err && err.message ? err.message : 'unknown'), { status: 500 });
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(SUB.getSub(env, true).catch(function () {}));
  },
};

// Экспорт для тестов (tests/routehub-worker.test.js): всё объявленное в
// модулях, одним объектом. На работу Worker'а не влияет — рантайм обращается
// только к default-экспорту.
export const __test = { ...CONST, ...UTIL, ...STORE, ...SUB, ...AI, ...API, ...DASH, ...ADMIN };
