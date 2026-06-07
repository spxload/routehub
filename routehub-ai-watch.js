// =============================================================
// routehub-ai-watch.js — RouteHub, наблюдатель смены AI-узла (ТЕСТ fallback)
var VERSION = 'ai-watch v0.1.0 (2026-06-07)';
//
// Тип: cron. ТОЛЬКО НАБЛЮДАТЕЛЬ — узлы НЕ переключает, lock не трогает.
//
// Назначение: при тесте RH-AI=fallback Loon выбирает узел сам (без
//   скрипта-селектора), и на внутреннее переключение скрипт не вызывается.
//   Этот cron каждые 5 мин читает текущий выбор RH-AI и, если он сменился
//   с прошлой проверки — шлёт уведомление. Так видно, кАК ЧАСТО fallback
//   передёргивает узел и когда уходит на обход (whitelist).
//
// ПРОВЕРИТЬ НА УСТРОЙСТВЕ: что $config.getSelectedPolicy('RH-AI') для
//   fallback-группы возвращает ИМЯ ВЫБРАННОГО УЗЛА (а не имя фильтра
//   или пусто). Если пусто/фильтр — логику уведомления пересмотреть.
// =============================================================

var GROUP = 'RH-AI';
var LAST_KEY = 'rh_ai_watch_last';
var METRIC_SEP = ' \u00B7 ';

function log(m) { console.log('[RH-AI-Watch] ' + m); }
function stripMetric(n) { var i = n.indexOf(METRIC_SEP); return i >= 0 ? n.slice(0, i) : n; }
function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

function selected(group) {
  try { var s = $config.getSelectedPolicy(group); return s ? String(s) : ''; }
  catch (e) { return ''; }
}

function main() {
  log('=== ' + VERSION + ' ===');
  var raw = selected(GROUP);
  var cur = norm(stripMetric(raw));
  if (!cur) { log('выбор RH-AI пуст — пропуск'); $done({}); return; }

  var prev = '';
  try { prev = $persistentStore.read(LAST_KEY) || ''; } catch (e) {}

  if (!prev) {
    try { $persistentStore.write(cur, LAST_KEY); } catch (e) {}
    log('первая фиксация: ' + cur);
    $done({}); return;
  }

  if (cur !== prev) {
    try { $persistentStore.write(cur, LAST_KEY); } catch (e) {}
    var bypass = cur.indexOf('[\u041E\u0431\u0445\u043E\u0434') >= 0; // [Обход
    log('смена: ' + prev + ' -> ' + cur);
    $notification.post('\uD83E\uDD16 RouteHub AI',
      'Узел AI сменился' + (bypass ? ' (обход — похоже на whitelist)' : ''),
      prev + '  \u2192  ' + cur);
  } else {
    log('без изменений: ' + cur);
  }
  $done({});
}

main();
