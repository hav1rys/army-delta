// Уровни доступа (старший состав и выше) и панель /админ. Панель открывает только владелец бота.
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

export const STAFF_ROLES = [
  { key: 'senior-admin', label: 'Старший администратор' },
  { key: 'admin', label: 'Администратор' },
  { key: 'head', label: 'Начальник отдела' },
  { key: 'deputy', label: 'Заместитель начальника отдела' },
  { key: 'senior-staff', label: 'Старший состав' },
];

const MANAGER_KEYS = ['senior-admin', 'admin', 'head', 'deputy'];

export const roleByKey =(key) => STAFF_ROLES.find((r) => r.key === key) ?? null;

/** Кто в каком уровне: { <key>: [userId, ...] }, хранится в JSON-файле. */
export class Staff {
  constructor(file) {
    this.file = file;
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // нет файла или он повреждён — начинаем с пустого списка
    }
  }

  members(key) {
    return this.data[key] ?? [];
  }

  has(userId) {
    return STAFF_ROLES.some(({ key }) => this.members(key).includes(userId));
  }

  /** Названия уровней человека через запятую («Администратор, Старший состав») или пустая строка. */
  rolesOf(userId) {
    return STAFF_ROLES.filter(({ key }) => this.members(key).includes(userId))
      .map((r) => r.label)
      .join(', ');
  }

  /** Все, кто есть хотя бы в одном уровне. */
  everyone() {
    return [...new Set(STAFF_ROLES.flatMap(({ key }) => this.members(key)))];
  }

  /** Руководство: админы, начальники отдела и их заместители. Старший состав (инструкторы) сюда не входит. */
  isManager(userId) {
    return MANAGER_KEYS.some((key) => this.members(key).includes(userId));
  }

  /** Добавляет человека в уровень; false, если он там уже был. */
  add(key, userId) {
    if (this.members(key).includes(userId)) return false;
    this.data[key] = [...this.members(key), userId];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return true;
  }
}

const ADD_PREFIX = 'staff:add:';
const MODAL_PREFIX = 'staff:modal:';
export const isStaffInteractionId = (customId) => customId.startsWith('staff:');
export const addRoleKey = (customId) => (customId.startsWith(ADD_PREFIX) ? customId.slice(ADD_PREFIX.length) : null);
export const modalRoleKey = (customId) => (customId.startsWith(MODAL_PREFIX) ? customId.slice(MODAL_PREFIX.length) : null);

/** Эмбед панели: кто в каком уровне, и по кнопке «добавить» на каждый уровень. */
export function panelMessage(staff) {
  const embed = new EmbedBuilder()
    .setTitle('Админ-панель')
    .setDescription('Нажмите кнопку, чтобы добавить человека в уровень.')
    .addFields(
      STAFF_ROLES.map(({ key, label }) => ({
        name: label,
        value: staff.members(key).map((id) => `<@${id}>`).join(', ') || '—',
      })),
    );
  const row = new ActionRowBuilder().addComponents(
    STAFF_ROLES.map(({ key, label }) =>
      new ButtonBuilder().setCustomId(`${ADD_PREFIX}${key}`).setLabel(`Добавить: ${label}`).setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [embed], components: [row] };
}

/** Окно запроса ID человека для выбранного уровня. */
export function addModal(role) {
  const input = new TextInputBuilder()
    .setCustomId('user')
    .setLabel('ID человека или упоминание')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  return new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${role.key}`)
    .setTitle(`Добавить: ${role.label}`.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(input));
}
