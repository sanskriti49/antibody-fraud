import { setTimeout as pause } from 'node:timers/promises';
import { z } from 'zod';
import { DEVICE_AGENT, describeDeviceEvidence } from './device-evidence.js';
import { graphAssessment, type GraphSnapshot } from './graph.js';
import type { Features } from './features.js';
import { actionSchema, type RiskAssessment } from './risk.js';
import { failureCode, type ContextSearch, type MemoryReader, type ModelUsage, type StructuredModel } from './integrations/ports.js';

import { ModelHttpError } from './integrations/models.js';
import { FINGERPRINT_QUERY, GRAPH_AGENT, INVESTIGATOR_AGENT, LOGIN_AGENT, TRANSFER_AGENT, type LearningService, type Pack, type ProvisionalSignal, type Reuse } from './learning.js';
import type { MemoryPolicyMode } from './memory-policy.js';
import type { BoundPassage, PlaybookReference } from './playbooks.js';

const behaviourAgentId = LOGIN_AGENT;
const investigatorId = INVESTIGATOR_AGENT;
const evidenceTopics = new Map([
  ['login_pressure', 'repeated failed logins'],
  ['recent_reset', 'recent password reset'],
  ['reset_after_device_failures', 'sensitive reset after nearby authentication failures'],
  ['behaviour_shift', 'unusual interaction timing'],
]);
const modelResultSchema = z.strictObject({
  riskScore: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string()).max(3),
  missingContext: z.array(z.string().trim().min(1).max(160)).max(3),
  recommendedAction: actionSchema,
  rationale: z.string().trim().min(1).max(500),
});

const graphResultSchema = z.strictObject({
  evidenceIds: z.array(z.string()).min(1).max(2),
  recommendedAction: actionSchema,
  rationale: z.string().trim().min(1).max(240),
});

const investigatorResultSchema = z.strictObject({
  recommendedAction: actionSchema,
  rationale: z.string().trim().min(1).max(320),
});
type ModelResult = Omit<z.infer<typeof modelResultSchema>, 'riskScore' | 'confidence'> & {
  riskScore: number | null;
  confidence: number | null;
};
type Attempt = { provider: string; model: string; fallback: boolean; retryDelayMs?: number; durationMs: number; status: 'accepted' | 'rejected'; error?: string; usage: ModelUsage | null };
type ContextTrace = ContextSearch & { status: 'ok'; durationMs: number; lookup?: 'exact_id' | 'search' } |
  { status: 'error' | 'not_configured'; durationMs: number; error: string };
export type AgentTrace = {
  agentId: string;
  provider: string;
  model: string;
  durationMs: number;
  attempts: Attempt[];
  result?: ModelResult & { caseId: string; evidence: RiskAssessment['evidence']; retrievedMemoryIds: string[] };
};

export type Investigation = {
  path: 'agent_review' | 'fallback';
  context: ContextTrace | null;
  agent: AgentTrace | null;
  team?: AgentTrace[];
  reuse?: Reuse | null;
  rejectedMemories?: { memoryId: string; reason: string }[];
  synthesis?: {
    conflictingRecommendations: boolean;
    missingCorroboration: string[];
    recommendation: RiskAssessment['preliminaryAction'];
    basis: 'investigator_model' | 'deterministic_policy';
  };
  provisionalSignals?: ProvisionalSignal[];
  provisionalContextError?: string;
  specialistContexts?: { agentId: string; pack: Pack; context: ContextTrace }[];
  knowledge?: KnowledgeTrace;
  rationale: string;
};
type KnowledgeTrace = { query: string; durationMs: number } & (
  | { status: 'ok'; hits: number; passages: BoundPassage[]; unverified: number }
  | { status: 'error'; error: string }
);

export type InvestigationOptions = {
  mode: 'rules' | 'agents' | 'meko';
  memory?: MemoryReader;
  model?: StructuredModel;
  investigatorModel?: StructuredModel;
  fallbackModel?: StructuredModel;
  learning?: LearningService;
  collective?: boolean;
  advanced?: boolean;
  publishProvisional?: boolean;
  /** off keeps earlier behaviour. shadow records would-be decisions. enforce lets verified patterns block. */
  memoryPolicy?: MemoryPolicyMode;
  memoryTimeoutMs: number;
  modelTimeoutMs: number;
};

const instruction = [
  'You are a specialist analysing synthetic login and behavioural timing signals.',
  'Return JSON matching the response schema, with only a brief evidence-based rationale.',
  'Copy evidence IDs exactly from the evidence list. State gaps explicitly. A timing change alone does not justify a block.',
  'Use riskScore from 0 through 100 and confidence from 0 through 1. Keep the rationale to one sentence.',
  'No tools or external actions are available. Your recommendation is advisory.',
].join(' ');

function parseModelResult(text: string, allowed: Set<string>, agentId: string) {
  if (!text || text.length > 4_000) return;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  if (agentId === investigatorId) {
    const parsed = investigatorResultSchema.safeParse(value);
    if (!parsed.success) return;
    return { ...parsed.data, confidence: null, riskScore: null, evidenceIds: [...allowed], missingContext: [] };
  }
  const validCitations = (ids: string[]) => new Set(ids).size === ids.length && ids.every((id) => allowed.has(id));
  if (agentId === GRAPH_AGENT) {
    const parsed = graphResultSchema.safeParse(value);
    if (!parsed.success || !validCitations(parsed.data.evidenceIds)) return;
    return { ...parsed.data, confidence: null, riskScore: null, missingContext: [] };
  }
  const parsed = modelResultSchema.safeParse(value);
  if (parsed.success && validCitations(parsed.data.evidenceIds)) return parsed.data;
}

async function retrieveContext(query: string, options: InvestigationOptions): Promise<ContextTrace | null> {
  if (options.mode !== 'meko') return null;
  if (!options.memory) return { status: 'not_configured', durationMs: 0, error: 'meko_not_configured' };
  const started = performance.now();
  const signal = AbortSignal.timeout(options.memoryTimeoutMs);
  try {
    // Controlled topic labels keep account, device and event identifiers out of the datapack.
    const result = await options.memory.search(query, signal);
    return { ...result, status: 'ok', durationMs: performance.now() - started };
  } catch (error) {
    return { status: 'error', error: failureCode(error, signal, 'meko_unavailable'), durationMs: performance.now() - started };
  }
}

export async function investigate(
  caseId: string, features: Features, risk: RiskAssessment, options: InvestigationOptions,
): Promise<Investigation> {
  const evidence = risk.evidence.filter((item) => evidenceTopics.has(item.id));
  if (!evidence.length) {
    return {
      path: 'fallback', context: null, agent: null,
      rationale: 'No specialist covers the active signals yet. Require step-up verification.',
    };
  }
  const query = 'Synthetic account takeover: ' + evidence.map((item) => evidenceTopics.get(item.id)).join(', ');
  const context = await retrieveContext(query, options);
  if (context && context.status !== 'ok') {
    return { path: 'fallback', context, agent: null, rationale: 'Meko lookup unavailable. Require step-up verification.' };
  }
  if (!options.model && !options.fallbackModel) {
    return { path: 'fallback', context, agent: null, rationale: 'No model available. Require step-up verification.' };
  }

  const agent = await runAgent(behaviourAgentId, caseId, evidence, instruction, {
    failedLogins15m: features.failedLogins15m,
    passwordResets30m: features.passwordResets30m,
    behaviourSamples: features.behaviourSamples,
    behaviourDeviations: features.behaviourDeviations,
  }, options);
  return agent?.result ? {
    path: 'agent_review', context, agent,
    rationale: 'Specialist assessment recorded. Policy requires step-up verification for this score.',
  } : {
    path: 'fallback', context, agent,
    rationale: 'Specialist did not return a usable assessment. Require step-up verification.',
  };
}

async function runAgent(
  id: string, caseId: string, evidence: RiskAssessment['evidence'], prompt: string, input: object,
  options: InvestigationOptions, primary = options.model,
): Promise<AgentTrace | null> {
  const fallback = options.fallbackModel;
  if (!primary && !fallback) return null;
  const allowed = new Set(evidence.map((item) => item.id));
  const item = allowed.size ? z.enum([...allowed]) : z.string();
  const resultSchema = id === investigatorId ? investigatorResultSchema :
    id === GRAPH_AGENT ? graphResultSchema.extend({ evidenceIds: z.array(item).min(1).max(Math.min(2, allowed.size)) }) :
    modelResultSchema.extend({ evidenceIds: z.array(item).max(Math.min(3, allowed.size)) });
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(resultSchema);
  const data = JSON.stringify({ ...input, evidence });
  const started = performance.now();
  const attempts: Attempt[] = [];

  for (const model of new Set([primary, fallback])) {
    if (!model) continue;
    const localFallback = model !== primary;
    for (let attempt = 0; attempt < (localFallback ? 1 : 2); attempt++) {
      const requestStarted = performance.now();
      const signal = AbortSignal.timeout(options.modelTimeoutMs);
      const entry = { provider: model.provider, model: model.model, fallback: localFallback };
      try {
        const instructionText = attempt === 0 ? prompt : prompt + ' Fix format and use only the provided evidence IDs.';
        const generated = await model.generate(instructionText, data, jsonSchema, signal);
        const result = parseModelResult(generated.text, allowed, id);
        attempts.push({
          ...entry, durationMs: performance.now() - requestStarted, status: result ? 'accepted' : 'rejected',
          error: result ? undefined : 'invalid_agent_result', usage: generated.usage,
        });
        if (result) {
          const cited = new Set(result.evidenceIds);
          return {
            agentId: id, provider: model.provider, model: model.model,
            durationMs: performance.now() - started, attempts,
            result: { ...result, caseId, evidence: evidence.filter((value) => cited.has(value.id)), retrievedMemoryIds: [] },
          };
        }
      } catch (error) {
        const code = failureCode(error, signal, 'model_unavailable');
        const retryDelayMs = error instanceof ModelHttpError && error.status === 429 && error.retryAfterMs !== null &&
          error.retryAfterMs <= 1000 && !localFallback && attempt === 0 ? error.retryAfterMs : undefined;
        attempts.push({ ...entry, durationMs: performance.now() - requestStarted, status: 'rejected', error: code, usage: null, retryDelayMs });
        if (retryDelayMs !== undefined) await pause(retryDelayMs);
        else if (code !== 'model_invalid_envelope') break;
      }
    }
  }
  const last = attempts.at(-1);
  if (!last) return null;
  return { agentId: id, provider: last.provider, model: last.model, durationMs: performance.now() - started, attempts };
}

const transferRules = new Set(['new_payee', 'fresh_payee', 'amount_spike', 'transfer_burst', 'sensitive_payee_transition']);
const transferTopics = new Map([
  ['new_payee', 'new payment recipient'], ['fresh_payee', 'recently registered recipient'],
  ['amount_spike', 'amount above historical baseline'], ['transfer_burst', 'burst of transfers'],
  ['sensitive_payee_transition', 'payee registration after timing shift and recent account activity'],
]);

export function fingerprintQuery(risk: RiskAssessment) {
  const topics = risk.evidence.flatMap((item) => [evidenceTopics.get(item.id) ?? transferTopics.get(item.id) ?? '']).filter(Boolean);
  return 'ContextCon suspicious transfer ' + topics.join(', ');
}

export async function investigateCollectively(
  caseId: string, kind: string, features: Features, risk: RiskAssessment, options: InvestigationOptions, graph?: GraphSnapshot,
  playbooks: readonly PlaybookReference[] = [],
): Promise<Investigation> {
  const team: AgentTrace[] = [];
  const specialistContexts: NonNullable<Investigation['specialistContexts']> = [];
  const learning = options.learning;
  const behaviour = risk.evidence.filter((item) => evidenceTopics.has(item.id));
  const transfer = risk.evidence.filter((item) => transferRules.has(item.id));
  let reuse: Reuse | null = null;
  let rejectedMemories: NonNullable<Investigation['rejectedMemories']> = [];

  async function recall(pack: Pack, query: string, agentId: string) {
    if (options.mode !== 'meko') return;
    const start = performance.now();
    let context: ContextTrace;
    try {
      const found = await learning?.recall(pack, query, agentId);
      context = found ? { status: 'ok', durationMs: performance.now() - start, matches: found.matches, lookup: found.lookup } :
        { status: 'not_configured', durationMs: 0, error: 'meko_pack_not_configured' };
      specialistContexts.push({ agentId, pack, context });
      return found;
    } catch (error) {
      context = { status: 'error', durationMs: performance.now() - start,
        error: failureCode(error, new AbortController().signal, 'meko_unavailable') };
      specialistContexts.push({ agentId, pack, context });
    }
  }

  if (kind === 'transfer' && transfer.length && behaviour.length && learning && options.mode === 'meko') {
    const result = await recall('confirmed', options.advanced ? fingerprintQuery(risk) : FINGERPRINT_QUERY, TRANSFER_AGENT);
    if (result) ({ reuse, rejected: rejectedMemories } = await learning.validateRecall(caseId, risk, result, options.advanced));
  }

  const plans: { id: string; evidence: RiskAssessment['evidence']; prompt: string; query: string; input: object }[] = [];
  if (!reuse && behaviour.length) plans.push({
    id: LOGIN_AGENT, evidence: behaviour, prompt: instruction,
    query: 'ContextCon provisional login timing and reset observation',
    input: {
      behaviourDeviations: features.behaviourDeviations, failedLogins15m: features.failedLogins15m,
      passwordResets30m: features.passwordResets30m,
    },
  });

  const device = options.advanced ? describeDeviceEvidence(features, risk) : null;
  if (device?.evidence.length) plans.push({
    id: DEVICE_AGENT, evidence: device.evidence, query: 'ContextCon provisional ' + device.queryTopics.join(', '),
    prompt: 'Assess synthetic device, login, location and network evidence. Cite only supplied IDs. Shared identifiers or travel alone cannot establish fraud. Respond with JSON.',
    input: device.input,
  });

  if (transfer.length) plans.push({
    id: TRANSFER_AGENT, evidence: transfer,
    query: options.advanced ? 'ContextCon provisional ' + transfer.map((item) => transferTopics.get(item.id)).join(', ') :
      'ContextCon provisional unusual transfer and newly registered payee observation',
    prompt: 'Assess transaction amount and payee or velocity evidence. Cite active rule IDs, identify benign explanations and return JSON.',
    input: { amountRatio: features.amountRatio, transfers10m: features.transfers10m,
      payeeAgeMinutes: features.payeeAgeMinutes, verifiedCaseReference: reuse ? { version: reuse.version } : null },
  });

  const links = options.advanced && graph ? graphAssessment(graph) : null;
  if (links?.evidence.length) plans.push({
    id: GRAPH_AGENT, evidence: links.evidence, query: links.query,
    prompt: 'Assess the supplied graph paths. Copy one or two evidence IDs exactly. Explain corroboration or a benign shared identifier in one short sentence. Return JSON with an advisory action.',
    input: links.input,
  });

  const receiving = [TRANSFER_AGENT, DEVICE_AGENT, GRAPH_AGENT, LOGIN_AGENT].find((id) => plans.some((plan) => plan.id === id));
  let prior: ProvisionalSignal[] = [];
  let provisionalContextError: string | undefined;
  const loadPrior = async () => {
    if (!receiving || !options.advanced || options.mode !== 'meko' || !learning) return;
    try {
      prior = await learning.previousSignals(caseId, receiving);
    } catch (error) {
      provisionalContextError = failureCode(error, new AbortController().signal, 'meko_signal_unavailable');
    }
  };
  // Approved playbook passages from the Meko knowledge base, verified against the local registry.
  let knowledge: KnowledgeTrace | undefined;
  const loadKnowledge = async () => {
    if (options.mode !== 'meko' || !options.advanced || !learning) return;
    const topics = risk.evidence.map((item) => evidenceTopics.get(item.id) ?? transferTopics.get(item.id) ?? item.id.replaceAll('_', ' '));
    const query = 'Fraud playbook investigation checklist for ' + topics.join(', ');
    const started = performance.now();
    try {
      const found = await learning.knowledgeContext(query, investigatorId);
      if (found) knowledge = { status: 'ok', query, durationMs: performance.now() - started, ...found, passages: found.bound };
    } catch (error) {
      knowledge = { status: 'error', query, durationMs: performance.now() - started,
        error: failureCode(error, new AbortController().signal, 'meko_knowledge_unavailable') };
    }
  };
  await Promise.all([
    ...plans.map((plan) => recall('risk', plan.query, plan.id)),
    loadPrior(),
    loadKnowledge(),
  ]);

  // Keep model scheduling serial per case. Parallel Meko reads do not consume local model slots.
  const consumed: ProvisionalSignal[] = [];
  for (const plan of plans) {
    const priorForAgent = prior.filter((item) => item.receivingAgent === plan.id);
    const input = priorForAgent.length ? { ...plan.input,
      earlierProvisionalSignals: priorForAgent.map(({ originAgent, evidenceIds, crossSession }) => ({ originAgent, evidenceIds, crossSession })),
    } : plan.input;
    const prompt = priorForAgent.length ? plan.prompt + ' Consider earlier provisional signals as context only. Cite current evidence IDs. ' : plan.prompt;
    const agent = await runAgent(plan.id, caseId, plan.evidence, prompt, input, options);
    if (!agent) continue;
    if (agent.result && priorForAgent.length) {
      agent.result.retrievedMemoryIds.push(...priorForAgent.map((item) => item.memoryId));
      consumed.push(...priorForAgent);
    }
    if (reuse && agent.result && plan.id === TRANSFER_AGENT) agent.result.retrievedMemoryIds.push(reuse.memoryId);
    team.push(agent);
  }

  const available = team.flatMap((agent) => agent.result ? [{
    agentId: agent.agentId, evidenceIds: agent.result.evidenceIds,
    action: agent.result.recommendedAction, missing: agent.result.missingContext,
  }] : []);
  const conflict = new Set(available.map((item) => item.action)).size > 1;
  const missingCorroboration = options.advanced ?
    plans.filter((plan) => !available.some((item) => item.agentId === plan.id)).map((item) => item.id) :
    [
      ...(!reuse && !available.some((item) => item.agentId === LOGIN_AGENT) ? [LOGIN_AGENT] : []),
      ...(kind === 'transfer' && !available.some((item) => item.agentId === TRANSFER_AGENT) ? [TRANSFER_AGENT] : []),
    ];
  const supplied = new Set([...available.flatMap((item) => item.evidenceIds), ...(reuse?.evidence ?? [])]);
  const synthesisEvidence = [...new Map([...risk.evidence, ...plans.flatMap((plan) => plan.evidence)]
    .filter((item) => supplied.has(item.id)).map((item) => [item.id, item])).values()];
  const investigator = available.length || reuse ? await runAgent(
    investigatorId, caseId, synthesisEvidence,
    'Recommend one action with a single short sentence. Weigh specialist agreement and missing corroboration. Use only the supplied evidence. Treat approvedPlaybooks as review guidance, not evidence. The policy controls the final verdict.',
    { specialistResults: available, conflictingRecommendations: conflict, missingCorroboration,
      verifiedMemoryConditions: reuse?.evidence ?? [],
      // Approved, versioned guidance. Titles and checklist items only.
      ...(playbooks.length ? { approvedPlaybooks: playbooks.slice(0, 3).map(({ id, title, checklist }) => ({ id, title, checklist: checklist.slice(0, 4) })) } : {}),
      ...(knowledge?.status === 'ok' && knowledge.passages.length ? {
        approvedPlaybookPassages: knowledge.passages.slice(0, 2).map(({ playbookId, section, excerpt }) => ({ playbookId, section, excerpt: excerpt.slice(0, 280) })),
      } : {}),
      ...(consumed.length ? { earlierProvisionalSignals: consumed.map(({ evidenceIds, receivingAgent }) => ({ evidenceIds, receivingAgent })) } : {}),
    }, options, options.investigatorModel ?? options.model,
  ) : null;
  if (investigator) team.push(investigator);
  return {
    path: investigator?.result || reuse ? 'agent_review' : 'fallback',
    synthesis: {
      conflictingRecommendations: conflict, missingCorroboration,
      recommendation: investigator?.result?.recommendedAction ?? risk.preliminaryAction,
      basis: investigator?.result ? 'investigator_model' : 'deterministic_policy',
    },
    context: specialistContexts.find((item) => item.pack === 'confirmed')?.context ?? null,
    agent: investigator, team, reuse, rejectedMemories, specialistContexts, ...(knowledge ? { knowledge } : {}),
    ...(options.advanced ? { provisionalSignals: consumed, provisionalContextError } : {}),
    rationale: reuse
      ? 'The Transaction specialist retrieved an active verified fingerprint from Meko and matched its conditions. The behaviour review was skipped. Deterministic policy remains in force.'
      : consumed.length
        ? 'A different specialist received earlier provisional evidence from Meko and passed it to the Investigator alongside current evidence. Deterministic policy remains in force.'
        : rejectedMemories.length
          ? 'Retrieved fingerprints were rejected by verification or applicability checks. Full applicable reviews were attempted under deterministic policy.'
          : 'Applicable specialist reviews and Investigator synthesis were attempted. Deterministic policy remains in force.',
  };
}
