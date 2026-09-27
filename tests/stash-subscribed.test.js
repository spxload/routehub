// Профиль Stash S-draft-11: строки `#SUBSCRIBED` в выдаче НЕТ (S-draft-10 её
// добавлял — снято).
//
// ЗАЧЕМ СНЯТО. Worker отдавал одну строку, а в файле на устройстве их две:
// вторую дописывает сам Stash, сохраняя профиль, скачанный по ссылке
// (проверено 27.09: живой /config — одна строка, файл на устройстве — две).
// Stash и так считает такой профиль подписанным; наша строка лишняя. Да и
// обновление по сроку идёт только на переднем плане (экран «Ресурсы») —
// фоновому обновлению узлов она не помогает (опыт ST22).
//
// Что сторожится:
//   * ни в одной форме членства, ни на живом /config нет строки #SUBSCRIBED;
//   * первая строка — шапка с версией (как до S-draft-10);
//   * функции subscribeUrl в слое нет (мёртвый код не возвращается);
//   * Loon и routehub.conf не тронуты;
//   * профиль разбирается PyYAML (если есть на машине).

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
const HEAD = '# RouteHub — профиль Stash, ' + P.VERSION;

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

test('renderProfile: строки #SUBSCRIBED нет ни в одной форме членства; первая строка — шапка', () => {
  for (const t of [P.renderProfile(CTX), P.renderProfile({ ...CTX, membership: 'provider' })]) {
    assert.ok(t.indexOf('SUBSCRIBED') < 0, 'метка вернулась');
    assert.equal(first(t), HEAD);
  }
  assert.equal(P.subscribeUrl, undefined, 'subscribeUrl вернулся в слой');
});

test('живой /config (CLIENT=stash): строки #SUBSCRIBED нет, первая — шапка', async () => {
  for (const url of [ORIGIN + '/t/' + TOKEN + '/config?key=k1', ORIGIN + '/config?key=k1&token=' + TOKEN]) {
    const t = await fetchText(url, 'stash');
    assert.ok(t.indexOf('SUBSCRIBED') < 0, url);
    assert.equal(first(t), HEAD);
  }
});

test('Loon: /config без #SUBSCRIBED, routehub.conf не тронут', async () => {
  const t = await fetchText(ORIGIN + '/t/' + TOKEN + '/config?key=k1');
  assert.ok(t.indexOf('#SUBSCRIBED') < 0, 'метка Stash в конфиге Loon');
  assert.ok(fs.readFileSync(path.join(ROOT, 'routehub.conf'), 'utf8').indexOf('SUBSCRIBED') < 0);
});

const PY = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
test('профиль разбирается настоящим YAML-парсером (обе формы)', { skip: PY.status !== 0 && 'нет python3 + PyYAML' }, () => {
  const src = 'import sys, json, yaml\nd = yaml.safe_load(sys.stdin.read())\n' +
    'print(json.dumps({"keys": sorted(d.keys()), "mode": d["mode"], "n": len(d["proxy-groups"])}, ensure_ascii=False))';
  for (const t of [P.renderProfile(CTX), P.renderProfile({ ...CTX, membership: 'provider' })]) {
    const r = spawnSync('python3', ['-c', src], { input: t, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(r.stdout);
    assert.equal(d.mode, 'rule');
    assert.ok(d.n > 5, 'групп подозрительно мало');
  }
});
