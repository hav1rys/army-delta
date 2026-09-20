import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
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
import { memoMessages } from './memo.js';
import { Store } from './store.js';

const {
  DISCORD_TOKEN,
  ALLOWED_USER_IDS = '',
  CHANNEL_ID = '',
  DATA_DIR = './data',
} = process.env;
if (!DISCORD_TOKEN) {
  console.error('Не задана переменная окружения DISCORD_TOKEN');
  process.exit(1);
}

const allowedUsers = new Set(ALLOWED_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean));

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

const isUserAllowed = (userId) => allowedUsers.size === 0 || allowedUsers.has(userId);

/** Пересланные сообщения принимаем только в личке и (если задан) в одном канале, и только от разрешённых пользователей. */
function isAllowed(userId, guildId, channelId) {
  return isUserAllowed(userId) && (guildId === null || (CHANNEL_ID !== '' && channelId === CHANNEL_ID));
}

// Обычное сообщение в тот же чат, а не «ответ» на сообщение пользователя: без строки-цитаты сверху.
const say = (message, content) => message.channel.send({ content, allowedMentions: noPings });

// Слэш-команды. Каждая возвращает список сообщений для ответа.
const COMMANDS = {
  'отчет': {
    description: 'Три формы по отчётам, которые проверили вы',
    run(userId) {
      const entries = storeFor(userId).entries();
      return entries.length ? buildForms([{ checkerId: userId, entries }]) : ['Пока нет ни одной проверки.'];
    },
  },

  'общий-отчет': {
    description: 'Три формы по отчётам всех проверяющих',
    run() {
      const groups = allCheckerIds()
        .map((checkerId) => ({ checkerId, entries: storeFor(checkerId).entries() }))
        .filter((g) => g.entries.length);
      return groups.length ? buildForms(groups) : ['Пока нет ни одной проверки.'];
    },
  },

  'памятка': {
    description: 'Как пользоваться ботом: шаги и формат проверки',
    run: () => memoMessages(client.user?.username),
  },

  'статус': {
    description: 'Сколько принято/отказано и чего не хватает',
    run(userId) {
      const store = storeFor(userId);
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
    run(userId) {
      storeFor(userId).clear();
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
      contexts: [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel],
      // UserInstall: приложение ставится на аккаунт, и писать боту в личку можно без общего сервера.
      integrationTypes: [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall],
    })),
  );
  console.log(`Слэш-команды зарегистрированы: ${Object.keys(COMMANDS).map((n) => `/${n}`).join(', ')}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = COMMANDS[interaction.commandName];
  if (!command) return;
  if (!isUserAllowed(interaction.user.id)) {
    return interaction.reply({
      content: `Нет доступа: вашего ID (${interaction.user.id}) нет в ALLOWED_USER_IDS.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  // В личке с ботом и в канале CHANNEL_ID ответ обычный; в остальных серверных каналах его видит только вызвавший.
  const publicHere = !interaction.inGuild() || interaction.channelId === CHANNEL_ID;
  const flags = publicHere ? undefined : MessageFlags.Ephemeral;
  try {
    await interaction.deferReply({ flags });
    const [first, ...rest] = command.run(interaction.user.id);
    await interaction.editReply({ content: first, allowedMentions: noPings });

    // Остальные сообщения — обычными сообщениями друг за другом: follow-up'ы Discord показывает как ответы на предыдущее.
    let channel = publicHere ? (interaction.channel ?? (await interaction.user.createDM().catch(() => null))) : null;
    for (const content of rest) {
      if (channel) {
        try {
          await channel.send({ content, allowedMentions: noPings });
          continue;
        } catch {
          channel = null; // нет доступа к каналу — дальше follow-up'ами
        }
      }
      await interaction.followUp({ content, flags, allowedMentions: noPings });
    }
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

  const store = storeFor(message.author.id);
  store.setReport(ref.messageId, { ...report, link: ref.link });
  const who = `${report.name} (ранг ${report.rank ?? '?'}, ${report.position ?? '?'})`;
  const verdict = store.verdict(ref.messageId);
  if (!verdict) return say(message, `📄 Отчёт: ${who}, ${report.total ?? '?'} б. Жду проверку.`);
  return say(message, `🔗 ${describe(store.entry(ref.messageId))}`);
}

async function handleCheck(message, check, text) {
  const store = storeFor(message.author.id);

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
    return say(message, `Проверка сохранена, но отчёта для неё нет. ${hint}`);
  }
  return say(message, describe(entry));
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
