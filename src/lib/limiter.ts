/**
 * Tiny concurrency limiter + TTL cache used to stop URL analysis from spawning
 * an unbounded number of yt-dlp processes (ten rapid clicks used to mean ten
 * parallel extractions).
 */

export function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= limit) return;
    const run = queue.shift();
    if (run) {
      active += 1;
      run();
    }
  };

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => queue.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      active -= 1;
      next();
    }
  };
}

export function createTtlCache<T>(ttlMs: number) {
  const store = new Map<string, { at: number; value: T }>();
  return {
    get(key: string, now: number = Date.now()): T | undefined {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (now - hit.at > ttlMs) {
        store.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key: string, value: T, now: number = Date.now()): void {
      store.set(key, { at: now, value });
      if (store.size > 100) {
        const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) store.delete(oldest[0]);
      }
    },
    clear(): void {
      store.clear();
    },
    get size(): number {
      return store.size;
    },
  };
}
