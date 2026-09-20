// Сборка трёх форм из накопленных проверок.
import { bonusType } from './parsing.js';

const LIMIT = 1900; // запас до лимита Discord в 2000 символов
const UNKNOWN = '???';

// В форме 3 ссылка пишется с экранированным слэшем («https:/\/»), это требование формы.
const formLink3 = (link) => link.replace('https://', 'https:/\\/');

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
        name, // как в графе «Сотрудник», без изменений
        report?.rank ?? verdict.rank ?? UNKNOWN, // ранг и должность — из отчёта («Подполковник (12)», «отчёт Delta»)
        report?.position ?? verdict.position ?? UNKNOWN, // ник из проверки — только если отчёта нет
        formLink3(verdict.link),
        points ?? UNKNOWN,
        type ?? '—',
      ].join(' | '),
    );
  }

  return { accepted, rejected, bonuses, warnings };
}

const CAPACITY = LIMIT - 8; // минус «```\n» и «\n```»

const COLUMNS = {
  accepted: '-# Упоминание | Имя Фамилия(В отчёте) | Ссылка на отчёт | Баллы',
  rejected: '-# Упоминание | Имя Фамилия(В отчёте) | Ссылка на отчёт | Причина отказа',
  bonuses: '-# Имя Фамилия | Ранг | Должность | Ссылка на отчёт | Баллы | Тип премии',
};

const code = (text) => `\`\`\`\n${text}\n\`\`\``;

/**
 * Раздел -> сообщения (каждое в обёртке wrap). Длинный список делится на несколько сообщений,
 * заголовок повторяется; пустой раздел не пропускается, вместо строк пишется «нету».
 */
function section(headerLines, rows, wrap) {
  if (rows.length === 0) return [wrap([...headerLines, 'нету'].join('\n'))];
  const out = [];
  const text = (rs) => [...headerLines, ...rs.map((r) => `- ${r}`)].join('\n');
  let cur = [];
  for (const row of rows) {
    if (cur.length && text([...cur, row]).length > CAPACITY) {
      out.push(wrap(text(cur)));
      cur = [];
    }
    cur.push(row);
  }
  if (cur.length) out.push(wrap(text(cur)));
  return out;
}

/**
 * Формы: «Проверил», принятые, отказанные, премии — каждая часть отдельным сообщением.
 * groups: [{ checkerId, entries }]. На каждого проверяющего свои «Проверил», принятые и отказанные подряд;
 * премии — одним общим списком в конце. Предупреждения — отдельным обычным сообщением.
 * wrap: как оформить сообщение; по умолчанию блок кода для копирования, (t) => t даёт обычный текст.
 */
export function buildForms(groups, wrap = code) {
  const rows = groups.map(({ checkerId, entries }) => ({ checkerId, ...formRows(entries) }));

  const messages = [];
  for (const r of rows) {
    messages.push(wrap(`**Проверил:** <@${r.checkerId}>`));
    messages.push(...section(['**:white_check_mark: Принятые отчёты:**', COLUMNS.accepted], r.accepted, wrap));
    messages.push(...section(['**:x: Отказанные отчёты:**', COLUMNS.rejected], r.rejected, wrap));
  }
  messages.push(...section(['**Кто будет составлять премии**', COLUMNS.bonuses], rows.flatMap((r) => r.bonuses), wrap));

  const warnings = rows.flatMap((r) => r.warnings);
  const seen = new Set();
  for (const { entries } of groups) {
    for (const { messageId, verdict } of entries) {
      if (seen.has(messageId)) warnings.push(`Отчёт проверили несколько человек: ${verdict.link}`);
      seen.add(messageId);
    }
  }
  if (warnings.length) messages.push(`⚠️ Проверьте вручную:\n${warnings.map((w) => `- ${w}`).join('\n')}`.slice(0, 2000));
  return messages;
}
