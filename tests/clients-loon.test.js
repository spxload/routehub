// Тесты клиентского слоя Loon (ADR-01, v1.9.6).
// Ядро отдаёт посчитанное, clients/loon.js превращает это в текст конфига.
// Если плейсхолдер уцелел или аргумент скрипта не подставился — устройство
// получит нерабочий конфиг молча.

import test from 'node:test';
import assert from 'node:assert/strict';
import { T } from './harness.js';

// Клиентские слои лежат в __test под ключами-неймспейсами (T.LOON, T.STASH),
// а не спредом: у clients/loon.js и clients/stash.js одноимённые функции, и
// плоский спред дал бы молчаливое затирание — тесты Loon проверяли бы Stash.
// Проверка ниже — на уровне модуля, чтобы не попасть в счётчик тестов, но
// упасть громко, если спред вернут.
assert.equal(T.renderConfig, undefined, 'clients/loon.js снова спредится плоско в __test');
assert.equal(typeof T.LOON.renderConfig, 'function', 'неймспейс LOON пропал из __test');

test('renderConfig подставляет плейсхолдеры и аргументы скриптов', () => {
  const conf = [
    'Lastdep = https://old.invalid/n,udp=true',
    '# __RH_AI_FILTERS__',
    '# __RH_AI_GROUPS__',
    '# __RH_MYLIST_URL__',
    'generic script-path=routehub-speedtest.js, tag=RH-Speed, timeout=60',
    'generic script-path=routehub-netwatch.js, tag=RH-Net, timeout=60',
  ].join('\n');
  const out = T.LOON.renderConfig(conf, {
    key: 'k1',
    base: 'https://w.invalid/t/TOK',
    dev: { cell_unlim: true, ewma: true, auto_refresh: true },
    blocks: { filters: 'FILTERS', groups: 'GROUPS' },
    subParams: ',udp=true,enabled=true',
    scriptBase: 'https://raw.invalid/repo/',
  });
  assert.ok(out.indexOf('__RH_') < 0, 'плейсхолдеры остались в конфиге');
  assert.ok(out.indexOf('Lastdep = https://w.invalid/t/TOK/nodes?key=k1,udp=true,enabled=true') >= 0);
  assert.ok(out.indexOf('script-path=https://raw.invalid/repo/routehub-speedtest.js') >= 0);
  assert.ok(out.indexOf('argument=k1|https://w.invalid/t/TOK|cellall,ewma') >= 0, 'флаги устройства не доехали');
  assert.ok(out.indexOf('argument=k1|https://w.invalid/t/TOK|autorefresh') >= 0);
});

test('renderConfig без флагов устройства оставляет аргумент пустым, а не undefined', () => {
  const out = T.LOON.renderConfig('generic script-path=routehub-speedtest.js, tag=RH-Speed', {
    key: 'k2',
    base: 'https://w.invalid/t/T2',
    dev: {},
    blocks: { filters: '', groups: '' },
    subParams: ',udp=true,enabled=true',
    scriptBase: 'https://raw.invalid/repo/',
  });
  assert.ok(out.indexOf('argument=k2|https://w.invalid/t/T2|,') >= 0 || out.endsWith('argument=k2|https://w.invalid/t/T2|'));
  assert.ok(out.indexOf('undefined') < 0);
});

test('subParamsFromConf сохраняет хвост параметров подписки', () => {
  const conf = 'Lastdep = https://x.invalid/nodes?key=k1,block-quic=false,udp=true,enabled=true\n';
  assert.equal(T.LOON.subParamsFromConf(conf), ',block-quic=false,udp=true,enabled=true');
});

test('subParamsFromConf: строки нет либо параметров нет — запасной дефолт', () => {
  assert.equal(T.LOON.subParamsFromConf('# пусто'), ',udp=true,enabled=true');
  assert.equal(T.LOON.subParamsFromConf('Lastdep = https://x.invalid/n'), ',udp=true,enabled=true');
});

// v1.9.9: файлы скриптов переезжают в папки (scripts/, probes/). Подстановка
// обязана работать для обеих раскладок — иначе между переездом файлов и
// обновлением конфига на устройстве ссылки укажут в никуда.
test('renderConfig подставляет базу и для путей с папкой, и без неё', () => {
  const conf = [
    'generic script-path=routehub-viewer.js, tag=RH-View',
    'generic script-path=scripts/routehub-speedtest.js, tag=RH-Speed',
    'generic script-path=probes/routehub-probe-context.js, tag=RH-L10',
  ].join('\n');
  const out = T.LOON.renderConfig(conf, {
    key: 'k1', base: 'https://w.invalid/t/TOK', dev: {},
    blocks: { filters: '', groups: '' }, subParams: ',udp=true',
    scriptBase: 'https://raw.invalid/repo/',
  });
  assert.ok(out.indexOf('script-path=https://raw.invalid/repo/routehub-viewer.js') >= 0);
  assert.ok(out.indexOf('script-path=https://raw.invalid/repo/scripts/routehub-speedtest.js') >= 0,
    'путь с папкой scripts/ должен получить базу');
  assert.ok(out.indexOf('script-path=https://raw.invalid/repo/probes/routehub-probe-context.js') >= 0);
  assert.ok(out.indexOf('script-path=scripts/') < 0, 'остался неподставленный относительный путь');
});
