// Уровни доступа и панель /старший-состав. Владелец бота может всё; остальные добавляют только тех, кто ниже них.
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

// Сверху вниз: чем раньше в списке, тем выше уровень.
export const STAFF_ROLES = [
  { key: 'general', label: 'Генерал армии' },
  { key: 'army-deputy', label: 'Заместитель армии' },
  { key: 'curator', label: 'Куратор отдела' },
  { key: 'head', label: 'Начальник отдела' },
  { key: 'deputy', label: 'Заместитель начальника отдела' },
  { key: 'instructor', label: 'Инструктор' },
];

// Прежние названия уровней в сохранённом файле.
const LEGACY_KEYS = { 'senior-admin': 'general', admin: 'army-deputy', 'senior-staff': 'instructor' };

const INSTRUCTOR = 'instructor';
const levelOf = (key) => STAFF_ROLES.findIndex((r) => r.key === key); // 0 — самый высокий
export const roleByKey = (key) => STAFF_ROLES.find((r) => r.key === key) ?? null;

/**
 * Кто в каком уровне: { <key>: [{ id, name }] } в JSON-файле. Человек состоит в одном уровне.
 * Правило: добавлять и менять можно только тех, кто строго ниже тебя, и только на уровни строго ниже тебя.
 * Владелец (ownerId) — выше всех.
 */
export class Staff {
  constructor(file, ownerId = '') {
    this.file = file;
    this.ownerId = ownerId;
    this.data = {};
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // нет файла или он повреждён — начинаем с пустого списка
    }
    for (const [oldKey, list] of Object.entries(raw)) {
      const key = LEGACY_KEYS[oldKey] ?? oldKey;
      if (levelOf(key) === -1) continue;
      this.data[key] = [...(this.data[key] ?? []), ...list.map((m) => (typeof m === 'string' ? { id: m, name: '' } : m))];
    }
  }

  isOwner(userId) {
    return this.ownerId !== '' && userId === this.ownerId;
  }

  members(key) {
    return this.data[key] ?? [];
  }

  /** Ключ уровня человека или null. */
  roleKeyOf(userId) {
    return STAFF_ROLES.find(({ key }) => this.members(key).some((m) => m.id === userId))?.key ?? null;
  }

  has(userId) {
    return this.roleKeyOf(userId) !== null;
  }

  /** Руководство: всё, кроме инструкторов. */
  isManager(userId) {
    const key = this.roleKeyOf(userId);
    return key !== null && key !== INSTRUCTOR;
  }

  rolesOf(userId) {
    return roleByKey(this.roleKeyOf(userId))?.label ?? '';
  }

  nameOf(userId) {
    return STAFF_ROLES.flatMap(({ key }) => this.members(key)).find((m) => m.id === userId)?.name ?? '';
  }

  /** Все, кто есть хотя бы в одном уровне. */
  everyone() {
    return STAFF_ROLES.flatMap(({ key }) => this.members(key).map((m) => m.id));
  }

  /** Уровень того, кто действует: владелец -1 (выше всех), без уровня — бесконечность (не может ничего). */
  #actorLevel(actorId) {
    if (this.isOwner(actorId)) return -1;
    const key = this.roleKeyOf(actorId);
    return key === null ? Infinity : levelOf(key);
  }

  /** Уровни, на которые этот человек может добавлять (строго ниже него). */
  assignableRoles(actorId) {
    const level = this.#actorLevel(actorId);
    return STAFF_ROLES.filter((_, i) => i > level);
  }

  canAssign(actorId, roleKey, targetId) {
    const level = this.#actorLevel(actorId);
    if (levelOf(roleKey) <= level) return false;
    const current = this.roleKeyOf(targetId);
    return current === null || levelOf(current) > level;
  }

  /** Уровни выше инструктора, которые этот человек вправе добавлять (для /старший-состав). */
  assignableSeniorRoles(actorId) {
    return this.assignableRoles(actorId).filter((r) => r.key !== INSTRUCTOR);
  }

  /** Может ли вести инструкторов: владелец и все уровни выше инструктора. */
  canManageInstructors(actorId) {
    return this.assignableRoles(actorId).some((r) => r.key === INSTRUCTOR);
  }

  instructors() {
    return this.members(INSTRUCTOR);
  }

  isInstructor(userId) {
    return this.roleKeyOf(userId) === INSTRUCTOR;
  }

  /** Убирает инструктора из системы (его отчёты остаются); false, если такого инструктора нет. */
  removeInstructor(userId) {
    if (!this.isInstructor(userId)) return false;
    this.data[INSTRUCTOR] = this.members(INSTRUCTOR).filter((m) => m.id !== userId);
    this.#save();
    return true;
  }

  /** Менять имя можно только тем, кто уже в уровне строго ниже тебя. */
  canEdit(actorId, targetId) {
    const current = this.roleKeyOf(targetId);
    return current !== null && levelOf(current) > this.#actorLevel(actorId);
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  /** Добавляет человека в уровень (или переносит, если он был в другом) и записывает имя. */
  add(roleKey, userId, name = '') {
    const previous = this.roleKeyOf(userId);
    if (previous) this.data[previous] = this.members(previous).filter((m) => m.id !== userId);
    this.data[roleKey] = [...this.members(roleKey), { id: userId, name: name.trim() }];
    this.#save();
    return previous === null ? 'added' : 'moved';
  }

  setName(userId, name) {
    const member = STAFF_ROLES.flatMap(({ key }) => this.members(key)).find((m) => m.id === userId);
    if (!member) return false;
    member.name = name.trim();
    this.#save();
    return true;
  }
}

const ADD_PREFIX = 'staff:add:';
const MODAL_PREFIX = 'staff:modal:';
export const NAME_BUTTON_ID = 'staff:name';
export const NAME_MODAL_ID = 'staff:namemodal';
export const isStaffInteractionId = (customId) => customId.startsWith('staff:');
export const addRoleKey = (customId) => (customId.startsWith(ADD_PREFIX) ? customId.slice(ADD_PREFIX.length) : null);
export const modalRoleKey = (customId) => (customId.startsWith(MODAL_PREFIX) ? customId.slice(MODAL_PREFIX.length) : null);

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

const SENIOR_ROLES = STAFF_ROLES.filter((r) => r.key !== INSTRUCTOR);

/** Панель старшего состава (без инструкторов): список и кнопки только на уровни, которые человек вправе добавлять. */
export function panelMessage(staff, actorId) {
  const embed = new EmbedBuilder()
    .setTitle('Старший состав')
    .setDescription('Упоминание | имя и фамилия. Кнопки ниже — только для уровней, которые вы вправе добавлять. Инструкторы — команда /инструктор.')
    .addFields(SENIOR_ROLES.map(({ key, label }) => ({ name: label, value: fieldValue(staff.members(key)) })));

  const buttons = staff
    .assignableSeniorRoles(actorId)
    .map(({ key, label }) =>
      new ButtonBuilder().setCustomId(`${ADD_PREFIX}${key}`).setLabel(`Добавить: ${label}`).setStyle(ButtonStyle.Secondary),
    );
  if (buttons.length) {
    buttons.push(new ButtonBuilder().setCustomId(NAME_BUTTON_ID).setLabel('Изменить имя').setStyle(ButtonStyle.Primary));
  }

  const components = [];
  for (let i = 0; i < buttons.length; i += 5) {
    components.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }
  return { embeds: [embed], components };
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

/** Окно добавления: ID человека и (необязательно) имя с фамилией. */
export function addModal(role) {
  return new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${role.key}`)
    .setTitle(`Добавить: ${role.label}`.slice(0, 45))
    .addComponents(
      textInput('user', 'ID человека или упоминание'),
      textInput('name', 'Имя и фамилия (можно с тегом)', { required: false, placeholder: '[Инст.Delta] Имя Фамилия' }),
    );
}

/** Окно смены имени уже добавленного человека. */
export function nameModal() {
  return new ModalBuilder()
    .setCustomId(NAME_MODAL_ID)
    .setTitle('Изменить имя')
    .addComponents(
      textInput('user', 'ID человека или упоминание'),
      textInput('name', 'Новые имя и фамилия', { placeholder: '[Инст.Delta] Имя Фамилия' }),
    );
}

// ── Панель /инструктор ───────────────────────────────────────────────────────────────────────

export const INSTRUCTOR_BUTTONS = {
  add: 'inst:add',
  remove: 'inst:remove',
  addReport: 'inst:addreport',
  removeReport: 'inst:removereport',
};
export const INSTRUCTOR_MODALS = {
  add: 'inst:addmodal',
  remove: 'inst:removemodal',
  addReport: 'inst:addreportmodal',
  removeReport: 'inst:removereportmodal',
};
export const isInstructorInteractionId = (customId) => customId.startsWith('inst:');

/** Панель инструкторов: список и четыре кнопки. */
export function instructorPanelMessage(staff) {
  const embed = new EmbedBuilder()
    .setTitle('Инструкторы')
    .setDescription(fieldValue(staff.instructors()))
    .setFooter({ text: 'Упоминание | имя и фамилия' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(INSTRUCTOR_BUTTONS.add).setLabel('Добавить инструктора').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(INSTRUCTOR_BUTTONS.remove).setLabel('Убрать инструктора').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(INSTRUCTOR_BUTTONS.addReport).setLabel('Добавить отчёт инструктору').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(INSTRUCTOR_BUTTONS.removeReport).setLabel('Убрать отчёт инструктору').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

/** Окно по кнопке панели инструкторов: kind — ключ из INSTRUCTOR_BUTTONS. */
export function instructorModal(kind) {
  const idField = textInput('user', 'ID инструктора или упоминание');
  const modal = new ModalBuilder().setCustomId(INSTRUCTOR_MODALS[kind]);
  switch (kind) {
    case 'add':
      return modal
        .setTitle('Добавить инструктора')
        .addComponents(
          idField,
          textInput('name', 'Имя и фамилия (можно с тегом)', { required: false, placeholder: '[Инст.Delta] Имя Фамилия' }),
        );
    case 'remove':
      return modal.setTitle('Убрать инструктора').addComponents(idField);
    case 'addReport':
      return modal.setTitle('Добавить отчёт инструктору').addComponents(idField);
    case 'removeReport':
      return modal
        .setTitle('Убрать отчёт инструктору')
        .addComponents(textInput('link', 'Ссылка на отчёт', { maxLength: 200, placeholder: 'https://discord.com/channels/…' }));
    default:
      throw new Error(`Неизвестное окно: ${kind}`);
  }
}
