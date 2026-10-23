/**
 * Serialises async critical sections within this process. Enough for us:
 * only one container writes DATA_DIR, so no cross-process lock is needed.
 */
export class Mutex {
  /** @type {Promise<unknown>} */
  #tail = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  run(fn) {
    const result = this.#tail.then(fn);
    // Keep the chain alive even if fn rejects; the caller still sees the rejection.
    this.#tail = result.catch(() => undefined);
    return result;
  }

  /** Resolves once everything queued so far has finished (used on shutdown). */
  idle() {
    return this.#tail.then(() => undefined);
  }
}

/**
 * Non-blocking counting semaphore: callers that find no free slot get an
 * immediate "busy" instead of queuing request bodies in memory.
 */
export class Semaphore {
  #free;

  /** @param {number} slots */
  constructor(slots) {
    this.#free = slots;
  }

  tryAcquire() {
    if (this.#free === 0) return false;
    this.#free -= 1;
    return true;
  }

  release() {
    this.#free += 1;
  }
}
