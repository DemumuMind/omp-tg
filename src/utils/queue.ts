export class AsyncQueue {
  #tail: Promise<void> = Promise.resolve();

  push(task: () => Promise<void> | void): Promise<void> {
    const next = this.#tail.then(task, task);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}
