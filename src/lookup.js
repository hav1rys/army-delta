// «Проверить наличие отчёта»: по списку имён и фамилий или Discord ID показывает, у кого отчёт есть, а у кого нет.
import { entryPoints } from './forms.js';

const LIMIT = 1900; // запас до лимита Discord в 2000 символов
const MAX_QUERIES = 100;

/** Имя без регистра, без «ё», подчёркивания и пробелы считаются одинаково: Matvey_Siberyak == matvey siberyak. */
const normalize = (s) => s.toLowerCase().replace(/ё/g, 'е').replace(/[_\s]+/g, ' ').trim();

/**
 * Список запросов из текста. Разделители: запятая, точка с запятой, перенос строки.
 * Всё, что похоже на Discord ID (17–20 цифр, в том числе внутри упоминания), — запрос по ID, остальное — по имени.
 */
export function parseQueries(text) {
  const queries = [];
  const seen = new Set();
  const add = (query) => {
    const key = query.kind === 'id' ? `id:${query.id}` : `name:${normalize(query.name)}`;
    if (seen.has(key)) return;
    seen.add(key);
    queries.push(query);
  };

  for (const piece of (text ?? '').split(/[,;\n]+/)) {
    const ids = piece.match(/\d{17,20}/g);
    if (ids) ids.forEach((id) => add({ kind: 'id', id }));
    else if (piece.trim()) add({ kind: 'name', name: piece.trim() });
  }
  return queries;
}

const label = (query) => (query.kind === 'id' ? `<@${query.id}>` : query.name);

/** Все отчёты, подходящие под запрос: и проверенные, и ещё ждущие проверки. stores: [{ checkerId, store }]. */
export function findReports(stores, query) {
  const wanted = query.kind === 'name' ? normalize(query.name).split(' ') : null;
  const nameMatches = (name) => {
    const tokens = normalize(name ?? '').split(' ');
    return wanted.every((w) => tokens.includes(w)); // все слова из запроса есть в имени, порядок не важен
  };

  const found = [];
  for (const { checkerId, store } of stores) {
    for (const entry of store.entries()) {
      const hit = query.kind === 'id' ? entry.verdict.userId === query.id : nameMatches(entry.report?.name);
      if (hit) found.push({ checkerId, entry });
    }
    if (query.kind === 'name') {
      for (const { report } of store.pendingReports()) {
        if (nameMatches(report.name)) found.push({ checkerId, pending: report });
      }
    }
  }
  return found;
}

function describeMatch(query, { checkerId, entry, pending }) {
  const by = `проверил <@${checkerId}>`;
  if (pending) return `📄 **${label(query)}**: отчёт есть, проверки ещё нет (у <@${checkerId}>)`;

  const { verdict, report } = entry;
  const name = report?.name ? ` (${report.name})` : '';
  if (verdict.accepted) {
    const points = entryPoints(entry);
    return `✅ **${label(query)}**${name}: принят, ${points ?? '?'} б., ${by}, ${verdict.link}`;
  }
  return `⚠️ **${label(query)}**${name}: есть, но отказан (${verdict.reason || 'без причины'}), ${by}, ${verdict.link}`;
}

/** Ответ на запрос: строка на каждый найденный отчёт, «нет отчёта» для остальных и итог. Возвращает сообщения. */
export function lookupMessages(stores, text) {
  const all = parseQueries(text);
  if (!all.length) return ['Ничего не распознал: укажите имена и фамилии или Discord ID через запятую.'];
  const queries = all.slice(0, MAX_QUERIES);

  const lines = [];
  const missing = [];
  let present = 0;
  for (const query of queries) {
    const matches = findReports(stores, query);
    if (!matches.length) {
      lines.push(`❌ **${label(query)}**: отчёта нет`);
      missing.push(label(query));
      continue;
    }
    present += 1;
    for (const match of matches) lines.push(describeMatch(query, match));
  }

  const footer = [
    `**Итого:** отчёт есть у ${present}, нет у ${missing.length} (из ${queries.length}).`,
    ...(all.length > queries.length ? [`Проверил только первые ${MAX_QUERIES} из ${all.length}.`] : []),
    ...(missing.length ? [`Нет отчёта: ${missing.join(', ')}`] : []),
  ];

  // Режем на сообщения по строкам: каждое в пределах лимита Discord.
  const messages = [];
  let current = [];
  for (const line of [...lines, ...footer]) {
    if (current.length && [...current, line].join('\n').length > LIMIT) {
      messages.push(current.join('\n'));
      current = [];
    }
    current.push(line.slice(0, LIMIT));
  }
  messages.push(current.join('\n'));
  return messages;
}
