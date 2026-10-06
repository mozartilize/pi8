// Spec: JobQueue({ concurrency }).add(handler(signal)) returns an id.
// cancel(id) removes a queued job. For a running job, it aborts the signal and
// frees the slot at once. A cancelled handler can stay unresolved; the queue
// does not wait for it.
export class JobQueue {
  #concurrency;
  #pending = [];
  #running = new Map();
  #next = 1;

  constructor({ concurrency = 1 } = {}) {
    this.#concurrency = concurrency;
  }

  add(handler) {
    const id = this.#next++;
    this.#pending.push({ id, handler });
    this.#pump();
    return id;
  }

  cancel(id) {
    const queued = this.#pending.findIndex((job) => job.id === id);
    if (queued >= 0) {
      this.#pending.splice(queued, 1);
      return true;
    }
    const running = this.#running.get(id);
    if (!running) return false;
    running.controller.abort();
    this.#running.delete(id);
    this.#pump();
    return true;
  }

  #pump() {
    while (this.#running.size < this.#concurrency && this.#pending.length > 0) {
      const { id, handler } = this.#pending.shift();
      const controller = new AbortController();
      this.#running.set(id, { controller });
      Promise.resolve()
        .then(() => handler(controller.signal))
        .catch(() => {})
        .finally(() => {
          if (this.#running.get(id)?.controller !== controller) return;
          this.#running.delete(id);
          this.#pump();
        });
    }
  }
}
