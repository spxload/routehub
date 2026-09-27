// Профиль Stash S-draft-10: метка `#SUBSCRIBED <url>` первой строкой.
//
// ЗАЧЕМ. Узлы вшиты в профиль (S-draft-4), а профиль Stash без метки сам не
// обновляется: провайдер сменил узлы — вне дома интернета нет до ручного
// обновления. С меткой первой строкой Stash считает профиль управляемым
// провайдером и перекачивает его с указанного адреса
// (stash.wiki/en/features/service-provider-subscription).
//
// Что сторожится и почему:
//   * метка — ровно ПЕРВАЯ строка и ровно одна: иначе Stash её не узнает;
//   * адрес в метке — тот, по которому профиль скачан (/t/<токен>/config?key=),
//     сверка на живом эндпоинте, а не только на renderProfile: не тот адрес —
//     тихий отказ (Stash обновляется не с того ключа или получает 403);
//   * адрес совпадает с config_url админки — оттуда Диана берёт ссылку;
//   * YAML-комментарий не ломает разбор (PyYAML, если есть на машине);
//   * Loon и routehub.conf не тронуты (правило парности, боевой контур).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { T, ROOT, worker, req, DE } from './harness.js';
import { makeEnv, nodeLine } from './mock-d1.js';

const P = T.STASH_PROFILE;
const TOKEN = 'b'.repeat(32);
const ORIGIN = 'https://w.invalid';
const LINES = [nodeLine('[VPN] ' + DE + ' Германия #1'), nodeLine('[Обход] ' + DE + ' Германия #7')];
const CTX = { key: 'k2', base: ORIGIN + '/t/' + TOKEN, masterLines: LINES, state: {} };

function envFor(client) {
  return makeEnv({
    sub_cache: { ts: Date.now(), n: LINES.length, text: LINES.join('\n'), meta: {} },
    devices: { k1: { status: 'bound', token: TOKEN } },
  }, client === undefined ? {} : { CLIENT: client });
}
async function fetchText(url, client) {
  const r = await worker.fetch(req(url), envFor(client));
  assert.equal(r.status, 200, url + ': ' + r.status);
  return r.text();
}
const first = (t) => t.split('\n')[0];

test('renderProfile: первая строка — #SUBSCRIBED base + /config?key=, в обеих формах членства', () => {
  const want = '#SUBSCRIBED ' + ORIGIN + '/t/' + TOKEN + '/config?key=k2';
  for (const t of [P.renderProfile(CTX), P.renderProfile({ ...CTX, membership: 'provider' })]) {
    const lines = t.split('\n');
    assert.equal(lines[0], want);
    assert.equal(lines[1], '# RouteHub — профиль Stash, ' + P.VERSION, 'прежняя шапка — следующей строкой');
    assert.equal(lines.filter((l) => l.indexOf('#SUBSCRIBED') >= 0).length, 1, 'метка не одна');
  }
  assert.equal(P.subscribeUrl(CTX), want.slice('#SUBSCRIBED '.length));
});

test('живой /config (CLIENT=stash): адрес в метке — ровно адрес запроса', async () => {
  const url = ORIGIN + '/t/' + TOKEN + '/config?key=k1';
  const t = await fetchText(url, 'stash');
  assert.equal(first(t), '#SUBSCRIBED ' + url);
  assert.ok(t.split('\n').slice(1).every((l) => !/^\s*#SUBSCRIBED/.test(l)), '#SUBSCRIBED не только первой строкой');
});

test('запрос с ?token= — метка в форме /t/<токен>/, и по ней профиль отдаётся с той же меткой', async () => {
  const canon = ORIGIN + '/t/' + TOKEN + '/config?key=k1';
  const t = await fetchText(ORIGIN + '/config?key=k1&token=' + TOKEN, 'stash');
  assert.equal(first(t), '#SUBSCRIBED ' + canon);
  assert.equal(first(await fetchText(canon, 'stash')), '#SUBSCRIBED ' + canon, 'обновление по метке меняет адрес');
});

test('адрес в метке совпадает с config_url админки (оттуда Диана берёт ссылку)', async () => {
  const row = T.deviceRow(new URL(ORIGIN + '/admin/keys'), 'k1', { token: TOKEN });
  const t = await fetchText(row.config_url, 'stash');
  assert.equal(first(t), '#SUBSCRIBED ' + row.config_url);
});

test('Loon: /config без #SUBSCRIBED, routehub.conf не тронут', async () => {
  const t = await fetchText(ORIGIN + '/t/' + TOKEN + '/config?key=k1');
  assert.ok(t.indexOf('#SUBSCRIBED') < 0, 'метка Stash в конфиге Loon');
  assert.ok(fs.readFileSync(path.join(ROOT, 'routehub.conf'), 'utf8').indexOf('SUBSCRIBED') < 0);
});

const PY = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
test('профиль с меткой разбирается настоящим YAML-парсером (обе формы)', { skip: PY.status !== 0 && 'нет python3 + PyYAML' }, () => {
  const src = 'import sys, json, yaml\nd = yaml.safe_load(sys.stdin.read())\n' +
    'print(json.dumps({"keys": sorted(d.keys()), "mode": d["mode"], "n": len(d["proxy-groups"])}, ensure_ascii=False))';
  for (const t of [P.renderProfile(CTX), P.renderProfile({ ...CTX, membership: 'provider' })]) {
    assert.equal(first(t).indexOf('#SUBSCRIBED '), 0);
    const r = spawnSync('python3', ['-c', src], { input: t, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(r.stdout);
    assert.equal(d.mode, 'rule');
    assert.ok(d.n > 5, 'групп подозрительно мало');
    assert.ok(d.keys.indexOf('SUBSCRIBED') < 0 && d.keys.every((k) => k.indexOf('http') < 0), 'метка разобрана как ключ');
  }
});
