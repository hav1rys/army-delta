// Куда бот отправляет ответы. Правило: всё уходит в личные сообщения тому, кто вызвал команду или написал боту,
// и не остаётся в канале, где это было сделано.
import { MessageFlags } from 'discord.js';

const noPings = { parse: [] };

/** Сообщение — строка или готовое содержимое ({ embeds, components }). */
const toPayload = (m) => ({ ...(typeof m === 'string' ? { content: m } : m), allowedMentions: noPings });

/**
 * Доставка ответа слэш-команды.
 * - В личке с ботом: первое сообщение — ответ на команду, остальные обычными сообщениями друг за другом
 *   (follow-up'ы Discord показывает как ответы на предыдущее).
 * - На сервере: сообщения уходят в личку, а ответ на команду в канале удаляется, там не остаётся ничего.
 *   Только если личка закрыта, ответ показывается на месте и виден лишь вызвавшему.
 * Перед вызовом команда должна быть подтверждена через deferReply.
 */
export async function deliver(interaction, messages) {
  const payloads = messages.map(toPayload);

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
  } catch {
    await interaction.editReply({
      content: 'Не удалось написать вам в личные сообщения (откройте личку с ботом), показываю здесь: видите только вы.',
    });
    for (const payload of payloads) await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deleteReply().catch(() => {}); // в канале не остаётся ничего
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
