import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ActingFor } from '../src/acting.js';
import { addAccepted, removeByLinkAllowed } from '../src/manual.js';
import { leadershipMessage, memoMessages, unregisteredMessage } from '../src/memo.js';
import { STAFF_BUTTONS, STAFF_MODALS, STAFF_ROLES, Staff, panelMessage, roleByRank, roleTitle, staffModal } from '../src/staff.js';
import { statsMessages } from '../src/stats.js';
import { Store } from '../src/store.js';

const OWNER = '900';
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'staff-'));
const tempFile = () => path.join(tempDir(), 'staff.json');
const tempStaff = () => new Staff(tempFile(), OWNER);

test('ранги: числа от 6 до 1, сверху вниз', () => {
  assert.deepEqual(
    STAFF_ROLES.map((r) => `${r.label} ${r.rank}`),
    [
      'Генерал армии 6',
      'Заместитель армии 5',
      'Куратор отдела 4',
      'Начальник отдела 3',
      'Заместитель начальника отдела 2',
      'Инструктор 1',
    ],
  );
  assert.equal(roleByRank(5).key, 'army-deputy');
  assert.equal(roleByRank(7), null);
  assert.equal(roleTitle(roleByRank(6)), '[6] Генерал армии');
});

test('владелец добавляет кого угодно на любой ранг', () => {
  const staff = tempStaff();
  assert.equal(staff.assignableRoles(OWNER).length, 6);
  assert.equal(staff.canAssign(OWNER, 'general', '1'), true);
  staff.add('general', '1');
  assert.equal(staff.canAssign(OWNER, 'instructor', '1'), true); // и переназначить генерала
});

test('каждый добавляет только на ранги ниже своего', () => {
  const staff = tempStaff();
  staff.add('general', '1');
  staff.add('army-deputy', '2');
  staff.add('instructor', '6');

  assert.deepEqual(staff.assignableRoles('1').map((r) => r.rank), [5, 4, 3, 2, 1]);
  assert.equal(staff.canAssign('1', 'general', '10'), false); // на такой же ранг нельзя
  assert.equal(staff.canAssign('1', 'army-deputy', '10'), true);

  assert.deepEqual(staff.assignableRoles('2').map((r) => r.rank), [4, 3, 2, 1]);
  assert.equal(staff.canAssign('2', 'army-deputy', '10'), false);
  assert.equal(staff.canAssign('2', 'curator', '10'), true);

  // инструктор и человек вне системы не добавляют никого
  assert.deepEqual(staff.assignableRoles('6'), []);
  assert.deepEqual(staff.assignableRoles('777'), []);
  assert.equal(staff.canAssign('6', 'instructor', '10'), false);
});

test('нельзя тронуть того, кто выше или наравне: ни переместить, ни убрать, ни поменять имя', () => {
  const staff = tempStaff();
  staff.add('general', '1');
  staff.add('army-deputy', '2');
  staff.add('curator', '3');
  staff.add('instructor', '6');

  assert.equal(staff.canAssign('3', 'instructor', '2'), false); // куратор не разжалует заместителя армии
  assert.equal(staff.canAssign('2', 'instructor', '1'), false);
  assert.equal(staff.canAssign('2', 'instructor', '2'), false); // и себя
  assert.equal(staff.canEdit('3', '2'), false);
  assert.equal(staff.canEdit('3', '3'), false);
  assert.equal(staff.canEdit('2', '3'), true); // ниже: можно
  assert.equal(staff.canEdit('6', '6'), false); // инструктор наравне с собой
  assert.equal(staff.canEdit('2', '999'), false); // такого человека нет в списке
  assert.equal(staff.canEdit(OWNER, '999'), false); // и владельцу нечего убирать

  assert.equal(staff.outranks('2', '3'), true);
  assert.equal(staff.outranks('6', '2'), false);
  assert.equal(staff.outranks('2', '999'), false); // не в списке: не ниже
  assert.equal(staff.outranks(OWNER, '999'), true); // кроме владельца
});

test('кто уже в списке, переносится на новый ранг, дубля нет', () => {
  const staff = tempStaff();
  assert.equal(staff.add('instructor', '5', '[Инст.Delta] Иван Петров'), 'added');
  assert.equal(staff.add('deputy', '5', '[Зам.Delta] Иван Петров'), 'moved');
  assert.equal(staff.roleKeyOf('5'), 'deputy');
  assert.deepEqual(staff.members('instructor'), []);
  assert.deepEqual(staff.everyone(), ['5']);
});

test('убрать человека, имя и фамилия', () => {
  const staff = tempStaff();
  staff.add('instructor', '5', '  [Инст.Delta] Иван Петров ');
  assert.equal(staff.nameOf('5'), '[Инст.Delta] Иван Петров');
  assert.equal(staff.setName('5', '[Инст.Delta] Пётр Иванов'), true);
  assert.equal(staff.nameOf('5'), '[Инст.Delta] Пётр Иванов');
  assert.equal(staff.setName('404', 'x'), false);

  assert.equal(staff.remove('5'), true);
  assert.equal(staff.remove('5'), false);
  assert.equal(staff.has('5'), false);
});

test('старший состав: всё выше инструктора', () => {
  const staff = tempStaff();
  staff.add('curator', '3');
  staff.add('instructor', '6');
  assert.equal(staff.isManager('3'), true);
  assert.equal(staff.isManager('6'), false);
  assert.equal(staff.isManager('999'), false);
  assert.equal(staff.has('6'), true);
  assert.equal(staff.rolesOf('6'), 'Инструктор');
  assert.deepEqual(staff.everyone().sort(), ['3', '6']);
});

test('сохранение на диск и прежние названия', () => {
  const file = tempFile();
  new Staff(file, OWNER).add('army-deputy', '2', 'Имя Фамилия');
  const again = new Staff(file, OWNER);
  assert.equal(again.roleKeyOf('2'), 'army-deputy');
  assert.equal(again.nameOf('2'), 'Имя Фамилия');

  const legacy = tempFile();
  fs.writeFileSync(legacy, JSON.stringify({ 'senior-admin': ['1'], admin: ['2'], 'senior-staff': ['3'] }));
  const migrated = new Staff(legacy, OWNER);
  assert.equal(migrated.roleKeyOf('1'), 'general');
  assert.equal(migrated.roleKeyOf('2'), 'army-deputy');
  assert.equal(migrated.roleKeyOf('3'), 'instructor');
});

test('панель: все шесть рангов с числами, инструкторы тоже здесь', () => {
  const staff = tempStaff();
  staff.add('deputy', '4', '[Зам.Delta] Иван Петров');
  staff.add('instructor', '6', '[Инст.Delta] Пётр Иванов');

  const fields = panelMessage(staff, OWNER).embeds[0].toJSON().fields;
  assert.deepEqual(
    fields.map((f) => f.name),
    [
      '[6] Генерал армии',
      '[5] Заместитель армии',
      '[4] Куратор отдела',
      '[3] Начальник отдела',
      '[2] Заместитель начальника отдела',
      '[1] Инструктор',
    ],
  );
  assert.equal(fields[4].value, '<@4> | [Зам.Delta] Иван Петров');
  assert.equal(fields[5].value, '<@6> | [Инст.Delta] Пётр Иванов');
  assert.equal(fields[0].value, '—');
});

test('панель: пять кнопок у тех, у кого есть кто-то ниже; у инструктора кнопок нет', () => {
  const staff = tempStaff();
  staff.add('deputy', '4');
  staff.add('instructor', '6');

  const buttonsOf = (actor) => panelMessage(staff, actor).components.flatMap((row) => row.toJSON().components);
  for (const actor of [OWNER, '4']) {
    const buttons = buttonsOf(actor);
    assert.deepEqual(buttons.map((b) => b.label), ['Добавить', 'Убрать', 'Изменить имя', 'Добавить отчёт', 'Убрать отчёт']);
    assert.deepEqual(buttons.map((b) => b.custom_id), Object.values(STAFF_BUTTONS));
  }
  assert.deepEqual(buttonsOf('6'), []); // ниже инструктора никого нет
  assert.deepEqual(buttonsOf('999'), []);
});

test('окна: поля по сценарию «ранг, ID, имя» и «только ID»', () => {
  const fieldIds = (kind) => staffModal(kind).toJSON().components.map((row) => row.components[0].custom_id);
  assert.deepEqual(fieldIds('add'), ['rank', 'user', 'name']); // ранг первым, потом ID и имя
  assert.deepEqual(fieldIds('remove'), ['user']); // увольнение без ранга
  assert.deepEqual(fieldIds('name'), ['user', 'name']);
  assert.deepEqual(fieldIds('addReport'), ['user']);
  assert.deepEqual(fieldIds('removeReport'), ['link']);
  for (const kind of Object.keys(STAFF_BUTTONS)) {
    const modal = staffModal(kind).toJSON();
    assert.equal(modal.custom_id, STAFF_MODALS[kind]);
    assert.ok(modal.title.length <= 45);
  }
});

test('длинный список в эмбеде обрезается под лимит поля (1024)', () => {
  const staff = tempStaff();
  for (let i = 0; i < 80; i++) staff.add('instructor', String(100000000000000000n + BigInt(i)), '[Инст.Delta] Очень Длинное Имя Фамилия');
  const field = panelMessage(staff, OWNER).embeds[0].toJSON().fields.find((f) => f.name === '[1] Инструктор');
  assert.ok(field.value.length <= 1024);
  assert.match(field.value, /и ещё \d+$/);
});

test('удаление отчёта: свои и тех, кто ниже по рангу; чужой инструктор нельзя', () => {
  const staff = tempStaff();
  staff.add('curator', '3');
  staff.add('instructor', '6');
  staff.add('instructor', '7');

  const link = 'https://discord.com/channels/713076174108229712/1027944923829383188/1548582679338024982';
  const other = new Store(path.join(tempDir(), '7.json'));
  const own = new Store(path.join(tempDir(), '6.json'));
  const mine = new Store(path.join(tempDir(), '3.json'));
  addAccepted(other, { id: '621978844894593026', name: 'A B', link, points: 60, rank: 12, position: 'Delta' });
  const stores = [{ checkerId: '7', store: other }, { checkerId: '6', store: own }, { checkerId: '3', store: mine }];

  // инструктор «6» не может удалить отчёт инструктора «7»
  const canRemove6 = (c) => c === '6' || staff.outranks('6', c);
  assert.deepEqual(removeByLinkAllowed(stores, link, canRemove6), { removed: [], denied: ['7'] });
  assert.equal(other.entries().length, 1);

  // куратор «3» выше инструктора: может
  const canRemove3 = (c) => c === '3' || staff.outranks('3', c);
  assert.deepEqual(removeByLinkAllowed(stores, link, canRemove3), { removed: [{ checkerId: '7', name: 'A B' }], denied: [] });
  assert.equal(other.entries().length, 0);

  assert.deepEqual(removeByLinkAllowed(stores, link, canRemove3), { removed: [], denied: [] }); // уже нет
  assert.match(removeByLinkAllowed(stores, 'не ссылка', canRemove3).error, /ссылк/);
});

test('режим «за другого»: одноразовый, с ограничением по времени', () => {
  const acting = new ActingFor();
  assert.equal(acting.get('1'), null);
  acting.set('1', '6', 1000);
  assert.equal(acting.get('1', 1000 + 29 * 60 * 1000), '6');
  assert.equal(acting.get('1', 1000 + 31 * 60 * 1000), null);
  acting.set('1', '6', 1000);
  acting.clear('1');
  assert.equal(acting.get('1', 1001), null);
  acting.set('1', '6', 1000);
  acting.set('1', '7', 1000);
  assert.equal(acting.get('1', 1001), '7');
});

test('помощь: незарегистрированным — обратитесь к старшему составу и ID', () => {
  const text = unregisteredMessage('123456789012345678');
  assert.match(text, /не зарегистрированы/);
  assert.match(text, /старшему составу/);
  assert.match(text, /123456789012345678/);
  assert.doesNotMatch(text, /\/инструктор/); // такой команды больше нет
});

test('помощь для старшего состава: кнопки, кого можно, отчёты', () => {
  const text = leadershipMessage({ level: '[6] Генерал армии', addable: ['[5] Заместитель армии', '[4] Куратор отдела'], canReports: true });
  assert.match(text, /Генерал армии/);
  assert.match(text, /\[5\] Заместитель армии, \[4\] Куратор отдела/);
  for (const button of ['Добавить', 'Убрать', 'Изменить имя', 'Добавить отчёт', 'Убрать отчёт']) assert.match(text, new RegExp(`«${button}»`));
  assert.match(text, /переносится на новый ранг/);
  assert.match(text, /\/общий-отчет/);
  assert.doesNotMatch(text, /\/инструктор/);

  assert.doesNotMatch(leadershipMessage({ level: 'Инструктор', addable: [], canReports: false }), /\/общий-отчет/);
});

test('помощь: сообщения влезают в лимит Discord', () => {
  const all = [
    ...memoMessages('ARMY Delta Inst'),
    leadershipMessage({ level: 'Владелец', addable: STAFF_ROLES.map(roleTitle), canReports: true }),
    unregisteredMessage('123456789012345678'),
  ];
  assert.ok(all.every((m) => m.length <= 2000));
});

test('статистика: сортировка, итог, люди без отчётов тоже видны', () => {
  const [text] = statsMessages([
    { checkerId: '1', roles: 'Инструктор', accepted: 1, rejected: 0 },
    { checkerId: '2', roles: '', accepted: 5, rejected: 2 },
    { checkerId: '3', roles: 'Инструктор', accepted: 0, rejected: 0 },
  ]);
  const lines = text.split('\n');
  assert.equal(lines[1], '- <@2>: принято 5, отказано 2, всего 7');
  assert.equal(lines[2], '- <@1> (Инструктор): принято 1, отказано 0, всего 1');
  assert.equal(lines[3], '- <@3> (Инструктор): принято 0, отказано 0, всего 0');
  assert.equal(lines.at(-1), '**Итого:** принято 6, отказано 2, всего 8');
});

test('статистика: длинный список делится на сообщения', () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ checkerId: String(100000000000000000n + BigInt(i)), roles: 'Инструктор', accepted: 1, rejected: 1 }));
  const parts = statsMessages(rows);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((m) => m.length <= 2000));
  assert.match(parts.at(-1), /Итого/);
});

test('ранг словами для сообщений об отказе', () => {
  const staff = tempStaff();
  staff.add('head', '3');
  assert.equal(staff.describeRank(OWNER), 'владелец');
  assert.equal(staff.describeRank('3'), '[3] Начальник отдела');
  assert.equal(staff.describeRank('999'), 'нет в списке');
});

test('владелец может добавить в список и себя; остальные себя — нет', () => {
  const staff = tempStaff();
  assert.equal(staff.canAssign(OWNER, 'general', OWNER), true);
  assert.equal(staff.add('general', OWNER, 'Имя Фамилия'), 'added');

  // запись в списке ничего не меняет в правах: владелец по-прежнему выше всех
  assert.equal(staff.rankOf(OWNER), Infinity);
  assert.equal(staff.describeRank(OWNER), 'владелец');
  assert.equal(staff.canAssign(OWNER, 'instructor', '5'), true);
  assert.equal(staff.canEdit(OWNER, OWNER), true); // имя себе поменять и убрать себя из списка можно

  staff.add('curator', '3');
  assert.equal(staff.canAssign('3', 'instructor', '3'), false); // сам себя перевести нельзя
  assert.equal(staff.canAssign('3', 'curator', '3'), false);
  assert.equal(staff.canAssign('3', 'general', '5'), false); // и поставить выше себя тоже
});
