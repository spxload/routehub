// =============================================================
// routehub-test-step0.js v0.2.0 — РАЗОВЫЙ тест T1 (повтор, расширенный).
// Тип: generic (ручной запуск из UI Loon). После теста — удалить из Loon.
//
// ПРОВЕРКА: маршрутизирует ли $httpClient по параметру node ВООБЩЕ.
// v0.1.0 дал один IP на все node -> подозрение, что node игнорируется.
// Диана уточнила: вдруг причина — Wi-Fi. Логически нет (node — это узел
// ВНУТРИ туннеля, не зависит от Wi-Fi/сотовой), но проверяем жёстко.
//
// Метод: 5 запросов к https://api.ipify.org (эхо внешнего IP) через
// node = реально существующие группы конфига + фейк + без node:
//   R1 node="RH-Обход"   — обходной хвост (точно существует)
//   R2 node="RH-AI"      — другая реальная группа (иной набор узлов)
//   R3 node="DIRECT"     — встроенная политика прямого соединения
//   R4 node="RH-НетТакой"— несуществующая (контроль: ошибка или игнор)
//   R5 без node          — базовая линия (маршрут по правилам конфига)
//
// ИНТЕРПРЕТАЦИЯ:
//   IP различаются между R1/R2/R3 -> node РАБОТАЕТ (Wi-Fi был ни при чём,
//     ветка DIRECT-проба возможна — НО см. ниже: всё равно DIRECT под
//     whitelist бесполезен, проверка через fetch надёжнее).
//   Все IP совпали И R4 не дал ошибки -> node ИГНОРИРУЕТСЯ окончательно.
//   R4 дал ошибку, а R1/R2/R3 разошлись -> node работает и валидируется.
//
// Запусти на Wi-Fi И, если можно, повтори на сотовой — сравнить.
// Результат — в пуше и в логе Loon (метка [step0]).
// =============================================================

var URL_ = 'https://api.ipify.org';
var out = [];

function go(label, node, cb) {
  var p = { url: URL_, timeout: 6000 };
  if (node) p.node = node;
  $httpClient.get(p, function (err, resp, data) {
    var s;
    if (err) s = label + ': ОШИБКА ' + String(err);
    else s = label + ': ip=' + String(data || '').trim() + ' status=' + (resp && resp.status ? resp.status : '?');
    out.push(s);
    console.log('[step0] ' + s);
    cb();
  });
}

go('R1 RH-Обход', 'RH-Обход', function () {
  go('R2 RH-AI', 'RH-AI', function () {
    go('R3 DIRECT', 'DIRECT', function () {
      go('R4 фейк-группа', 'RH-НетТакой', function () {
        go('R5 без node', null, function () {
          $notification.post('RouteHub шаг 0 (v2)', 'T1 повтор: node в $httpClient', out.join('\n'));
          console.log('[step0] ГОТОВО:\n' + out.join('\n'));
          $done();
        });
      });
    });
  });
});
