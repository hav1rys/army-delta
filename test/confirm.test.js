import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PendingChecks,
  applyEdits,
  confirmMessage,
  editModal,
  isConfirmId,
  parseConfirmId,
  parseEditFields,
  previewFields,
} from '../src/confirm.js';
import { bonusInfo, formatMoney, parseCheck } from '../src/parsing.js';

const LINK = 'https://discord.com/channels/713076174108229712/1027944923829383188/1551154782306046055';
const USER = '766166436656709642';

const ACCEPTED_TEXT = `${LINK}
<@${USER}> | [Delta] Matvey_Siberyak [12]
**Изменение баллов:**
Нет
-/+ Балов | Активности | Причина
---------------------------------
**90 баллов**
-# Минимум 50 баллов`;

const REJECTED_TEXT = `${LINK}
<@${USER}> | [Delta] Matvey_Siberyak [12]
Нет скриншотов`;

const REPORT = { name: 'Matvey_Siberyak', rank: '12', position: 'Delta', total: 90 };

const field = (fields, name) => fields.find((f) => f.name === name)?.value;

test('карточка принятого: упоминание, имя, ссылка, баллы, тип и размер премии, ранг, должность', () => {
  const { fields, warnings } = previewFields({ check: parseCheck(ACCEPTED_TEXT), report: REPORT });
  assert.equal(field(fields, 'Упоминание'), `<@${USER}>`);
  assert.equal(field(fields, 'Имя и фамилия'), 'Matvey_Siberyak');
  assert.equal(field(fields, 'Ссылка на отчёт'), LINK);
  assert.equal(field(fields, 'Статус'), '✅ Принят');
  assert.equal(field(fields, 'Баллы'), '90');
  assert.equal(field(fields, 'Тип премии'), 'Средняя');
  assert.equal(field(fields, 'Размер премии'), '70 000$');
  assert.equal(field(fields, 'Ранг'), '12');
  assert.equal(field(fields, 'Должность'), 'Delta');
  assert.match(field(fields, 'В премию'), /^Да/);
  assert.deepEqual(warnings, []);
});

test('карточка отказанного: причина, без баллов и премии', () => {
  const { fields, warnings } = previewFields({ check: parseCheck(REJECTED_TEXT), report: REPORT });
  assert.equal(field(fields, 'Статус'), '❌ Отказан');
  assert.equal(field(fields, 'Причина отказа'), 'Нет скриншотов');
  assert.equal(field(fields, 'Баллы'), undefined);
  assert.equal(field(fields, 'Тип премии'), undefined);
  assert.deepEqual(warnings, []);
});

test('карточка: пойдёт ли отчёт в премию — сравнение с уже сохранёнными отчётами человека', () => {
  const check = parseCheck(ACCEPTED_TEXT); // 90 баллов
  const saved = (points) => ({ messageId: '5', verdict: { userId: USER, accepted: true, points, link: 'https://x/5' }, report: REPORT });

  assert.match(field(previewFields({ check, report: REPORT, others: [saved(60)] }).fields, 'В премию'), /^Да/);
  const worse = field(previewFields({ check, report: REPORT, others: [saved(125)] }).fields, 'В премию');
  assert.match(worse, /^Нет/);
  assert.match(worse, /125/); // видно, какой отчёт лучше
  // отказанный отчёт человека в премию не претендует
  const rejectedOther = { messageId: '6', verdict: { userId: USER, accepted: false, points: null, link: 'https://x/6' }, report: REPORT };
  assert.match(field(previewFields({ check, report: REPORT, others: [rejectedOther] }).fields, 'В премию'), /^Да/);
});

test('карточка: предупреждения — нет баллов, меньше 10, меньше минимума, нет причины', () => {
  const base = parseCheck(ACCEPTED_TEXT);
  assert.deepEqual(previewFields({ check: { ...base, points: null }, report: { ...REPORT, total: null } }).warnings, ['Нет баллов.']);
  assert.deepEqual(previewFields({ check: { ...base, points: 5 }, report: REPORT }).warnings, [
    'Меньше 10 баллов: тип премии не определён.',
    'Баллов меньше минимума (50).',
  ]);
  assert.deepEqual(previewFields({ check: { ...base, points: 40 }, report: REPORT }).warnings, ['Баллов меньше минимума (50).']);
  assert.deepEqual(previewFields({ check: { ...parseCheck(REJECTED_TEXT), reason: '' }, report: REPORT }).warnings, ['Нет причины отказа.']);
});

test('размеры премий из таблицы и формат денег', () => {
  assert.deepEqual(bonusInfo(20), { type: 'Пониженная', amount: 25000 });
  assert.deepEqual(bonusInfo(50), { type: 'Стандарт', amount: 45000 });
  assert.deepEqual(bonusInfo(125), { type: 'Высокая', amount: 80000 });
  assert.deepEqual(bonusInfo(260), { type: 'Повышенная', amount: 95000 });
  assert.deepEqual(bonusInfo(451), { type: 'Сверхвысокая', amount: 130000 });
  assert.equal(bonusInfo(9), null);
  assert.equal(formatMoney(130000), '130 000$');
  assert.equal(formatMoney(25000), '25 000$');
});

test('правки из окна «Изменить» попадают в карточку', () => {
  const data = { check: parseCheck(ACCEPTED_TEXT), report: REPORT, edits: { name: 'Matvey Siberyak', points: 125, rank: '11', position: 'Alpha' } };
  const { check, report } = applyEdits(data, data.edits);
  assert.equal(report.name, 'Matvey Siberyak');
  assert.equal(check.points, 125);
  assert.equal(report.rank, '11');
  assert.equal(report.position, 'Alpha');

  const { fields } = previewFields({ check, report });
  assert.equal(field(fields, 'Баллы'), '125');
  assert.equal(field(fields, 'Тип премии'), 'Высокая');
  assert.equal(field(fields, 'Должность'), 'Alpha');
  // исходные данные не испорчены
  assert.equal(REPORT.name, 'Matvey_Siberyak');
});

test('окно «Изменить»: разбор и проверка полей', () => {
  const ok = parseEditFields({ name: ' Ivan Petrov ', points: '125', rank: '11', position: ' Alpha ' }, true);
  assert.deepEqual(ok.patch, { name: 'Ivan Petrov', points: 125, rank: '11', position: 'Alpha' });

  // ранг и должность можно оставить пустыми: они не меняются
  assert.deepEqual(parseEditFields({ name: 'Ivan Petrov', points: '70', rank: '', position: '' }, true).patch, { name: 'Ivan Petrov', points: 70 });

  assert.match(parseEditFields({ name: 'Ivan', points: 'много', rank: '', position: '' }, true).error, /Баллы — целое число, получил «много»/);
  assert.match(parseEditFields({ name: 'Ivan', points: '', rank: '', position: '' }, true).error, /получил «пусто»/);
  assert.match(parseEditFields({ name: 'Ivan', points: '70', rank: 'x', position: '' }, true).error, /Ранг — число/);
  assert.match(parseEditFields({ name: '  ', points: '70' }, true).error, /Имя и фамилия/);

  // отказанный: имя и причина
  assert.deepEqual(parseEditFields({ name: 'Santa', reason: ' Альбом пуст ' }, false).patch, { name: 'Santa', reason: 'Альбом пуст' });
  assert.match(parseEditFields({ name: 'Santa', reason: '' }, false).error, /Причина/);
});

test('кнопки: сохранить, изменить, отменить с одним токеном', () => {
  const data = { check: parseCheck(ACCEPTED_TEXT), report: REPORT, edits: {} };
  const { embeds, components } = confirmMessage('abc123', data, [], 'За <@1>: ');
  assert.equal(embeds[0].toJSON().title, 'За <@1>: Проверьте и подтвердите');
  assert.match(embeds[0].toJSON().description, /Ничего не сохранено/);

  const buttons = components[0].toJSON().components;
  assert.deepEqual(buttons.map((b) => b.label), ['✅ Сохранить', '✏️ Изменить', '❌ Отменить']);
  assert.deepEqual(buttons.map((b) => parseConfirmId(b.custom_id)), [
    { action: 'save', token: 'abc123' },
    { action: 'edit', token: 'abc123' },
    { action: 'cancel', token: 'abc123' },
  ]);
  assert.ok(buttons.every((b) => isConfirmId(b.custom_id) && b.custom_id.length <= 100));
  assert.equal(isConfirmId('staff:add'), false);
});

test('окно «Изменить»: поля заполнены текущими значениями', () => {
  const values = (data) => editModal('t', data).toJSON().components.map((row) => [row.components[0].custom_id, row.components[0].value]);
  const accepted = { check: parseCheck(ACCEPTED_TEXT), report: REPORT, edits: {} };
  assert.deepEqual(values(accepted), [['name', 'Matvey_Siberyak'], ['points', '90'], ['rank', '12'], ['position', 'Delta'], ['user', USER]]);
  assert.deepEqual(values({ check: parseCheck(REJECTED_TEXT), report: REPORT, edits: {} }), [['name', 'Matvey_Siberyak'], ['reason', 'Нет скриншотов'], ['user', USER]]);
  assert.equal(editModal('t', accepted).toJSON().custom_id, 'confirm:editmodal:t');
});

test('ожидающие подтверждения: одноразовые, только автору, со сроком', () => {
  const pending = new PendingChecks();
  const token = pending.add('1', { check: parseCheck(ACCEPTED_TEXT) }, 1000);

  assert.equal(pending.peek(token, '1', 1001).data.check.userId, USER);
  assert.equal(pending.peek(token, '1', 1001).data.check.userId, USER); // peek не забирает

  const stranger = pending.take(token, '2', 1002);
  assert.match(stranger.error, /не для вас/);
  assert.equal(stranger.foreign, true); // чужое нажатие карточку не гасит
  assert.ok(pending.peek(token, '1', 1003).data); // карточка жива

  assert.ok(pending.take(token, '1', 1004).data); // «Сохранить» забрал
  assert.match(pending.take(token, '1', 1005).error, /устарело/); // повторно нельзя: не сохранится дважды
});

test('ожидающие подтверждения: правки накапливаются, через полчаса устаревают', () => {
  const pending = new PendingChecks();
  const token = pending.add('1', { check: parseCheck(ACCEPTED_TEXT) }, 1000);
  pending.edit(token, '1', { points: 125 }, 1001);
  pending.edit(token, '1', { name: 'Ivan Petrov' }, 1002);
  assert.deepEqual(pending.peek(token, '1', 1003).data.edits, { points: 125, name: 'Ivan Petrov' });

  const half = 30 * 60 * 1000;
  assert.ok(pending.peek(token, '1', 1000 + half - 1).data);
  assert.match(pending.peek(token, '1', 1000 + half + 1).error, /устарело/);
  assert.match(pending.take('нет-такого', '1').error, /устарело/);
});
