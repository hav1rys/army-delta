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
import { buildForms, entryPoints } from './forms.js';
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
import { addAccepted, addRejected, duplicateMessage, findDuplicate, parseUserId, removeByLink } from './manual.js';
import { ActingFor } from './acting.js';
import { leadershipMessage, memoMessages, unregisteredMessage } from './memo.js';
import {
  INSTRUCTOR_BUTTONS,
  INSTRUCTOR_MODALS,
  NAME_BUTTON_ID,
  NAME_MODAL_ID,
  Staff,
  addModal,
  addRoleKey,
  instructorModal,
  instructorPanelMessage,
  isInstructorInteractionId,
  isStaffInteractionId,
  modalRoleKey,
  nameModal,
  panelMessage,
  roleByKey,
} from './staff.js';
import { statsMessages } from './stats.js';
import { Store } from './store.js';

const {
  DISCORD_TOKEN,
  ALLOWED_USER_IDS = '',
  OWNER_USER_ID = '',
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

const isOwner = (userId) => staff.isOwner(userId);
/** Руководство: владелец и все уровни выше инструктора. */
const isManager = (userId) => isOwner(userId) || staff.isManager(userId);
const isStaff = (userId) => isOwner(userId) || staff.has(userId);

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

/** Хранилища всех проверяющих — для проверки «один человек — один отчёт» и общих команд. */
const everyStore = () => allCheckerIds().map((checkerId) => ({ checkerId, store: storeFor(checkerId) }));

/** Пересланные сообщения принимаем только в личке и (если задан) в одном канале, и только от разрешённых пользователей. */
function isAllowed(userId, guildId, channelId) {
  return isUserAllowed(userId) && (guildId === null || (CHANNEL_ID !== '' && channelId === CHANNEL_ID));
}

// Обычное сообщение в тот же чат, а не «ответ» на сообщение пользователя: без строки-цитаты сверху.
const say = (message, content) => message.channel.send({ content, allowedMentions: noPings });

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
const forOption = textOption('проверяющий', 'Только старший состав: записать за инструктора (ID). Пусто: на вас', false);

/** Чей список пополняем: свой или (за другого) список инструктора; за других могут только старший состав и владелец. */
function targetStore(userId, i) {
  const forWho = i.options.getString('проверяющий');
  if (!forWho) return { store: storeFor(userId) };
  if (!staff.canManageInstructors(userId)) {
    return { error: 'Записывать отчёты за других может только старший состав. Инструктор записывает свои.' };
  }
  const id = parseUserId(forWho);
  if (!id) return { error: 'Не похоже на ID инструктора: нужно число из 17–20 цифр (или упоминание).' };
  if (!staff.isInstructor(id)) return { error: `<@${id}> нет в списке инструкторов: сначала добавьте его через /инструктор.` };
  return { store: storeFor(id) };
}

const managersOnly = (text) => `Нет доступа: ${text} для руководства (уровни выше инструктора).`;

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
      if (target.error) return [target.error];
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
      return [result.error ?? `Добавлено: ${describe(result.entry)}`];
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
      if (target.error) return [target.error];
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
      return [result.error ?? `Добавлено: ${describe(result.entry)}`];
    },
  },

  'удалить-отчет': {
    description: 'Удалить отчёт (принятый или отказанный) по ссылке',
    options: [textOption('ссылка', 'Ссылка на отчёт')],
    run(userId, i) {
      const link = i.options.getString('ссылка', true);
      // Руководство удаляет у любого проверяющего, остальные — только свои.
      const stores = isManager(userId) ? everyStore() : [{ checkerId: userId, store: storeFor(userId) }];
      const removed = [];
      for (const { checkerId, store } of stores) {
        const result = removeByLink(store, link);
        if (result.error) return [result.error];
        if (result.removed) removed.push(`${result.name ?? 'без имени'} (проверил <@${checkerId}>)`);
      }
      return [removed.length ? `Удалено: ${removed.join(', ')}` : 'Такого отчёта не найдено.'];
    },
  },

  'отчет': {
    description: 'Три формы по отчётам, которые проверили вы',
    run(userId) {
      const entries = storeFor(userId).entries();
      return entries.length ? buildForms([{ checkerId: userId, entries }]) : ['Пока нет ни одной проверки.'];
    },
  },

  'общий-отчет': {
    description: 'Отчёты всех проверяющих (для руководства)',
    run(userId) {
      if (!isManager(userId)) return [managersOnly('общий отчёт доступен')];
      const groups = allCheckerIds()
        .map((checkerId) => ({ checkerId, entries: storeFor(checkerId).entries() }))
        .filter((g) => g.entries.length);
      // Обычным текстом, а не блоками кода: упоминания видны именами, читать удобнее.
      return groups.length ? buildForms(groups, (text) => text) : ['Пока нет ни одной проверки.'];
    },
  },

  'статистика': {
    description: 'Кто из проверяющих сколько отчётов сделал (для руководства)',
    run(userId) {
      if (!isManager(userId)) return [managersOnly('статистика доступна')];
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
    description: 'Старший состав: добавить человека выше инструктора и изменить имя',
    run(userId) {
      if (!staff.assignableSeniorRoles(userId).length) {
        return [
          OWNER_USER_ID
            ? 'Нет доступа: старший состав добавляют владелец и уровни выше заместителя начальника отдела.'
            : 'Не задана переменная OWNER_USER_ID.',
        ];
      }
      return [panelMessage(staff, userId)];
    },
  },

  'инструктор': {
    description: 'Инструкторы: добавить, убрать, добавить или убрать отчёт',
    run(userId) {
      if (!staff.canManageInstructors(userId)) {
        return [
          OWNER_USER_ID
            ? 'Нет доступа: инструкторов ведёт старший состав.'
            : 'Не задана переменная OWNER_USER_ID.',
        ];
      }
      return [instructorPanelMessage(staff)];
    },
  },

  'помощь': {
    description: 'Как пользоваться ботом (зависит от вашего уровня)',
    open: true, // отвечает и тем, кого нет в системе
    run(userId) {
      if (!isUserAllowed(userId)) return [unregisteredMessage(userId)];
      const messages = memoMessages(client.user?.username);
      const addable = staff.assignableSeniorRoles(userId).map((r) => r.label);
      const canInstructors = staff.canManageInstructors(userId);
      const canReports = isManager(userId);
      if (addable.length || canInstructors || canReports) {
        const level = isOwner(userId) ? 'Владелец' : staff.rolesOf(userId) || 'Ваш уровень';
        messages.push(leadershipMessage({ level, addable, canInstructors, canReports }));
      }
      return messages;
    },
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
  console.log(`Бот запущен как ${c.user.tag}`);
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
const NOT_LOWER = 'Недостаточно прав: добавлять и менять можно только тех, кто ниже вас по уровню.';

const NOT_MANAGER = 'Недостаточно прав: инструкторов ведёт старший состав.';
const replyHere = (interaction, payload) =>
  interaction.reply({ ...payload, flags: interaction.inGuild() ? MessageFlags.Ephemeral : undefined });

/** Кнопки и окна панели /инструктор. Права проверяются при каждом действии. */
async function onInstructorInteraction(interaction) {
  const actorId = interaction.user.id;
  if (!staff.canManageInstructors(actorId)) return denyPanel(interaction, NOT_MANAGER);

  const kindOf = (ids) => Object.keys(ids).find((k) => ids[k] === interaction.customId);

  // Нажатия кнопок открывают окно ввода.
  if (interaction.isButton()) {
    const kind = kindOf(INSTRUCTOR_BUTTONS);
    return kind ? interaction.showModal(instructorModal(kind)) : undefined;
  }

  const kind = kindOf(INSTRUCTOR_MODALS);
  const refreshPanel = () => {
    const panel = instructorPanelMessage(staff);
    return interaction.isFromMessage() ? interaction.update(panel) : replyHere(interaction, panel);
  };

  // «Убрать отчёт инструктору»: достаточно ссылки на отчёт.
  if (kind === 'removeReport') {
    const link = interaction.fields.getTextInputValue('link');
    const removed = [];
    for (const { checkerId, store } of everyStore()) {
      const result = removeByLink(store, link);
      if (result.error) return denyPanel(interaction, result.error);
      if (result.removed) removed.push(`${result.name ?? 'без имени'} (инструктор <@${checkerId}>)`);
    }
    return replyHere(interaction, {
      content: removed.length ? `Удалено: ${removed.join(', ')}` : 'Такого отчёта не найдено.',
      allowedMentions: noPings,
    });
  }

  const userId = parseUserId(interaction.fields.getTextInputValue('user'));
  if (!userId) return denyPanel(interaction, 'Не похоже на ID инструктора: нужно число из 17–20 цифр (или упоминание).');

  switch (kind) {
    case 'add':
      if (!staff.canAssign(actorId, 'instructor', userId)) return denyPanel(interaction, NOT_LOWER);
      staff.add('instructor', userId, interaction.fields.getTextInputValue('name'));
      return refreshPanel();
    case 'remove':
      if (!staff.removeInstructor(userId)) return denyPanel(interaction, `<@${userId}> нет в списке инструкторов.`);
      return refreshPanel();
    case 'addReport':
      if (!staff.isInstructor(userId)) {
        return denyPanel(interaction, `<@${userId}> нет в списке инструкторов: сначала добавьте его.`);
      }
      actingFor.set(actorId, userId);
      return replyHere(interaction, {
        content:
          `Записываю отчёты за <@${userId}>. Перешлите мне в личные сообщения отчёт, затем отправьте проверку по формату из /помощь. ` +
          'Режим сбросится после записи пары «отчёт + проверка» или через 30 минут.',
        allowedMentions: noPings,
      });
    default:
      return undefined;
  }
}

/** Кнопки и окна панели /старший-состав. Права проверяются при каждом действии, а не только при открытии. */
async function onPanelInteraction(interaction) {
  const actorId = interaction.user.id;
  if (!staff.assignableSeniorRoles(actorId).length) return denyPanel(interaction, NOT_LOWER);

  // Нажатия кнопок открывают окно ввода.
  if (interaction.isButton()) {
    if (interaction.customId === NAME_BUTTON_ID) return interaction.showModal(nameModal());
    const role = roleByKey(addRoleKey(interaction.customId));
    if (!role || !staff.assignableSeniorRoles(actorId).some((r) => r.key === role.key)) return denyPanel(interaction, NOT_LOWER);
    return interaction.showModal(addModal(role));
  }

  // Отправка окна ввода.
  const userId = parseUserId(interaction.fields.getTextInputValue('user'));
  if (!userId) {
    return denyPanel(interaction, 'Не похоже на ID человека: нужно число из 17–20 цифр (или упоминание).');
  }
  const name = interaction.fields.getTextInputValue('name');

  if (interaction.customId === NAME_MODAL_ID) {
    if (!staff.canEdit(actorId, userId)) return denyPanel(interaction, NOT_LOWER);
    staff.setName(userId, name);
  } else {
    const role = roleByKey(modalRoleKey(interaction.customId));
    if (!role || !staff.canAssign(actorId, role.key, userId)) return denyPanel(interaction, NOT_LOWER);
    staff.add(role.key, userId, name);
  }

  const panel = panelMessage(staff, actorId);
  return interaction.isFromMessage() ? interaction.update(panel) : interaction.reply({ ...panel, flags: MessageFlags.Ephemeral });
}

/**
 * Доставка ответа команды. Сообщение — строка или готовое содержимое ({ embeds, components }).
 * В личке с ботом: первое сообщение — ответ на команду, остальные обычными сообщениями друг за другом
 * (follow-up'ы Discord показывает как ответы на предыдущее).
 * На сервере: всё уходит вам в личные сообщения, а в канале виден только короткий ответ, который видите лишь вы.
 */
async function deliver(interaction, messages) {
  const payloads = messages.map((m) => ({ ...(typeof m === 'string' ? { content: m } : m), allowedMentions: noPings }));

  if (!interaction.inGuild()) {
    const [first, ...rest] = payloads;
    await interaction.editReply(first);
    let channel = interaction.channel ?? (await interaction.user.createDM().catch(() => null));
    for (const payload of rest) {
      if (channel) {
        try {
          await channel.send(payload);
          continue;
        } catch {
          channel = null; // нет доступа к чату — дальше follow-up'ами
        }
      }
      await interaction.followUp(payload);
    }
    return;
  }

  try {
    for (const payload of payloads) await interaction.user.send(payload);
    await interaction.editReply({ content: 'Отправил вам в личные сообщения.' });
  } catch {
    // Личка закрыта: показываем здесь, но только вам.
    await interaction.editReply({ content: 'Не удалось написать вам в личные сообщения, показываю здесь (видите только вы).' });
    for (const payload of payloads) await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton() || interaction.isModalSubmit()) {
    const handler = isStaffInteractionId(interaction.customId)
      ? onPanelInteraction
      : isInstructorInteractionId(interaction.customId)
        ? onInstructorInteraction
        : null;
    handler?.(interaction).catch((err) => console.error('Ошибка панели:', err));
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const command = COMMANDS[interaction.commandName];
  if (!command) return;
  if (!command.open && !isUserAllowed(interaction.user.id)) {
    return interaction.reply({ content: unregisteredMessage(interaction.user.id), flags: MessageFlags.Ephemeral });
  }
  try {
    await interaction.deferReply({ flags: interaction.inGuild() ? MessageFlags.Ephemeral : undefined });
    await deliver(interaction, command.run(interaction.user.id, interaction));
  } catch (err) {
    console.error(`Ошибка команды /${interaction.commandName}:`, err);
    const content = `Ошибка: ${err.message}`;
    await (interaction.deferred ? interaction.editReply(content) : interaction.reply({ content, flags: MessageFlags.Ephemeral })).catch(() => {});
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
    return say(message, 'Это похоже на отчёт, но Discord не передал ссылку на исходное сообщение. Перешлите отчёт (Forward), а не копируйте.');
  }

  const { store, prefix } = workingStore(message.author.id);
  store.setReport(ref.messageId, { ...report, link: ref.link });
  const who = `${report.name} (ранг ${report.rank ?? '?'}, ${report.position ?? '?'})`;
  const verdict = store.verdict(ref.messageId);
  if (!verdict) return say(message, `${prefix}📄 Отчёт: ${who}, ${report.total ?? '?'} б. Жду проверку.`);
  return say(message, `${prefix}🔗 ${describe(store.entry(ref.messageId))}`);
}

/** Чей список пополняем: свой или (после «Добавить отчёт инструктору») список выбранного инструктора. */
function workingStore(actorId) {
  const targetId = actingFor.get(actorId);
  return targetId ? { store: storeFor(targetId), prefix: `За <@${targetId}>: ` } : { store: storeFor(actorId), prefix: '' };
}

async function handleCheck(message, check, text) {
  const { store, prefix } = workingStore(message.author.id);

  // Один человек — один отчёт.
  const dup = findDuplicate(everyStore(), check.userId, check.messageId);
  if (dup) return say(message, `${prefix}${duplicateMessage(check.userId, dup)}`);

  // Ссылка в формах берётся из проверки. Но id пересланного отчёта не всегда совпадает с id из этой ссылки,
  // тогда отчёт ищем среди ещё не проверенных: по имени в нике, иначе единственный.
  if (!store.report(check.messageId)) {
    const match = matchPendingReport(store.pendingReports(), text);
    if (match) {
      console.log(`Отчёт привязан к проверке без совпадения id: ${match.messageId} → ${check.messageId}`);
      store.moveReport(match.messageId, check.messageId);
    }
  }

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
  const entry = store.entry(check.messageId);
  if (!entry.report) {
    const waiting = store.pendingReports().map(({ report }) => report.name);
    const hint = waiting.length
      ? `Ждут проверки: ${waiting.join(', ')}, но в проверке нет имени, чтобы выбрать нужный. Отправьте проверку сразу после его отчёта.`
      : 'Сначала перешлите отчёт, потом отправьте проверку.';
    return say(message, `${prefix}Проверка сохранена, но отчёта для неё нет. ${hint}`);
  }
  actingFor.clear(message.author.id); // пара «отчёт + проверка» записана: режим «за инструктора» одноразовый
  return say(message, `${prefix}${describe(entry)}`);
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
    await say(message, `Ошибка: ${err.message}`).catch(() => {});
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
    return say(message, `Не могу принять ${what}, не хватает:\n${list}`);
  }
  return say(message, 'Не понял, что это. Жду пересланный отчёт или проверку (ссылка на отчёт, «id | ник ...», баллы или причина отказа). Команды: /памятка, /отчет, /общий-отчет, /статус, /очистить.');
}

process.on('unhandledRejection', (err) => console.error('Ошибка:', err));
client.login(DISCORD_TOKEN);
