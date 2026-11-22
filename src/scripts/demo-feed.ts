import { randomInt } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { generateEarlyCorpus } from '../early-scenarios.js';

/**
 * Streams a synthetic temporal tape into the running API at a steady rate so the workspace has
 * live data. With --auto-analyst it plays the analyst: it confirms each attack's impact case a
 * few events later and corrects a pattern once when it changed a legitimate customer's action.
 * Ground truth stays in this process. The API receives ordinary events and feedback requests.
 */
const { values } = parseArgs({ options: {
  seed: { type: 'string' },
  events: { type: 'string', default: '600' },
  rate: { type: 'string', default: '6' },
  'hard-negatives': { type: 'boolean', default: true },
  'auto-analyst': { type: 'boolean', default: false },
  'analyst-delay-events': { type: 'string', default: '12' },
  'skip-warmup-delay': { type: 'boolean', default: true },
} });
const seed = z.coerce.number().int().min(0).max(999_999_999).parse(values.seed ?? randomInt(1, 999_999_999));
const maxEvents = z.coerce.number().int().min(20).max(50_000).parse(values.events);
const rate = z.coerce.number().min(0.2).max(200).parse(values.rate);
const analystDelay = z.coerce.number().int().min(0).max(1000).parse(values['analyst-delay-events']);
const base = 'http://127.0.0.1:' + z.coerce.number().int().parse(process.env.PORT ?? 3001);
const correctionPriority = ['amount_spike', 'fresh_payee', 'transfer_burst', 'impossible_travel', 'login_pressure',
  'reset_after_device_failures', 'recent_reset', 'shared_device', 'new_payee', 'sensitive_payee_transition'];

const corpus = generateEarlyCorpus({ split: 'evaluation', seed, maxEvents, hardNegatives: values['hard-negatives'] });
const episodes = new Map(corpus.episodes.map((episode) => [episode.id, episode]));
type Review = { at: number; caseId: string } & ({ type: 'confirm' } | { type: 'correct'; publicationId: string });
const queue: Review[] = [];
const corrected = new Set<string>();
const tally = { posted: 0, alerts: 0, blocks: 0, memoryBlocks: 0, confirmations: 0, corrections: 0, reviewErrors: 0 };

async function post(path: string, body: unknown) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) as Record<string, any> | null };
}

async function review(item: Review) {
  if (item.type === 'confirm') {
    const result = await post('/api/cases/' + item.caseId + '/feedback', { verdict: 'fraud_confirmed' });
    if (result.status === 202) tally.confirmations++;
    else tally.reviewErrors++;
    return;
  }
  if (corrected.has(item.publicationId)) return;
  corrected.add(item.publicationId);
  const [trace, patterns] = await Promise.all([
    fetch(base + '/api/cases/' + item.caseId).then((response) => response.json()) as Promise<any>,
    fetch(base + '/api/memory/patterns').then((response) => response.json()) as Promise<any>,
  ]);
  const evidence: string[] = patterns.items.find((row: any) => row.id === item.publicationId)?.evidence ?? [];
  const present: string[] = trace.trace?.memoryPolicy?.sessionRules ?? [];
  const require = correctionPriority.find((id) => evidence.includes(id) && !present.includes(id));
  if (!require) return;
  const result = await post('/api/cases/' + item.caseId + '/feedback', { verdict: 'legitimate_correction', publicationId: item.publicationId, require });
  if (result.status === 202) tally.corrections++;
  else tally.reviewErrors++;
}

const health = await fetch(base + '/health').catch(() => null);
if (!health?.ok) {
  console.error('The API is not reachable at ' + base + '. Start it with npm run dev first.');
  process.exit(1);
}
console.error('Feeding seed ' + seed + ': ' + corpus.events.length + ' events at ' + rate + '/s' + (values['auto-analyst'] ? ' with the auto-analyst.' : '.'));
for (const [index, event] of corpus.events.entries()) {
  while (queue.length && queue[0]!.at <= index) await review(queue.shift()!).catch(() => { tally.reviewErrors++; });
  const label = corpus.labels.get(event.id)!;
  const result = await post('/api/events', event);
  if (result.status >= 400) throw new Error('Event rejected with HTTP ' + result.status);
  tally.posted++;
  const row = result.body?.case;
  if (row?.action && row.action !== 'ALLOW') tally.alerts++;
  if (row?.action === 'BLOCK') tally.blocks++;
  const memory = row?.trace?.memoryPolicy;
  if (memory?.applied) tally.memoryBlocks++;
  const episode = episodes.get(label.episodeId)!;
  if (values['auto-analyst']) {
    if (episode.malicious && episode.impactId === event.id) queue.push({ type: 'confirm', at: index + analystDelay, caseId: event.id });
    if (!episode.malicious && memory?.applied && memory.match) {
      queue.push({ type: 'correct', at: index + analystDelay, caseId: event.id, publicationId: memory.match.publicationId });
    }
  }
  // Warm-up history is old activity; send it quickly so the live part starts sooner.
  if (!(values['skip-warmup-delay'] && label.phase === 'warmup')) await pause(1000 / rate);
  if ((index + 1) % 100 === 0) console.error(JSON.stringify({ processed: index + 1, ...tally }));
}
while (queue.length) await review(queue.shift()!).catch(() => { tally.reviewErrors++; });
console.error(JSON.stringify({ done: true, seed, ...tally }));
