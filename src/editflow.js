// Правка уже сохранённого отчёта: найти по ссылке, проверить права, записать изменения.
import { applyEdits } from './confirm.js';
import { findDuplicate } from './manual.js';
import { findMessageLink } from './parsing.js';

/**
 * Находит отчёт по ссылке у любого проверяющего и проверяет, можно ли его менять:
 * свои и тех, кто ниже по рангу (outranks(actorId, checkerId)).
 * Возвращает { checkerId, entry, messageId } или { error }.
 */
export function findEditable({ stores, actorId, linkText, outranks }) {
  const ref = findMessageLink(linkText);
  if (!ref) return { error: 'Не похоже на ссылку на отчёт: нужна ссылка на сообщение Discord.' };

  const found = findDuplicate(stores, ref.messageId);
  if (!found) return { error: 'Отчёт с такой ссылкой не найден: сначала его нужно добавить.' };
  if (found.checkerId !== actorId && !outranks(actorId, found.checkerId)) {
    return { error: `Нельзя изменить: этот отчёт у <@${found.checkerId}>, он не ниже вас по рангу.` };
  }
  return { ...found, messageId: ref.messageId };
}

/**
 * Записывает правки в отчёт на месте (порядок в списках не меняется). При смене статуса на «отказан» баллы
 * убираются, на «принят» причина отказа убирается; ссылка не меняется.
 * Возвращает { entry } или { error }, если отчёт за это время удалили.
 */
export function commitEdit(store, { reportId, check: rawCheck, report: rawReport, edits }) {
  const { check, report } = applyEdits({ check: rawCheck, report: rawReport }, edits);
  if (!store.verdict(reportId)) return { error: 'Отчёт уже удалён. Найдите его заново через /изменить.' };

  if (store.report(reportId) || report.name != null) {
    store.setReport(reportId, {
      ...(store.report(reportId) ?? { link: check.link }),
      name: report.name,
      rank: report.rank,
      position: report.position,
    });
  }
  store.updateVerdict(reportId, {
    userId: check.userId,
    rank: check.rank,
    position: check.position,
    accepted: check.accepted,
    points: check.accepted ? (check.points ?? null) : null,
    minimum: check.minimum ?? null,
    reason: check.accepted ? null : (check.reason ?? null),
    link: check.link,
  });
  return { entry: store.entry(reportId) };
}
