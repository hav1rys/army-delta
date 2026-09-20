// Подтверждение проверки перед записью: бот показывает карточку с данными, и только «Сохранить» что-то записывает.
import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { entryPoints, positionLabel, premiumEntries } from './forms.js';
import { badIdMessage, parseUserId } from './manual.js';
import { bonusInfo, formatMoney } from './parsing.js';

const TTL_MS = 30 * 60 * 1000;
const UNKNOWN = '???';

export const CONFIRM_PREFIX = 'confirm:';
export const isConfirmId = (customId) => customId.startsWith(CONFIRM_PREFIX);
/** 'confirm:save:<token>' / 'confirm:editmodal:<token>' -> { action, token }. */
export const parseConfirmId = (customId) => {
  const [, action, token] = customId.split(':');
  return { action, token };
};

/** Проверки, ожидающие подтверждения, в памяти. Запись одноразовая, живёт полчаса, подтвердить может только автор. */
export class PendingChecks {
  #map = new Map();

  add(actorId, data, now = Date.now()) {
    const token = randomBytes(8).toString('hex');
    this.#map.set(token, { actorId, data: { ...data, edits: {} }, until: now + TTL_MS });
    return token;
  }

  #lookup(token, userId, now) {
    const entry = this.#map.get(token);
    if (!entry || entry.until <= now) {
      this.#map.delete(token);
      return { error: 'Подтверждение устарело. Отправьте проверку заново.' };
    }
    if (entry.actorId !== userId) return { error: 'Это подтверждение не для вас.', foreign: true }; // карточку не трогаем
    return { entry };
  }

  /** Данные без удаления (кнопка «Изменить»). Возвращает { data } или { error }. */
  peek(token, userId, now = Date.now()) {
    const found = this.#lookup(token, userId, now);
    return found.error ? found : { data: found.entry.data };
  }

  /** Данные с удалением: после «Сохранить» или «Отменить» повторно уже не получить. */
  take(token, userId, now = Date.now()) {
    const found = this.#lookup(token, userId, now);
    if (found.error) return found;
    this.#map.delete(token);
    return { data: found.entry.data };
  }

  /** Записывает правки, сделанные в окне «Изменить». */
  edit(token, userId, patch, now = Date.now()) {
    const found = this.#lookup(token, userId, now);
    if (found.error) return found;
    Object.assign(found.entry.data.edits, patch);
    return { data: found.entry.data };
  }
}

/** Проверка и отчёт с учётом правок из окна «Изменить». */
export function applyEdits({ check, report }, edits = {}) {
  const c = { ...check };
  const r = { ...report };
  if (edits.name != null) r.name = edits.name;
  if (edits.rank != null) {
    r.rank = edits.rank;
    c.rank = edits.rank;
  }
  if (edits.position != null) {
    r.position = edits.position;
    c.position = edits.position;
  }
  if (edits.points != null) c.points = edits.points;
  if (edits.reason != null) c.reason = edits.reason;
  if (edits.userId != null) c.userId = edits.userId;
  if (edits.accepted != null) c.accepted = edits.accepted; // смена статуса: принят <-> отказан
  return { check: c, report: r };
}

/**
 * Поля карточки и предупреждения. others — уже сохранённые отчёты этого человека у всех проверяющих
 * (чтобы сказать, пойдёт ли этот отчёт в премию).
 */
export function previewFields({ check, report, others = [], isInstructor }) {
  const verdict = { ...check }; // userId, link, accepted, points, minimum, reason, rank, position
  const candidate = { messageId: check.messageId, verdict, report };
  const points = entryPoints(candidate);
  const warnings = [];

  const fields = [
    { name: 'Упоминание', value: `<@${check.userId}>` },
    { name: 'Имя и фамилия', value: report?.name ?? UNKNOWN },
    { name: 'Ссылка на отчёт', value: check.link },
    { name: 'Статус', value: check.accepted ? '✅ Принят' : '❌ Отказан' },
  ];

  if (!check.accepted) {
    fields.push({ name: 'Причина отказа', value: check.reason || UNKNOWN });
    if (!check.reason) warnings.push('Нет причины отказа.');
    return { fields, warnings };
  }

  const info = bonusInfo(points);
  fields.push(
    { name: 'Баллы', value: `${points ?? UNKNOWN}`, inline: true },
    { name: 'Тип премии', value: info?.type ?? '—', inline: true },
    { name: 'Размер премии', value: info ? formatMoney(info.amount) : '—', inline: true },
    { name: 'Ранг', value: `${report?.rank ?? check.rank ?? UNKNOWN}`, inline: true },
    { name: 'Должность', value: positionLabel(candidate, isInstructor), inline: true },
  );

  const best = premiumEntries([...others, candidate]).find((e) => e.verdict.userId === check.userId);
  fields.push({
    name: 'В премию',
    value:
      best === candidate
        ? 'Да: лучший принятый отчёт этого человека'
        : `Нет: у него уже есть отчёт с большим числом баллов (${entryPoints(best) ?? UNKNOWN}): ${best.verdict.link}`,
  });

  if (points == null) warnings.push('Нет баллов.');
  else if (!info) warnings.push('Меньше 10 баллов: тип премии не определён.');
  if (check.minimum && points != null && points < check.minimum) warnings.push(`Баллов меньше минимума (${check.minimum}).`);
  return { fields, warnings };
}

/** Карточка с тремя кнопками: сохранить, изменить, отменить. */
export function confirmMessage(token, data, others, prefix = '', isInstructor) {
  const { check, report } = applyEdits(data, data.edits);
  const { fields, warnings } = previewFields({ check, report, others, isInstructor });
  const editing = data.mode === 'edit'; // правка уже сохранённого отчёта, а не новая проверка
  const embed = new EmbedBuilder()
    .setTitle(`${prefix}${editing ? 'Изменение отчёта: проверьте и подтвердите' : 'Проверьте и подтвердите'}`)
    .setDescription(
      editing
        ? 'В отчёте ничего не меняется, пока вы не нажмёте «Сохранить».'
        : 'Ничего не сохранено, пока вы не нажмёте «Сохранить».',
    )
    .setColor(check.accepted ? 0x2ecc71 : 0xe74c3c)
    .addFields(fields);
  if (warnings.length) embed.addFields({ name: '⚠️ Проверьте', value: warnings.join('\n') });

  const button = (action, label, style) =>
    new ButtonBuilder().setCustomId(`${CONFIRM_PREFIX}${action}:${token}`).setLabel(label).setStyle(style);
  const buttons = [
    button('save', '✅ Сохранить', ButtonStyle.Success),
    button('edit', '✏️ Изменить', ButtonStyle.Primary),
    ...(editing ? [button('status', '🔄 Сменить статус', ButtonStyle.Secondary)] : []),
    button('cancel', '❌ Отменить', ButtonStyle.Danger),
  ];
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(buttons)] };
}

const input = (id, label, value, required = true) =>
  new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(TextInputStyle.Short)
      .setRequired(required)
      .setMaxLength(100)
      .setValue(`${value ?? ''}`),
  );

/** Окно «Изменить»: у принятого имя, баллы, ранг, должность; у отказанного имя и причина. */
export function editModal(token, data) {
  const { check, report } = applyEdits(data, data.edits);
  const modal = new ModalBuilder().setCustomId(`${CONFIRM_PREFIX}editmodal:${token}`).setTitle('Изменить данные');
  const idField = input('user', 'ID человека, чей это отчёт', check.userId);
  if (check.accepted) {
    return modal.addComponents(
      input('name', 'Имя и фамилия', report?.name),
      input('points', 'Баллы (число)', entryPoints({ verdict: check, report })),
      input('rank', 'Ранг (число)', report?.rank ?? check.rank, false),
      input('position', 'Должность', report?.position ?? check.position, false),
      idField,
    );
  }
  return modal.addComponents(input('name', 'Имя и фамилия', report?.name), input('reason', 'Причина отказа', check.reason), idField);
}

/** Значения из окна «Изменить» -> правки или ошибка (баллы и ранг — целые числа). */
export function parseEditFields(values, accepted) {
  const patch = {};
  const name = (values.name ?? '').trim();
  if (!name) return { error: 'Имя и фамилия не могут быть пустыми.' };
  patch.name = name;

  // ID можно поправить, если в проверке указали не того человека; пустое поле — не менять.
  const user = (values.user ?? '').trim();
  if (user) {
    const userId = parseUserId(user);
    if (!userId) return { error: badIdMessage(user) };
    patch.userId = userId;
  }

  if (!accepted) {
    const reason = (values.reason ?? '').trim();
    if (!reason) return { error: 'Причина отказа не может быть пустой.' };
    return { patch: { ...patch, reason } };
  }

  const points = (values.points ?? '').trim();
  if (!/^\d+$/.test(points)) return { error: `Баллы — целое число, получил «${points || 'пусто'}».` };
  patch.points = Number(points);

  const rank = (values.rank ?? '').trim();
  if (rank) {
    if (!/^\d+$/.test(rank)) return { error: `Ранг — число, получил «${rank}».` };
    patch.rank = rank;
  }
  const position = (values.position ?? '').trim();
  if (position) patch.position = position;
  return { patch };
}
