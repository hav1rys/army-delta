import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {
  ApplicationCommandOptionType,
  ApplicationIntegrationType,
  Client,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  Partials,
} from 'discord.js';
import { COPY_HINT, buildForms, entryPoints } from './forms.js';
import {
  bonusType,
  diagnose,
  findMessageLink,
  flattenEmbeds,
  matchPendingReport,
  messageLink,
  parseCheck,
  parseReport,
} from './parsing.js';
import {
  addAccepted,
  addRejected,
  badIdMessage,
  badRankMessage,
  duplicateMessage,
  findDuplicate,
  parseUserId,
  removeByLinkAllowed,
} from './manual.js';
import { ActingFor } from './acting.js';
import { BUILD } from './build.js';
import { PendingChecks, applyEdits, confirmMessage, editModal, isConfirmId, parseConfirmId, parseEditFields } from './confirm.js';
import { deliver, fail, say, sayError } from './deliver.js';
import { commitEdit, findEditable } from './editflow.js';
import { leadershipMessage, memoMessages, supportMessage, unregisteredMessage } from './memo.js';
import {
  STAFF_BUTTONS,
  STAFF_ROLES,
  STAFF_MODALS,
  Staff,
  isStaffInteractionId,
  panelMessage,
  roleByRank,
  roleTitle,
  staffModal,
} from './staff.js';
import { lookupMessages } from './lookup.js';
import { PERIOD_CHOICES, profileMessages } from './profile.js';
import { statsMessages } from './stats.js';
import { Store } from './store.js';

const {
  DISCORD_TOKEN,
  ALLOWED_USER_IDS = '',
  OWNER_USER_ID = '',
  SUPPORT_CONTACT = '',
  CHANNEL_ID = '',
  DATA_DIR = './data',
} = process.env;
if (!DISCORD_TOKEN) {
  console.error('Не задана переменная окружения DISCORD_TOKEN');
  process.exit(1);
}

const allowedUsers = new Set(ALLOWED_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean));
const staff = new Staff(path.join(DATA_DIR, 'staff.json'), OWNER_USER_ID);

const actingFor = new ActingFor();
const pendingChecks = new PendingChecks();

const isOwner = (userId) => staff.isOwner(userId);
/** Старший состав: владелец и все ранги выше инструктора. */
const isManager = (userId) => isOwner(userId) || staff.isManager(userId);
const isStaff = (userId) => isOwner(userId) || staff.has(userId);
const isInstructor = (userId) => staff.isInstructor(userId);

// У каждого пользователя своё хранилище: отчёты и проверки разных людей не смешиваются.
const stores = new Map();
function storeFor(userId) {
  if (!stores.has(userId)) stores.set(userId, new Store(path.join(DATA_DIR, `${userId}.json`)));
  return stores.get(userId);
}

/** Все, у кого есть сохранённые данные: уже загруженные в память и лежащие на диске (файл <id>.json). */
function allCheckerIds() {
  const onDisk = fs.existsSync(DATA_DIR)
    ? fs.readdirSync(DATA_DIR).filter((f) => /^\d+\.json$/.test(f)).map((f) => f.slice(0, -'.json'.length))
    : [];
  return [...new Set([...onDisk, ...stores.keys()])];
}

const noPings = { parse: [] };

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

/**
 * Кто может пользоваться ботом. Пока не задан ни ALLOWED_USER_IDS, ни OWNER_USER_ID — все;
 * после этого — только они, владелец и добавленные через /старший-состав.
 */
const isUserAllowed = (userId) =>
  (allowedUsers.size === 0 && OWNER_USER_ID === '') || allowedUsers.has(userId) || isStaff(userId);

/** Хранилища всех проверяющих — для проверки «одна ссылка — один отчёт» и общих команд. */
const everyStore = () => allCheckerIds().map((checkerId) => ({ checkerId, store: storeFor(checkerId) }));

/** Пересланные сообщения принимаем только в личке и (если задан) в одном канале, и только от разрешённых пользователей. */
function isAllowed(userId, guildId, channelId) {
  return isUserAllowed(userId) && (guildId === null || (CHANNEL_ID !== '' && channelId === CHANNEL_ID));
}

const textOption = (name, description, required = true) => ({
  name,
  description,
  type: ApplicationCommandOptionType.String,
  required,
});
const numberOption = (name, description) => ({
  name,
  description,
  type: ApplicationCommandOptionType.Integer,
  required: true,
  minValue: 0,
});

// Необязательное поле в командах добавления: записать отчёт в список другого проверяющего.
const forOption = textOption('проверяющий', 'Записать за того, кто ниже вас по рангу (ID). Пусто: на вас', false);

/** Чей список пополняем: свой или (за другого) того, кто ниже вас по рангу. */
function targetStore(userId, i) {
  const forWho = i.options.getString('проверяющий');
  if (!forWho) return { store: storeFor(userId) };
  const id = parseUserId(forWho);
  if (!id) return { error: badIdMessage(forWho) };
  if (id !== userId && !staff.outranks(userId, id)) {
    return { error: 'Записывать отчёты за других можно только тем, кто ниже вас по рангу. Свои — без этого поля.' };
  }
  return { store: storeFor(id) };
}

/** Удаляет отчёт по ссылке: свои и тех, кто ниже вас по рангу. Возвращает { done, problems }: что удалено и что не вышло. */
function removeReport(actorId, link) {
  const result = removeByLinkAllowed(everyStore(), link, (checkerId) => checkerId === actorId || staff.outranks(actorId, checkerId));
  if (result.error) return { done: null, problems: [result.error] };
  const problems = [];
  if (result.denied.length) {
    problems.push(`Нельзя удалить: отчёт у ${result.denied.map((id) => `<@${id}>`).join(', ')}, он не ниже вас по рангу.`);
  }
  if (!result.removed.length && !result.denied.length) problems.push('Такого отчёта не найдено.');
  const done = result.removed.length
    ? `Удалено: ${result.removed.map(({ checkerId, name }) => `${name ?? 'без имени'} (проверил <@${checkerId}>)`).join(', ')}`
    : null;
  return { done, problems };
}

/** Для окна панели: один текст. */
const removeReportFor = (actorId, link) => {
  const { done, problems } = removeReport(actorId, link);
  return [done, ...problems].filter(Boolean).join('\n');
};

/** Для команды: удалённое обычным сообщением, ошибки — ответом на команду. */
function removeReportMessages(actorId, link) {
  const { done, problems } = removeReport(actorId, link);
  return [...(done ? [done] : []), ...problems.map(fail)];
}

const managersOnly = (text) => `Нет доступа: ${text} для тех, кто выше инструктора по рангу.`;

// Слэш-команды. run(userId, interaction) возвращает список сообщений для ответа:
// строки или готовое содержимое ({ embeds, components }). open — доступна и незарегистрированным.
const COMMANDS = {
  'добавить-принятый': {
    description: 'Добавить принятый отчёт вручную',
    options: [
      textOption('id', 'ID человека (числом или упоминанием)'),
      textOption('имя-фамилия', 'Имя и фамилия из графы «Сотрудник» в отчёте'),
      textOption('ссылка', 'Ссылка на отчёт'),
      numberOption('баллы', 'Количество баллов'),
      numberOption('ранг', 'Ранг (число)'),
      textOption('должность', 'Должность, например Delta'),
      forOption,
    ],
    run(userId, i) {
      const target = targetStore(userId, i);
      if (target.error) return [fail(target.error)];
      const result = addAccepted(
        target.store,
        {
          id: i.options.getString('id', true),
          name: i.options.getString('имя-фамилия', true),
          link: i.options.getString('ссылка', true),
          points: i.options.getInteger('баллы', true),
          rank: i.options.getInteger('ранг', true),
          position: i.options.getString('должность', true),
        },
        everyStore(),
      );
      return [result.error ? fail(result.error) : `Добавлено: ${describe(result.entry)}`];
    },
  },

  'добавить-отказанный': {
    description: 'Добавить отказанный отчёт вручную',
    options: [
      textOption('id', 'ID человека (числом или упоминанием)'),
      textOption('имя-фамилия', 'Имя и фамилия из графы «Сотрудник» в отчёте'),
      textOption('ссылка', 'Ссылка на отчёт'),
      textOption('причина', 'Причина отказа'),
      forOption,
    ],
    run(userId, i) {
      const target = targetStore(userId, i);
      if (target.error) return [fail(target.error)];
      const result = addRejected(
        target.store,
        {
          id: i.options.getString('id', true),
          name: i.options.getString('имя-фамилия', true),
          link: i.options.getString('ссылка', true),
          reason: i.options.getString('причина', true),
        },
        everyStore(),
      );
      return [result.error ? fail(result.error) : `Добавлено: ${describe(result.entry)}`];
    },
  },

  'удалить-отчет': {
    description: 'Удалить отчёт (принятый или отказанный) по ссылке',
    options: [textOption('ссылка', 'Ссылка на отчёт')],
    run: (userId, i) => removeReportMessages(userId, i.options.getString('ссылка', true)),
  },

  'отчет': {
    description: 'Три формы по отчётам, которые проверили вы',
    run(userId) {
      const entries = storeFor(userId).entries();
      return entries.length ? [...buildForms([{ checkerId: userId, entries }], { isInstructor }), COPY_HINT] : ['Пока нет ни одной проверки.'];
    },
  },

  'общий-отчет': {
    description: 'Отчёты всех проверяющих (для руководства)',
    run(userId) {
      if (!isManager(userId)) return [fail(managersOnly('общий отчёт доступен'))];
      const groups = allCheckerIds()
        .map((checkerId) => ({ checkerId, entries: storeFor(checkerId).entries() }))
        .filter((g) => g.entries.length);
      return groups.length ? [...buildForms(groups, { isInstructor }), COPY_HINT] : ['Пока нет ни одной проверки.'];
    },
  },

  'статистика': {
    description: 'Кто из проверяющих сколько отчётов сделал (для руководства)',
    run(userId) {
      if (!isManager(userId)) return [fail(managersOnly('статистика доступна'))];
      const ids = [...new Set([...allCheckerIds(), ...staff.everyone()])];
      const rows = ids.map((checkerId) => {
        const entries = storeFor(checkerId).entries();
        const accepted = entries.filter((e) => e.verdict.accepted).length;
        return { checkerId, roles: staff.rolesOf(checkerId), accepted, rejected: entries.length - accepted };
      });
      return rows.length ? statsMessages(rows) : ['Пока нет ни проверяющих, ни отчётов.'];
    },
  },

  'старший-состав': {
    description: 'Список рангов: добавить, убрать, имя, отчёты',
    run(userId) {
      if (!staff.assignableRoles(userId).length) {
        return [
          fail(
            OWNER_USER_ID
              ? `Нет доступа: команда для тех, у кого есть кто-то ниже по рангу. Ваш ранг: ${staff.describeRank(userId)}.${notOwnerHint(userId)}`
              : 'Не задана переменная OWNER_USER_ID.',
          ),
        ];
      }
      return [panelMessage(staff, userId)];
    },
  },

  'помощь': {
    description: 'Как пользоваться ботом (зависит от вашего уровня)',
    open: true, // отвечает и тем, кого нет в системе
    run(userId) {
      if (!isUserAllowed(userId)) return [fail(unregisteredMessage(userId)), supportMessage(SUPPORT_CONTACT)];
      const messages = memoMessages(client.user?.username);
      const addable = staff.assignableRoles(userId).map(roleTitle);
      if (addable.length) {
        const level = isOwner(userId) ? 'Владелец' : staff.rolesOf(userId) || 'Ваш ранг';
        messages.push(leadershipMessage({ level, addable, canReports: isManager(userId) }));
      }
      messages.push(supportMessage(SUPPORT_CONTACT));
      return messages;
    },
  },

  'изменить': {
    description: 'Изменить отчёт по ссылке: статус, баллы, имя, ранг, должность',
    options: [textOption('ссылка', 'Ссылка на отчёт')],
    run(userId, i) {
      const started = startEdit(userId, i.options.getString('ссылка', true));
      return [started.error ? fail(started.error) : started.card];
    },
  },

  'профиль': {
    description: 'Все отчёты человека за период: баллы, премия',
    options: [
      textOption('id', 'ID человека (числом или упоминанием)'),
      {
        name: 'период',
        description: 'За какой период (по умолчанию месяц)',
        type: ApplicationCommandOptionType.String,
        required: false,
        choices: PERIOD_CHOICES,
      },
    ],
    run(userId, i) {
      const raw = i.options.getString('id', true);
      const target = parseUserId(raw);
      if (!target) return [fail(badIdMessage(raw))];
      return profileMessages({
        stores: everyStore(),
        userId: target,
        period: i.options.getString('период') ?? 'month',
        name: staff.nameOf(target),
      });
    },
  },

  'проверить-наличие': {
    description: 'Проверить, есть ли отчёты: по именам и фамилиям или Discord ID',
    options: [textOption('список', 'Имена и фамилии или ID через запятую (можно несколько)')],
    run: (userId, i) => lookupMessages(everyStore(), i.options.getString('список', true)),
  },

  'статус': {
    description: 'Сколько принято/отказано и чего не хватает',
    run(userId) {
      const store = storeFor(userId);
      const entries = store.entries();
      const accepted = entries.filter((e) => e.verdict.accepted).length;
      const lines = [`Принято: ${accepted}, отказано: ${entries.length - accepted}`];
      const acting = actingFor.get(userId);
      if (acting) lines.push(`Сейчас отчёты записываются за <@${acting}> (до записи пары «отчёт + проверка»).`);
      const pending = store.pendingReports();
      if (pending.length) {
        lines.push('Отчёты без проверки:', ...pending.map(({ report }) => `- ${report.name} (${report.total ?? '?'} б.)`));
      }
      const orphans = entries.filter((e) => !e.report);
      if (orphans.length) {
        lines.push('Проверки без отчёта:', ...orphans.map(({ verdict }) => `- ${verdict.link}`));
      }
      return [lines.join('\n').slice(0, 2000)];
    },
  },

  'очистить': {
    description: 'Удалить все накопленные отчёты и проверки',
    run(userId) {
      storeFor(userId).clear();
      return ['Всё очищено.'];
    },
  },
};

client.once(Events.ClientReady, async (c) => {
  console.log(`Бот запущен как ${c.user.tag}. Сборка: ${BUILD}`);
  await c.application.commands.set(
    Object.entries(COMMANDS).map(([name, { description, options }]) => ({
      name,
      description,
      options,
      contexts: [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel],
      // UserInstall: приложение ставится на аккаунт, и писать боту в личку можно без общего сервера.
      integrationTypes: [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall],
    })),
  );
  console.log(`Слэш-команды зарегистрированы: ${Object.keys(COMMANDS).map((n) => `/${n}`).join(', ')}`);
});

const denyPanel = (interaction, text) => interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
/** Если действует не владелец и не человек из списка, почти всегда дело в OWNER_USER_ID. */
const notOwnerHint = (actorId) =>
  staff.has(actorId) || staff.isOwner(actorId)
    ? ''
    : `\nВас нет в списке, и вы не владелец. Ваш ID: ${actorId}. Владелец задаётся переменной OWNER_USER_ID.`;

/** Почему нельзя трогать этого человека: ваш ранг, его ранг, правило. */
const whyNotLower = (actorId, targetId) =>
  `Недостаточно прав. Ваш ранг: ${staff.describeRank(actorId)}. У <@${targetId}>: ${staff.describeRank(targetId)}. ` +
  `Трогать можно только тех, кто ниже вас по рангу.${notOwnerHint(actorId)}`;
const replyHere = (interaction, payload) =>
  interaction.reply({ ...payload, flags: interaction.inGuild() ? MessageFlags.Ephemeral : undefined });

/** Кнопки и окна панели /старший-состав. Права проверяются при каждом действии, а не только при открытии. */
async function onPanelInteraction(interaction) {
  const actorId = interaction.user.id;
  if (!staff.assignableRoles(actorId).length) {
    return denyPanel(
      interaction,
      `Недостаточно прав. Ваш ранг: ${staff.describeRank(actorId)}: под вами никого нет.${notOwnerHint(actorId)}`,
    );
  }

  const kindOf = (ids) => Object.keys(ids).find((k) => ids[k] === interaction.customId);

  // Нажатия кнопок открывают окно ввода.
  if (interaction.isButton()) {
    const kind = kindOf(STAFF_BUTTONS);
    return kind ? interaction.showModal(staffModal(kind)) : undefined;
  }

  const kind = kindOf(STAFF_MODALS);
  const field = (id) => interaction.fields.getTextInputValue(id);
  const refreshPanel = () => {
    const panel = panelMessage(staff, actorId);
    return interaction.isFromMessage() ? interaction.update(panel) : replyHere(interaction, panel);
  };

  // «Убрать отчёт»: достаточно ссылки.
  if (kind === 'removeReport') {
    return replyHere(interaction, { content: removeReportFor(actorId, field('link')), allowedMentions: noPings });
  }

  // «Изменить отчёт»: карточка с текущими данными приходит в личные сообщения.
  if (kind === 'editReport') {
    const started = startEdit(actorId, field('link'));
    if (started.error) return denyPanel(interaction, started.error);
    return sendToActor(interaction, [started.card]);
  }

  const userId = parseUserId(field('user'));
  if (!userId) return denyPanel(interaction, badIdMessage(field('user')));

  switch (kind) {
    case 'add': {
      const role = roleByRank(Number(field('rank')));
      if (!role) return denyPanel(interaction, badRankMessage(field('rank'), STAFF_ROLES.length));
      if (role.rank >= staff.rankOf(actorId)) {
        return denyPanel(
          interaction,
          `Ранг ${roleTitle(role)} не ниже вашего (${staff.describeRank(actorId)}): ставить можно только на ранги ниже своего.${notOwnerHint(actorId)}`,
        );
      }
      if (!staff.canAssign(actorId, role.key, userId)) return denyPanel(interaction, whyNotLower(actorId, userId));
      staff.add(role.key, userId, field('name')); // если человек уже в списке, он переносится на этот ранг
      return refreshPanel();
    }
    case 'remove':
      if (!staff.has(userId)) return denyPanel(interaction, `<@${userId}> нет в списке: убирать некого.`);
      if (!staff.canEdit(actorId, userId)) return denyPanel(interaction, whyNotLower(actorId, userId));
      staff.remove(userId);
      return refreshPanel();
    case 'name':
      if (!staff.has(userId)) return denyPanel(interaction, `<@${userId}> нет в списке: имя можно менять только у добавленных.`);
      if (!staff.canEdit(actorId, userId)) return denyPanel(interaction, whyNotLower(actorId, userId));
      staff.setName(userId, field('name'));
      return refreshPanel();
    case 'addReport':
      if (!staff.outranks(actorId, userId)) return denyPanel(interaction, whyNotLower(actorId, userId));
      actingFor.set(actorId, userId);
      return replyHere(interaction, {
        content:
          `Записываю отчёты за <@${userId}>. Перешлите мне в личные сообщения отчёт, затем отправьте проверку по формату из /помощь. ` +
          'Режим сбросится после записи пары «отчёт + проверка» или через 30 минут.',
        allowedMentions: noPings,
      });
    case 'profile':
      return sendToActor(interaction, profileMessages({ stores: everyStore(), userId, period: 'month', name: staff.nameOf(userId) }));
    default:
      return undefined;
  }
}

/**
 * Ответ на кнопку панели, который приходит обычными сообщениями в личку: окно закрывается без ответа на него,
 * а если личка закрыта, показывается на месте и виден только вам.
 */
async function sendToActor(interaction, messages) {
  const payloads = messages.map((m) => ({ ...(typeof m === 'string' ? { content: m } : m), allowedMentions: noPings }));
  if (interaction.isFromMessage()) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    for (const payload of payloads) await interaction.user.send(payload);
  } catch {
    for (const payload of payloads) await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
    return undefined;
  }
  if (!interaction.isFromMessage()) await interaction.deleteReply().catch(() => {});
  return undefined;
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton() || interaction.isModalSubmit()) {
    const id = interaction.customId;
    const handler = isStaffInteractionId(id) ? onPanelInteraction : isConfirmId(id) ? onConfirmInteraction : null;
    handler?.(interaction).catch((err) => console.error('Ошибка панели:', err));
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const command = COMMANDS[interaction.commandName];
  if (!command) return;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // подтверждение команды скрытое; оно удаляется после отправки в личку
    const notRegistered = !command.open && !isUserAllowed(interaction.user.id);
    const messages = notRegistered ? [fail(unregisteredMessage(interaction.user.id))] : command.run(interaction.user.id, interaction);
    await deliver(interaction, messages);
  } catch (err) {
    console.error(`Ошибка команды /${interaction.commandName}:`, err);
    if (interaction.deferred) await deliver(interaction, [fail(`Ошибка: ${err.message}`)]).catch(() => {});
    else await interaction.reply({ content: `Ошибка: ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

/** Текст и «источник» сообщения: для пересылки — снимок исходного сообщения, иначе само сообщение. */
function readMessage(message) {
  const snapshot = message.messageSnapshots?.first() ?? null;
  const source = snapshot ?? message;
  return {
    snapshot,
    embedText: flattenEmbeds(source.embeds),
    text: [source.content, flattenEmbeds(source.embeds)].filter(Boolean).join('\n'),
  };
}

async function handleReport(message, report, { snapshot, text }) {
  const ref = snapshot
    ? { messageId: snapshot.id, link: messageLink(snapshot.guildId, snapshot.channelId, snapshot.id) }
    : findMessageLink(text);
  if (!ref?.messageId || ref.messageId === 'undefined') {
    return sayError(message, 'Это похоже на отчёт, но Discord не передал ссылку на исходное сообщение. Перешлите отчёт (Forward), а не копируйте.');
  }

  const { store, prefix } = workingStore(message.author.id);
  store.setReport(ref.messageId, { ...report, link: ref.link });
  const who = `${report.name} (ранг ${report.rank ?? '?'}, ${report.position ?? '?'})`;
  const verdict = store.verdict(ref.messageId);
  if (!verdict) return say(message, `${prefix}📄 Отчёт: ${who}, ${report.total ?? '?'} б. Жду проверку.`);
  return say(message, `${prefix}🔗 ${describe(store.entry(ref.messageId))}`);
}

/** Чей список пополняем: свой или (после «Добавить отчёт») список выбранного человека. ownerId — чей это список. */
function workingStore(actorId) {
  const targetId = actingFor.get(actorId);
  return targetId
    ? { store: storeFor(targetId), ownerId: targetId, prefix: `За <@${targetId}>: ` }
    : { store: storeFor(actorId), ownerId: actorId, prefix: '' };
}

const prefixFor = (actorId, ownerId) => (ownerId === actorId ? '' : `За <@${ownerId}>: `);

/** Уже сохранённые отчёты этого человека у всех проверяющих: нужны, чтобы сказать, пойдёт ли новый в премию. */
const othersOf = (userId, exceptMessageId) =>
  everyStore().flatMap(({ store }) => store.entries().filter((e) => e.verdict.userId === userId && e.messageId !== exceptMessageId));

/**
 * Проверка пришла: ничего не записываем, а показываем карточку с данными и кнопками
 * «Сохранить», «Изменить», «Отменить». Без найденного отчёта карточки нет: одна ссылка отчётом не становится.
 */
async function handleCheck(message, check, text) {
  const actorId = message.author.id;
  const { store, ownerId, prefix } = workingStore(actorId);

  // Одна ссылка — один отчёт (у человека отчётов может быть сколько угодно).
  const dup = findDuplicate(everyStore(), check.messageId);
  if (dup) return sayError(message, `${prefix}${duplicateMessage(dup)}`);

  // Ссылка в формах берётся из проверки. Но id пересланного отчёта не всегда совпадает с id из этой ссылки,
  // тогда отчёт ищем среди ещё не проверенных: по имени в нике, иначе единственный.
  let reportId = store.report(check.messageId) ? check.messageId : null;
  if (!reportId) reportId = matchPendingReport(store.pendingReports(), text)?.messageId ?? null;

  if (!reportId) {
    const waiting = store.pendingReports().map(({ report }) => report.name);
    const hint = waiting.length
      ? `Ждут проверки: ${waiting.join(', ')}, но в проверке нет имени, чтобы выбрать нужный. Отправьте проверку сразу после его отчёта.`
      : 'Сначала перешлите отчёт, потом отправьте проверку.';
    return sayError(message, `${prefix}Не нашёл отчёт для этой проверки, ничего не сохранил. ${hint}`);
  }

  const token = pendingChecks.add(actorId, { ownerId, reportId, check, report: store.report(reportId) });
  const { data } = pendingChecks.peek(token, actorId);
  return say(message, renderCard(token, data, actorId));
}

/** Запись проверки после «Сохранить». Возвращает { entry } или { error }. */
function commitCheck({ ownerId, reportId, check: rawCheck, report: rawReport, edits }) {
  const { check, report } = applyEdits({ check: rawCheck, report: rawReport }, edits);
  const dup = findDuplicate(everyStore(), check.messageId);
  if (dup) return { error: duplicateMessage(dup) };

  const store = storeFor(ownerId);
  if (!store.report(reportId)) return { error: 'Отчёт уже удалён. Отправьте отчёт и проверку заново.' };
  if (reportId !== check.messageId) store.moveReport(reportId, check.messageId);
  store.setReport(check.messageId, {
    ...store.report(check.messageId),
    name: report.name,
    rank: report.rank,
    position: report.position,
  });
  store.setVerdict(check.messageId, {
    userId: check.userId,
    rank: check.rank,
    position: check.position,
    accepted: check.accepted,
    points: check.points,
    minimum: check.minimum,
    reason: check.reason,
    link: check.link,
  });
  return { entry: store.entry(check.messageId) };
}

/** Кнопки и окно карточки подтверждения: «Сохранить», «Изменить», «Сменить статус» (правка отчёта), «Отменить». */
async function onConfirmInteraction(interaction) {
  const { action, token } = parseConfirmId(interaction.customId);
  const actorId = interaction.user.id;
  const stop = (text) => interaction.update({ content: text, embeds: [], components: [] });
  // Чужое нажатие ничего не меняет в карточке; устаревшая карточка заменяется текстом.
  const fail = (result) => (result.foreign ? replyHere(interaction, { content: result.error }) : stop(result.error));

  if (action === 'cancel') {
    const taken = pendingChecks.take(token, actorId);
    if (taken.error) return fail(taken);
    return stop(taken.data.mode === 'edit' ? 'Отменено. Отчёт не изменён.' : 'Отменено. Ничего не сохранено.');
  }

  if (action === 'edit') {
    const found = pendingChecks.peek(token, actorId);
    return found.error ? fail(found) : interaction.showModal(editModal(token, found.data));
  }

  if (action === 'status') {
    const found = pendingChecks.peek(token, actorId);
    if (found.error) return fail(found);
    const { check } = applyEdits(found.data, found.data.edits);
    const { data } = pendingChecks.edit(token, actorId, { accepted: !check.accepted });
    return interaction.update(renderCard(token, data, actorId));
  }

  if (action === 'editmodal') {
    const found = pendingChecks.peek(token, actorId);
    if (found.error) return fail(found);
    const has = (id) => interaction.fields.fields.has(id);
    const value = (id) => (has(id) ? interaction.fields.getTextInputValue(id) : undefined);
    const { check } = applyEdits(found.data, found.data.edits);
    const parsed = parseEditFields(
      {
        name: value('name'),
        points: value('points'),
        rank: value('rank'),
        position: value('position'),
        reason: value('reason'),
        user: value('user'),
      },
      check.accepted,
    );
    if (parsed.error) return replyHere(interaction, { content: parsed.error });
    const { data } = pendingChecks.edit(token, actorId, parsed.patch);
    return interaction.update(renderCard(token, data, actorId));
  }

  if (action === 'save') {
    const taken = pendingChecks.take(token, actorId);
    if (taken.error) return fail(taken);
    const editing = taken.data.mode === 'edit';
    const result = editing ? commitEdit(storeFor(taken.data.ownerId), taken.data) : commitCheck(taken.data);
    if (result.error) return stop(result.error);
    if (!editing && actingFor.get(actorId) === taken.data.ownerId) actingFor.clear(actorId); // режим «за другого» одноразовый
    return stop(`${prefixFor(actorId, taken.data.ownerId)}✅ ${editing ? 'Изменено' : 'Сохранено'}. ${describe(result.entry)}`);
  }
  return undefined;
}

/** Карточка подтверждения с учётом правок: чужие отчёты этого человека нужны, чтобы сказать, пойдёт ли отчёт в премию. */
function renderCard(token, data, actorId) {
  const { check } = applyEdits(data, data.edits);
  return confirmMessage(token, data, othersOf(check.userId, check.messageId), prefixFor(actorId, data.ownerId), isInstructor);
}

/**
 * Начало правки сохранённого отчёта по ссылке: находит его, проверяет права и возвращает карточку с текущими данными.
 * Возвращает { card } или { error }. Ничего не меняется, пока не нажато «Сохранить».
 */
function startEdit(actorId, linkText) {
  const found = findEditable({
    stores: everyStore(),
    actorId,
    linkText,
    outranks: (actor, checker) => staff.outranks(actor, checker),
  });
  if (found.error) return { error: found.error };

  const { checkerId, entry, messageId } = found;
  const data = {
    mode: 'edit',
    ownerId: checkerId,
    reportId: messageId,
    check: { ...entry.verdict, messageId },
    report: entry.report,
  };
  const token = pendingChecks.add(actorId, data);
  return { card: renderCard(token, pendingChecks.peek(token, actorId).data, actorId) };
}


function describe({ verdict, report }) {
  const name = report?.name ?? '???';
  if (!verdict.accepted) return `❌ ${name} — отказ: ${verdict.reason || '(причина не найдена)'}`;
  const points = entryPoints({ verdict, report });
  return `✅ ${name} — ${points ?? '?'} б. → ${bonusType(points) ?? 'нет типа премии'}`;
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !isAllowed(message.author.id, message.guildId, message.channelId)) return;
  try {
    await onMessage(message);
  } catch (err) {
    console.error('Ошибка обработки сообщения:', err);
    await sayError(message, `Ошибка: ${err.message}`).catch(() => {});
  }
});

async function onMessage(message) {
  const payload = readMessage(message);
  const report = parseReport(payload.embedText || payload.text);
  if (report) return handleReport(message, report, payload);

  const check = parseCheck(payload.text);
  if (check) return handleCheck(message, check, payload.text);

  console.log('Не распознано сообщение:', JSON.stringify(payload.text).slice(0, 500));
  const problem = diagnose(payload.text);
  if (problem?.problems.length) {
    const what = problem.kind === 'report' ? 'отчёт' : 'проверку';
    const list = problem.problems.map((p) => `- ${p}`).join('\n');
    return sayError(message, `Не могу принять ${what}, не хватает:\n${list}`);
  }
  return sayError(message, 'Не понял, что это. Жду пересланный отчёт или проверку (ссылка на отчёт, «id | ник ...», баллы или причина отказа). Команды: /памятка, /отчет, /общий-отчет, /статус, /очистить.');
}

process.on('unhandledRejection', (err) => console.error('Ошибка:', err));
client.login(DISCORD_TOKEN);
