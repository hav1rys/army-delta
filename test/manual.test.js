import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { formRows } from '../src/forms.js';
import { addAccepted, addRejected, badIdMessage, badRankMessage, findDuplicate, parseUserId, removeByLink } from '../src/manual.js';
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

test('одна ссылка — один отчёт: повторно добавить ту же ссылку нельзя, старая запись остаётся', () => {
  const store = tempStore();
  assert.equal(addAccepted(store, ACCEPTED).error, undefined);

  const again = addAccepted(store, { ...ACCEPTED, points: 60 });
  assert.match(again.error, /эта ссылка уже добавлена/);
  assert.match(again.error, /\/удалить-отчет/);
  const rejectedAgain = addRejected(store, { id: ACCEPTED.id, name: 'Vladislav Siberyak', link: LINK, reason: 'Передумали' });
  assert.match(rejectedAgain.error, /эта ссылка уже добавлена/);

  const entries = store.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].verdict.accepted, true);
  assert.equal(entries[0].verdict.points, 125); // не перезаписалось
});

test('одна ссылка — один отчёт: проверяется у всех проверяющих сразу', () => {
  const a = tempStore();
  const b = tempStore();
  const stores = [{ checkerId: '111', store: a }, { checkerId: '222', store: b }];
  addAccepted(a, ACCEPTED, stores);

  // та же ссылка у другого проверяющего, даже на другого человека
  const r = addAccepted(b, { ...ACCEPTED, id: '466633638511902752' }, stores);
  assert.match(r.error, /<@111>/); // видно, кто проверил
  assert.match(r.error, /<@621978844894593026>/); // и чей это отчёт
  assert.equal(b.entries().length, 0);
});

test('у одного человека отчётов может быть сколько угодно, если ссылки разные', () => {
  const a = tempStore();
  const b = tempStore();
  const stores = [{ checkerId: '111', store: a }, { checkerId: '222', store: b }];
  const link = (n) => LINK.slice(0, -1) + n;

  assert.equal(addAccepted(a, { ...ACCEPTED, link: link(3), points: 60 }, stores).error, undefined);
  assert.equal(addAccepted(a, { ...ACCEPTED, link: link(4), points: 125 }, stores).error, undefined);
  assert.equal(addAccepted(b, { ...ACCEPTED, link: link(5), points: 90 }, stores).error, undefined); // и у другого проверяющего
  assert.equal(addRejected(b, { id: ACCEPTED.id, name: ACCEPTED.name, link: link(6), reason: 'нет скриншотов' }, stores).error, undefined);
  assert.equal(a.entries().length + b.entries().length, 4);
});

test('findDuplicate: ищет по ссылке, а не по человеку', () => {
  const store = tempStore();
  addAccepted(store, ACCEPTED);
  const stores = [{ checkerId: '1', store }];
  assert.equal(findDuplicate(stores, '1548582679338024982').checkerId, '1');
  assert.equal(findDuplicate(stores, '999'), null); // другая ссылка — не дубль, хоть человек тот же
});

test('ошибка про ID показывает, что ввели, и подсказывает, где взять ID', () => {
  const text = badIdMessage('@Ruslan Evil');
  assert.match(text, /получил «@Ruslan Evil»/);
  assert.match(text, /17–20 цифр/);
  assert.match(text, /Копировать ID/);
  assert.match(badIdMessage(''), /«пусто»/);
  assert.match(badIdMessage('x'.repeat(100)), /«x{40}…»/); // длинный ввод обрезается

  // и в командах добавления
  const store = tempStore();
  assert.match(addAccepted(store, { ...ACCEPTED, id: '@Ruslan Evil' }).error, /получил «@Ruslan Evil»/);
});

test('ошибка про ранг: диапазон и что ввели', () => {
  assert.equal(badRankMessage('9', 6), 'Ранг — цифра от 1 до 6 (в скобках перед названием ранга). Получил «9».');
});
