// Простое хранилище в JSON-файле: отчёты и проверки, ключ — id сообщения с отчётом.
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(file) {
    this.file = file;
    this.data = { reports: {}, verdicts: {} };
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      // нет файла или он повреждён — начинаем с пустого состояния
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  setReport(messageId, report) {
    this.data.reports[messageId] = report;
    this.save();
  }

  setVerdict(messageId, verdict) {
    delete this.data.verdicts[messageId]; // повторная проверка уходит в конец списка
    this.data.verdicts[messageId] = verdict;
    this.save();
  }

  /** Перекладывает отчёт под другой id (когда id при пересылке не совпал с id из ссылки в проверке). */
  moveReport(fromId, toId) {
    this.data.reports[toId] = this.data.reports[fromId];
    delete this.data.reports[fromId];
    this.save();
  }

  entry(messageId) {
    const verdict = this.verdict(messageId);
    return verdict ? { messageId, verdict, report: this.report(messageId) } : null;
  }

  report(messageId) {
    return this.data.reports[messageId] ?? null;
  }

  verdict(messageId) {
    return this.data.verdicts[messageId] ?? null;
  }

  /** Проверки с найденными отчётами, в порядке поступления. */
  entries() {
    return Object.entries(this.data.verdicts).map(([messageId, verdict]) => ({
      messageId,
      verdict,
      report: this.report(messageId),
    }));
  }

  /** Отчёты, для которых ещё нет проверки. */
  pendingReports() {
    return Object.entries(this.data.reports)
      .filter(([id]) => !this.data.verdicts[id])
      .map(([messageId, report]) => ({ messageId, report }));
  }

  clear() {
    this.data = { reports: {}, verdicts: {} };
    this.save();
  }
}
