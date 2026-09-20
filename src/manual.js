// Ручное добавление и удаление отчётов (слэш-команды). Работает с хранилищем, Discord не нужен.
import { findMessageLink } from './parsing.js';

/** ID человека: число (17–20 цифр) или упоминание вида <@id>. */
export const parseUserId = (text) => /\d{17,20}/.exec(text ?? '')?.[0] ?? null;

function checkCommon({ id, link }) {
  const userId = parseUserId(id);
  if (!userId) return { error: 'Не похоже на ID человека: нужно число из 17–20 цифр (или упоминание).' };
  const ref = findMessageLink(link);
  if (!ref) return { error: 'Не похоже на ссылку на отчёт: нужна ссылка на сообщение Discord.' };
  return { userId, ref };
}

/**
 * Один человек (Discord ID) — один отчёт: ищет у любого проверяющего другой отчёт на того же человека.
 * stores: [{ checkerId, store }]. Тот же самый отчёт (та же ссылка) не считается, его можно перезаписать.
 */
export function findDuplicate(stores, userId, messageId) {
  for (const { checkerId, store } of stores) {
    const entry = store.entries().find((e) => e.verdict.userId === userId && e.messageId !== messageId);
    if (entry) return { checkerId, entry };
  }
  return null;
}

export function duplicateMessage(userId, { checkerId, entry }) {
  const by = checkerId ? ` (проверил <@${checkerId}>)` : '';
  return `Ошибка: на <@${userId}> уже есть отчёт: ${entry.verdict.link}${by}. Один человек — один отчёт; сначала удалите старый через /удалить-отчет.`;
}

/** Общая проверка полей и дубля. Возвращает { error } или { userId, ref }. */
function checkNew(input, stores) {
  const c = checkCommon(input);
  if (c.error) return c;
  const dup = findDuplicate(stores, c.userId, c.ref.messageId);
  return dup ? { error: duplicateMessage(c.userId, dup) } : c;
}

/** Добавляет (или заменяет) принятый отчёт. Возвращает { entry } или { error }. */
export function addAccepted(store, { id, name, link, points, rank, position }, stores = [{ checkerId: '', store }]) {
  const c = checkNew({ id, link }, stores);
  if (c.error) return c;
  const person = { rank: String(rank), position: position.trim() };
  store.setReport(c.ref.messageId, { name: name.trim(), ...person, total: points, link: c.ref.link });
  store.setVerdict(c.ref.messageId, {
    userId: c.userId,
    ...person,
    accepted: true,
    points,
    minimum: null,
    reason: null,
    link: c.ref.link,
  });
  return { entry: store.entry(c.ref.messageId) };
}

/** Добавляет (или заменяет) отказанный отчёт. Возвращает { entry } или { error }. */
export function addRejected(store, { id, name, link, reason }, stores = [{ checkerId: '', store }]) {
  const c = checkNew({ id, link }, stores);
  if (c.error) return c;
  store.setReport(c.ref.messageId, { name: name.trim(), rank: null, position: null, total: null, link: c.ref.link });
  store.setVerdict(c.ref.messageId, {
    userId: c.userId,
    rank: null,
    position: null,
    accepted: false,
    points: null,
    minimum: null,
    reason: reason.trim(),
    link: c.ref.link,
  });
  return { entry: store.entry(c.ref.messageId) };
}

/**
 * Удаляет отчёт (принятый или отказанный) по ссылке из одного хранилища.
 * Возвращает { removed: true, name } / { removed: false } или { error }, если это не ссылка на сообщение Discord.
 */
export function removeByLink(store, linkText) {
  const ref = findMessageLink(linkText);
  if (!ref) return { error: 'Не похоже на ссылку на отчёт: нужна ссылка на сообщение Discord.' };

  const name = store.report(ref.messageId)?.name ?? null;
  return store.remove(ref.messageId) ? { removed: true, name } : { removed: false };
}
