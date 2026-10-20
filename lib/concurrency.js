export function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

// Динамический worker pool: освободившийся worker сразу берёт следующий item.
// Результаты всегда возвращаются в исходном порядке.
export async function runPool(items, concurrency, worker, { shouldStop } = {}) {
  const results = new Array(items.length);
  let next = 0;

  async function runWorker() {
    while (true) {
      if (shouldStop && shouldStop()) return;
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const count = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: count }, () => runWorker()));
  return results;
}

// Последовательно раздаёт разрешения на старт запросов. Сам сетевой запрос
// слот не удерживает: перекрывается ожидание ответов разных каналов.
export function createRateLimiter(intervalMs, { now = Date.now, wait = sleep } = {}) {
  let tail = Promise.resolve();
  let nextAt = 0;
  let pausedUntil = 0;

  function enqueue(fn) {
    const turn = tail.then(async () => {
      const delay = Math.max(0, nextAt - now(), pausedUntil - now());
      if (delay > 0) await wait(delay);
      nextAt = now() + intervalMs;
    });
    tail = turn.catch(() => {});
    return turn.then(fn);
  }

  return {
    run(fn) {
      return enqueue(fn);
    },
    pause(ms) {
      pausedUntil = Math.max(pausedUntil, now() + Math.max(0, ms));
    },
  };
}
