// Ручное добавление и удаление отчётов (слэш-команды). Работает с хранилищем, Discord не нужен.
import { findMessageLink } from './parsing.js';

/** ID человека: число (17–20 цифр) или упоминание вида <@id>. */
export const parseUserId = (text) => /\d{17,20}/.exec(text ?? '')?.[0] ?? null;

const shorten = (text) => {
  const t = (text ?? '').trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t || 'пусто';
};

/** Ошибка про ID с тем, что реально ввели: обычно вместо числа там @имя, а в окнах ввода оно не работает. */
export const badIdMessage = (input) =>
  `Не похоже на ID: получил «${shorten(input)}». Нужно число из 17–20 цифр (правый клик по профилю → «Копировать ID пользователя»). ` +
  '@имя в окне не работает.';

/** Ошибка про ранг: цифра из списка, и что ввели. */
export const badRankMessage = (input, maxRank) =>
  `Ранг — цифра от 1 до ${maxRank} (в скобках перед названием ранга). Получил «${shorten(input)}».`;

function checkCommon({ id, link }) {
  const userId = parseUserId(id);
  if (!userId) return { error: badIdMessage(id) };
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

/**
 * Удаляет отчёт по ссылке у тех, чьи отчёты можно трогать: canRemove(checkerId).
 * Возвращает { removed: [{ checkerId, name }], denied: [checkerId] } (denied — отчёт нашёлся, но трогать его нельзя)
 * или { error }, если это не ссылка на сообщение Discord.
 */
export function removeByLinkAllowed(stores, linkText, canRemove) {
  const ref = findMessageLink(linkText);
  if (!ref) return { error: 'Не похоже на ссылку на отчёт: нужна ссылка на сообщение Discord.' };

  const removed = [];
  const denied = [];
  for (const { checkerId, store } of stores) {
    if (!store.report(ref.messageId) && !store.verdict(ref.messageId)) continue;
    if (canRemove(checkerId)) {
      removed.push({ checkerId, name: store.report(ref.messageId)?.name ?? null });
      store.remove(ref.messageId);
    } else {
      denied.push(checkerId);
    }
  }
  return { removed, denied };
}
