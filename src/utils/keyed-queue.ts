/** Serializes work per key while different keys run concurrently. */
export class KeyedQueue {
  readonly #tails = new Map<string, Promise<void>>();

  push(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.#tails.set(key, next);
    const cleanup = (): void => {
      if (this.#tails.get(key) === next) this.#tails.delete(key);
    };
    void next.then(cleanup, cleanup);
    return next;
  }
}
