// Тесты клиентского слоя Loon (ADR-01, v1.9.6).
// Ядро отдаёт посчитанное, clients/loon.js превращает это в текст конфига.
// Если плейсхолдер уцелел или аргумент скрипта не подставился — устройство
// получит нерабочий конфиг молча.

import test from 'node:test';
import assert from 'node:assert/strict';
import { T } from './harness.js';

test('renderConfig подставляет плейсхолдеры и аргументы скриптов', () => {
  const conf = [
    'Lastdep = https://old.invalid/n,udp=true',
    '# __RH_AI_FILTERS__',
    '# __RH_AI_GROUPS__',
    '# __RH_MYLIST_URL__',
    'generic script-path=routehub-speedtest.js, tag=RH-Speed, timeout=60',
    'generic script-path=routehub-netwatch.js, tag=RH-Net, timeout=60',
  ].join('\n');
  const out = T.renderConfig(conf, {
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
  const out = T.renderConfig('generic script-path=routehub-speedtest.js, tag=RH-Speed', {
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
  assert.equal(T.subParamsFromConf(conf), ',block-quic=false,udp=true,enabled=true');
});

test('subParamsFromConf: строки нет либо параметров нет — запасной дефолт', () => {
  assert.equal(T.subParamsFromConf('# пусто'), ',udp=true,enabled=true');
  assert.equal(T.subParamsFromConf('Lastdep = https://x.invalid/n'), ',udp=true,enabled=true');
});
