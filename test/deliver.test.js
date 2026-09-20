import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags } from 'discord.js';
import { deliver, fail, say, sayError } from '../src/deliver.js';

/** Подделка слэш-команды: записывает, что и куда отправлено. dmOpen — можно ли написать пользователю в личку. */
function fakeInteraction({ inGuild, dmOpen = true }) {
  const calls = { dm: [], channel: [], editReply: [], followUp: [], deleteReply: 0 };
  return {
    calls,
    inGuild: () => inGuild,
    user: {
      send: async (payload) => {
        if (!dmOpen) throw new Error('Cannot send messages to this user');
        calls.dm.push(payload);
      },
      createDM: async () => ({ send: async (payload) => calls.channel.push(payload) }),
    },
    channel: { send: async (payload) => calls.channel.push(payload) },
    editReply: async (payload) => calls.editReply.push(payload),
    followUp: async (payload) => calls.followUp.push(payload),
    deleteReply: async () => {
      calls.deleteReply += 1;
    },
  };
}

test('команда на сервере: всё уходит в личку, в канале ничего не остаётся', async () => {
  const i = fakeInteraction({ inGuild: true });
  await deliver(i, ['первое', 'второе', { embeds: ['эмбед'], components: [] }]);

  assert.equal(i.calls.dm.length, 3);
  assert.equal(i.calls.dm[0].content, 'первое');
  assert.deepEqual(i.calls.dm[2].embeds, ['эмбед']); // и панели с эмбедом тоже
  assert.deepEqual(i.calls.channel, []); // в канал ничего
  assert.deepEqual(i.calls.editReply, []); // и ответа-пометки нет
  assert.deepEqual(i.calls.followUp, []);
  assert.equal(i.calls.deleteReply, 1); // ответ на команду удалён
});

test('команда на сервере: упоминания в личке не пингуют', async () => {
  const i = fakeInteraction({ inGuild: true });
  await deliver(i, ['<@123456789012345678>']);
  assert.deepEqual(i.calls.dm[0].allowedMentions, { parse: [] });
});

test('команда на сервере при закрытой личке: показано на месте, но только вызвавшему', async () => {
  const i = fakeInteraction({ inGuild: true, dmOpen: false });
  await deliver(i, ['первое', 'второе']);

  assert.deepEqual(i.calls.dm, []);
  assert.match(i.calls.editReply[0].content, /откройте личку/);
  assert.equal(i.calls.followUp.length, 2);
  assert.ok(i.calls.followUp.every((p) => p.flags === MessageFlags.Ephemeral)); // видно только ему
  assert.equal(i.calls.deleteReply, 0);
});

test('команда в личке с ботом: всё самостоятельными сообщениями, не ответом на команду', async () => {
  const i = fakeInteraction({ inGuild: false });
  await deliver(i, ['первое', 'второе', 'третье']);

  assert.deepEqual(i.calls.dm.map((p) => p.content), ['первое', 'второе', 'третье']); // все три — обычные сообщения
  assert.deepEqual(i.calls.editReply, []); // на саму команду ничего не отвечено
  assert.deepEqual(i.calls.followUp, []); // и цепочки ответов нет
  assert.deepEqual(i.calls.channel, []);
  assert.equal(i.calls.deleteReply, 1); // скрытое подтверждение команды убрано, строки «использует /…» не остаётся
});

test('команда в личке при сбое отправки: показано на месте, только вызвавшему', async () => {
  const i = fakeInteraction({ inGuild: false, dmOpen: false });
  await deliver(i, ['первое']);
  assert.deepEqual(i.calls.dm, []);
  assert.equal(i.calls.followUp.length, 1);
  assert.equal(i.calls.followUp[0].flags, MessageFlags.Ephemeral);
  assert.equal(i.calls.deleteReply, 0);
});

test('ошибка приходит ответом на команду, остальное обычными сообщениями в личку', async () => {
  for (const inGuild of [true, false]) {
    const i = fakeInteraction({ inGuild });
    await deliver(i, ['формы', fail('Нет доступа: …'), 'ещё']);

    assert.deepEqual(i.calls.dm.map((p) => p.content), ['формы', 'ещё']); // обычные — в личку, без ошибки
    assert.equal(i.calls.editReply.length, 1); // ошибка — ответом на команду
    assert.equal(i.calls.editReply[0].content, 'Нет доступа: …');
    assert.equal(i.calls.deleteReply, 0); // ответ не удаляется, он и есть ошибка
    assert.deepEqual(i.calls.followUp, []);
  }
});

test('только ошибка: в личку ничего не идёт, ответ на команду — эта ошибка', async () => {
  const i = fakeInteraction({ inGuild: false });
  await deliver(i, [fail('Не похоже на ID')]);
  assert.deepEqual(i.calls.dm, []);
  assert.equal(i.calls.editReply[0].content, 'Не похоже на ID');
  assert.equal(i.calls.deleteReply, 0);
});

test('несколько ошибок: первая ответом на команду, остальные скрытыми дополнениями', async () => {
  const i = fakeInteraction({ inGuild: true });
  await deliver(i, [fail('первая'), fail('вторая')]);
  assert.equal(i.calls.editReply[0].content, 'первая');
  assert.equal(i.calls.followUp.length, 1);
  assert.equal(i.calls.followUp[0].content, 'вторая');
  assert.equal(i.calls.followUp[0].flags, MessageFlags.Ephemeral);
});

test('без ошибок ответа на команду нет: подтверждение удалено', async () => {
  const i = fakeInteraction({ inGuild: true });
  await deliver(i, ['только формы']);
  assert.deepEqual(i.calls.editReply, []);
  assert.equal(i.calls.deleteReply, 1);
});

test('личка закрыта: и обычные сообщения, и ошибки показаны на месте, только вам', async () => {
  const i = fakeInteraction({ inGuild: true, dmOpen: false });
  await deliver(i, ['формы', fail('ошибка')]);
  assert.deepEqual(i.calls.dm, []);
  assert.deepEqual(i.calls.followUp.map((p) => p.content), ['формы', 'ошибка']);
  assert.ok(i.calls.followUp.every((p) => p.flags === MessageFlags.Ephemeral));
});

/** Подделка сообщения, написанного боту: в личке (guildId null) или в канале сервера. */
function fakeMessage({ guildId, dmOpen = true }) {
  const calls = { channel: [], dm: [], reply: [] };
  return {
    calls,
    guildId,
    channel: { send: async (payload) => calls.channel.push(payload) },
    author: {
      send: async (payload) => {
        if (!dmOpen) throw new Error('Cannot send messages to this user');
        calls.dm.push(payload);
      },
    },
    reply: async (payload) => calls.reply.push(payload),
  };
}

test('ответ на сообщение в личке: обычным сообщением в том же чате', async () => {
  const m = fakeMessage({ guildId: null });
  await say(m, 'Отчёт принят');
  assert.deepEqual(m.calls.channel.map((p) => p.content), ['Отчёт принят']);
  assert.deepEqual(m.calls.dm, []);
});

test('ответ на сообщение из канала сервера: только в личку автору, канал пуст', async () => {
  const m = fakeMessage({ guildId: '713076174108229712' });
  await say(m, 'Отчёт принят');
  assert.deepEqual(m.calls.dm.map((p) => p.content), ['Отчёт принят']);
  assert.deepEqual(m.calls.channel, []);
  assert.deepEqual(m.calls.reply, []);
});

test('ответ на сообщение из канала при закрытой личке: в канале только просьба, без данных', async () => {
  const m = fakeMessage({ guildId: '713076174108229712', dmOpen: false });
  await say(m, 'Отчёт: Li Il, 185 б.');
  assert.deepEqual(m.calls.channel, []);
  assert.equal(m.calls.reply.length, 1);
  assert.match(m.calls.reply[0].content, /личные сообщения/);
  assert.doesNotMatch(m.calls.reply[0].content, /Li Il|185/); // данные в канал не попали
});

test('ошибка при обработке сообщения в личке: ответом на само сообщение', async () => {
  const m = fakeMessage({ guildId: null });
  await sayError(m, 'Не нашёл отчёт');
  assert.equal(m.calls.reply.length, 1);
  assert.equal(m.calls.reply[0].content, 'Не нашёл отчёт');
  assert.equal(m.calls.reply[0].allowedMentions.repliedUser, false); // без пинга
  assert.deepEqual(m.calls.channel, []);
});

test('ошибка при обработке сообщения из канала сервера: только в личку, в канале ничего', async () => {
  const m = fakeMessage({ guildId: '713076174108229712' });
  await sayError(m, 'Не нашёл отчёт');
  assert.deepEqual(m.calls.dm.map((p) => p.content), ['Не нашёл отчёт']);
  assert.deepEqual(m.calls.reply, []);
  assert.deepEqual(m.calls.channel, []);
});

test('ошибка при обработке сообщения: если исходное удалено, придёт обычным сообщением', async () => {
  const m = fakeMessage({ guildId: null });
  m.reply = async () => {
    throw new Error('Unknown Message');
  };
  await sayError(m, 'Не нашёл отчёт');
  assert.deepEqual(m.calls.channel.map((p) => p.content), ['Не нашёл отчёт']);
});
