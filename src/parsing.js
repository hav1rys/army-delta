// Чистые функции разбора отчётов и проверок — без Discord, чтобы их можно было тестировать.

const LINK_RE = /https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;

// Таблица премий: [от, до, тип, размер в долларах]. Всё, что больше последней границы — «Сверхвысокая».
const BONUS_TIERS = [
  [10, 25, 'Пониженная', 25000],
  [26, 50, 'Стандарт', 45000],
  [51, 100, 'Средняя', 70000],
  [101, 200, 'Высокая', 80000],
  [201, 450, 'Повышенная', 95000],
];
const BONUS_TOP = { type: 'Сверхвысокая', amount: 130000 };

/** Тип и размер премии по баллам, или null, если баллов нет или их меньше 10. */
export function bonusInfo(points) {
  if (!Number.isFinite(points)) return null;
  if (points > BONUS_TIERS.at(-1)[1]) return BONUS_TOP;
  const tier = BONUS_TIERS.find(([lo, hi]) => points >= lo && points <= hi);
  return tier ? { type: tier[2], amount: tier[3] } : null;
}

export const bonusType = (points) => bonusInfo(points)?.type ?? null;

/** 80000 -> «80 000$». */
export const formatMoney = (amount) => `${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}$`;

const stripMarkdown = (s) => s.replace(/[*`]/g, '').trim();

/** Строка без разметки Discord: **жирный**, `код`, ~~зачёркнутый~~, -# мелкий шрифт, > цитата, __подчёркнутый__. */
const plainLine = (l) =>
  l
    .replace(/[*`~]/g, '')
    .replace(/^\s*(?:-#|>+|#+)\s*/, '')
    .replace(/^\s*_+|_+\s*$/g, '')
    .trim();

/** Строка с ссылкой на сообщение Discord -> { guildId, channelId, messageId, link } */
export function findMessageLink(text) {
  const m = LINK_RE.exec(text ?? '');
  if (!m) return null;
  return { guildId: m[1], channelId: m[2], messageId: m[3], link: m[0] };
}

export function messageLink(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId ?? '@me'}/${channelId}/${messageId}`;
}

/** Значение после метки: в той же строке (после «:») или в следующей непустой строке. */
function valueAfter(lines, label) {
  const i = lines.findIndex((l) => l.toLowerCase().includes(label.toLowerCase()));
  if (i === -1) return null;
  const line = lines[i];
  const rest = stripMarkdown(line.slice(line.toLowerCase().indexOf(label.toLowerCase()) + label.length).replace(/^\s*:/, ''));
  if (rest) return rest;
  for (let j = i + 1; j < lines.length; j++) {
    const v = stripMarkdown(lines[j]);
    if (v) return v;
  }
  return null;
}

/** Эмбед (или массив эмбедов) -> плоский текст: заголовок, описание, поля «имя\nзначение», футер. */
export function flattenEmbeds(embeds) {
  return (embeds ?? [])
    .map((e) =>
      [
        e.title,
        e.description,
        ...(e.fields ?? []).map((f) => `${f.name}\n${f.value}`),
        e.footer?.text,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n');
}

/**
 * Разбор пересланного отчёта («Еженедельный отчёт Delta»).
 * Возвращает null, если текст не похож на отчёт.
 */
export function parseReport(text) {
  const lines = (text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const name = valueAfter(lines, 'Сотрудник');
  const rankText = valueAfter(lines, 'Звание');
  if (!name || !rankText) return null;

  const rank = /\((\d+)\)/.exec(rankText)?.[1] ?? /(\d+)/.exec(rankText)?.[1] ?? null;
  const position = /отч[её]т\s+([^\s|]+)/i.exec(text)?.[1] ?? null;
  const totalText = valueAfter(lines, 'ИТОГО БАЛЛОВ');
  const total = totalText ? Number(/-?\d+/.exec(totalText)?.[0]) : null;

  return { name, rank, position, total: Number.isFinite(total) ? total : null };
}

/**
 * Разбор сообщения-проверки.
 *
 *   <ссылка на отчёт>
 *   <id автора> | <ник> [причина отказа]
 *   ...Изменение баллов... / <N> баллов / Минимум <M> баллов
 *
 * Принято — если есть отдельная строка «N баллов» (или блок «Изменение баллов»), иначе отказ.
 * Возвращает null, если нет ссылки на отчёт или id автора.
 */
export function parseCheck(text) {
  const src = text ?? '';
  const link = findMessageLink(src);
  if (!link) return null;

  const afterLink = src.slice(src.indexOf(link.link) + link.link.length);
  const idMatch = /(?:^|\n)[ \t]*(\d{17,20})[ \t]*\|?[ \t]*/.exec(afterLink) ?? /<@!?(\d{17,20})>[ \t]*/.exec(afterLink);
  if (!idMatch) return null;

  const userId = idMatch[1];
  const rest = afterLink.slice(idMatch.index + idMatch[0].length);
  const restLines = rest.split(/\r?\n/);

  const pointsLines = restLines
    .map((l) => /^(\d+)\s*балл\S*$/i.exec(plainLine(l)))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  const hasChangeBlock = /Изменение\s+баллов/i.test(rest);
  const accepted = pointsLines.length > 0 || hasChangeBlock;
  const minimum = Number(/Минимум\s+(\d+)/i.exec(rest)?.[1]) || null;

  const nick = parseNickTags(restLines[0] ?? '');
  if (accepted) {
    return { ...link, userId, ...nick, accepted: true, points: pointsLines.at(-1) ?? null, minimum, reason: null };
  }
  return { ...link, userId, ...nick, accepted: false, points: null, minimum: null, reason: extractReason(rest) };
}

/** Ник «[Delta] Имя Фамилия [12]» -> { position: 'Delta', rank: '12' }: должность и ранг из скобок. */
function parseNickTags(nickLine) {
  const tags = [...nickLine.matchAll(/\[\s*([^\]]+?)\s*\]/g)].map((m) => m[1]);
  return {
    position: tags.find((t) => !/^\d+$/.test(t)) ?? null,
    rank: tags.find((t) => /^\d+$/.test(t)) ?? null,
  };
}

/** Убирает из хвоста строки с id ник вида «@[Delta] Имя Фамилия [12]» и оставляет причину. */
function extractReason(rest) {
  const s = rest.trim().replace(/^\|\s*/, '');
  const mention = /^<@!?\d+>\s*/.exec(s);
  if (mention) return clean(s.slice(mention[0].length));
  // Ник заканчивается на «[ранг]»: режем до первой такой скобки, остальное — причина.
  const nick = /^@?.*?\[\s*\d+\s*\]\s*/.exec(s.split(/\r?\n/)[0]);
  if (nick) return clean(s.slice(nick[0].length));
  return clean(s);
}

const clean = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Что не хватает в сообщении, которое не распозналось ни как отчёт, ни как проверка.
 * Возвращает { kind: 'report' | 'check', problems: [...] } или null, если сообщение ни на что не похоже.
 */
export function diagnose(text) {
  const src = text ?? '';
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (/Сотрудник|Звание|ИТОГО\s+БАЛЛОВ/i.test(src)) {
    const problems = ['Сотрудник', 'Звание']
      .filter((label) => !valueAfter(lines, label))
      .map((label) => `в отчёте нет поля «${label}»`);
    return { kind: 'report', problems };
  }

  const hasId = /(?:^|\n)[ \t]*\d{17,20}[ \t]*\|/.test(src) || /<@!?\d{17,20}>/.test(src);
  const looksLikeCheck = hasId || lines.some((l) => /^Изменение\s+баллов|^Минимум\s+\d+|^\d+\s*балл/i.test(plainLine(l)));
  if (!looksLikeCheck) return null;

  const problems = [];
  if (!findMessageLink(src)) problems.push('нет ссылки на отчёт (первой строкой)');
  if (!hasId) problems.push('нет ID автора: нужна строка вида «766166436656709642 | ник»');
  return { kind: 'check', problems };
}

const normName = (s) => s.toLowerCase().replace(/[_\s]+/g, ' ').trim();

/**
 * Отчёт для проверки, чья ссылка не совпала ни с одним пересланным отчётом (id при пересылке бывает другим):
 * среди ещё не проверенных берём того, чьё имя есть в тексте проверки (в нике), иначе единственного.
 * pending: [{ messageId, report }] в порядке поступления.
 */
export function matchPendingReport(pending, text) {
  const hay = normName(text ?? '');
  const byName = pending.filter(({ report }) => hay.includes(normName(report.name)));
  return byName.at(-1) ?? (pending.length === 1 ? pending[0] : null);
}
