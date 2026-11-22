import { setTimeout as wait } from 'node:timers/promises';
import type { LearningService } from './learning.js';

/** Drain the durable outbox independently of event intake. */
export function startPublicationWorker(learning: LearningService, onError: () => void, intervalMs = 1500) {
  const stop = new AbortController();
  const loop = (async () => {
    while (!stop.signal.aborted) {
      try {
        // Drain a small batch per tick so analyst feedback becomes usable within seconds.
        for (let job = 0; job < 10 && !stop.signal.aborted; job++) {
          if (!await learning.workOne()) break;
        }
      } catch {
        onError();
      }
      try {
        await wait(intervalMs, undefined, { signal: stop.signal });
      } catch {
        break;
      }
    }
  })();
  return async () => {
    stop.abort();
    await loop;
  };
}
