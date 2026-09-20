// Сборка трёх форм из накопленных проверок.
import { bonusType, toGameNick } from './parsing.js';

const LIMIT = 1900; // запас до лимита Discord в 2000 символов
const UNKNOWN = '???';

export function entryPoints({ verdict, report }) {
  return verdict.points ?? report?.total ?? null;
}

export function formRows(entries) {
  const accepted = [];
  const rejected = [];
  const bonuses = [];
  const warnings = [];

  for (const e of entries) {
    const { verdict, report } = e;
    const name = report?.name ?? UNKNOWN;
    const mention = `<@${verdict.userId}>`;
    if (!report) warnings.push(`Нет отчёта (имя не найдено): ${verdict.link}`);

    if (!verdict.accepted) {
      rejected.push(`${mention} | ${name} | ${verdict.link} | ${verdict.reason || UNKNOWN}`);
      if (!verdict.reason) warnings.push(`Нет причины отказа: ${verdict.link}`);
      continue;
    }

    const points = entryPoints(e);
    accepted.push(`${mention} | ${name} | ${verdict.link} | ${points ?? UNKNOWN}`);

    const type = bonusType(points);
    if (points == null) warnings.push(`Нет баллов: ${verdict.link}`);
    else if (!type) warnings.push(`${points} баллов — ниже 10, тип премии не определён: ${verdict.link}`);
    if (verdict.minimum && points != null && points < verdict.minimum) {
      warnings.push(`${points} баллов — меньше минимума ${verdict.minimum}: ${verdict.link}`);
    }

    bonuses.push(
      [
        report ? toGameNick(report.name) : UNKNOWN,
        report?.rank ?? UNKNOWN,
        report?.position ?? UNKNOWN,
        verdict.link,
        points ?? UNKNOWN,
        type ?? '—',
      ].join(' | '),
    );
  }

  return { accepted, rejected, bonuses, warnings };
}

/** Делит строки на сообщения с заголовком и блоком кода, чтобы влезть в лимит Discord. */
function blocks(title, columns, rows, prefix = '') {
  if (rows.length === 0) return [];
  const head = `${title}\n`;
  const out = [];
  let cur = [];
  const render = () => `${head}\`\`\`\n${prefix}${columns}\n${cur.join('\n')}\n\`\`\``;
  for (const row of rows) {
    cur.push(row);
    if (render().length > LIMIT && cur.length > 1) {
      cur.pop();
      out.push(render());
      cur = [row];
    }
  }
  out.push(render());
  return out;
}

export function buildForms(entries, checkerId) {
  const { accepted, rejected, bonuses, warnings } = formRows(entries);
  const who = checkerId ? `Проверил: <@${checkerId}>\n` : '';
  const messages = [
    ...blocks(
      '**1. ✅ Принятые отчёты**',
      'Упоминание | Имя Фамилия(В отчёте) | Ссылка на отчёт | Баллы',
      accepted,
      who,
    ),
    ...blocks(
      '**2. ❌ Отказанные отчёты**',
      'Упоминание | Имя Фамилия(В отчёте) | Ссылка на отчёт | Причина отказа',
      rejected,
      who,
    ),
    ...blocks(
      '**3. Кто будет составлять премии**',
      'Имя Фамилия | Ранг | Должность | Ссылка на отчёт | Баллы | Тип премии',
      bonuses,
    ),
  ];
  if (warnings.length) messages.push(`⚠️ Проверьте вручную:\n${warnings.map((w) => `- ${w}`).join('\n')}`.slice(0, 2000));
  return messages;
}
