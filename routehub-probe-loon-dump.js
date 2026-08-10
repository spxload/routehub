// =============================================================
// routehub-probe-loon-dump.js — выгрузка отчёта Loon-пробы. REV: D1.
//
// ЗАЧЕМ: скрипт routehub-probe-loon.js отработал (7 шагов из 7), но отчёт не
//   доехал до стенда — не сработала отправка либо не передался argument.
//   Данные лежат в $persistentStore под ключом rh_probe_l1.
//
// КАК ДОСТАВЛЯЕТ (три способа сразу, срабатывает хотя бы один):
//   1. КЛАДЁТ ВЕСЬ ОТЧЁТ В БУФЕР ОБМЕНА через $notification.post с attach
//      clipboard — самый надёжный путь, не зависит ни от сети, ни от argument.
//      После запуска просто вставить содержимое буфера в чат.
//   2. Если argument задан — пробует отправить POST на указанный адрес.
//   3. В теле уведомления показывает диагностику: сколько байт в отчёте,
//      виден ли $argument, какие шаги записаны. По ней сразу понятно, почему
//      не сработала отправка в прошлый раз.
//
// ТОЛЬКО ЧТЕНИЕ: ничего не меняет и не удаляет, состояние пробы не трогает.
// =============================================================

const STATE = 'rh_probe_l1';

let raw = '';
try { raw = $persistentStore.read(STATE) || ''; } catch (e) { raw = 'ОШИБКА ЧТЕНИЯ: ' + String((e && e.message) || e); }

let argSeen = 'нет';
let postUrl = '';
try {
  if (typeof $argument !== 'undefined' && $argument) {
    postUrl = String($argument).trim();
    argSeen = 'есть, ' + postUrl.length + ' симв.';
  }
} catch (e) { argSeen = 'ошибка доступа'; }

let steps = 'нет данных';
let runs = '?';
try {
  const o = JSON.parse(raw);
  steps = Object.keys(o.results || {}).join(', ');
  runs = o.runs;
} catch (e) { }

const info = 'Байт в отчёте: ' + raw.length +
             '. Прогонов: ' + runs +
             '. argument: ' + argSeen +
             '. Шаги: ' + steps;

// Главный путь доставки — буфер обмена.
try {
  $notification.post('Отчёт Loon-пробы скопирован', 'Вставь из буфера в чат', info,
                     { 'clipboard': raw });
} catch (e) {
  try { $notification.post('Отчёт Loon-пробы', '', info); } catch (e2) { }
}

// Запасной путь — отправка, если адрес передан.
if (postUrl) {
  try {
    $httpClient.post({ url: postUrl,
                       headers: { 'Content-Type': 'application/json' },
                       body: raw || '{}' },
      function (err) {
        try {
          $notification.post('Отправка отчёта',
                             err ? 'не удалась' : 'удалась',
                             err ? String(err).slice(0, 120) : 'отчёт ушёл на стенд');
        } catch (e) { }
        $done({});
      });
  } catch (e) { $done({}); }
} else {
  $done({});
}

// ХВОСТОВОЙ СТРАЖ — строка без перевода в конце файла; мусор после неё —