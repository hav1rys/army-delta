// Ранги и панель /старший-состав. Владелец бота выше всех; остальные трогают только тех, кто ниже них по рангу.
import fs from 'node:fs';
import path from 'node:path';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { BUILD } from './build.js';

// Чем больше число, тем выше ранг. Число показывается в списке в скобках и вводится при добавлении.
export const STAFF_ROLES = [
  { key: 'general', label: 'Генерал армии', rank: 6 },
  { key: 'army-deputy', label: 'Заместитель армии', rank: 5 },
  { key: 'curator', label: 'Куратор отдела', rank: 4 },
  { key: 'head', label: 'Начальник отдела', rank: 3 },
  { key: 'deputy', label: 'Заместитель начальника отдела', rank: 2 },
  { key: 'instructor', label: 'Инструктор', rank: 1 },
];

const OWNER_RANK = Infinity; // владелец выше всех
const INSTRUCTOR_RANK = 1;

// Прежние названия уровней в сохранённом файле.
const LEGACY_KEYS = { 'senior-admin': 'general', admin: 'army-deputy', 'senior-staff': 'instructor' };

export const roleByKey = (key) => STAFF_ROLES.find((r) => r.key === key) ?? null;
export const roleByRank = (rank) => STAFF_ROLES.find((r) => r.rank === rank) ?? null;
export const roleTitle = (role) => `[${role.rank}] ${role.label}`;

/**
 * Кто в каком ранге: { <key>: [{ id, name }] } в JSON-файле. Человек состоит в одном ранге.
 * Правило: добавлять, убирать и менять можно только тех, кто ниже тебя по рангу, и только на ранги ниже твоего.
 */
export class Staff {
  constructor(file, ownerId = '') {
    this.file = file;
    // Владельцев может быть несколько: ID через запятую.
    this.ownerIds = new Set(ownerId.split(',').map((id) => id.trim()).filter(Boolean));
    this.data = {};
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // нет файла или он повреждён — начинаем с пустого списка
    }
    for (const [oldKey, list] of Object.entries(raw)) {
      const key = LEGACY_KEYS[oldKey] ?? oldKey;
      if (!roleByKey(key)) continue;
      this.data[key] = [...(this.data[key] ?? []), ...list.map((m) => (typeof m === 'string' ? { id: m, name: '' } : m))];
    }
  }

  isOwner(userId) {
    return this.ownerIds.has(userId);
  }

  members(key) {
    return this.data[key] ?? [];
  }

  /** Ключ ранга человека или null. */
  roleKeyOf(userId) {
    return STAFF_ROLES.find(({ key }) => this.members(key).some((m) => m.id === userId))?.key ?? null;
  }

  /** Числовой ранг: владелец — выше всех, вне системы — 0. */
  rankOf(userId) {
    if (this.isOwner(userId)) return OWNER_RANK;
    return roleByKey(this.roleKeyOf(userId))?.rank ?? 0;
  }

  has(userId) {
    return this.roleKeyOf(userId) !== null;
  }

  /** Ранг словами для сообщений: «владелец», «[3] Начальник отдела» или «нет в списке». */
  describeRank(userId) {
    if (this.isOwner(userId)) return 'владелец';
    const role = roleByKey(this.roleKeyOf(userId));
    return role ? roleTitle(role) : 'нет в списке';
  }

  /** Старший состав: всё выше инструктора (и владелец). */
  isManager(userId) {
    return this.rankOf(userId) > INSTRUCTOR_RANK;
  }

  rolesOf(userId) {
    return roleByKey(this.roleKeyOf(userId))?.label ?? '';
  }

  nameOf(userId) {
    return STAFF_ROLES.flatMap(({ key }) => this.members(key)).find((m) => m.id === userId)?.name ?? '';
  }

  /** Все, кто есть хотя бы в одном ранге. */
  everyone() {
    return STAFF_ROLES.flatMap(({ key }) => this.members(key).map((m) => m.id));
  }

  /** Ранги, на которые этот человек может добавлять (ниже его собственного). */
  assignableRoles(actorId) {
    const rank = this.rankOf(actorId);
    return STAFF_ROLES.filter((r) => r.rank < rank);
  }

  /** Стоит ли человек ниже по рангу (для владельца — любой). Нужно и для отчётов человека, даже если он не в списке. */
  outranks(actorId, targetId) {
    if (this.isOwner(actorId)) return true;
    const target = this.rankOf(targetId);
    return target > 0 && target < this.rankOf(actorId);
  }

  canAssign(actorId, roleKey, targetId) {
    const role = roleByKey(roleKey);
    if (!role) return false;
    if (this.isOwner(actorId)) return true; // владелец ставит кого угодно, в том числе себя (запись в списке, права те же)
    if (role.rank >= this.rankOf(actorId)) return false;
    const current = this.rankOf(targetId);
    return current === 0 || current < this.rankOf(actorId);
  }

  /** Убирать и менять имя можно только тем, кто уже в списке и ниже тебя по рангу. */
  canEdit(actorId, targetId) {
    return this.has(targetId) && this.outranks(actorId, targetId);
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  /** Добавляет человека в ранг; если он уже был в другом, переносит. Возвращает 'added' или 'moved'. */
  add(roleKey, userId, name = '') {
    const previous = this.roleKeyOf(userId);
    if (previous) this.data[previous] = this.members(previous).filter((m) => m.id !== userId);
    this.data[roleKey] = [...this.members(roleKey), { id: userId, name: name.trim() }];
    this.#save();
    return previous === null ? 'added' : 'moved';
  }

  /** Убирает человека из списка (его отчёты остаются); false, если его там нет. */
  remove(userId) {
    const key = this.roleKeyOf(userId);
    if (!key) return false;
    this.data[key] = this.members(key).filter((m) => m.id !== userId);
    this.#save();
    return true;
  }

  setName(userId, name) {
    const member = STAFF_ROLES.flatMap(({ key }) => this.members(key)).find((m) => m.id === userId);
    if (!member) return false;
    member.name = name.trim();
    this.#save();
    return true;
  }
}

export const STAFF_BUTTONS = {
  add: 'staff:add',
  remove: 'staff:remove',
  name: 'staff:name',
  addReport: 'staff:addreport',
  removeReport: 'staff:removereport',
};
export const STAFF_MODALS = {
  add: 'staff:addmodal',
  remove: 'staff:removemodal',
  name: 'staff:namemodal',
  addReport: 'staff:addreportmodal',
  removeReport: 'staff:removereportmodal',
};
export const isStaffInteractionId = (customId) => customId.startsWith('staff:');

const memberLine = ({ id, name }) => (name ? `<@${id}> | ${name}` : `<@${id}>`);

/** Значение поля эмбеда: не длиннее лимита Discord (1024), остаток — «и ещё N». */
function fieldValue(members) {
  if (!members.length) return '—';
  const lines = [];
  let length = 0;
  for (const [i, m] of members.entries()) {
    const line = memberLine(m);
    if (length + line.length + 1 > 950) return `${lines.join('\n')}\nи ещё ${members.length - i}`;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n');
}

/** Список всех рангов с числами в скобках и пять кнопок. Кнопки только у тех, кто выше кого-то по рангу. */
export function panelMessage(staff, actorId) {
  const embed = new EmbedBuilder()
    .setTitle('Старший состав')
    .setDescription('Ранг в скобках. Добавить: ранг, ID, имя и фамилия. Убрать: ID. Трогать можно только тех, кто ниже вас.')
    .addFields(STAFF_ROLES.map((role) => ({ name: roleTitle(role), value: fieldValue(staff.members(role.key)) })))
    .setFooter({ text: `Сборка: ${BUILD}` });

  if (!staff.assignableRoles(actorId).length) return { embeds: [embed], components: [] };

  const button = (kind, label, style) => new ButtonBuilder().setCustomId(STAFF_BUTTONS[kind]).setLabel(label).setStyle(style);
  const row = new ActionRowBuilder().addComponents(
    button('add', 'Добавить', ButtonStyle.Success),
    button('remove', 'Убрать', ButtonStyle.Danger),
    button('name', 'Изменить имя', ButtonStyle.Secondary),
    button('addReport', 'Добавить отчёт', ButtonStyle.Primary),
    button('removeReport', 'Убрать отчёт', ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

const textInput = (id, label, { required = true, placeholder, maxLength = 100 } = {}) =>
  new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(id)
      .setLabel(label)
      .setStyle(TextInputStyle.Short)
      .setRequired(required)
      .setMaxLength(maxLength)
      .setPlaceholder(placeholder ?? ''),
  );

const NAME_PLACEHOLDER = '[Инст.Delta] Имя Фамилия';

/** Окно по кнопке панели: kind — ключ из STAFF_BUTTONS. */
export function staffModal(kind) {
  const idField = textInput('user', 'ID человека или упоминание');
  const modal = new ModalBuilder().setCustomId(STAFF_MODALS[kind]);
  switch (kind) {
    case 'add':
      return modal
        .setTitle('Добавить')
        .addComponents(
          textInput('rank', 'Ранг (цифра из списка)', { placeholder: '5', maxLength: 1 }),
          idField,
          textInput('name', 'Имя и фамилия (можно с тегом)', { required: false, placeholder: NAME_PLACEHOLDER }),
        );
    case 'remove':
      return modal.setTitle('Убрать').addComponents(idField);
    case 'name':
      return modal
        .setTitle('Изменить имя')
        .addComponents(idField, textInput('name', 'Новые имя и фамилия', { placeholder: NAME_PLACEHOLDER }));
    case 'addReport':
      return modal.setTitle('Добавить отчёт').addComponents(textInput('user', 'ID того, за кого записываете отчёт'));
    case 'removeReport':
      return modal
        .setTitle('Убрать отчёт')
        .addComponents(textInput('link', 'Ссылка на отчёт', { maxLength: 200, placeholder: 'https://discord.com/channels/…' }));
    default:
      throw new Error(`Неизвестное окно: ${kind}`);
  }
}
