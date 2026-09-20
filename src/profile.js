// Профиль человека: все его еженедельные отчёты за период, баллы, тип и размер премии.
import { entryPoints, premiumEntries } from './forms.js';
import { bonusInfo, formatMoney } from './parsing.js';

const LIMIT = 1900; // запас до лимита Discord в 2000 символов
const DAY_MS = 24 * 60 * 60 * 1000;

export const PERIODS = {
  week: { days: 7, label: 'за неделю' },
  month: { days: 30, label: 'за месяц (30 дней)' },
  all: { days: null, label: 'за всё время' },
};
export const PERIOD_CHOICES = [
  { name: 'неделя', value: 'week' },
  { name: 'месяц', value: 'month' },
  { name: 'всё время', value: 'all' },
];

const DISCORD_EPOCH = 1420070400000n;

/** Когда создано сообщение Discord: время зашито в его id. У ссылок вида .../<id сообщения> дата есть всегда. */
export function snowflakeTime(id) {
  return /^\d{17,20}$/.test(`${id}`) ? Number((BigInt(id) >> 22n) + DISCORD_EPOCH) : null;
}

/** Дата в формате Discord: у каждого читающего показывается в его часовом поясе. */
const dateTag = (ms) => (ms == null ? 'без даты' : `<t:${Math.floor(ms / 1000)}:d>`);

function line({ checkerId, entry, at }) {
  const { verdict, report } = entry;
  const when = dateTag(at);
  const by = `проверил <@${checkerId}>`;
  if (!verdict.accepted) return `- ❌ ${when} | отказан: ${verdict.reason || 'без причины'} | ${by} | ${verdict.link}`;

  const points = entryPoints(entry);
  const info = bonusInfo(points);
  const premium = info ? `${info.type}, ${formatMoney(info.amount)}` : 'премии нет';
  return `- ✅ ${when} | принят | ${points ?? '?'} б. | ${premium} | ${by} | ${verdict.link}`;
}

/**
 * Сообщения профиля. stores: [{ checkerId, store }]. period: 'week' | 'month' | 'all'.
 * name — имя из списка старшего состава (если человек там есть), иначе берётся из последнего отчёта.
 */
export function profileMessages({ stores, userId, period = 'month', now = Date.now(), name = '' }) {
  const { days, label } = PERIODS[period] ?? PERIODS.month;

  const all = stores
    .flatMap(({ checkerId, store }) =>
      store
        .entries()
        .filter((e) => e.verdict.userId === userId)
        .map((entry) => ({ checkerId, entry, at: snowflakeTime(entry.messageId) })),
    )
    // за неделю и месяц берутся отчёты с известной датой не старше периода; «всё время» — все
    .filter(({ at }) => (days == null ? true : at != null && at >= now - days * DAY_MS))
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));

  const person = name || all.find((x) => x.entry.report?.name)?.entry.report.name;
  const header = `**Профиль <@${userId}>**${person ? ` | ${person}` : ''} | ${label}`;
  if (!all.length) return [`${header}\nОтчётов за этот период нет.`];

  const entries = all.map((x) => x.entry);
  const accepted = entries.filter((e) => e.verdict.accepted);
  const points = accepted.map((e) => entryPoints(e) ?? 0);
  const sum = points.reduce((a, b) => a + b, 0);
  const amounts = accepted.map((e) => bonusInfo(entryPoints(e))?.amount ?? 0);
  const best = premiumEntries(entries)[0];
  const bestInfo = best && bonusInfo(entryPoints(best));

  const summary = [
    `**Итого ${label}:** отчётов ${entries.length}: принято ${accepted.length}, отказано ${entries.length - accepted.length}.`,
    ...(accepted.length ? [`Баллов по принятым: ${sum}. Премии по принятым отчётам: ${formatMoney(amounts.reduce((a, b) => a + b, 0))}.`] : []),
    ...(best
      ? [`Лучший принятый отчёт (он идёт в форму премий): ${entryPoints(best) ?? '?'} б., ${bestInfo ? `${bestInfo.type}, ${formatMoney(bestInfo.amount)}` : 'премии нет'}.`]
      : []),
  ];

  // Режем на сообщения по строкам; шапка только в первом.
  const messages = [];
  let current = [header];
  for (const text of [...all.map(line), ...summary]) {
    if ([...current, text].join('\n').length > LIMIT) {
      messages.push(current.join('\n'));
      current = [];
    }
    current.push(text.slice(0, LIMIT));
  }
  messages.push(current.join('\n'));
  return messages;
}
