import { randomUUID } from 'node:crypto';
import type { MemoryGateway } from '../learning.js';

/**
 * In-process stand-in for a Meko datapack, used only by offline evaluation when no Meko
 * credentials are configured. It implements the same write → read-back contract the
 * publication worker verifies, with immediate visibility and naive keyword ranking. Results
 * produced with it must be labelled as local-store runs, not hosted Meko runs.
 */
export function localMemoryGateway(): MemoryGateway & { readonly size: number } {
  const stored: { id: string; text: string }[] = [];
  const terms = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
  return {
    get size() { return stored.length; },
    async write(text) {
      const id = randomUUID();
      stored.push({ id, text });
      return id;
    },
    async read(id) {
      return stored.find((row) => row.id === id) ?? null;
    },
    async recent() {
      return stored.slice(-20).reverse();
    },
    async search(query) {
      const wanted = terms(query);
      const ranked = stored.map((row) => {
        const have = terms(row.text);
        const overlap = [...wanted].filter((word) => have.has(word)).length;
        return { row, score: wanted.size ? overlap / wanted.size : 0 };
      }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 10);
      return { records: ranked.map(({ row }) => row), matches: ranked.map(({ row, score }) => ({ id: row.id, score })) };
    },
  };
}
