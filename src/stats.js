// Статистика по проверяющим: кто сколько отчётов принял и отказал.

const LIMIT = 1900; // запас до лимита Discord в 2000 символов

/**
 * rows: [{ checkerId, roles, accepted, rejected }] -> сообщения. Порядок: у кого больше отчётов — выше.
 * Люди без отчётов тоже попадают в список (видно, кто ничего не проверил).
 */
export function statsMessages(rows) {
  const sorted = [...rows].sort((a, b) => b.accepted + b.rejected - (a.accepted + a.rejected));
  const total = sorted.reduce(
    (t, r) => ({ accepted: t.accepted + r.accepted, rejected: t.rejected + r.rejected }),
    { accepted: 0, rejected: 0 },
  );

  const lines = sorted.map(
    (r) => `- <@${r.checkerId}>${r.roles ? ` (${r.roles})` : ''}: принято ${r.accepted}, отказано ${r.rejected}, всего ${r.accepted + r.rejected}`,
  );
  const footer = `**Итого:** принято ${total.accepted}, отказано ${total.rejected}, всего ${total.accepted + total.rejected}`;

  const header = '**Статистика по проверяющим**';
  const messages = [];
  let cur = [header];
  for (const line of lines) {
    if ([...cur, line].join('\n').length > LIMIT) {
      messages.push(cur.join('\n'));
      cur = [];
    }
    cur.push(line);
  }
  cur.push(footer);
  messages.push(cur.join('\n'));
  return messages;
}
