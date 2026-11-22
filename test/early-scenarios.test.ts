import { describe, expect, it } from 'vitest';
import { earlyScenarios, evaluateEarlyCorpus, generateEarlyCorpus, type EarlyCorpus, type EvaluationDecision } from '../src/early-scenarios.js';
import { eventSchema } from '../src/events.js';

function allowAll(corpus: EarlyCorpus) {
  return new Map<string, EvaluationDecision>(corpus.events.map((event) => [event.id, { action: 'ALLOW' }]));
}

function firstCorpus(challengePasses: boolean) {
  for (let seed = 0; seed < 128; seed++) {
    const corpus = generateEarlyCorpus({ split: 'evaluation', seed, maxEvents: 20, scenario: 'velocity' });
    if (corpus.episodes[0]?.challengePasses === challengePasses) return corpus;
  }
  throw new Error('Fixture seed range did not include the requested synthetic challenge result');
}

describe('deterministic temporal eval corpus', () => {
  it('emits a near-2,000-event chronological held-out tape without labels in payloads', () => {
    const options = { split: 'evaluation', seed: 7403, maxEvents: 2000 } as const;
    const corpus = generateEarlyCorpus(options);
    expect(corpus.events).toEqual(generateEarlyCorpus(options).events);
    expect(corpus.events.length).toBeGreaterThan(1980);
    expect(corpus.events.length).toBeLessThanOrEqual(2000);
    expect(new Set(corpus.episodes.map((episode) => episode.scenario))).toEqual(new Set(earlyScenarios));
    expect(new Set(corpus.events.map((event) => event.id)).size).toBe(corpus.events.length);
    expect(corpus.events.map((event) => event.timestamp)).toEqual(corpus.events.map((event) => event.timestamp).sort());
    expect(corpus.events.every((event) => eventSchema.safeParse(event).success)).toBe(true);
    expect(corpus.events.some((event) => Object.hasOwn(event, 'scenario') || Object.hasOwn(event, 'malicious'))).toBe(false);
    const developmentIds = new Set(generateEarlyCorpus({ ...options, split: 'development' }).events.map((event) => event.id));
    expect(corpus.events.some((event) => developmentIds.has(event.id))).toBe(false);
  });

  it('supports chronological failed login observations ahead of the credential-stuffing reset and access impact', () => {
    const corpus = generateEarlyCorpus({ split: 'evaluation', seed: 7403, maxEvents: 20, scenario: 'credential-stuffing' });
    const current = corpus.events.filter((event) => corpus.labels.get(event.id)?.phase !== 'warmup');
    expect(current.slice(0, -2).map((event) => event.kind)).toEqual(Array(current.length - 2).fill('login_failed'));
    expect(current.slice(-2).map((event) => event.kind)).toEqual(['password_reset', 'login']);
    expect(new Set(current.map((event) => event.sessionId)).size).toBe(1);
  });
});

describe('effect ledger for simulated interventions', () => {
  it('separates a successful early alert from prevention if the attacker passes a challenge', () => {
    const corpus = firstCorpus(true);
    const decisions = allowAll(corpus);
    const registration = corpus.events.find((event) => event.kind === 'payee_added')!;
    decisions.set(registration.id, { action: 'STEP_UP_VERIFICATION' });

    const report = evaluateEarlyCorpus(corpus, decisions);
    expect(report.classification.tp).toBe(1);
    expect(report.attacks.alertedBeforeImpact).toBe(1);
    expect(report.attacks.alertLeadSeconds.p50).toBe(270);
    expect(report.attacks.alertLeadSteps.p50).toBe(1);
    expect(report.episodes[0]?.alertLeadSteps).toBe(1);
    expect(report.attacks.preventedBeforeImpact).toBe(0);
    expect(report.attacks.simulatedTransferHarmPreventedMinor).toBe(0);
    expect(report.episodes[0]?.impactOutcome).toBe('executed');
  });

  it('counts impact held by a failed challenge separately from a block at impact', () => {
    const corpus = firstCorpus(false);
    const decisions = allowAll(corpus);
    const registration = corpus.events.find((event) => event.kind === 'payee_added')!;
    decisions.set(registration.id, { action: 'STEP_UP_VERIFICATION' });
    const report = evaluateEarlyCorpus(corpus, decisions);
    expect(report.attacks.preventedByFailedChallenge).toBe(1);
    expect(report.attacks.preventedBeforeImpact).toBe(1);
    expect(report.attacks.simulatedTransferHarmPreventedMinor).toBeGreaterThan(0);

    const late = allowAll(corpus);
    late.set(corpus.episodes[0]!.impactId!, { action: 'BLOCK' });
    const lateReport = evaluateEarlyCorpus(corpus, late);
    expect(lateReport.attacks.alertedBeforeImpact).toBe(0);
    expect(lateReport.attacks.preventedAtImpact).toBe(1);
    expect(lateReport.attacks.preventedByBlock).toBe(1);
  });

  it('does not treat a flag on a different account/session as preventing the target impact', () => {
    const corpus = generateEarlyCorpus({ split: 'evaluation', seed: 7403, maxEvents: 20, scenario: 'coordinated' });
    const decisions = allowAll(corpus);
    const impact = corpus.events.find((event) => event.id === corpus.episodes[0]?.impactId)!;
    const peer = corpus.events.find((event) => event.accountId !== impact.accountId)!;
    decisions.set(peer.id, { action: 'BLOCK' });
    const report = evaluateEarlyCorpus(corpus, decisions);
    expect(report.attacks.alertedBeforeImpact).toBe(1);
    expect(report.attacks.executed).toBe(1);
    expect(report.attacks.simulatedTransferHarmPreventedMinor).toBe(0);
  });

  it('reports legitimate verification friction as a false-positive recommendation even when verification succeeds', () => {
    const corpus = generateEarlyCorpus({ split: 'evaluation', seed: 7403, maxEvents: 20, scenario: 'legitimate-burst' });
    const decisions = allowAll(corpus);
    decisions.set(corpus.events.find((event) => event.kind === 'payee_added')!.id, { action: 'STEP_UP_VERIFICATION' });
    const report = evaluateEarlyCorpus(corpus, decisions);
    expect(report.classification.fp).toBe(1);
    expect(report.legitimateStepUpRate).toBeGreaterThan(0);
    expect(report.episodes[0]?.challengeOutcomeIfRequested).toBe('pass');
    expect(report.attacks.total).toBe(0);
  });
});
describe('hard negatives and encounter reporting', () => {
  it('adds the opt-in recovery sessions without changing the default tape', () => {
    const options = { split: 'evaluation', seed: 7403, maxEvents: 400 } as const;
    expect(generateEarlyCorpus(options).episodes.some((episode) => episode.scenario === 'legitimate-recovery')).toBe(false);
    const withNegatives = generateEarlyCorpus({ ...options, hardNegatives: true });
    const recovery = withNegatives.episodes.find((episode) => episode.scenario === 'legitimate-recovery');
    expect(recovery).toMatchObject({ malicious: false, impactId: null });
  });

  it('separates first and repeat encounters by when a confirmed pattern became active', () => {
    const corpus = generateEarlyCorpus({ split: 'evaluation', seed: 7403, maxEvents: 200, scenario: 'takeover' });
    const starts = corpus.episodes.map((episode) => Math.min(...corpus.events
      .filter((event) => corpus.labels.get(event.id)?.episodeId === episode.id && corpus.labels.get(event.id)?.phase !== 'warmup')
      .map((event) => Date.parse(event.timestamp))));
    const report = evaluateEarlyCorpus(corpus, allowAll(corpus), new Map([['takeover', starts[1]!]]));
    expect(report.episodes.map((episode) => episode.encounter)).toEqual(starts.map((_, index) => index === 0 ? 'first' : 'repeat'));
    expect(report.attacks.byEncounter.first.total + report.attacks.byEncounter.repeat.total).toBe(corpus.episodes.length);
  });
});
