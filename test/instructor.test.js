import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { previewFields } from '../src/confirm.js';
import { buildForms, formRows, positionLabel } from '../src/forms.js';
import { instructorDepartment, parseCheck } from '../src/parsing.js';
import { Staff } from '../src/staff.js';

const LINK = 'https://discord.com/channels/713076174108229712/1027944923829383188/';
const LINK3 = (id) => `https:/\\/discord.com/channels/713076174108229712/1027944923829383188/${id}`;
const RUSLAN = '466633638511902752';

// Проверка со скриншота: инструктор с тегом [I.Delta], 205 баллов.
const RUSLAN_CHECK = `${LINK}1551200000000000001
<@${RUSLAN}> | [I.Delta] Ruslan Evil [11]
**Изменение баллов:**
- 10 Балов | Участие в ГМП | 1 Скриншот
+ 10 Балов | Участие в ГМП | Ссылка
-/+ Балов | Активности | Причина
---------------------------------
**205 баллов**
-# Минимум 50 баллов`;

const entry = (text, name, rank = '11', position = 'Delta', id = '1') => ({
  messageId: id,
  verdict: parseCheck(text),
  report: { name, rank, position, total: 205 },
});
const nickCheck = (tag, user = RUSLAN) => `${LINK}1\n<@${user}> | [${tag}] Ruslan Evil [11]\n90 баллов`;

test('тег инструктора: три частых написания и слитное — только по-английски', () => {
  // три самых частых: I.Delta, Inst.Delta, Instructor Delta
  for (const tag of ['I.Delta', 'Inst.Delta', 'Instructor Delta']) assert.equal(instructorDepartment(tag), 'Delta', tag);
  // четвёртое — слитно
  for (const tag of ['InstructorDelta', 'InstDelta', 'IDelta', 'instructordelta', 'INSTRUCTORDELTA']) {
    assert.equal(instructorDepartment(tag), 'Delta', tag);
  }
  // регистр и разделители
  for (const tag of ['i.delta', 'INST.DELTA', 'I. Delta', 'Inst Delta', 'Instructor_Delta', 'Instructor-Delta']) {
    assert.equal(instructorDepartment(tag), 'Delta', tag);
  }
  // другой отдел сохраняется как написан
  assert.equal(instructorDepartment('I.Alpha'), 'Alpha');
  assert.equal(instructorDepartment('Instructor Alpha'), 'Alpha');
  // «Instructor» без отдела: инструктор, отдела нет
  assert.equal(instructorDepartment('Instructor'), '');
});

test('русские теги инструкторов не принимаются, обычные слова и другие теги — тоже', () => {
  for (const tag of ['Инст.Delta', 'Инструктор Дельта', 'Инструктор', 'Инст', 'инструктор Delta']) {
    assert.equal(instructorDepartment(tag), null, tag); // по-русски инструкторов не пишут
  }
  for (const tag of ['Delta', 'Iota', 'Institute', 'InstitutDelta', 'Instr-Delta', 'IAlpha', 'Начальник отдела Delta', 'Inst', 'I', '', null, undefined]) {
    assert.equal(instructorDepartment(tag), null, `${tag}`);
  }
});

test('в проверке со скриншота тег [I.Delta] читается как должность', () => {
  const c = parseCheck(RUSLAN_CHECK);
  assert.equal(c.position, 'I.Delta');
  assert.equal(c.rank, '11');
  assert.equal(c.points, 205);
});

test('должность инструктора по нику: «Инструктор Delta»', () => {
  const report = { position: 'Delta' };
  for (const tag of ['I.Delta', 'Inst.Delta', 'Instructor Delta', 'InstructorDelta']) {
    const verdict = parseCheck(nickCheck(tag));
    assert.equal(positionLabel({ verdict, report }), 'Инструктор Delta', tag);
  }
  // отдел берётся из тега, а не из отчёта
  assert.equal(positionLabel({ verdict: parseCheck(nickCheck('I.Alpha')), report }), 'Инструктор Alpha');
  // «Инструктор» без отдела: отдел из отчёта
  assert.equal(positionLabel({ verdict: parseCheck(nickCheck('Instructor')), report }), 'Инструктор Delta');
  // русский тег инструктором не считается: должность как у обычного сотрудника, из отчёта
  assert.equal(positionLabel({ verdict: parseCheck(nickCheck('Инст.Delta')), report }), 'Delta');
  // отчёта нет: достаточно тега
  assert.equal(positionLabel({ verdict: parseCheck(nickCheck('I.Delta')), report: null }), 'Инструктор Delta');
});

test('не инструктор — должность как раньше, из отчёта', () => {
  const verdict = parseCheck(nickCheck('Delta'));
  assert.equal(positionLabel({ verdict, report: { position: 'Delta' } }), 'Delta');
  assert.equal(positionLabel({ verdict, report: null }), 'Delta'); // из ника, если отчёта нет
  assert.equal(positionLabel({ verdict: { ...verdict, position: null }, report: null }), '???');
});

test('в первую очередь ник, потом запись в старшем составе', () => {
  const inStaff = (id) => id === RUSLAN;
  const report = { position: 'Delta' };

  // ник не говорит про инструктора, но человек внесён как инструктор: это инструктор
  assert.equal(positionLabel({ verdict: parseCheck(nickCheck('Delta')), report }, inStaff), 'Инструктор Delta');
  // внесён, а отчёта и отдела нет: просто «Инструктор»
  assert.equal(positionLabel({ verdict: { ...parseCheck(nickCheck('Delta')), position: null }, report: null }, inStaff), 'Инструктор');
  // нет ни тега, ни записи: не инструктор
  assert.equal(positionLabel({ verdict: parseCheck(nickCheck('Delta', '621978844894593026')), report }, inStaff), 'Delta');
  // тег главнее: инструктор по нику даже без записи в списке, и отдел берётся из тега
  assert.equal(positionLabel({ verdict: parseCheck(nickCheck('I.Delta', '621978844894593026')), report }, () => false), 'Инструктор Delta');
  assert.equal(positionLabel({ verdict: parseCheck(nickCheck('I.Alpha')), report }, inStaff), 'Инструктор Alpha');
});

test('форма 3 со скриншота: Ruslan Evil — «Инструктор Delta», остальные — «Delta»', () => {
  const entries = [
    entry(`${LINK}1551200000000000000\n621978844894593026 | [Delta] Vladislav Siberyak [12]\n125 баллов`, 'Vladislav Siberyak', '12', 'Delta', '1551200000000000000'),
    entry(RUSLAN_CHECK, 'Ruslan Evil', '11', 'Delta', '1551200000000000001'),
    entry(`${LINK}1551200000000000002\n466633638511902700 | [Delta] Santa Siberyak [12]\n55 баллов`, 'Santa Siberyak', '12', 'Delta', '1551200000000000002'),
  ];
  const { bonuses } = formRows(entries);
  assert.deepEqual(bonuses, [
    `Vladislav Siberyak | 12 | Delta | ${LINK3('1551200000000000000')} | 125 | Высокая`,
    `Ruslan Evil | 11 | Инструктор Delta | ${LINK3('1551200000000000001')} | 205 | Повышенная`,
    `Santa Siberyak | 12 | Delta | ${LINK3('1551200000000000002')} | 55 | Средняя`,
  ]);

  // и в готовом сообщении, и в общем отчёте
  const text = buildForms([{ checkerId: '1', entries }]).join('\n');
  assert.match(text, /^- Ruslan Evil \| 11 \| Инструктор Delta \|/m);
  assert.doesNotMatch(text, /Ruslan Evil \| 11 \| Delta \|/);
});

test('форма 3: инструктор узнаётся по записи в старшем составе, если в нике тега нет', () => {
  const noTag = entry(`${LINK}1\n<@${RUSLAN}> | [Delta] Ruslan Evil [11]\n90 баллов`, 'Ruslan Evil', '11', 'Delta', '1');
  assert.match(formRows([noTag]).bonuses[0], /\| Delta \|/); // без списка — обычная должность
  const withList = formRows([noTag], { isInstructor: (id) => id === RUSLAN });
  assert.match(withList.bonuses[0], /^Ruslan Evil \| 11 \| Инструктор Delta \|/);
  assert.match(buildForms([{ checkerId: '1', entries: [noTag] }], { isInstructor: (id) => id === RUSLAN }).join('\n'), /Инструктор Delta/);
});

test('карточка подтверждения показывает «Инструктор Delta»', () => {
  const check = { ...parseCheck(RUSLAN_CHECK), messageId: '1551200000000000001' };
  const report = { name: 'Ruslan Evil', rank: '11', position: 'Delta', total: 205 };
  const { fields } = previewFields({ check, report });
  assert.equal(fields.find((f) => f.name === 'Должность').value, 'Инструктор Delta');

  const noTag = { ...check, position: 'Delta' };
  assert.equal(previewFields({ check: noTag, report }).fields.find((f) => f.name === 'Должность').value, 'Delta');
  assert.equal(
    previewFields({ check: noTag, report, isInstructor: (id) => id === RUSLAN }).fields.find((f) => f.name === 'Должность').value,
    'Инструктор Delta',
  );
});

test('Staff.isInstructor: только ранг [1]', () => {
  const staff = new Staff(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inst-')), 'staff.json'), '900');
  staff.add('instructor', RUSLAN, '[I.Delta] Ruslan Evil');
  staff.add('head', '3');
  assert.equal(staff.isInstructor(RUSLAN), true);
  assert.equal(staff.isInstructor('3'), false); // начальник — не инструктор
  assert.equal(staff.isInstructor('900'), false); // владелец тоже
  assert.equal(staff.isInstructor('404'), false);
});
