import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formRows } from '../src/forms.js';
import { addAccepted, addRejected, findDuplicate, parseUserId, removeByLink } from '../src/manual.js';
import { Store } from '../src/store.js';

const LINK = 'https://discord.com/channels/713076174108229712/1027944923829383188/1548582679338024982';
const LINK3 = LINK.replace('https://', 'https:/\\/');
const OTHER = LINK.slice(0, -1) + '3'; // другой отчёт: id сообщения отличается последней цифрой

const tempStore = () => new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chec-')), 'state.json'));

const ACCEPTED = { id: '621978844894593026', name: 'Vladislav Siberyak', link: LINK, points: 125, rank: 12, position: 'Delta' };

test('ID человека: число или упоминание', () => {
  assert.equal(parseUserId('621978844894593026'), '621978844894593026');
  assert.equal(parseUserId('<@621978844894593026>'), '621978844894593026');
  assert.equal(parseUserId('привет'), null);
  assert.equal(parseUserId('12345'), null);
});

test('добавить принятый: попадает в формы 1 и 3', () => {
  const store = tempStore();
  const { entry, error } = addAccepted(store, ACCEPTED);
  assert.equal(error, undefined);
  assert.equal(entry.verdict.accepted, true);

  const rows = formRows(store.entries());
  assert.deepEqual(rows.accepted, [`<@621978844894593026> | Vladislav Siberyak | ${LINK} | 125`]);
  assert.deepEqual(rows.bonuses, [`Vladislav Siberyak | 12 | Delta | ${LINK3} | 125 | Высокая`]);
  assert.deepEqual(rows.warnings, []);
});

test('добавить отказанный: попадает в форму 2', () => {
  const store = tempStore();
  const { error } = addRejected(store, { id: '<@466633638511902752>', name: 'Santa Siberyak', link: LINK, reason: 'У тебя альбом пуст' });
  assert.equal(error, undefined);

  const rows = formRows(store.entries());
  assert.deepEqual(rows.rejected, [`<@466633638511902752> | Santa Siberyak | ${LINK} | У тебя альбом пуст`]);
  assert.deepEqual(rows.accepted, []);
  assert.deepEqual(rows.bonuses, []);
});

test('добавить: неверный ID или ссылка — ошибка, ничего не сохраняется', () => {
  const store = tempStore();
  assert.match(addAccepted(store, { ...ACCEPTED, id: 'abc' }).error, /ID/);
  assert.match(addAccepted(store, { ...ACCEPTED, link: 'https://example.com' }).error, /ссылк/);
  assert.match(addRejected(store, { id: '621978844894593026', name: 'X', link: 'нет', reason: 'р' }).error, /ссылк/);
  assert.equal(store.entries().length, 0);
});

test('добавить ту же ссылку повторно: заменяет, а не дублирует', () => {
  const store = tempStore();
  addAccepted(store, ACCEPTED);
  addAccepted(store, { ...ACCEPTED, points: 60 });
  addRejected(store, { id: ACCEPTED.id, name: 'Vladislav Siberyak', link: LINK, reason: 'Передумали' });
  const entries = store.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].verdict.accepted, false);
});

test('удалить по ссылке: принятый и отказанный, соседний отчёт не тронут', () => {
  const store = tempStore();
  addAccepted(store, ACCEPTED);
  addRejected(store, { id: '466633638511902752', name: 'Santa', link: OTHER, reason: 'р' });

  assert.deepEqual(removeByLink(store, LINK), { removed: true, name: 'Vladislav Siberyak' });
  assert.equal(store.entries().length, 1);
  assert.deepEqual(removeByLink(store, OTHER), { removed: true, name: 'Santa' });
  assert.equal(store.entries().length, 0);
});

test('удалить: нет такого отчёта и неверная ссылка', () => {
  const store = tempStore();
  assert.deepEqual(removeByLink(store, LINK), { removed: false });
  assert.match(removeByLink(store, 'не ссылка').error, /ссылк/);
});

test('удаление сохраняется на диск', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chec-')), 'state.json');
  const store = new Store(file);
  addAccepted(store, ACCEPTED);
  removeByLink(store, LINK);
  assert.equal(new Store(file).entries().length, 0);
});

test('один человек — один отчёт: повтор ID у любого проверяющего — ошибка', () => {
  const a = tempStore();
  const b = tempStore();
  const stores = [{ checkerId: '111', store: a }, { checkerId: '222', store: b }];
  addAccepted(a, ACCEPTED, stores);

  // тот же человек, другая ссылка, другой проверяющий
  const other = OTHER;
  const r1 = addAccepted(b, { ...ACCEPTED, link: other }, stores);
  assert.match(r1.error, /уже есть отчёт/);
  assert.match(r1.error, /<@111>/); // видно, кто проверил
  assert.equal(b.entries().length, 0);

  // и отказ на того же человека — тоже ошибка
  const r2 = addRejected(b, { id: ACCEPTED.id, name: 'X', link: other, reason: 'р' }, stores);
  assert.match(r2.error, /уже есть отчёт/);
});

test('один человек — один отчёт: имя, ранг, должность и баллы могут повторяться; тот же отчёт перезаписывается', () => {
  const store = tempStore();
  const stores = [{ checkerId: '1', store }];
  addAccepted(store, ACCEPTED, stores);

  // другой человек с теми же именем, рангом, должностью и баллами — можно
  const twin = addAccepted(store, { ...ACCEPTED, id: '466633638511902752', link: OTHER }, stores);
  assert.equal(twin.error, undefined);
  assert.equal(store.entries().length, 2);

  // тот же человек и та же ссылка — это поправка, а не дубль
  assert.equal(addAccepted(store, { ...ACCEPTED, points: 70 }, stores).error, undefined);
  assert.equal(store.entries().length, 2);
});

test('findDuplicate: находит только другой отчёт того же человека', () => {
  const store = tempStore();
  addAccepted(store, ACCEPTED);
  const stores = [{ checkerId: '1', store }];
  assert.equal(findDuplicate(stores, ACCEPTED.id, '1548582679338024982'), null);
  assert.equal(findDuplicate(stores, ACCEPTED.id, '999').checkerId, '1');
  assert.equal(findDuplicate(stores, '466633638511902752', '999'), null);
});
