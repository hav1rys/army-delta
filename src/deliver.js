// Куда бот отправляет ответы. Правило: всё уходит в личные сообщения тому, кто вызвал команду или написал боту,
// самостоятельными сообщениями (не ответами на команду) и не остаётся в канале, где это было сделано.
import { MessageFlags } from 'discord.js';

const noPings = { parse: [] };

/** Сообщение — строка или готовое содержимое ({ embeds, components }). */
const toPayload = (m) => ({ ...(typeof m === 'string' ? { content: m } : m), allowedMentions: noPings });

/** Пометка «это ошибка»: такое сообщение приходит ответом на команду, а не обычным сообщением в личку. */
export const fail = (text) => ({ error: text });
const isError = (m) => typeof m === 'object' && m !== null && 'error' in m;

/**
 * Доставка ответа слэш-команды.
 * - Обычные сообщения (формы, панель, список, статистика) приходят в личные сообщения самостоятельными сообщениями,
 *   не ответом на команду: команду бот подтверждает скрыто (deferReply с флагом Ephemeral), а после отправки
 *   удаляет это подтверждение, поэтому не остаётся ни строки «использует /команда», ни цепочки ответов.
 * - Ошибки (fail(...)) приходят ответом на команду, его видит только вызвавший. Если ошибок нет, ответа на команду нет.
 * Если личка закрыта, всё показывается на месте, и виден лишь вызвавшему.
 * Перед вызовом команда должна быть подтверждена: interaction.deferReply({ flags: MessageFlags.Ephemeral }).
 */
export async function deliver(interaction, messages) {
  const errors = messages.filter(isError).map((m) => toPayload(m.error));
  const payloads = messages.filter((m) => !isError(m)).map(toPayload);

  try {
    for (const payload of payloads) await interaction.user.send(payload);
  } catch {
    await interaction.editReply({
      content: 'Не удалось написать вам в личные сообщения (откройте личку с ботом), показываю здесь: видите только вы.',
    });
    for (const payload of [...payloads, ...errors]) await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
    return;
  }

  if (!errors.length) {
    await interaction.deleteReply().catch(() => {}); // скрытое подтверждение команды убираем
    return;
  }
  const [first, ...rest] = errors;
  await interaction.editReply(first); // ошибка — ответом на команду
  for (const payload of rest) await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
}

/**
 * Ответ на пересланное или написанное боту сообщение. В личке с ботом — обычным сообщением в том же чате
 * (без строки-цитаты сверху). Если сообщение пришло из канала сервера, ответ уходит только в личные сообщения
 * автору; при закрытой личке в канале остаётся одна короткая просьба открыть её, без данных.
 */
export async function say(message, content) {
  const payload = toPayload(content); // строка или готовое содержимое ({ embeds, components })
  if (message.guildId === null) return message.channel.send(payload);
  try {
    await message.author.send(payload);
  } catch {
    await message.reply({
      content: 'Не могу написать вам в личные сообщения. Откройте личку с ботом, и я отвечу там.',
      allowedMentions: { repliedUser: false },
    });
  }
}

/**
 * Ошибка при обработке сообщения. В личке с ботом — ответом на это сообщение (видно, какое именно не принято),
 * из канала сервера — только в личку автору, как и всё остальное.
 */
export async function sayError(message, text) {
  if (message.guildId !== null) return say(message, text);
  try {
    await message.reply({ ...toPayload(text), allowedMentions: { parse: [], repliedUser: false } });
  } catch {
    await say(message, text); // исходное сообщение уже удалено — обычным сообщением
  }
}
