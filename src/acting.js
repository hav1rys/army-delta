// Режим «записывать за инструктора»: после кнопки «Добавить отчёт инструктору» пересланный отчёт и проверка
// записываются в список выбранного инструктора. Режим одноразовый: сбрасывается после записи пары «отчёт + проверка»,
// а если её не дождались — через полчаса. Хранится в памяти, при перезапуске бота сбрасывается.

const TTL_MS = 30 * 60 * 1000;

export class ActingFor {
  #map = new Map();

  set(actorId, targetId, now = Date.now()) {
    this.#map.set(actorId, { targetId, until: now + TTL_MS });
  }

  /** За кого записывает этот человек сейчас, или null. */
  get(actorId, now = Date.now()) {
    const entry = this.#map.get(actorId);
    if (!entry) return null;
    if (entry.until <= now) {
      this.#map.delete(actorId);
      return null;
    }
    return entry.targetId;
  }

  clear(actorId) {
    this.#map.delete(actorId);
  }
}
