import assert from 'node:assert/strict';
import test from 'node:test';
import { buildForms, formRows } from '../src/forms.js';
import { ACCEPTED_TEMPLATE, REJECTED_TEMPLATE, memoMessages } from '../src/memo.js';
import { bonusType, diagnose, flattenEmbeds, matchPendingReport, parseCheck, parseReport } from '../src/parsing.js';

const LINK = 'https://discord.com/channels/713076174108229712/1027944923829383188/1548582679338024982';
const LINK3 = LINK.replace('https://', 'https:/\\/'); // в форме 3 слэш экранирован

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

// Проверка со скриншота пользователя: без ссылки на отчёт.
const NO_LINK = `766166436656709642 | [Delta] Matvey_Siberyak [12]
Изменение баллов:
Нет
-/+ Балов | Активности | Причина
---------------------------------
90 баллов
Минимум 50 баллов`;

test('что не хватает: проверка без ссылки', () => {
  assert.equal(parseCheck(NO_LINK), null);
  assert.deepEqual(diagnose(NO_LINK), { kind: 'check', problems: ['нет ссылки на отчёт (первой строкой)'] });
});

test('что не хватает: проверка без id и без ссылки', () => {
  const d = diagnose('Изменение баллов:\nНет\n90 баллов\nМинимум 50 баллов');
  assert.equal(d.kind, 'check');
  assert.equal(d.problems.length, 2);
});

test('что не хватает: ссылка есть, id нет', () => {
  const d = diagnose(`${LINK}\n@maboy | [Delta] Matvey_Siberyak [12]\n90 баллов`);
  assert.deepEqual(d, { kind: 'check', problems: ['нет ID автора: нужна строка вида «766166436656709642 | ник»'] });
});

test('что не хватает: отчёт без звания', () => {
  assert.deepEqual(diagnose('Еженедельный отчёт Delta\nСотрудник\nLi Il'), {
    kind: 'report',
    problems: ['в отчёте нет поля «Звание»'],
  });
});

test('что не хватает: обычная болтовня — null', () => {
  assert.equal(diagnose('привет, как дела'), null);
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
  assert.match(rows.rejected[0],/^<@466633638511902752> \| Santa Siberyak \| .+ \| У тебя альбом пуст$/);
  assert.deepEqual(rows.bonuses, [`Vladislav Siberyak | 12 | Delta | ${LINK3} | 125 | Высокая`]);
  assert.deepEqual(rows.warnings, []);
  assert.ok(buildForms([{ checkerId: '1', entries }]).every((m) => m.length <= 2000));
});

test('формы: каждая часть — отдельное сообщение-блок для копирования', () => {
  const report = { name: 'Vladislav Siberyak', rank: '12', position: 'Delta', total: 125 };
  const parts = buildForms([{ checkerId: '9', entries: [{ messageId: '1', verdict: parseCheck(ACCEPTED), report }] }]);
  const fence = (body) => '```\n' + body + '\n```';
  assert.deepEqual(parts, [
    fence('**Проверил:** <@9>'),
    fence(
      '**:white_check_mark: Принятые отчёты:**\n' +
        '-# Упоминание | Имя Фамилия(В отчёте) | Ссылка на отчёт | Баллы\n' +
        `- <@621978844894593026> | Vladislav Siberyak | ${LINK} | 125`,
    ),
    fence(
      '**:x: Отказанные отчёты:**\n' +
        '-# Упоминание | Имя Фамилия(В отчёте) | Ссылка на отчёт | Причина отказа\n' +
        'нету',
    ),
    fence(
      '**Кто будет составлять премии**\n' +
        '-# Имя Фамилия | Ранг | Должность | Ссылка на отчёт | Баллы | Тип премии\n' +
        `- Vladislav Siberyak | 12 | Delta | ${LINK3} | 125 | Высокая`,
    ),
  ]);
});

test('формы: нет принятых и премий — пишется «нету»', () => {
  const report = { name: 'Santa Siberyak', rank: '12', position: 'Delta', total: 55 };
  const parts = buildForms([{ checkerId: '9', entries: [{ messageId: '2', verdict: parseCheck(REJECTED), report }] }]);
  assert.equal(parts.length, 4);
  assert.match(parts[1],/Принятые отчёты:\*\*\n-# .+\nнету/);
  assert.match(parts[3],/Кто будет составлять премии\*\*\n-# .+\nнету/);
});

test('общий отчёт: блоки «Проверил» на каждого, премии одним списком, повторная ссылка отмечается', () => {
  const report = { name: 'Name Surname', rank: '12', position: 'Delta', total: 100 };
  const a = { messageId: '1', verdict: parseCheck(ACCEPTED), report };
  const b = { messageId: '2', verdict: parseCheck(REJECTED), report };
  const parts = buildForms([
    { checkerId: '111', entries: [a] },
    { checkerId: '222', entries: [b, { ...a }] }, // одна и та же ссылка у обоих
  ]);
  const text = parts.join('\n');
  assert.match(text, /\*\*Проверил:\*\* <@111>/);
  assert.match(text, /\*\*Проверил:\*\* <@222>/);
  assert.equal(parts.filter((m) => m.includes('Кто будет составлять премии')).length, 1);
  const premiums = parts.find((m) => m.includes('Кто будет составлять премии'));
  assert.equal((premiums.match(/^- Name Surname \|/gm) ?? []).length, 1); // один человек — одна строка
  assert.match(text, /Отчёт проверили несколько человек/);
});

// ── Премии: у человека много отчётов, в форму 3 идёт один — принятый с максимумом баллов ─────────────

const entry = (messageId, userId, { accepted = true, points = 100, name = 'Vladislav Siberyak' } = {}) => ({
  messageId,
  verdict: { userId, accepted, points: accepted ? points : null, minimum: null, reason: accepted ? null : 'нет скриншотов', link: `${LINK}${messageId}` },
  report: { name, rank: '12', position: 'Delta', total: points },
});

test('премия: из нескольких отчётов человека берётся принятый с максимумом баллов', () => {
  const rows = formRows([
    entry('1', '10', { points: 60 }),
    entry('2', '10', { points: 125 }),
    entry('3', '10', { points: 90 }),
  ]);
  assert.equal(rows.bonuses.length, 1);
  assert.match(rows.bonuses[0], /\| 125 \| Высокая$/);
  assert.match(rows.bonuses[0], /2 \| 125/); // ссылка на тот самый отчёт с максимумом
  assert.equal(rows.accepted.length, 3); // в списке принятых остались все три
});

test('премия: отказанные не участвуют, даже если баллов «больше»', () => {
  const rows = formRows([
    entry('1', '10', { accepted: false, points: 500 }),
    entry('2', '10', { points: 70 }),
  ]);
  assert.equal(rows.bonuses.length, 1);
  assert.match(rows.bonuses[0], /\| 70 \| Средняя$/);
  assert.equal(rows.rejected.length, 1); // а в списке отказанных он есть

  // только отказанные: человека в премии нет
  assert.deepEqual(formRows([entry('1', '10', { accepted: false })]).bonuses, []);
});

test('премия: по одной строке на каждого человека, при равных баллах — первый отчёт', () => {
  const rows = formRows([
    entry('1', '10', { points: 80 }),
    entry('2', '20', { points: 80, name: 'Santa Siberyak' }),
    entry('3', '10', { points: 80 }), // равно первому: остаётся первый
    entry('4', '20', { points: 210, name: 'Santa Siberyak' }),
  ]);
  assert.equal(rows.bonuses.length, 2);
  // ссылка отчёта = LINK + его номер: у Vladislav берётся отчёт «1», а не «3», у Santa — «4», а не «2»
  assert.match(rows.bonuses[0], /^Vladislav Siberyak \| 12 \| Delta \| .*9821 \| 80 \| Средняя$/);
  assert.match(rows.bonuses[1], /^Santa Siberyak \| 12 \| Delta \| .*9824 \| 210 \| Повышенная$/);
});

test('премия: общий отчёт выбирает лучший отчёт человека среди всех проверяющих', () => {
  const parts = buildForms([
    { checkerId: '111', entries: [entry('1', '10', { points: 60 })] },
    { checkerId: '222', entries: [entry('2', '10', { points: 125 })] }, // тот же человек у другого проверяющего
  ]);
  const premiums = parts.find((m) => m.includes('Кто будет составлять премии'));
  assert.equal((premiums.match(/^- Vladislav Siberyak \|/gm) ?? []).length, 1); // один человек — одна строка
  assert.match(premiums, /2 \| 125 \| Высокая/);
  // а в списках принятых у каждого проверяющего его отчёт на месте
  assert.equal(parts.filter((m) => m.includes('Принятые отчёты') && m.includes('| Vladislav Siberyak |')).length, 2);
});

test('премия: предупреждение про «ниже 10 баллов» только про лучший отчёт', () => {
  // лучший отчёт человека — 5 баллов: тип не определён
  assert.equal(formRows([entry('1', '10', { points: 5 })]).warnings.length, 1);
  // 5 баллов — не лучший отчёт: лишнего предупреждения нет
  assert.deepEqual(formRows([entry('1', '10', { points: 5 }), entry('2', '10', { points: 60 })]).warnings, []);
});

// Проверка так, как её видит бот в реальном сообщении: упоминание, **жирный** текст, «-#» мелкий шрифт.
const REAL_CHECK = `https://discord.com/channels/713076174108229712/1027944923829383188/1551154782306046055
<@766166436656709642> | [Delta] Matvey_Siberyak [12]
**Изменение баллов:**
Нет
-/+ Балов | Активности | Причина
---------------------------------
**90 баллов**
-# Минимум 50 баллов`;

test('проверка с жирным шрифтом: баллы, минимум, ранг и должность из ника', () => {
  const c = parseCheck(REAL_CHECK);
  assert.equal(c.accepted, true);
  assert.equal(c.userId, '766166436656709642');
  assert.equal(c.points, 90);
  assert.equal(c.minimum, 50);
  assert.equal(c.rank, '12');
  assert.equal(c.position, 'Delta');
});

test('ник: разные написания тега и ранга', () => {
  const nick = (line) => {
    const c = parseCheck(`${LINK}\n466633638511902752 | ${line} Причина`);
    return [c.position, c.rank];
  };
  assert.deepEqual(nick('@[Delta] Santa Siberyak [12]'), ['Delta', '12']);
  assert.deepEqual(nick('@[Delta]Webfox Siberyakov[12]'), ['Delta', '12']);
  assert.deepEqual(nick('@[I.Delta]Jaba Siberyak [12]'), ['I.Delta', '12']);
  assert.deepEqual(nick('@Dane4ka'), [null, null]);
});

test('формы: ранг и должность берутся из отчёта, ник из проверки — только если отчёта нет', () => {
  const report = { name: 'Matvey Siberyak', rank: '11', position: 'Alpha', total: 90 };
  const fromReport = formRows([{ messageId: '1', verdict: parseCheck(REAL_CHECK), report }]);
  assert.match(fromReport.bonuses[0], /^Matvey Siberyak \| 11 \| Alpha \| /); // имя без замены пробела
  const noReport = formRows([{ messageId: '1', verdict: parseCheck(REAL_CHECK), report: null }]);
  assert.match(noReport.bonuses[0],/^\?\?\? \| 12 \| Delta \| /);
});

test('привязка отчёта: по имени в нике, иначе единственный ожидающий', () => {
  const a = { messageId: 'a', report: { name: 'Li Il' } };
  const b = { messageId: 'b', report: { name: 'Matvey_Siberyak' } };
  assert.equal(matchPendingReport([a, b], REAL_CHECK).messageId, 'b');
  assert.equal(matchPendingReport([a], REAL_CHECK).messageId, 'a'); // единственный, имени в нике нет
  assert.equal(matchPendingReport([a, { messageId: 'c', report: { name: 'Santa Siberyak' } }], REAL_CHECK), null);
  assert.equal(matchPendingReport([], REAL_CHECK), null);
});

test('памятка: шаблон принятой проверки в заполненном виде разбирается', () => {
  const filled = ACCEPTED_TEMPLATE.replace('Ссылка на отчёт', LINK)
    .replace('Упоминание человека', '<@766166436656709642>')
    .replace('[Отдел]', '[Delta]')
    .replace('[Ранг]', '[12]')
    .replace('[Количество баллов]', '90');
  const c = parseCheck(filled);
  assert.equal(c.accepted, true);
  assert.equal(c.userId, '766166436656709642');
  assert.equal(c.points, 90);
  assert.equal(c.minimum, 50);
  assert.equal(c.rank, '12');
  assert.equal(c.position, 'Delta');
});

test('памятка: шаблон отказа в заполненном виде разбирается', () => {
  const filled = REJECTED_TEMPLATE.replace('Ссылка на отчёт', LINK)
    .replace('Упоминание человека', '<@766166436656709642>')
    .replace('[Отдел]', '[Delta]')
    .replace('[Ранг]', '[12]')
    .replace('Причина отказа', 'Нет скриншотов');
  const c = parseCheck(filled);
  assert.equal(c.accepted, false);
  assert.equal(c.reason, 'Нет скриншотов');
});

test('памятка: сообщения влезают в лимит Discord', () => {
  assert.ok(memoMessages().every((m) => m.length <= 2000));
});

test('формы: длинный список делится на сообщения', () => {
  const report = { name: 'Name Surname', rank: '12', position: 'Delta', total: 100 };
  const entries = Array.from({ length: 60 }, (_, i) => ({ messageId: `${i}`, verdict: parseCheck(ACCEPTED), report }));
  const parts = buildForms([{ checkerId: '1', entries }]);
  assert.ok(parts.length > 3);
  assert.ok(parts.every((m) => m.length <= 2000));
});
