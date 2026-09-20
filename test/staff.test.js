import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { leadershipMessage, memoMessages, unregisteredMessage } from '../src/memo.js';
import { ActingFor } from '../src/acting.js';
import {
  INSTRUCTOR_BUTTONS,
  INSTRUCTOR_MODALS,
  STAFF_ROLES,
  Staff,
  addModal,
  instructorModal,
  instructorPanelMessage,
  isInstructorInteractionId,
  nameModal,
  panelMessage,
  roleByKey,
} from '../src/staff.js';
import { statsMessages } from '../src/stats.js';

const OWNER = '900';
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'staff-')), 'staff.json');
const tempStaff = () => new Staff(tempFile(), OWNER);

test('уровни сверху вниз', () => {
  assert.deepEqual(
    STAFF_ROLES.map((r) => r.label),
    ['Генерал армии', 'Заместитель армии', 'Куратор отдела', 'Начальник отдела', 'Заместитель начальника отдела', 'Инструктор'],
  );
});

test('владелец добавляет кого угодно, в любой уровень', () => {
  const staff = tempStaff();
  assert.equal(staff.assignableRoles(OWNER).length, 6);
  assert.equal(staff.canAssign(OWNER, 'general', '1'), true);
  staff.add('general', '1');
  assert.equal(staff.canAssign(OWNER, 'instructor', '1'), true); // владелец может и переназначить генерала
});

test('каждый добавляет только тех, кто строго ниже него', () => {
  const staff = tempStaff();
  staff.add('general', '1');
  staff.add('army-deputy', '2');
  staff.add('curator', '3');
  staff.add('instructor', '6');

  // генерал армии: заместителя армии и ниже, но не такого же генерала
  assert.deepEqual(staff.assignableRoles('1').map((r) => r.key), ['army-deputy', 'curator', 'head', 'deputy', 'instructor']);
  assert.equal(staff.canAssign('1', 'general', '10'), false);
  assert.equal(staff.canAssign('1', 'army-deputy', '10'), true);

  // заместитель армии: куратора и ниже
  assert.deepEqual(staff.assignableRoles('2').map((r) => r.key), ['curator', 'head', 'deputy', 'instructor']);
  assert.equal(staff.canAssign('2', 'army-deputy', '10'), false);
  assert.equal(staff.canAssign('2', 'curator', '10'), true);

  // инструктор не добавляет никого, человек вне системы — тоже
  assert.deepEqual(staff.assignableRoles('6'), []);
  assert.deepEqual(staff.assignableRoles('777'), []);
  assert.equal(staff.canAssign('6', 'instructor', '10'), false);
});

test('нельзя тронуть того, кто выше или наравне: ни переназначить, ни поменять имя', () => {
  const staff = tempStaff();
  staff.add('general', '1');
  staff.add('army-deputy', '2');
  staff.add('curator', '3');

  assert.equal(staff.canAssign('3', 'instructor', '2'), false); // куратор не разжалует заместителя армии
  assert.equal(staff.canAssign('2', 'instructor', '1'), false); // и заместитель — генерала
  assert.equal(staff.canAssign('2', 'instructor', '2'), false); // и себя
  assert.equal(staff.canEdit('3', '2'), false);
  assert.equal(staff.canEdit('3', '3'), false);
  assert.equal(staff.canEdit('2', '3'), true); // выше — можно
  assert.equal(staff.canEdit('2', '999'), false); // такого человека нет
});

test('человек состоит в одном уровне: повторное добавление переносит его', () => {
  const staff = tempStaff();
  assert.equal(staff.add('instructor', '5', '[Инст.Delta] Иван Петров'), 'added');
  assert.equal(staff.add('deputy', '5'), 'moved');
  assert.equal(staff.roleKeyOf('5'), 'deputy');
  assert.deepEqual(staff.members('instructor'), []);
});

test('имя и фамилия: записывается при добавлении и меняется потом', () => {
  const staff = tempStaff();
  staff.add('instructor', '5', '  [Инст.Delta] Иван Петров ');
  assert.equal(staff.nameOf('5'), '[Инст.Delta] Иван Петров');
  assert.equal(staff.setName('5', '[Инст.Delta] Пётр Иванов'), true);
  assert.equal(staff.nameOf('5'), '[Инст.Delta] Пётр Иванов');
  assert.equal(staff.setName('404', 'x'), false);
});

test('руководство — все, кроме инструкторов', () => {
  const staff = tempStaff();
  staff.add('curator', '3');
  staff.add('instructor', '6');
  assert.equal(staff.isManager('3'), true);
  assert.equal(staff.isManager('6'), false);
  assert.equal(staff.has('6'), true);
  assert.equal(staff.rolesOf('6'), 'Инструктор');
  assert.deepEqual(staff.everyone().sort(), ['3', '6']);
});

test('сохранение на диск и прежние названия уровней', () => {
  const file = tempFile();
  new Staff(file, OWNER).add('army-deputy', '2', 'Имя Фамилия');
  const again = new Staff(file, OWNER);
  assert.equal(again.roleKeyOf('2'), 'army-deputy');
  assert.equal(again.nameOf('2'), 'Имя Фамилия');

  // файл со старыми названиями и без имён
  const legacy = tempFile();
  fs.writeFileSync(legacy, JSON.stringify({ 'senior-admin': ['1'], admin: ['2'], 'senior-staff': ['3'] }));
  const migrated = new Staff(legacy, OWNER);
  assert.equal(migrated.roleKeyOf('1'), 'general');
  assert.equal(migrated.roleKeyOf('2'), 'army-deputy');
  assert.equal(migrated.roleKeyOf('3'), 'instructor');
});

test('панель старшего состава: без инструкторов, кнопки только на доступные уровни', () => {
  const staff = tempStaff();
  staff.add('general', '1');
  staff.add('deputy', '4', '[Зам.Delta] Иван Петров');
  staff.add('instructor', '6', '[Инст.Delta] Пётр Иванов');

  const forOwner = panelMessage(staff, OWNER);
  const fields = forOwner.embeds[0].toJSON().fields;
  assert.equal(fields.length, 5); // инструкторов в этой панели нет
  assert.ok(!fields.some((f) => f.name === 'Инструктор'));
  assert.equal(fields.find((f) => f.name === 'Заместитель начальника отдела').value, '<@4> | [Зам.Delta] Иван Петров');
  assert.equal(fields.find((f) => f.name === 'Куратор отдела').value, '—');

  const buttonsOf = (message) => message.components.flatMap((row) => row.toJSON().components);
  assert.equal(buttonsOf(forOwner).length, 6); // 5 уровней + «Изменить имя»
  assert.ok(!buttonsOf(forOwner).some((b) => b.custom_id === 'staff:add:instructor'));

  const forGeneral = buttonsOf(panelMessage(staff, '1'));
  assert.equal(forGeneral.length, 5); // 4 уровня ниже, кроме инструктора, + «Изменить имя»
  assert.ok(!forGeneral.some((b) => b.custom_id === 'staff:add:general'));

  // заместителю начальника отдела добавлять из старшего состава уже некого
  assert.deepEqual(panelMessage(staff, '4').components, []);
  assert.deepEqual(panelMessage(staff, '999').components, []); // не в системе: кнопок нет
  assert.ok(buttonsOf(forOwner).every((b) => b.label.length <= 80));
});

test('/старший-состав и /инструктор: кто что может', () => {
  const staff = tempStaff();
  staff.add('general', '1');
  staff.add('deputy', '4');
  staff.add('instructor', '6');

  assert.equal(staff.assignableSeniorRoles(OWNER).length, 5);
  assert.equal(staff.assignableSeniorRoles('4').length, 0); // зам. начальника: только инструкторов
  assert.equal(staff.canManageInstructors(OWNER), true);
  assert.equal(staff.canManageInstructors('1'), true);
  assert.equal(staff.canManageInstructors('4'), true);
  assert.equal(staff.canManageInstructors('6'), false); // инструктор инструкторов не ведёт
  assert.equal(staff.canManageInstructors('999'), false);
});

test('инструкторы: добавить, убрать, повторное добавление меняет имя', () => {
  const staff = tempStaff();
  assert.equal(staff.canAssign('4', 'instructor', '6'), false); // «4» ещё не в системе: добавлять не может
  staff.add('deputy', '4');
  assert.equal(staff.canAssign('4', 'instructor', '6'), true);

  staff.add('instructor', '6', '[Инст.Delta] Иван Петров');
  assert.equal(staff.isInstructor('6'), true);
  assert.deepEqual(staff.instructors().map((m) => m.id), ['6']);

  staff.add('instructor', '6', '[Инст.Delta] Иван Сидоров'); // повторно: имя обновилось, дубля нет
  assert.equal(staff.instructors().length, 1);
  assert.equal(staff.nameOf('6'), '[Инст.Delta] Иван Сидоров');

  assert.equal(staff.removeInstructor('4'), false); // «4» не инструктор: убрать нельзя
  assert.equal(staff.removeInstructor('6'), true);
  assert.equal(staff.removeInstructor('6'), false);
  assert.equal(staff.has('6'), false);
});

test('панель инструкторов: список, четыре кнопки, окна', () => {
  const staff = tempStaff();
  staff.add('instructor', '6', '[Инст.Delta] Иван Петров');
  const { embeds, components } = instructorPanelMessage(staff);
  assert.equal(embeds[0].toJSON().description, '<@6> | [Инст.Delta] Иван Петров');

  const buttons = components[0].toJSON().components;
  assert.deepEqual(
    buttons.map((b) => b.label),
    ['Добавить инструктора', 'Убрать инструктора', 'Добавить отчёт инструктору', 'Убрать отчёт инструктору'],
  );
  assert.deepEqual(buttons.map((b) => b.custom_id), Object.values(INSTRUCTOR_BUTTONS));

  // окна: у «убрать отчёт» одна ссылка, у «добавить» ID и имя, у остальных ID
  const fieldIds = (kind) => instructorModal(kind).toJSON().components.map((row) => row.components[0].custom_id);
  assert.deepEqual(fieldIds('add'), ['user', 'name']);
  assert.deepEqual(fieldIds('remove'), ['user']);
  assert.deepEqual(fieldIds('addReport'), ['user']);
  assert.deepEqual(fieldIds('removeReport'), ['link']);
  for (const kind of Object.keys(INSTRUCTOR_BUTTONS)) {
    assert.equal(instructorModal(kind).toJSON().custom_id, INSTRUCTOR_MODALS[kind]);
    assert.ok(instructorModal(kind).toJSON().title.length <= 45);
  }
  assert.ok(isInstructorInteractionId('inst:add') && !isInstructorInteractionId('staff:add:head'));
});

test('режим «за инструктора»: одноразовый, с ограничением по времени', () => {
  const acting = new ActingFor();
  assert.equal(acting.get('1'), null);
  acting.set('1', '6', 1000);
  assert.equal(acting.get('1', 1000 + 29 * 60 * 1000), '6'); // в течение получаса
  assert.equal(acting.get('1', 1000 + 31 * 60 * 1000), null); // потом сбрасывается
  acting.set('1', '6', 1000);
  acting.clear('1');
  assert.equal(acting.get('1', 1001), null);
  acting.set('1', '6', 1000);
  acting.set('1', '7', 1000); // новый выбор заменяет старый
  assert.equal(acting.get('1', 1001), '7');
});

test('окна: название влезает в лимит Discord (45 символов), поля на месте', () => {
  for (const role of STAFF_ROLES) {
    const modal = addModal(roleByKey(role.key)).toJSON();
    assert.ok(modal.title.length <= 45);
    assert.equal(modal.components.length, 2); // ID и имя
  }
  assert.equal(nameModal().toJSON().components.length, 2);
});

test('длинный список в эмбеде обрезается под лимит поля (1024)', () => {
  const staff = tempStaff();
  for (let i = 0; i < 80; i++) staff.add('instructor', String(100000000000000000n + BigInt(i)), '[Инст.Delta] Очень Длинное Имя Фамилия');
  const value = instructorPanelMessage(staff).embeds[0].toJSON().description;
  assert.ok(value.length <= 1024);
  assert.match(value, /и ещё \d+$/);
});

test('помощь: незарегистрированным — обратитесь к старшему составу и ID', () => {
  const text = unregisteredMessage('123456789012345678');
  assert.match(text, /не зарегистрированы/);
  assert.match(text, /старшему составу/);
  assert.match(text, /123456789012345678/);
});

test('помощь для руководства: старший состав, инструкторы, отчёты', () => {
  const text = leadershipMessage({
    level: 'Генерал армии',
    addable: ['Заместитель армии', 'Куратор отдела'],
    canInstructors: true,
    canReports: true,
  });
  assert.match(text, /Генерал армии/);
  assert.match(text, /Заместитель армии, Куратор отдела/);
  assert.match(text, /\/старший-состав/);
  assert.match(text, /\/инструктор/);
  assert.match(text, /Убрать отчёт инструктору/);
  assert.match(text, /чужие не может/);
  assert.match(text, /\/общий-отчет/);

  // заместитель начальника отдела старший состав не добавляет, но инструкторов ведёт
  const deputy = leadershipMessage({ level: 'Заместитель начальника отдела', addable: [], canInstructors: true, canReports: true });
  assert.doesNotMatch(deputy, /Старший состав\*\*/);
  assert.match(deputy, /\/инструктор/);

  // пустые части не показываются
  const bare = leadershipMessage({ level: 'Инструктор', addable: [], canInstructors: false, canReports: false });
  assert.doesNotMatch(bare, /Старший состав\*\*/);
  assert.doesNotMatch(bare, /\/инструктор/);
  assert.doesNotMatch(bare, /общий-отчет/);
});

test('помощь: сообщения влезают в лимит Discord', () => {
  const all = [
    ...memoMessages('ARMY Delta Inst'),
    leadershipMessage({ level: 'Владелец', addable: STAFF_ROLES.map((r) => r.label), canInstructors: true, canReports: true }),
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
