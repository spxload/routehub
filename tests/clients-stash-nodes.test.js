// Тесты нижнего яруса клиентского слоя Stash: clients/stash-nodes.js
// (ссылка подписки → объект узла) и clients/stash-yaml.js (объекты → YAML).
//
// Зачем так подробно. Ошибка здесь молчаливая: Stash не жалуется на лишнее
// или неверно названное поле, он просто поднимает узел не так, как задумано,
// — либо роняет разбор всего профиля на одной кривой строке. Поэтому три
// формы подписки проверяются ПОЛЕ В ПОЛЕ, а не выборочными assert'ами.
//
// Эти модули не зависят ни от D1, ни от HTML-импорта, поэтому грузятся
// напрямую, без tests/harness.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNodeLink, nodesFromLinks } from '../src/clients/stash-nodes.js';
import { yScalar, nodeToYaml, nodesToYaml } from '../src/clients/stash-yaml.js';

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const U3 = '33333333-3333-3333-3333-333333333333';

// Форма A: tcp + tls + vision. Пустые параметры в подписке присутствуют.
const A = 'vless://' + U1 + '@a1.example.net:443'
  + '?security=tls&type=tcp&headerType=&path=&host=&flow=xtls-rprx-vision&sni=a1.example.net&fp=&alpn='
  + '#%F0%9F%87%A9%F0%9F%87%AA%20%D0%93%D0%B5%D1%80%D0%BC%D0%B0%D0%BD%D0%B8%D1%8F%20%231';

// Форма B: tcp + reality + pbk/sid.
const B = 'vless://' + U2 + '@b1.example.net:8443'
  + '?security=reality&type=tcp&headerType=&flow=xtls-rprx-vision&pbk=PBKEY123&sid=ab12&sni=www.microsoft.com&fp=chrome'
  + '#B-Reality';

// Форма C: строка параметров ДОСЛОВНО из подписки (срез D1 от 2026-08-24).
const C = 'vless://' + U3 + '@c1.example.net:443'
  + '?security=tls&type=ws&headerType=&path=%2F%2F&host=cdn.deploy-assure.ru&flow=&sni=cdn.deploy-assure.ru&fp=chrome&alpn=http%2F1.1'
  + '#C-WS';

test('форма A: tcp + tls + vision — поле в поле', () => {
  assert.deepEqual(parseNodeLink(A), {
    name: '\u{1F1E9}\u{1F1EA} Германия #1',
    type: 'vless',
    server: 'a1.example.net',
    port: 443,
    uuid: U1,
    tls: true,
    sni: 'a1.example.net',
    flow: 'xtls-rprx-vision',
  });
});

test('форма B: reality — pbk/sid уходят в reality-opts, tls поднят', () => {
  assert.deepEqual(parseNodeLink(B), {
    name: 'B-Reality',
    type: 'vless',
    server: 'b1.example.net',
    port: 8443,
    uuid: U2,
    tls: true,
    sni: 'www.microsoft.com',
    flow: 'xtls-rprx-vision',
    'client-fingerprint': 'chrome',
    'reality-opts': { 'public-key': 'PBKEY123', 'short-id': 'ab12' },
  });
});

test('форма C: ws — network, ws-opts, alpn массивом — поле в поле', () => {
  assert.deepEqual(parseNodeLink(C), {
    name: 'C-WS',
    type: 'vless',
    server: 'c1.example.net',
    port: 443,
    uuid: U3,
    tls: true,
    sni: 'cdn.deploy-assure.ru',
    'client-fingerprint': 'chrome',
    alpn: ['http/1.1'],
    network: 'ws',
    'ws-opts': { path: '//', headers: { Host: 'cdn.deploy-assure.ru' } },
  });
});

test('пустой параметр = отсутствие параметра: headerType=, flow=, fp=, alpn=', () => {
  const a = parseNodeLink(A), c = parseNodeLink(C);
  assert.equal('client-fingerprint' in a, false, 'fp= пустой не должен давать поле');
  assert.equal('alpn' in a, false, 'alpn= пустой не должен давать поле');
  assert.equal('flow' in c, false, 'flow= пустой не должен давать поле');
  assert.equal('headerType' in c, false, 'headerType в схему Stash не переносится');
  assert.equal('type' in c && c.type === 'vless', true, 'type=ws не должен затирать тип прокси');
});

test('tcp не выводит network — это значение по умолчанию у Stash', () => {
  assert.equal('network' in parseNodeLink(A), false);
  assert.equal('network' in parseNodeLink(B), false);
  assert.equal(parseNodeLink(C).network, 'ws');
});

test('udp и servername не выводятся ни в объекте, ни в YAML', () => {
  const { nodes } = nodesFromLinks([A, B, C]);
  nodes.forEach(function (n) {
    assert.equal('udp' in n, false, 'udp для vless не документирован');
    assert.equal('servername' in n, false, 'у Stash поле называется sni');
  });
  const yaml = nodesToYaml(nodes);
  assert.equal(yaml.indexOf('udp'), -1);
  assert.equal(yaml.indexOf('servername'), -1);
  assert.ok(yaml.indexOf("sni: 'a1.example.net'") >= 0, 'sni обязан быть в выводе');
});

test('URL-декодирование: путь %2F%2F и кириллица с эмодзи в имени', () => {
  assert.equal(parseNodeLink(C)['ws-opts'].path, '//');
  assert.equal(parseNodeLink(A).name, '\u{1F1E9}\u{1F1EA} Германия #1');
});

test('эмодзи и пробелы в имени переживают сериализацию', () => {
  const y = nodeToYaml(parseNodeLink(A), 2);
  assert.ok(y.indexOf("- name: '\u{1F1E9}\u{1F1EA} Германия #1'") >= 0, y);
});

test('порт — число, а не строка', () => {
  const n = parseNodeLink(A);
  assert.equal(typeof n.port, 'number');
  assert.equal(n.port, 443);
  assert.ok(nodeToYaml(n, 2).indexOf('port: 443') >= 0, 'порт не должен быть в кавычках');
});

test('alpn — массив строк, разделитель запятая', () => {
  assert.deepEqual(parseNodeLink(C).alpn, ['http/1.1']);
  const two = parseNodeLink('vless://' + U1 + '@x.example.net:443?security=tls&alpn=h2%2Chttp%2F1.1#X');
  assert.deepEqual(two.alpn, ['h2', 'http/1.1']);
  const y = nodeToYaml(two, 2);
  assert.ok(y.indexOf("    alpn:\n      - 'h2'\n      - 'http/1.1'") >= 0, y);
});

test('дубль имени получает суффикс-счётчик, порядок не меняется', () => {
  const dup = 'vless://' + U2 + '@d2.example.net:443?security=tls#%D0%94%D1%83%D0%B1%D0%BB%D1%8C';
  const dup3 = 'vless://' + U3 + '@d3.example.net:443?security=tls#%D0%94%D1%83%D0%B1%D0%BB%D1%8C';
  const first = 'vless://' + U1 + '@d1.example.net:443?security=tls#%D0%94%D1%83%D0%B1%D0%BB%D1%8C';
  const { nodes } = nodesFromLinks([first, dup, dup3]);
  assert.deepEqual(nodes.map(function (n) { return n.name; }), ['Дубль', 'Дубль (2)', 'Дубль (3)']);
  assert.deepEqual(nodes.map(function (n) { return n.server; }), ['d1.example.net', 'd2.example.net', 'd3.example.net']);
});

test('имена уникальны на всём наборе', () => {
  const { nodes } = nodesFromLinks([A, B, C, A, A]);
  const names = nodes.map(function (n) { return n.name; });
  assert.equal(new Set(names).size, names.length);
  assert.equal(nodes.length, 5);
});

test('битые строки и чужие схемы пропускаются и считаются', () => {
  const bad = [
    'мусор',
    'ss://YWVzLTI1Ni1nY206cGFzcw==@s.example.net:8388#SS',   // чужая схема
    'vless://@nouuid.example.net:443?security=tls#NoUUID',    // нет uuid
    'vless://' + U1 + '@noport.example.net?security=tls#NoPort', // нет порта
    'vless://' + U1 + '@bad.example.net:99999?security=tls#BadPort',
    'vless://' + U1 + '@grpc.example.net:443?security=tls&type=grpc#Grpc', // транспорт не проверялся
  ];
  const { nodes, skipped } = nodesFromLinks([A].concat(bad).concat([C]));
  assert.equal(skipped, 6);
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes.map(function (n) { return n.name; }), ['\u{1F1E9}\u{1F1EA} Германия #1', 'C-WS']);
});

test('пустые строки подписки пропусками не считаются', () => {
  const { nodes, skipped } = nodesFromLinks(A + '\n\n  \n' + C + '\n');
  assert.equal(skipped, 0);
  assert.equal(nodes.length, 2);
});

test('одинарная кавычка в имени удваивается', () => {
  const n = parseNodeLink('vless://' + U1 + "@q.example.net:443?security=tls#O'Hare%20%D1%83%D0%B7%D0%B5%D0%BB");
  assert.equal(n.name, "O'Hare узел");
  assert.equal(yScalar(n.name), "'O''Hare узел'");
  assert.ok(nodeToYaml(n, 2).indexOf("- name: 'O''Hare узел'") >= 0);
  // Строка из двух кавычек: каждая удваивается, всё оборачивается в кавычки.
  assert.equal(yScalar("''"), "''''''");
});

test('неизвестный flow поле не создаёт, но узел не теряется', () => {
  const n = parseNodeLink('vless://' + U1 + '@f.example.net:443?security=tls&flow=xtls-rprx-unknown#F');
  assert.equal('flow' in n, false);
  assert.equal(n.server, 'f.example.net');
});

test('имя без фрагмента заменяется адресом, управляющие символы вычищаются', () => {
  assert.equal(parseNodeLink('vless://' + U1 + '@n.example.net:443?security=tls').name, 'n.example.net:443');
  assert.equal(parseNodeLink('vless://' + U1 + '@n.example.net:443?security=tls#A%0AB').name, 'A B');
});

test('nodesToYaml: двухпробельные отступы, вложенность ws-opts, пустой список', () => {
  const { nodes } = nodesFromLinks([C]);
  assert.equal(nodesToYaml(nodes),
    "proxies:\n" +
    "  - name: 'C-WS'\n" +
    "    type: 'vless'\n" +
    "    server: 'c1.example.net'\n" +
    "    port: 443\n" +
    "    uuid: '" + U3 + "'\n" +
    "    tls: true\n" +
    "    sni: 'cdn.deploy-assure.ru'\n" +
    "    client-fingerprint: 'chrome'\n" +
    "    alpn:\n" +
    "      - 'http/1.1'\n" +
    "    network: 'ws'\n" +
    "    ws-opts:\n" +
    "      path: '//'\n" +
    "      headers:\n" +
    "        Host: 'cdn.deploy-assure.ru'\n");
  assert.equal(nodesToYaml([]), 'proxies: []\n');
});

test('reality-opts в YAML: public-key и short-id вложены', () => {
  assert.ok(nodeToYaml(parseNodeLink(B), 2).indexOf(
    "    reality-opts:\n      public-key: 'PBKEY123'\n      short-id: 'ab12'") >= 0);
});

test('регистр схемы и значений параметров не важен', () => {
  const n = parseNodeLink('VLESS://' + U1 + '@up.example.net:443?security=TLS&type=WS&path=/x#Up');
  assert.equal(n.tls, true);
  assert.equal(n.network, 'ws');
  assert.deepEqual(n['ws-opts'], { path: '/x' });
});

test('IPv6-литерал теряет скобки в поле server, без порта — пропуск', () => {
  assert.equal(parseNodeLink('vless://' + U1 + '@[2001:db8::1]:443?security=tls#V6').server, '2001:db8::1');
  assert.equal(parseNodeLink('vless://' + U1 + '@[2001:db8::1]?security=tls#V6'), null);
});

test('ключ __proto__ в параметрах ссылки прототип не трогает', () => {
  const n = parseNodeLink('vless://' + U1 + '@p.example.net:443?__proto__=x&security=tls#P');
  assert.equal(n.server, 'p.example.net');
  assert.equal(({}).x, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});
