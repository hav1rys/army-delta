import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findReports, lookupMessages, parseQueries } from '../src/lookup.js';
import { addAccepted, addRejected } from '../src/manual.js';
import { Store } from '../src/store.js';

const LINK = 'https://discord.com/channels/713076174108229712/1027944923829383188/154858267933802498';
const tempStore = () => new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-')), 'state.json'));

const VLAD = '621978844894593026';
const SANTA = '466633638511902752';
const MATVEY = '766166436656709642';

/** Проверяющий 111: Vladislav (принят, 125) и Santa (отказ). Проверяющий 222: Matvey ждёт проверки. */
function setup() {
  const a = tempStore();
  const b = tempStore();
  addAccepted(a, { id: VLAD, name: 'Vladislav Siberyak', link: `${LINK}1`, points: 125, rank: 12, position: 'Delta' });
  addRejected(a, { id: SANTA, name: 'Santa Siberyak', link: `${LINK}2`, reason: 'У тебя альбом пуст' });
  b.setReport('333', { name: 'Matvey_Siberyak', rank: '12', position: 'Delta', total: 90, link: `${LINK}3` });
  return [{ checkerId: '111', store: a }, { checkerId: '222', store: b }];
}

test('разбор списка: запятая, точка с запятой, перенос строки, ID и упоминания', () => {
  assert.deepEqual(parseQueries('Ivan Petrov, Anna Sidorova;\nPetr'), [
    { kind: 'name', name: 'Ivan Petrov' },
    { kind: 'name', name: 'Anna Sidorova' },
    { kind: 'name', name: 'Petr' },
  ]);
  assert.deepEqual(parseQueries(`${VLAD} <@${SANTA}>`), [
    { kind: 'id', id: VLAD },
    { kind: 'id', id: SANTA },
  ]);
  assert.deepEqual(parseQueries(`Ivan Petrov, ${VLAD}`), [{ kind: 'name', name: 'Ivan Petrov' }, { kind: 'id', id: VLAD }]);
  assert.deepEqual(parseQueries('Ivan Petrov, ivan  petrov, IVAN_PETROV'), [{ kind: 'name', name: 'Ivan Petrov' }]); // без повторов
  assert.deepEqual(parseQueries(' , ;; '), []);
});

test('по имени: точное, без регистра, с подчёркиванием и в другом порядке слов', () => {
  const stores = setup();
  const names = (text) => findReports(stores, parseQueries(text)[0]).map((m) => m.entry?.report?.name ?? m.pending.name);
  assert.deepEqual(names('Vladislav Siberyak'), ['Vladislav Siberyak']);
  assert.deepEqual(names('vladislav siberyak'), ['Vladislav Siberyak']);
  assert.deepEqual(names('Siberyak Vladislav'), ['Vladislav Siberyak']);
  assert.deepEqual(names('Matvey Siberyak'), ['Matvey_Siberyak']); // подчёркивание = пробел
  assert.deepEqual(names('Siberyak').sort(), ['Matvey_Siberyak', 'Santa Siberyak', 'Vladislav Siberyak']); // одна фамилия
  assert.deepEqual(names('Nobody Here'), []);
});

test('по ID: ищет отчёты этого человека', () => {
  const stores = setup();
  assert.equal(findReports(stores, { kind: 'id', id: VLAD })[0].checkerId, '111');
  assert.deepEqual(findReports(stores, { kind: 'id', id: MATVEY }), []); // его отчёт ждёт проверки, ID у него ещё нет
});

test('ответ: есть, отказан, ждёт проверки, нет, и итог', () => {
  const [text] = lookupMessages(setup(), `Vladislav Siberyak, ${SANTA}, Matvey Siberyak, Li Il`);
  const lines = text.split('\n');
  assert.match(lines[0], /^✅ \*\*Vladislav Siberyak\*\* \(Vladislav Siberyak\): принят, 125 б\., проверил <@111>/);
  assert.match(lines[1], new RegExp(`^⚠️ \\*\\*<@${SANTA}>\\*\\* \\(Santa Siberyak\\): есть, но отказан \\(У тебя альбом пуст\\), проверил <@111>`));
  assert.match(lines[2], /^📄 \*\*Matvey Siberyak\*\*: отчёт есть, проверки ещё нет \(у <@222>\)/);
  assert.equal(lines[3], '❌ **Li Il**: отчёта нет');
  assert.equal(lines[4], '**Итого:** отчёт есть у 3, нет у 1 (из 4).');
  assert.equal(lines[5], 'Нет отчёта: Li Il');
});

test('ответ: пустой ввод и все отчёты на месте', () => {
  assert.match(lookupMessages(setup(), '  ,  ')[0], /Ничего не распознал/);
  const [text] = lookupMessages(setup(), 'Vladislav Siberyak');
  assert.doesNotMatch(text, /Нет отчёта:/); // раздела «нет» нет, когда все есть
  assert.match(text, /отчёт есть у 1, нет у 0 \(из 1\)/);
});

test('ответ: длинный список делится на сообщения, не больше 100 запросов', () => {
  const names = Array.from({ length: 120 }, (_, i) => `Person${i} Surname${i}`).join(', ');
  const parts = lookupMessages(setup(), names);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((m) => m.length <= 2000));
  const all = parts.join('\n');
  assert.match(all, /из 100\)/);
  assert.match(all, /Проверил только первые 100 из 120/);
});
