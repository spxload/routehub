// =============================================================
// routehub-test-step0.js v0.1.0 — РАЗОВЫЙ тест T1 дашборд-этапа.
// Тип: generic (ручной запуск из UI Loon). После теста — удалить из Loon.
//
// Вопрос: принимает ли $httpClient параметр node со значением "DIRECT".
// Метод: 4 запроса к https://api.ipify.org (эхо внешнего IP):
//   R1 node="RH-Обход"     -> ожидаем IP обходного узла (node работает с группами)
//   R2 node="DIRECT"       -> ожидаем домашний IP (если DIRECT принят как node)
//   R3 node="RH-НетТакой"  -> несуществующая группа: ожидаем ЯВНУЮ ошибку
//                             (дизамбигуатор: ошибка = невалидный node НЕ
//                             игнорируется молча)
//   R4 без node            -> базовая линия (маршрут по правилам конфига)
//
// ИНТЕРПРЕТАЦИЯ:
//   R3 = ошибка, R2 = ok, IP(R2) != IP(R1)  -> node:"DIRECT" РАБОТАЕТ.
//   R3 = ok (вернул IP)                     -> невалидный node игнорируется,
//                                              R2 недоказателен -> ветка
//                                              RH-ПробаDIRECT (select-группа).
//   R2 = ошибка                             -> DIRECT не принят -> та же ветка.
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
  go('R2 DIRECT', 'DIRECT', function () {
    go('R3 фейк-группа', 'RH-НетТакой', function () {
      go('R4 без node', null, function () {
        $notification.post('RouteHub шаг 0', 'T1: параметр node в $httpClient', out.join('\n'));
        console.log('[step0] ГОТОВО:\n' + out.join('\n'));
        $done();
      });
    });
  });
});
