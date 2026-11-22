export type Action = 'ALLOW' | 'STEP_UP_VERIFICATION' | 'BLOCK';
export type EventKind = 'login' | 'login_failed' | 'password_reset' | 'payee_added' | 'transfer';
export type View = 'alerts' | 'review' | 'blocked' | 'memory' | 'all' | 'pending';

export type CaseSummary = {
  id: string; status: 'pending' | 'decided'; action: Action | null; createdAt: string; decidedAt: string | null; sortTime: string;
  kind: EventKind; accountId: string; occurredAt: string; sessionId: string | null; amountMinor: number | null; payeeId: string | null;
  score: string | number; path: string; modelCalls: number; rules: string[];
  memoryMatch: PatternMatch | null; memoryApplied: boolean; playbooks: string[]; reviewed: boolean;
};
export type PatternMatch = {
  publicationId: string; memoryId: string; originCase: string; version: number; matchedSteps: number; totalSteps: number; points: number;
};
export type Evidence = { id: string; points: number; detail: string; provenance: 'postgres_features' | 'verified_memory' };
export type Attempt = { provider: string; model: string; status: 'accepted' | 'rejected'; error?: string; durationMs: number;
  usage: { inputTokens: number | null; outputTokens: number | null } | null };
export type AgentTrace = {
  agentId: string; provider: string; model: string; durationMs: number; attempts: Attempt[];
  result?: { recommendedAction: Action; rationale: string; evidenceIds: string[]; confidence: number | null; riskScore: number | null;
    missingContext: string[]; retrievedMemoryIds: string[] };
};
export type PlaybookReference = { id: string; version: number; title: string; matchedTrigger: string[]; knowledgeBase: string; checklist: string[] };
export type GraphPath = {
  pathId: string; accounts: string[]; recentAuthenticationRiskEvents: number;
  priorConfirmedCase: { caseId: string } | null;
  links: { via: { type: string; id: string }; edges: { account: { id: string }; eventKind: EventKind; occurredAt: string }[] }[];
};
export type Trace = {
  eventKind: EventKind; sessionId?: string; path: string; rationale: string; modelCalls: number; durationMs: number;
  risk: { score: number; evidence: Evidence[]; thresholds: { challenge: number; block: number }; hardBlock: boolean; memoryBlock?: boolean };
  features: Record<string, unknown>;
  memoryPolicy?: { mode: 'shadow' | 'enforce'; match: PatternMatch | null; applied?: boolean; wouldAction?: Action | null;
    candidates?: number; conditionsUnmet?: number; sessionRules?: string[]; error?: string; durationMs: number };
  playbooks?: PlaybookReference[];
  knowledge?: { status: 'ok' | 'error'; query: string; durationMs: number; hits?: number; unverified?: number; error?: string;
    passages?: { documentId: string | null; playbookId: string; version: number; section: string; excerpt: string; score: number | null }[] };
  team?: AgentTrace[];
  agent: AgentTrace | null;
  synthesis?: { conflictingRecommendations: boolean; missingCorroboration: string[]; recommendation: Action; basis: string };
  reuse?: { publicationId: string; memoryId: string; originCase: string; originAgent: string; retrievingAgent: string; version: number } | null;
  rejectedMemories?: { memoryId: string; reason: string }[];
  provisionalSignals?: { memoryId: string; originAgent: string; receivingAgent: string; evidenceIds: string[]; crossSession: boolean }[];
  graph?: { paths: GraphPath[]; directAccountCounts: Record<string, number> };
};
export type CaseRecord = { id: string; status: 'pending' | 'decided'; action: Action | null; trace: Trace; created_at: string; decided_at: string | null };
export type Publication = { id: string; pack: 'risk' | 'confirmed'; kind: string; state: string; attempts: number; version: string | null;
  verifiedAt: string | null; supersededAt: string | null; revokedAt: string | null; lastError: string | null };
export type CaseContext = { session: CaseSummary[]; feedback: { request: Record<string, string>; publicationId: string | null; createdAt: string } | null; publications: Publication[] };
export type Overview = {
  config: { mode: string; profile: string; memoryPolicy: string; memoryStore: 'meko' | 'local' | 'none'; feedbackEnabled: boolean };
  counts: { events: number; pending: number; allowed: number; stepUps: number; blocks: number; memoryBlocks: number; modelCalls: number; reviews: number };
  memory: { activePatterns: number; patternVersions: number; publications: { pack: string; state: string; count: number }[] };
  playbooks: number;
};
export type Pattern = {
  id: string; state: string; remoteId: string | null; verifiedAt: string | null; supersededAt: string | null; revokedAt: string | null;
  revocationReason: string | null; lastError: string | null; pattern: string | null; version: number; originCase: string; feedbackCase: string | null;
  supersedes: string | null; originAgent: string; steps: { kind: EventKind; rules: string[] }[] | null; conditions: string[];
  required: string[]; evidence: string[]; confirmations: number; matches: number; actionsChanged: number; originAccount: string | null;
};
export type Playbook = { id: string; version: number; title: string; checksum: string; body: string; triggers: string[][]; checklist: string[];
  loadedAt: string; knowledgeBase: string; checkedAt: string | null; error: string | null; cases: number };

async function json<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error((body as { error?: string } | null)?.error ?? 'HTTP ' + response.status);
  return body as T;
}
const get = <T,>(path: string) => fetch(path).then((response) => json<T>(response));
const post = <T,>(path: string, body: unknown) => fetch(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((response) => json<T>(response));

export const api = {
  overview: () => get<Overview>('/api/overview'),
  cases: (view: View, before?: { sortTime: string; id: string }) => get<{ items: CaseSummary[] }>('/api/cases?view=' + view + '&limit=60' +
    (before ? '&before=' + encodeURIComponent(before.sortTime) + '&beforeId=' + before.id : '')),
  case: (id: string) => get<CaseRecord>('/api/cases/' + id),
  context: (id: string) => get<CaseContext>('/api/cases/' + id + '/context'),
  patterns: () => get<{ items: Pattern[] }>('/api/memory/patterns'),
  playbooks: () => get<{ items: Playbook[] }>('/api/playbooks'),
  confirm: (id: string) => post<Publication>('/api/cases/' + id + '/feedback', { verdict: 'fraud_confirmed' }),
  correct: (id: string, publicationId: string, require: string) =>
    post<Publication>('/api/cases/' + id + '/feedback', { verdict: 'legitimate_correction', publicationId, require }),
  revoke: (publicationId: string, reason: 'invalid_confirmation' | 'incorrect_generalization') =>
    post<Publication>('/api/memory-publications/' + publicationId + '/revoke', { reason }),
};
