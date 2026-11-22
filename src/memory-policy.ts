import type pg from 'pg';
import type { FraudEvent } from './events.js';
import type { Evidence } from './risk.js';

/**
 * Verified-pattern policy.
 *
 * An analyst-confirmed attack is stored as an ordered list of session steps. Each step is
 * an event kind plus the deterministic rule IDs that fired on it. A later session on a
 * different account reuses that knowledge only when it reproduces the pattern's opening
 * steps in order, ending with the current event. No model participates in this decision.
 */
export const PATTERN_RULE = 'verified_pattern_match';
export const PATTERN_POINTS = 40;
/** At least two ordered steps must repeat. One step alone is never memory evidence. */
export const MIN_MATCHED_STEPS = 2;
/** The repeated steps must carry this much deterministic evidence, so weak context cannot block. */
export const MIN_MATCHED_POINTS = 40;
export const SESSION_WINDOW_MINUTES = 30;
export const MAX_PATTERN_STEPS = 12;
export const PATTERN_FRESHNESS_DAYS = 30;

export type MemoryPolicyMode = 'off' | 'shadow' | 'enforce';
export type PatternStep = { kind: FraudEvent['kind']; rules: string[] };
export type SessionStep = PatternStep & { points: Record<string, number> };
export type PatternMatch = { matchedSteps: number; totalSteps: number; points: number };

function toStep(kind: FraudEvent['kind'], evidence: readonly Pick<Evidence, 'id' | 'points'>[]): SessionStep {
  const points: Record<string, number> = {};
  for (const item of evidence) if (item.id !== PATTERN_RULE) points[item.id] = item.points;
  return { kind, rules: Object.keys(points).sort(), points };
}

/** Drop steps without rule evidence and collapse consecutive repeats of the same step. */
export function compactSteps(steps: readonly PatternStep[]): PatternStep[] {
  const compact: PatternStep[] = [];
  for (const step of steps) {
    if (!step.rules.length) continue;
    const rules = [...new Set(step.rules)].filter((id) => id !== PATTERN_RULE).sort();
    if (!rules.length) continue;
    const last = compact.at(-1);
    if (last && last.kind === step.kind && last.rules.join() === rules.join()) continue;
    compact.push({ kind: step.kind, rules });
  }
  return compact.slice(-MAX_PATTERN_STEPS);
}

function stepMatches(pattern: PatternStep, session: PatternStep) {
  if (pattern.kind !== session.kind) return false;
  const present = new Set(session.rules);
  return pattern.rules.every((id) => present.has(id));
}

/**
 * Longest prefix of `pattern` that occurs in order within `session` and whose last step
 * matches the current (final) session step. A pattern step matches when the session step
 * has the same kind and at least every rule the pattern step recorded.
 */
export function matchPattern(pattern: readonly PatternStep[], session: readonly SessionStep[]): PatternMatch | null {
  const current = session.at(-1);
  if (!current || !current.rules.length) return null;
  const earlier = session.slice(0, -1);
  for (let k = pattern.length; k >= MIN_MATCHED_STEPS; k--) {
    if (!stepMatches(pattern[k - 1]!, current)) continue;
    const used: SessionStep[] = [];
    let cursor = 0;
    for (const step of pattern.slice(0, k - 1)) {
      while (cursor < earlier.length && !stepMatches(step, earlier[cursor]!)) cursor++;
      if (cursor === earlier.length) break;
      used.push(earlier[cursor]!);
      cursor++;
    }
    if (used.length !== k - 1) continue;
    used.push(current);
    const points = used.reduce((sum, step, index) =>
      sum + pattern[index]!.rules.reduce((inner, id) => inner + (step.points[id] ?? 0), 0), 0);
    if (points < MIN_MATCHED_POINTS) continue;
    return { matchedSteps: k, totalSteps: pattern.length, points };
  }
  return null;
}

type StepRow = { kind: FraudEvent['kind']; evidence: Pick<Evidence, 'id' | 'points'>[] | null };

/**
 * Earlier steps from the same account and session in the preceding window. Without an
 * explicit session ID the account's own recent activity stands in for the session.
 */
export async function loadSessionSteps(
  db: Pick<pg.PoolClient, 'query'>, scope: { accountId: string; occurredAt: string; sessionId?: string | null; excludeId?: string },
) {
  const { rows } = await db.query<StepRow>(`
    SELECT e.kind, c.trace->'risk'->'evidence' AS evidence
    FROM events e JOIN cases c ON c.id = e.id
    WHERE e.account_id = $1 AND e.received_at <= statement_timestamp()
      AND e.occurred_at < $2::timestamptz
      AND e.occurred_at >= $2::timestamptz - make_interval(mins => $4)
      AND ($3::text IS NULL OR e.payload->>'sessionId' = $3::text)
      AND ($5::uuid IS NULL OR e.id <> $5::uuid)
    ORDER BY e.occurred_at, e.id
  `, [scope.accountId, scope.occurredAt, scope.sessionId ?? null, SESSION_WINDOW_MINUTES, scope.excludeId ?? null]);
  return rows.map((row) => toStep(row.kind, row.evidence ?? []));
}

export function currentStep(kind: FraudEvent['kind'], evidence: readonly Pick<Evidence, 'id' | 'points'>[]) {
  return toStep(kind, evidence);
}

export function sessionRules(steps: readonly PatternStep[]) {
  return [...new Set(steps.flatMap((step) => step.rules))].sort();
}

export function stepPoints(steps: readonly SessionStep[]) {
  return steps.reduce((sum, step) => sum + Object.values(step.points).reduce((a, b) => a + b, 0), 0);
}
