import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CaseService } from '../cases.js';
import { loadConfig } from '../config.js';
import { createPool, migrate } from '../database.js';
import {
  allEarlyScenarios, evaluateEarlyCorpus, generateEarlyCorpus,
  type EarlyCorpus, type EarlyScenario, type EvaluationDecision,
} from '../early-scenarios.js';
import { localMemoryGateway } from '../integrations/local-memory.js';
import { createFallbackModel, createModel } from '../integrations/models.js';
import { FeedbackError, LearningService } from '../learning.js';
import type { MemoryPolicyMode } from '../memory-policy.js';
import { createLearning } from '../wiring.js';

const modes = ['rules', 'agents', 'meko'] as const;
type Mode = typeof modes[number];
type Store = 'local' | 'meko';

function readOptions() {
  const { values } = parseArgs({
    options: {
      suite: { type: 'string', default: 'evaluation' },
      seed: { type: 'string', default: '7403' },
      events: { type: 'string', default: '160' },
      scenario: { type: 'string', default: 'all' },
      mode: { type: 'string', default: 'rules' },
      profile: { type: 'string', default: 'extended' },
      // off reproduces the earlier evaluator. compare runs off and enforce on the same tape.
      memory: { type: 'string', default: 'off' },
      'memory-store': { type: 'string', default: 'local' },
      'analyst-delay-minutes': { type: 'string', default: '30' },
      // Adds legitimate sessions that reproduce an attack's opening steps.
      'hard-negatives': { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  return z.strictObject({
    suite: z.enum(['development', 'evaluation']),
    seed: z.coerce.number().int().min(0).max(999_999_999),
    events: z.coerce.number().int().min(20).max(50_000),
    scenario: z.enum(['all', ...allEarlyScenarios]),
    mode: z.enum(['all', ...modes]),
    profile: z.enum(['legacy', 'extended']),
    memory: z.enum(['off', 'shadow', 'enforce', 'compare']),
    'memory-store': z.enum(['local', 'meko']),
    'analyst-delay-minutes': z.coerce.number().min(0).max(1440),
    'hard-negatives': z.boolean().optional(),
    json: z.boolean().optional(),
  }).parse(values);
}

type Analyst = {
  learning: LearningService;
  pool: ReturnType<typeof createPool>;
  store: Store;
  delayMs: number;
};

// The analyst names the strongest harm indicator the attack had and the legitimate session lacked.
const correctionPriority = ['amount_spike', 'fresh_payee', 'transfer_burst', 'impossible_travel', 'login_pressure',
  'reset_after_device_failures', 'recent_reset', 'shared_device', 'new_payee', 'sensitive_payee_transition'];

/**
 * Simulated analyst. After a review delay it confirms each attack's impact case, and it
 * corrects a pattern once when that pattern changed a legitimate customer's action. The
 * worker must read each publication back before it can be used. Ground truth stays in
 * this CLI. The engine sees only the analyst's feedback request.
 */
async function submitReview(analyst: Analyst, caseId: string, request: Parameters<LearningService['feedback']>[1]) {
  try {
    const queued = await analyst.learning.feedback(caseId, request);
    for (let attempt = 0; attempt < 12; attempt++) {
      if (queued.state === 'published') return { status: 'published' as const };
      // Make the job due now. The worker still verifies the stored text by exact ID.
      await analyst.pool.query(
        'UPDATE memory_publications SET next_check_at = clock_timestamp() WHERE id = $1', [queued.id]);
      const row = await analyst.learning.workOne(queued.id, 20);
      if (row?.state === 'published') return { status: 'published' as const };
      if (row?.state === 'failed') return { status: 'failed' as const };
      if (analyst.store === 'meko') await pause(1500);
    }
    return { status: 'not_visible' as const };
  } catch (error) {
    if (error instanceof FeedbackError) return { status: error.code };
    throw error;
  }
}

async function evaluateMode(
  mode: Mode, memoryMode: MemoryPolicyMode, corpus: EarlyCorpus, schema: string, config: ReturnType<typeof loadConfig>,
  profile: 'legacy' | 'extended', store: Store, analystDelayMinutes: number,
) {
  const admin = createPool(config.DATABASE_URL);
  const pool = createPool(config.DATABASE_URL, '-c search_path=' + schema);
  try {
    const provider = mode === 'rules' ? undefined : createModel(config);
    if (mode !== 'rules' && !provider) {
      throw new Error('Set a live provider for agent evaluation. For example LLM_PROVIDER=ollama.');
    }
    if (mode === 'meko' && store !== 'meko') {
      throw new Error('Configure Meko and pass --memory-store meko for Meko mode.');
    }
    const learning = mode === 'meko' || (memoryMode !== 'off' && store === 'meko') ? createLearning(pool, config)
      : memoryMode !== 'off' ? new LearningService(pool, { confirmed: localMemoryGateway() }, config.MEKO_TIMEOUT_MS)
      : undefined;
    if (mode === 'meko' && !learning?.hasPack('confirmed') && !learning?.hasPack('risk')) {
      throw new Error('Configure Meko credentials and at least one datapack for Meko mode.');
    }
    if (memoryMode !== 'off' && !learning?.hasPack('confirmed')) {
      throw new Error('Configure Meko credentials and the confirmed datapack, or use --memory-store local.');
    }

    // The name is generated locally from a random token and fixed labels.
    await admin.query('CREATE SCHEMA ' + schema);
    await migrate(pool);
    console.error('Evaluating', mode, 'with memory policy', memoryMode, 'in', schema, 'with', corpus.events.length, 'synthetic attempts');

    const investigationOptions = {
      mode, collective: true, advanced: profile === 'extended', publishProvisional: false, learning, model: provider,
      investigatorModel: mode === 'rules' ? undefined : createModel(config, true),
      fallbackModel: mode === 'rules' ? undefined : createFallbackModel(config),
      memoryTimeoutMs: config.MEKO_TIMEOUT_MS, modelTimeoutMs: config.LLM_TIMEOUT_MS, memoryPolicy: memoryMode,
    };
    const service = new CaseService(pool, { challenge: config.RISK_CHALLENGE_THRESHOLD, block: config.RISK_BLOCK_THRESHOLD }, investigationOptions);
    const analyst = memoryMode !== 'off' && learning ? { learning, pool, store, delayMs: analystDelayMinutes * 60_000 } : null;
    const impacts = new Map(corpus.episodes.flatMap((episode) =>
      episode.malicious && episode.impactId ? [[episode.impactId, episode.scenario] as const] : []));
    const labels = corpus.labels;
    const malicious = new Set(corpus.episodes.filter((episode) => episode.malicious).map((episode) => episode.id));
    const patternEvidence = new Map<string, string[]>();
    const reviewQueue: ({ due: number; caseId: string } & (
      | { type: 'confirm'; scenario: EarlyScenario }
      | { type: 'correct'; publicationId: string; require: string | null }
    ))[] = [];
    const knowledge = new Map<EarlyScenario, number>();
    const confirmations: Record<string, number> = {};
    const corrections: Record<string, number> = {};
    const corrected = new Set<string>();

    const decisions = new Map<string, EvaluationDecision>();
    const roleMix: Record<string, { cases: number; modelCalls: number; validatedResults: number }> = {};
    const started = performance.now();
    for (const [index, event] of corpus.events.entries()) {
      const now = Date.parse(event.timestamp);
      while (analyst && reviewQueue.length && reviewQueue[0]!.due <= now) {
        const item = reviewQueue.shift()!;
        if (item.type === 'confirm') {
          const outcome = await submitReview(analyst, item.caseId, { verdict: 'fraud_confirmed' });
          confirmations[outcome.status] = (confirmations[outcome.status] ?? 0) + 1;
          if (outcome.status === 'published' && !knowledge.has(item.scenario)) knowledge.set(item.scenario, item.due);
        } else if (!corrected.has(item.publicationId)) {
          corrected.add(item.publicationId);
          const outcome = item.require
            ? await submitReview(analyst, item.caseId, { verdict: 'legitimate_correction', publicationId: item.publicationId, require: item.require })
            : { status: 'no_distinguishing_rule' };
          corrections[outcome.status] = (corrections[outcome.status] ?? 0) + 1;
        }
      }
      // Truth, scenario names and synthetic challenge responses remain in this CLI.
      const { case: row } = await service.ingest(event);
      if (row.status !== 'decided' || !row.action) throw new Error('Evaluation case did not settle: ' + event.id);
      const scenario = impacts.get(event.id);
      if (analyst && scenario) reviewQueue.push({ type: 'confirm', due: now + analyst.delayMs, caseId: event.id, scenario });
      // A legitimate customer whose action memory changed complains. The analyst corrects that pattern once.
      const memory = row.trace.memoryPolicy;
      const label = labels.get(event.id);
      if (analyst && memory && 'applied' in memory && memory.applied && memory.match && label && !malicious.has(label.episodeId)) {
        const publicationId = memory.match.publicationId;
        if (!patternEvidence.has(publicationId)) {
          const stored = await pool.query<{ evidence: string[] }>(
            "SELECT ARRAY(SELECT jsonb_array_elements_text(document->'evidence')) AS evidence FROM memory_publications WHERE id = $1", [publicationId]);
          patternEvidence.set(publicationId, stored.rows[0]?.evidence ?? []);
        }
        const attack = patternEvidence.get(publicationId)!;
        const require = correctionPriority.find((id) => attack.includes(id) && !memory.sessionRules.includes(id)) ?? null;
        reviewQueue.push({ type: 'correct', due: now + analyst.delayMs, caseId: event.id, publicationId, require });
        reviewQueue.sort((a, b) => a.due - b.due);
      }

      const roles = row.trace.team ?? (row.trace.agent ? [row.trace.agent] : []);
      let measuredUsageCalls = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      for (const role of roles) {
        const mix = roleMix[role.agentId] ??= { cases: 0, modelCalls: 0, validatedResults: 0 };
        mix.cases++;
        mix.modelCalls += role.attempts.length;
        if (role.result) mix.validatedResults++;
        for (const { usage } of role.attempts) {
          if (!usage) continue;
          if (usage.inputTokens !== null || usage.outputTokens !== null) measuredUsageCalls++;
          inputTokens += usage.inputTokens ?? 0;
          outputTokens += usage.outputTokens ?? 0;
        }
      }
      const trace = row.trace as typeof row.trace & { provisionalSignals?: readonly unknown[] };
      const ranked = (trace.specialistContexts ?? []).flatMap(({ context }) =>
        context.status === 'ok' && context.lookup === 'search' ? [context] : [],
      );
      const policy = trace.memoryPolicy;
      decisions.set(event.id, {
        action: row.action, modelCalls: row.trace.modelCalls, measuredUsageCalls, inputTokens, outputTokens,
        latencyMs: trace.durationMs, verifiedReuse: Boolean(trace.reuse),
        priorObservationCount: trace.provisionalSignals?.length,
        rankedSearches: ranked.length, rankedHits: ranked.reduce((sum, context) => sum + context.matches.length, 0),
        rejectedCandidates: trace.rejectedMemories?.length,
        patternMatched: Boolean(policy?.match),
        patternApplied: Boolean(policy && 'applied' in policy && policy.applied),
      });
      if ((index + 1) % 100 === 0) console.error(mode, memoryMode, 'processed', index + 1, 'of', corpus.events.length);
    }
    return {
      mode, profile, memoryPolicy: memoryMode, schema, provider: provider?.provider ?? null, model: provider?.model ?? null,
      retrievalScope: mode === 'meko' ? 'ordinary ranked. Fresh local registry. This sweep does not queue or publish new observations.' : 'disabled',
      memoryStore: memoryMode === 'off' ? null : store === 'local'
        ? 'local in-process stand-in with read-back verification (not hosted Meko)' : 'hosted Meko confirmed datapack',
      analyst: analyst ? {
        semantics: 'Each attack impact case is confirmed after the review delay in simulated time. A pattern is usable only after the worker reads it back.',
        delayMinutes: analystDelayMinutes, confirmations, corrections,
        firstPatternActiveAt: Object.fromEntries([...knowledge].map(([name, time]) => [name, new Date(time).toISOString()])),
      } : null,
      policyThresholds: { challenge: config.RISK_CHALLENGE_THRESHOLD, block: config.RISK_BLOCK_THRESHOLD },
      wallMs: Math.round(performance.now() - started), roleMix,
      ...evaluateEarlyCorpus(corpus, decisions, knowledge),
    };
  } finally {
    await pool.end();
    await admin.end();
  }
}

async function main() {
  const options = readOptions();
  const config = loadConfig();
  const corpus = generateEarlyCorpus({
    split: options.suite, seed: options.seed, maxEvents: options.events,
    scenario: options.scenario === 'all' ? undefined : options.scenario, hardNegatives: options['hard-negatives'],
  });
  const tag = randomBytes(8).toString('hex');
  const memoryModes: MemoryPolicyMode[] = options.memory === 'compare' ? ['off', 'enforce'] : [options.memory];
  const runs = [];
  for (const mode of options.mode === 'all' ? modes : [options.mode]) {
    for (const memoryMode of memoryModes) {
      runs.push(await evaluateMode(mode, memoryMode, corpus, 'contextcon_eval_' + tag + '_' + mode + '_' + memoryMode, config,
        options.profile, options['memory-store'], options['analyst-delay-minutes']));
    }
  }
  if (options.json) {
    console.log(JSON.stringify({
      corpus: {
        split: corpus.split, seed: corpus.seed, requestedMaxEvents: corpus.maxEvents, scenario: options.scenario,
        hardNegatives: Boolean(options['hard-negatives']),
      }, runs,
    }, null, 2));
    return;
  }
  console.table(runs.map((run) => ({
    mode: run.mode, memory: run.memoryPolicy, profile: run.profile, events: run.eventCount,
    precision: run.classification.precision, recall: run.classification.recall,
    legitimateStepUpRate: run.legitimateStepUpRate,
    attacksBeforeImpact: run.attacks.alertedBeforeImpact + '/' + run.attacks.total,
    prevented: run.attacks.preventedBeforeImpact + run.attacks.preventedAtImpact,
    byBlock: run.attacks.preventedByBlock, executed: run.attacks.executed,
    repeatExecuted: run.attacks.byEncounter.repeat.executed + '/' + run.attacks.byEncounter.repeat.total,
    patternMatches: run.telemetry.verifiedPatternMatches, legitMatches: run.telemetry.verifiedPatternMatchesOnLegitimate,
    calls: run.telemetry.totalCalls, input: run.telemetry.inputTokens, output: run.telemetry.outputTokens,
  })));
  console.log('Use --json for per-scenario results, latency, gate outcomes and trace schema names.');
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  if (/^(?:Set a live provider|Configure Meko|Evaluation case did not settle|Use an integer seed)/.test(message)) console.error(message);
  else console.error('Early evaluation failed. Check arguments, PostgreSQL and provider configuration.', process.env.EVAL_DEBUG ? error : '');
  process.exitCode = 1;
});
