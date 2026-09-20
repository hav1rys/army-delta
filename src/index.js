import 'dotenv/config';
import {
  ApplicationIntegrationType,
  Client,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  Partials,
} from 'discord.js';
import { buildForms, entryPoints } from './forms.js';
import { bonusType, findMessageLink, flattenEmbeds, messageLink, parseCheck, parseReport } from './parsing.js';
import { Store } from './store.js';

const {
  DISCORD_TOKEN,
  ALLOWED_USER_IDS = '',
  CHANNEL_ID = '',
  DATA_FILE = './data/state.json',
} = process.env;
if (!DISCORD_TOKEN) {
  console.error('Не задана переменная окружения DISCORD_TOKEN');
  process.exit(1);
}

const allowedUsers = new Set(ALLOWED_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean));
const store = new Store(DATA_FILE);
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

/** Работаем только в личке и (если задан) в одном канале, и только для разрешённых пользователей. */
function isAllowed(userId, guildId, channelId) {
  if (allowedUsers.size && !allowedUsers.has(userId)) return false;
  return guildId === null || (CHANNEL_ID !== '' && channelId === CHANNEL_ID);
}

const reply = (message, content) => message.reply({ content, allowedMentions: { ...noPings, repliedUser: false } });

// Слэш-команды. Каждая возвращает список сообщений для ответа.
const COMMANDS = {
  'итог': {
    description: 'Собрать три формы из накопленных отчётов и проверок',
    run(userId) {
      const entries = store.entries();
      return entries.length ? buildForms(entries, userId) : ['Пока нет ни одной проверки.'];
    },
  },

  'статус': {
    description: 'Сколько принято/отказано и чего не хватает',
    run() {
      const entries = store.entries();
      const accepted = entries.filter((e) => e.verdict.accepted).length;
      const lines = [`Принято: ${accepted}, отказано: ${entries.length - accepted}`];
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
    run() {
      store.clear();
      return ['Всё очищено.'];
    },
  },
};

client.once(Events.ClientReady, async (c) => {
  console.log(`Бот запущен как ${c.user.tag}`);
  await c.application.commands.set(
    Object.entries(COMMANDS).map(([name, { description }]) => ({
      name,
      description,
      contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
      integrationTypes: [ApplicationIntegrationType.GuildInstall],
    })),
  );
  console.log(`Слэш-команды зарегистрированы: ${Object.keys(COMMANDS).map((n) => `/${n}`).join(', ')}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = COMMANDS[interaction.commandName];
  if (!command) return;
  if (!isAllowed(interaction.user.id, interaction.guildId, interaction.channelId)) {
    return interaction.reply({ content: 'Нет доступа.', flags: MessageFlags.Ephemeral });
  }
  try {
    await interaction.deferReply();
    const [first, ...rest] = command.run(interaction.user.id);
    await interaction.editReply({ content: first, allowedMentions: noPings });
    for (const content of rest) await interaction.followUp({ content, allowedMentions: noPings });
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
  if (!ref) return reply(message, 'Это похоже на отчёт, но нет ссылки на исходное сообщение. Перешлите отчёт (Forward), а не копируйте.');

  store.setReport(ref.messageId, { ...report, link: ref.link });
  const who = `${report.name} (ранг ${report.rank ?? '?'}, ${report.position ?? '?'})`;
  const verdict = store.verdict(ref.messageId);
  if (!verdict) return reply(message, `📄 Отчёт: ${who}, ${report.total ?? '?'} б. Жду проверку.`);
  return reply(message, `🔗 ${describe(store.entry(ref.messageId))}`);
}

function saveCheck(check) {
  store.setVerdict(check.messageId, {
    userId: check.userId,
    accepted: check.accepted,
    points: check.points,
    minimum: check.minimum,
    reason: check.reason,
    link: check.link,
  });
}

async function handleCheck(message, check) {
  saveCheck(check);
  const entry = store.entry(check.messageId);
  if (!entry.report) return reply(message, `Проверка сохранена, но отчёта нет — перешлите отчёт: ${check.link}`);
  return reply(message, describe(entry));
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
    await reply(message, `Ошибка: ${err.message}`).catch(() => {});
  }
});

async function onMessage(message) {
  const payload = readMessage(message);
  const report = parseReport(payload.embedText || payload.text);
  if (report) return handleReport(message, report, payload);

  const check = parseCheck(payload.text);
  if (check) return handleCheck(message, check);

  console.log('Не распознано сообщение:', JSON.stringify(payload.text).slice(0, 500));
  return reply(message, 'Не понял, что это. Жду пересланный отчёт или проверку (ссылка на отчёт, затем «id | ник ...»). Команды: /итог, /статус, /очистить.');
}

process.on('unhandledRejection', (err) => console.error('Ошибка:', err));
client.login(DISCORD_TOKEN);
