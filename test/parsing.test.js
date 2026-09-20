import assert from 'node:assert/strict';
import test from 'node:test';
import { buildForms, formRows } from '../src/forms.js';
import { bonusType, flattenEmbeds, parseCheck, parseReport } from '../src/parsing.js';

const LINK = 'https://discord.com/channels/713076174108229712/1027944923829383188/1548582679338024982';

const ACCEPTED = `${LINK}
621978844894593026 | @[Delta] Vladislav_Sideryak [12]
Изменение баллов:
- 5 Балов | Участие в лекции/тренировке | 1/2 Скриншотов
 - 10 Балов | Патруль вне ФЗ (1 час).(Второй) | Зашитываем от 1 часа
-/+ Балов | Активности | Причина
---------------------------------
125 баллов
Минимум 50 баллов`;

const REJECTED = `https://discord.com/channels/713076174108229712/1027944923829383188/1548444212175962274
466633638511902752 | @[Delta] Santa Siberyak [12]  У тебя альбом пуст`;

// Эмбед «Delta Report System» со скриншота.
const REPORT_EMBED = [
  {
    title: '📅 Еженедельный отчёт Delta',
    fields: [
      { name: '👮 Сотрудник', value: 'Li Il', inline: true },
      { name: '🎖️ Звание', value: 'Подполковник (12)', inline: true },
      { name: '📊 Активности', value: '1. Проверка еженедельного отчета. 80 баллов' },
      { name: '🏆 ИТОГО БАЛЛОВ', value: '185' },
    ],
    footer: { text: 'Delta | By Alexandr DeHaus & Evgeny Bauer' },
  },
];

test('принятая проверка', () => {
  const c = parseCheck(ACCEPTED);
  assert.equal(c.accepted, true);
  assert.equal(c.userId, '621978844894593026');
  assert.equal(c.points, 125);
  assert.equal(c.minimum, 50);
  assert.equal(c.messageId, '1548582679338024982');
  assert.equal(c.link, LINK);
});

test('отказ: причина отделяется от ника', () => {
  const c = parseCheck(REJECTED);
  assert.equal(c.accepted, false);
  assert.equal(c.userId, '466633638511902752');
  assert.equal(c.reason, 'У тебя альбом пуст');
});

test('отказ: причина на следующей строке и ник без пробела перед [ранг]', () => {
  const c = parseCheck(`${LINK}\n466633638511902752 | @[Delta]Webfox Siberyakov[12]\nНет скриншотов`);
  assert.equal(c.reason, 'Нет скриншотов');
});

test('отказ: причина со словом «баллов» остаётся отказом', () => {
  const c = parseCheck(`${LINK}\n466633638511902752 | @[Delta] Santa Siberyak [12] Не хватает баллов`);
  assert.equal(c.accepted, false);
  assert.equal(c.reason, 'Не хватает баллов');
});

test('упоминание <@id> вместо ника', () => {
  const c = parseCheck(`${LINK}\n<@466633638511902752> Альбом пуст`);
  assert.equal(c.userId, '466633638511902752');
  assert.equal(c.reason, 'Альбом пуст');
});

test('нет ссылки — не проверка', () => {
  assert.equal(parseCheck('466633638511902752 | @x [12] 125 баллов'), null);
});

test('отчёт из эмбеда', () => {
  assert.deepEqual(parseReport(flattenEmbeds(REPORT_EMBED)), {
    name: 'Li Il',
    rank: '12',
    position: 'Delta',
    total: 185,
  });
});

test('отчёт: метка и значение в одной строке', () => {
  const r = parseReport('Еженедельный отчёт Delta\n**Сотрудник:** Li Il\n**Звание:** Подполковник (12)\nИТОГО БАЛЛОВ: 185');
  assert.equal(r.name, 'Li Il');
  assert.equal(r.total, 185);
});

test('не отчёт', () => {
  assert.equal(parseReport(ACCEPTED), null);
});

test('типы премий по таблице', () => {
  const cases = [[9, null], [10, 'Пониженная'], [25, 'Пониженная'], [26, 'Стандарт'], [50, 'Стандарт'], [51, 'Средняя'], [100, 'Средняя'],
    [101, 'Высокая'], [125, 'Высокая'], [200, 'Высокая'], [201, 'Повышенная'], [260, 'Повышенная'], [450, 'Повышенная'], [451, 'Сверхвысокая']];
  for (const [points, type] of cases) assert.equal(bonusType(points), type, `${points}`);
});

test('формы: принятый, отказанный и премия', () => {
  const report = { name: 'Vladislav Siberyak', rank: '12', position: 'Delta', total: 125 };
  const entries = [
    { messageId: '1', verdict: parseCheck(ACCEPTED), report },
    { messageId: '2', verdict: parseCheck(REJECTED), report: { ...report, name: 'Santa Siberyak' } },
  ];
  const rows = formRows(entries);
  assert.deepEqual(rows.accepted, [`<@621978844894593026> | Vladislav Siberyak | ${LINK} | 125`]);
  assert.match(rows.rejected[0], /^<@466633638511902752> \| Santa Siberyak \| .+ \| У тебя альбом пуст$/);
  assert.deepEqual(rows.bonuses, [`Vladislav_Siberyak | 12 | Delta | ${LINK} | 125 | Высокая`]);
  assert.deepEqual(rows.warnings, []);
  assert.ok(buildForms(entries, '1').every((m) => m.length <= 2000));
});

test('формы: длинный список делится на сообщения', () => {
  const report = { name: 'Name Surname', rank: '12', position: 'Delta', total: 100 };
  const entries = Array.from({ length: 60 }, (_, i) => ({ messageId: `${i}`, verdict: parseCheck(ACCEPTED), report }));
  const parts = buildForms(entries, '1');
  assert.ok(parts.length > 3);
  assert.ok(parts.every((m) => m.length <= 2000));
});
