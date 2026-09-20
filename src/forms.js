// Сборка трёх форм из накопленных проверок.
import { bonusType } from './parsing.js';

const LIMIT = 1900; // запас до лимита Discord в 2000 символов
const UNKNOWN = '???';

// В форме 3 ссылка пишется с экранированным слэшем («https:/\/»), это требование формы.
const formLink3 = (link) => link.replace('https://', 'https:/\\/');

export function entryPoints({ verdict, report }) {
  return verdict.points ?? report?.total ?? null;
}

/**
 * Для премии: по одному принятому отчёту на человека (Discord ID), с максимумом баллов.
 * Отчётов у человека может быть сколько угодно, в списки принятых и отказанных попадают все,
 * а сюда — только лучший. При равенстве баллов берётся тот, что встретился раньше.
 */
export function premiumEntries(entries) {
  const best = new Map();
  for (const e of entries) {
    if (!e.verdict.accepted) continue;
    const current = best.get(e.verdict.userId);
    if (!current || (entryPoints(e) ?? -Infinity) > (entryPoints(current) ?? -Infinity)) best.set(e.verdict.userId, e);
  }
  return [...best.values()];
}

/** Списки принятых и отказанных: все отчёты, без выбора лучшего. Предупреждения — про сами проверки. */
export function listRows(entries) {
  const accepted = [];
  const rejected = [];
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
    if (points == null) warnings.push(`Нет баллов: ${verdict.link}`);
    if (verdict.minimum && points != null && points < verdict.minimum) {
      warnings.push(`${points} баллов — меньше минимума ${verdict.minimum}: ${verdict.link}`);
    }
  }
  return { accepted, rejected, warnings };
}

/** Форма 3: по одной строке на человека, из его лучшего принятого отчёта. */
export function premiumRows(entries) {
  const bonuses = [];
  const warnings = [];
  for (const e of premiumEntries(entries)) {
    const { verdict, report } = e;
    const points = entryPoints(e);
    const type = bonusType(points);
    if (points != null && !type) warnings.push(`${points} баллов — ниже 10, тип премии не определён: ${verdict.link}`);
    bonuses.push(
      [
        report?.name ?? UNKNOWN, // как в графе «Сотрудник», без изменений
        report?.rank ?? verdict.rank ?? UNKNOWN, // ранг и должность — из отчёта («Подполковник (12)», «отчёт Delta»)
        report?.position ?? verdict.position ?? UNKNOWN, // ник из проверки — только если отчёта нет
        formLink3(verdict.link),
        points ?? UNKNOWN,
        type ?? '—',
      ].join(' | '),
    );
  }
  return { bonuses, warnings };
}

/** Все три формы для одного списка отчётов: принятые, отказанные, премии и предупреждения. */
export function formRows(entries) {
  const lists = listRows(entries);
  const premium = premiumRows(entries);
  return { ...lists, bonuses: premium.bonuses, warnings: [...lists.warnings, ...premium.warnings] };
}

const CAPACITY = LIMIT;
const SEPARATOR = '-'.repeat(36); // линия между проверяющими в общем отчёте

const COLUMNS = {
  accepted: '-# Упоминание | Имя Фамилия(В отчёте) | Ссылка на отчёт | Баллы',
  rejected: '-# Упоминание | Имя Фамилия(В отчёте) | Ссылка на отчёт | Причина отказа',
  bonuses: '-# Имя Фамилия | Ранг | Должность | Ссылка на отчёт | Баллы | Тип премии',
};

const HEADERS = {
  accepted: ['**:white_check_mark: Принятые отчёты:**', COLUMNS.accepted],
  rejected: ['**:x: Отказанные отчёты:**', COLUMNS.rejected],
  bonuses: ['**Кто будет составлять премии**', COLUMNS.bonuses],
};

/**
 * Раздел -> куски текста. Раздел, который помещается в сообщение, остаётся одним куском и не режется.
 * Слишком большой делится на несколько кусков, и каждый начинается с заголовка раздела, а не со строки.
 * Пустой раздел не пропускается, вместо строк пишется «нету».
 * reserve — сколько места занимает то, что будет приписано перед первым куском («Проверил»).
 */
function sectionChunks(headerLines, rows, reserve = 0) {
  if (rows.length === 0) return [[...headerLines, 'нету'].join('\n')];
  const text = (rs) => [...headerLines, ...rs.map((r) => `- ${r}`)].join('\n');
  if (text(rows).length + reserve <= CAPACITY) return [text(rows)];

  const chunks = [];
  let current = [];
  let room = CAPACITY - reserve;
  for (const row of rows) {
    if (current.length && text([...current, row]).length > room) {
      chunks.push(text(current));
      current = [];
      room = CAPACITY;
    }
    current.push(row);
  }
  chunks.push(text(current));
  return chunks;
}

/**
 * Куски -> сообщения. Пока следующий кусок целиком помещается, он идёт в то же сообщение; иначе начинается новое.
 * Поэтому сообщение всегда начинается с начала куска: с «Проверил» или с заголовка раздела, но не со строки или ссылки.
 * lead — линия-разделитель перед куском; ставится только внутри сообщения, а в начале сообщения не нужна.
 */
function pack(chunks) {
  const messages = [];
  let current = '';
  for (const { text, lead = '' } of chunks) {
    const joined = current ? `${current}\n\n${lead}${text}` : text;
    if (current && joined.length > CAPACITY) {
      messages.push(current);
      current = text;
    } else {
      current = joined;
    }
  }
  if (current) messages.push(current);
  return messages;
}

/**
 * Формы: «Проверил», принятые, отказанные, премии. Если всё помещается, приходит одно сообщение; если нет, несколько.
 * groups: [{ checkerId, entries }]. На каждого проверяющего свои «Проверил», принятые и отказанные подряд;
 * премии — одним общим списком в конце. Предупреждения — отдельным обычным сообщением.
 * Всё идёт обычным текстом, без блоков кода: копировать через «Копировать текст» в меню сообщения (см. COPY_HINT).
 */
export function buildForms(groups) {
  const rows = groups.map(({ checkerId, entries }) => ({ checkerId, ...listRows(entries) }));
  // Премия одним списком по всем проверяющим: у каждого человека берётся один лучший принятый отчёт.
  const premium = premiumRows(groups.flatMap((g) => g.entries));

  const chunks = [];
  for (const [i, r] of rows.entries()) {
    const head = `**Проверил:** <@${r.checkerId}>`;
    const accepted = sectionChunks(HEADERS.accepted, r.accepted, head.length + 2);
    // «Проверил» приписывается к первому куску, а со второго проверяющего перед ним ставится линия из тире.
    chunks.push({ text: `${head}\n\n${accepted[0]}`, lead: i > 0 ? `${SEPARATOR}\n` : '' });
    chunks.push(...accepted.slice(1).map((text) => ({ text })));
    chunks.push(...sectionChunks(HEADERS.rejected, r.rejected).map((text) => ({ text })));
  }
  chunks.push(...sectionChunks(HEADERS.bonuses, premium.bonuses).map((text) => ({ text })));

  const messages = pack(chunks);

  const warnings = [...rows.flatMap((r) => r.warnings), ...premium.warnings];
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

/** Отдельное сообщение после форм: как скопировать текст целиком (для тех, кто не знает про «Копировать текст»). */
export const COPY_HINT =
  '💡 Как скопировать форму целиком: правый клик по сообщению (на телефоне — долгое нажатие) → «Копировать текст». ' +
  'Копируется весь текст вместе с разметкой, выделять и нажимать Ctrl+C не нужно.';
