import { describe, expect, it } from 'vitest';
import { compactSteps, matchPattern, PATTERN_POINTS, type SessionStep } from '../src/memory-policy.js';
import type { Features } from '../src/features.js';
import { scoreRisk } from '../src/risk.js';

const points: Record<string, number> = {
  behaviour_shift: 18, new_device: 14, sensitive_payee_transition: 12, amount_spike: 20, fresh_payee: 14, new_payee: 10,
  transfer_burst: 18, recent_reset: 12, login_pressure: 20,
};
function step(kind: SessionStep['kind'], ...rules: string[]): SessionStep {
  return { kind, rules: [...rules].sort(), points: Object.fromEntries(rules.map((id) => [id, points[id] ?? 0])) };
}
const takeover = compactSteps([
  step('login', 'behaviour_shift', 'new_device'),
  step('password_reset', 'behaviour_shift'),
  step('payee_added', 'behaviour_shift', 'sensitive_payee_transition'),
  step('transfer', 'amount_spike', 'behaviour_shift', 'fresh_payee', 'new_payee', 'recent_reset'),
]);

describe('verified-pattern matching', () => {
  it('matches the longest ordered prefix that ends on the current step', () => {
    const session = [step('login', 'behaviour_shift', 'new_device'), step('password_reset', 'behaviour_shift')];
    expect(matchPattern(takeover, session)).toEqual({ matchedSteps: 2, totalSteps: 4, points: 50 });
    expect(matchPattern(takeover, [...session, step('payee_added', 'behaviour_shift', 'sensitive_payee_transition')]))
      .toMatchObject({ matchedSteps: 3 });
  });

  it('tolerates extra rules and unrelated steps but not missing pattern rules', () => {
    const noisy = [
      step('login', 'behaviour_shift', 'new_device', 'shared_network'),
      step('transfer'),
      step('password_reset', 'behaviour_shift', 'new_device'),
    ];
    expect(matchPattern(takeover, noisy)).toMatchObject({ matchedSteps: 2 });
    expect(matchPattern(takeover, [step('login', 'new_device'), step('password_reset', 'behaviour_shift')])).toBeNull();
  });

  it('never matches on one step, an empty current step, or out of order', () => {
    expect(matchPattern(takeover, [step('login', 'behaviour_shift', 'new_device')])).toBeNull();
    expect(matchPattern(takeover, [step('login', 'behaviour_shift', 'new_device'), step('transfer')])).toBeNull();
    expect(matchPattern(takeover, [step('password_reset', 'behaviour_shift'), step('login', 'behaviour_shift', 'new_device')])).toBeNull();
  });

  it('keeps legitimate bursts that lack the attack amount away from a velocity pattern', () => {
    const velocity = compactSteps([
      step('payee_added', 'behaviour_shift', 'sensitive_payee_transition'),
      step('transfer', 'amount_spike', 'fresh_payee', 'new_payee'),
    ]);
    const burst = [step('payee_added', 'behaviour_shift', 'sensitive_payee_transition'), step('transfer', 'fresh_payee', 'new_payee', 'transfer_burst')];
    expect(matchPattern(velocity, burst)).toBeNull();
  });

  it('requires minimum evidence weight across the repeated steps', () => {
    const weak = compactSteps([step('login', 'new_device'), step('transfer', 'new_payee')]);
    expect(matchPattern(weak, [step('login', 'new_device'), step('transfer', 'new_payee')])).toBeNull();
  });

  it('compacts repeated and empty steps', () => {
    expect(compactSteps([
      step('login_failed', 'new_device'), step('login_failed', 'new_device'), step('login'),
      step('login_failed', 'login_pressure', 'new_device'),
    ]).map((item) => item.kind + ':' + item.rules.join('+'))).toEqual([
      'login_failed:new_device', 'login_failed:login_pressure+new_device',
    ]);
  });
});

describe('verified-pattern policy in scoring', () => {
  const features = {
    historyCount30d: 10, failedLogins15m: 0, passwordResets30m: 0, transfers10m: 0, newDevice: false, newPayee: false,
    payeeAgeMinutes: null, amountMinor: null, amountHistoryCount: 0, historicalAmountMean: null, amountRatio: null,
    priorLoginId: null, distanceKm: null, travelSpeedKmh: null, sharedDeviceAccounts24h: 0, sharedNetworkAccounts24h: 0,
    behaviourSamples: 5, behaviourDeviations: { dwell: 4, flight: 4, interaction: 1 }, behaviourOutliers: 2,
  } satisfies Features;
  const policy = { challenge: 25, block: 72 };
  const memory = { points: PATTERN_POINTS, detail: 'test pattern' };

  it('blocks an eligible event below the score threshold and records the memory evidence', () => {
    const without = scoreRisk('password_reset', features, policy);
    const withMemory = scoreRisk('password_reset', features, policy, false, memory);
    expect(without.preliminaryAction).toBe('ALLOW');
    expect(withMemory).toMatchObject({ preliminaryAction: 'BLOCK', memoryBlock: true, score: 58 });
    expect(withMemory.evidence.at(-1)).toMatchObject({ id: 'verified_pattern_match', provenance: 'verified_memory' });
  });

  it('keeps a failed login as an observation even when memory matches', () => {
    expect(scoreRisk('login_failed', features, policy, false, memory)).toMatchObject({ preliminaryAction: 'ALLOW', memoryBlock: false });
  });
});
