import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STAFF_ROLES, Staff, addModal, panelMessage, roleByKey } from '../src/staff.js';
import { statsMessages } from '../src/stats.js';

const tempStaff = () => new Staff(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'staff-')), 'staff.json'));

test('уровни: добавление, повтор, руководство и старший состав', () => {
  const staff = tempStaff();
  assert.equal(staff.add('head', '111'), true);
  assert.equal(staff.add('head', '111'), false); // уже был
  staff.add('senior-staff', '222');

  assert.equal(staff.has('111'), true);
  assert.equal(staff.has('333'), false);
  assert.equal(staff.isManager('111'), true);
  assert.equal(staff.isManager('222'), false); // старший состав — не руководство
  assert.equal(staff.rolesOf('222'), 'Старший состав');
  assert.deepEqual(staff.everyone().sort(), ['111', '222']);
});

test('уровни: сохраняются на диск', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'staff-')), 'staff.json');
  new Staff(file).add('admin', '111');
  assert.equal(new Staff(file).isManager('111'), true);
});

test('панель: пять уровней, пять кнопок, кто в каком уровне виден', () => {
  const staff = tempStaff();
  staff.add('deputy', '111');
  const { embeds, components } = panelMessage(staff);

  const fields = embeds[0].toJSON().fields;
  assert.equal(fields.length, STAFF_ROLES.length);
  assert.equal(fields.find((f) => f.name === 'Заместитель начальника отдела').value, '<@111>');
  assert.equal(fields.find((f) => f.name === 'Администратор').value, '—');

  const buttons = components[0].toJSON().components;
  assert.equal(buttons.length, 5);
  assert.ok(buttons.every((b) => b.label.length <= 80 && b.custom_id.startsWith('staff:add:')));
});

test('окно добавления: название влезает в лимит Discord (45 символов)', () => {
  for (const role of STAFF_ROLES) assert.ok(addModal(roleByKey(role.key)).toJSON().title.length <= 45);
});

test('статистика: сортировка, итог, люди без отчётов тоже видны', () => {
  const [text] = statsMessages([
    { checkerId: '1', roles: 'Старший состав', accepted: 1, rejected: 0 },
    { checkerId: '2', roles: '', accepted: 5, rejected: 2 },
    { checkerId: '3', roles: 'Старший состав', accepted: 0, rejected: 0 },
  ]);
  const lines = text.split('\n');
  assert.equal(lines[1], '- <@2>: принято 5, отказано 2, всего 7');
  assert.equal(lines[2], '- <@1> (Старший состав): принято 1, отказано 0, всего 1');
  assert.equal(lines[3], '- <@3> (Старший состав): принято 0, отказано 0, всего 0');
  assert.equal(lines.at(-1), '**Итого:** принято 6, отказано 2, всего 8');
});

test('статистика: длинный список делится на сообщения', () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ checkerId: `${100000000000000000 + i}`, roles: 'Старший состав', accepted: 1, rejected: 1 }));
  const parts = statsMessages(rows);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((m) => m.length <= 2000));
  assert.match(parts.at(-1), /Итого/);
});
