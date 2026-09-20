import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyEdits, confirmMessage, editModal, parseConfirmId, parseEditFields, previewFields } from '../src/confirm.js';
import { commitEdit, findEditable } from '../src/editflow.js';
import { formRows } from '../src/forms.js';
import { addAccepted, addRejected } from '../src/manual.js';
import { PERIOD_CHOICES, profileMessages, snowflakeTime } from '../src/profile.js';
import { Store } from '../src/store.js';

const tempStore = () => new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'edit-')), 'state.json'));

const USER = '621978844894593026';
const OTHER_USER = '466633638511902752';
// Настоящие id сообщений Discord: из них берётся дата отчёта. 1548582679338024982 = 13.09.2026.
const ID_SEP13 = '1548582679338024982';
const linkOf = (id) => `https://discord.com/channels/713076174108229712/1027944923829383188/${id}`;
const field = (fields, name) => fields.find((f) => f.name === name)?.value;

const accepted = (store, id, points, extra = {}) =>
  addAccepted(store, { id: USER, name: 'Vladislav Siberyak', link: linkOf(id), points, rank: 12, position: 'Delta', ...extra });

// ── Правка сохранённого отчёта ───────────────────────────────────────────────────────────────────────

test('правка: находит отчёт по ссылке у любого проверяющего', () => {
  const a = tempStore();
  const b = tempStore();
  accepted(b, ID_SEP13, 90);
  const stores = [{ checkerId: '111', store: a }, { checkerId: '222', store: b }];

  const found = findEditable({ stores, actorId: '222', linkText: linkOf(ID_SEP13), outranks: () => false });
  assert.equal(found.checkerId, '222');
  assert.equal(found.messageId, ID_SEP13);
  assert.equal(found.entry.verdict.points, 90);
});

test('правка: свой отчёт можно, чужой — только если проверяющий ниже по рангу', () => {
  const b = tempStore();
  accepted(b, ID_SEP13, 90);
  const stores = [{ checkerId: '222', store: b }];
  const args = { stores, linkText: linkOf(ID_SEP13) };

  assert.equal(findEditable({ ...args, actorId: '222', outranks: () => false }).error, undefined); // свой
  assert.equal(findEditable({ ...args, actorId: '111', outranks: (actor, checker) => actor === '111' && checker === '222' }).error, undefined);
  const denied = findEditable({ ...args, actorId: '333', outranks: () => false });
  assert.match(denied.error, /Нельзя изменить/);
  assert.match(denied.error, /<@222>/); // видно, чей отчёт
});

test('правка: не ссылка и несуществующий отчёт — ошибки', () => {
  const stores = [{ checkerId: '1', store: tempStore() }];
  assert.match(findEditable({ stores, actorId: '1', linkText: 'привет', outranks: () => true }).error, /Не похоже на ссылку/);
  assert.match(findEditable({ stores, actorId: '1', linkText: linkOf(ID_SEP13), outranks: () => true }).error, /не найден/);
});

test('правка: изменить баллы, имя, ранг, должность — в формах всё обновилось', () => {
  const store = tempStore();
  accepted(store, ID_SEP13, 90);
  const { entry } = { entry: store.entry(ID_SEP13) };

  const edits = { points: 125, name: 'Vladislav S', rank: '11', position: 'Alpha' };
  const result = commitEdit(store, { reportId: ID_SEP13, check: { ...entry.verdict, messageId: ID_SEP13 }, report: entry.report, edits });
  assert.equal(result.error, undefined);

  const rows = formRows(store.entries());
  assert.deepEqual(rows.accepted, [`<@${USER}> | Vladislav S | ${linkOf(ID_SEP13)} | 125`]);
  assert.match(rows.bonuses[0], /^Vladislav S \| 11 \| Alpha \| .* \| 125 \| Высокая$/);
  assert.equal(store.entries().length, 1); // не задвоилось
});

test('правка: статус принят -> отказан: баллы убираются, нужна причина, отчёт уходит из премий', () => {
  const store = tempStore();
  accepted(store, ID_SEP13, 90);
  const entry = store.entry(ID_SEP13);
  const base = { reportId: ID_SEP13, check: { ...entry.verdict, messageId: ID_SEP13 }, report: entry.report };

  commitEdit(store, { ...base, edits: { accepted: false, reason: 'Нет скриншотов' } });
  const after = store.entry(ID_SEP13);
  assert.equal(after.verdict.accepted, false);
  assert.equal(after.verdict.points, null);
  assert.equal(after.verdict.reason, 'Нет скриншотов');

  const rows = formRows(store.entries());
  assert.deepEqual(rows.accepted, []);
  assert.deepEqual(rows.bonuses, []); // в премии отказанный не идёт
  assert.match(rows.rejected[0], /Нет скриншотов$/);
});

test('правка: статус отказан -> принят: причина убирается, баллы можно задать', () => {
  const store = tempStore();
  addRejected(store, { id: USER, name: 'Vladislav Siberyak', link: linkOf(ID_SEP13), reason: 'Альбом пуст' });
  const entry = store.entry(ID_SEP13);
  const base = { reportId: ID_SEP13, check: { ...entry.verdict, messageId: ID_SEP13 }, report: entry.report };

  commitEdit(store, { ...base, edits: { accepted: true, points: 70, rank: '12', position: 'Delta' } });
  const after = store.entry(ID_SEP13);
  assert.equal(after.verdict.accepted, true);
  assert.equal(after.verdict.points, 70);
  assert.equal(after.verdict.reason, null);
  assert.equal(formRows(store.entries()).bonuses.length, 1); // теперь идёт в премии
});

test('правка: можно поправить ID человека; порядок отчётов в списке не меняется', () => {
  const store = tempStore();
  const id2 = '1548582679338024983';
  accepted(store, ID_SEP13, 90);
  accepted(store, id2, 60);
  const entry = store.entry(ID_SEP13);

  commitEdit(store, {
    reportId: ID_SEP13,
    check: { ...entry.verdict, messageId: ID_SEP13 },
    report: entry.report,
    edits: { userId: OTHER_USER },
  });
  assert.deepEqual(store.entries().map((e) => e.messageId), [ID_SEP13, id2]); // первый остался первым
  assert.equal(store.entry(ID_SEP13).verdict.userId, OTHER_USER);
});

test('правка сохраняется на диск; удалённый за это время отчёт править нельзя', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'edit-')), 'state.json');
  const store = new Store(file);
  accepted(store, ID_SEP13, 90);
  const entry = store.entry(ID_SEP13);
  const data = { reportId: ID_SEP13, check: { ...entry.verdict, messageId: ID_SEP13 }, report: entry.report };

  commitEdit(store, { ...data, edits: { points: 200 } });
  assert.equal(new Store(file).entry(ID_SEP13).verdict.points, 200);

  store.remove(ID_SEP13);
  assert.match(commitEdit(store, { ...data, edits: { points: 5 } }).error, /уже удалён/);
});

test('карточка правки: другой заголовок, кнопка смены статуса, окно с ID', () => {
  const store = tempStore();
  accepted(store, ID_SEP13, 90);
  const entry = store.entry(ID_SEP13);
  const data = { mode: 'edit', ownerId: '1', reportId: ID_SEP13, check: { ...entry.verdict, messageId: ID_SEP13 }, report: entry.report, edits: {} };

  const { embeds, components } = confirmMessage('tok', data, []);
  assert.match(embeds[0].toJSON().title, /^Изменение отчёта/);
  assert.match(embeds[0].toJSON().description, /ничего не меняется/);
  const buttons = components[0].toJSON().components;
  assert.deepEqual(buttons.map((b) => parseConfirmId(b.custom_id).action), ['save', 'edit', 'status', 'cancel']);
  assert.ok(buttons.some((b) => b.label === '🔄 Сменить статус'));

  // у новой проверки кнопки смены статуса нет, заголовок прежний
  const fresh = confirmMessage('tok', { ...data, mode: undefined }, []);
  assert.equal(fresh.embeds[0].toJSON().title, 'Проверьте и подтвердите');
  assert.deepEqual(fresh.components[0].toJSON().components.map((b) => parseConfirmId(b.custom_id).action), ['save', 'edit', 'cancel']);
});

test('смена статуса в карточке: показ переключается, причина/баллы подсказываются предупреждением', () => {
  const store = tempStore();
  accepted(store, ID_SEP13, 90);
  const entry = store.entry(ID_SEP13);
  const data = { check: { ...entry.verdict, messageId: ID_SEP13 }, report: entry.report };

  const rejected = applyEdits(data, { accepted: false });
  const preview = previewFields(rejected);
  assert.equal(field(preview.fields, 'Статус'), '❌ Отказан');
  assert.deepEqual(preview.warnings, ['Нет причины отказа.']); // причину нужно указать в «Изменить»

  const back = previewFields(applyEdits(rejected, { accepted: true }));
  assert.equal(field(back.fields, 'Статус'), '✅ Принят');
  assert.equal(field(back.fields, 'Баллы'), '90');
});

test('окно «Изменить» теперь содержит и ID человека; ID проверяется', () => {
  const store = tempStore();
  accepted(store, ID_SEP13, 90);
  const entry = store.entry(ID_SEP13);
  const data = { check: { ...entry.verdict, messageId: ID_SEP13 }, report: entry.report, edits: {} };

  const fields = editModal('t', data).toJSON().components.map((row) => [row.components[0].custom_id, row.components[0].value]);
  assert.deepEqual(fields, [['name', 'Vladislav Siberyak'], ['points', '90'], ['rank', '12'], ['position', 'Delta'], ['user', USER]]);

  const ok = parseEditFields({ name: 'A B', points: '70', user: `<@${OTHER_USER}>` }, true);
  assert.equal(ok.patch.userId, OTHER_USER);
  assert.match(parseEditFields({ name: 'A B', points: '70', user: '@Ruslan' }, true).error, /получил «@Ruslan»/);
  assert.equal(parseEditFields({ name: 'A B', points: '70', user: '' }, true).patch.userId, undefined); // пусто — не менять
});

// ── Профиль ──────────────────────────────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
/** id сообщения, созданного в момент ms (снежинка Discord). */
const idAt = (ms) => String((BigInt(ms) - 1420070400000n) << 22n);
const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

function profileSetup() {
  const a = tempStore();
  const b = tempStore();
  const at = (daysAgo) => idAt(NOW - daysAgo * DAY);
  accepted(a, at(2), 125); // на этой неделе
  accepted(a, at(9), 60); // 9 дней назад
  accepted(b, at(20), 260); // 20 дней назад, у другого проверяющего
  addRejected(b, { id: USER, name: 'Vladislav Siberyak', link: linkOf(at(15)), reason: 'Нет скриншотов' });
  accepted(b, at(45), 90); // 45 дней назад: старше месяца
  addAccepted(b, { id: OTHER_USER, name: 'Santa Siberyak', link: linkOf(at(3)), points: 40, rank: 12, position: 'Delta' }); // чужой человек
  return [{ checkerId: '111', store: a }, { checkerId: '222', store: b }];
}

test('дата отчёта берётся из id сообщения в ссылке', () => {
  assert.equal(new Date(snowflakeTime(ID_SEP13)).toISOString().slice(0, 10), '2026-09-13');
  assert.equal(snowflakeTime(idAt(NOW)), NOW);
  assert.equal(snowflakeTime('r1'), null);
  assert.equal(snowflakeTime('12345'), null);
});

test('профиль за месяц: только этот человек, только последние 30 дней, новые сверху', () => {
  const [text] = profileMessages({ stores: profileSetup(), userId: USER, period: 'month', now: NOW });
  const lines = text.split('\n');
  assert.match(lines[0], new RegExp(`^\\*\\*Профиль <@${USER}>\\*\\* \\| Vladislav Siberyak \\| за месяц`));

  const rows = lines.filter((l) => l.startsWith('- '));
  assert.equal(rows.length, 4); // 125, 60, отказ, 260; отчёт 45-дневной давности и чужой человек не попали
  assert.match(rows[0], /^- ✅ <t:\d+:d> \| принят \| 125 б\. \| Высокая, 80 000\$ \| проверил <@111>/);
  assert.match(rows[1], /\| принят \| 60 б\. \| Средняя, 70 000\$/);
  assert.match(rows[2], /^- ❌ .* \| отказан: Нет скриншотов \| проверил <@222>/);
  assert.match(rows[3], /\| принят \| 260 б\. \| Повышенная, 95 000\$ \| проверил <@222>/);
  assert.ok(!text.includes('Santa'));
});

test('профиль: итоги — сколько принято, сумма баллов, премии, лучший отчёт', () => {
  const [text] = profileMessages({ stores: profileSetup(), userId: USER, period: 'month', now: NOW });
  assert.match(text, /\*\*Итого за месяц \(30 дней\):\*\* отчётов 4: принято 3, отказано 1\./);
  assert.match(text, /Баллов по принятым: 445\. Премии по принятым отчётам: 245 000\$\./); // 125+60+260; 80+70+95 тыс.
  assert.match(text, /Лучший принятый отчёт \(он идёт в форму премий\): 260 б\., Повышенная, 95 000\$\./);
});

test('профиль: период «неделя» и «всё время»', () => {
  const week = profileMessages({ stores: profileSetup(), userId: USER, period: 'week', now: NOW })[0];
  assert.equal(week.split('\n').filter((l) => l.startsWith('- ')).length, 1); // только отчёт двухдневной давности
  assert.match(week, /за неделю/);

  const all = profileMessages({ stores: profileSetup(), userId: USER, period: 'all', now: NOW })[0];
  assert.equal(all.split('\n').filter((l) => l.startsWith('- ')).length, 5); // и 45-дневный
  assert.match(all, /за всё время/);
});

test('профиль: нет отчётов и имя из списка старшего состава', () => {
  const empty = profileMessages({ stores: profileSetup(), userId: '999999999999999999', now: NOW });
  assert.equal(empty.length, 1);
  assert.match(empty[0], /Отчётов за этот период нет/);

  const named = profileMessages({ stores: profileSetup(), userId: USER, now: NOW, name: '[Инст.Delta] Иван Петров' })[0];
  assert.match(named.split('\n')[0], /\| \[Инст\.Delta\] Иван Петров \| за месяц/); // имя из списка важнее имени из отчёта
});

test('профиль: длинный список делится на сообщения, шапка только в первом', () => {
  const store = tempStore();
  for (let i = 0; i < 60; i += 1) accepted(store, idAt(NOW - (i % 25) * DAY - i), 50 + (i % 40));
  const parts = profileMessages({ stores: [{ checkerId: '1', store }], userId: USER, period: 'month', now: NOW });
  assert.ok(parts.length > 1);
  assert.ok(parts.every((m) => m.length <= 2000));
  assert.match(parts[0], /^\*\*Профиль/);
  for (const m of parts.slice(1)) assert.doesNotMatch(m, /^\*\*Профиль/);
  assert.equal(parts.join('\n').split('\n').filter((l) => l.startsWith('- ')).length, 60);
  assert.match(parts.at(-1), /Итого за месяц/);
});

test('профиль: варианты периода для команды', () => {
  assert.deepEqual(PERIOD_CHOICES.map((c) => c.value), ['week', 'month', 'all']);
  assert.ok(PERIOD_CHOICES.every((c) => c.name.length <= 100));
});
