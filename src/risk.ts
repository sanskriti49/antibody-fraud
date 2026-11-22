import { z } from 'zod';
import type { FraudEvent } from './events.js';
import type { Features } from './features.js';

export const actionSchema = z.enum(['ALLOW', 'STEP_UP_VERIFICATION', 'BLOCK']);
export type Action = z.infer<typeof actionSchema>;
export type RiskPolicy = { challenge: number; block: number };
export type Evidence = { id: string; points: number; detail: string; provenance: 'postgres_features' | 'verified_memory' };
/** A verified attack pattern that the current session reproduces. See memory-policy.ts. */
export type MemoryEvidence = { points: number; detail: string };

export function scoreRisk(
  kind: FraudEvent['kind'], features: Features, policy: RiskPolicy, earlySession = false, memory?: MemoryEvidence,
) {
  const evidence: Evidence[] = [];
  function add(condition: boolean, id: string, points: number, detail: string) {
    if (condition) evidence.push({ id, points, detail, provenance: 'postgres_features' });
  }

  const transfer = kind === 'transfer';
  const loginPressure = features.failedLogins15m >= 3;
  const impossibleTravel = (features.distanceKm ?? 0) >= 500 && (features.travelSpeedKmh ?? 0) >= 1_000;
  const behaviouralShift = features.behaviourOutliers >= 2;
  const amountSpike = transfer && (features.amountRatio ?? 0) >= 3 && (features.amountMinor ?? 0) >= 25_000;
  const burst = transfer && features.transfers10m >= 3;
  const freshPayee = transfer && features.newPayee && (features.payeeAgeMinutes ?? Infinity) <= 15;

  add(loginPressure, 'login_pressure', 20, features.failedLogins15m + ' preceding failed logins in 15 minutes');
  add(transfer && features.passwordResets30m > 0, 'recent_reset', 12, 'Password reset observed in the preceding 30 minutes');
  add(features.newDevice && features.historyCount30d > 0, 'new_device', 14, 'Device absent from prior non-failed activity in 30 days');
  add(transfer && features.newPayee, 'new_payee', 10, 'No prior transfer to this payee in 30 days');
  add(freshPayee, 'fresh_payee', 14, 'First transfer to a payee registered in the preceding 15 minutes');
  add(amountSpike, 'amount_spike', 20, 'Amount is at least three times the historical transfer mean');
  add(burst, 'transfer_burst', 18, features.transfers10m + ' preceding transfers in 10 minutes');
  add(impossibleTravel, 'impossible_travel', 26, 'Prior successful login implies at least 500 km of travel at 1,000 km/h or more');
  add(behaviouralShift, 'behaviour_shift', 18, features.behaviourOutliers + ' timing features are at least three standard deviations from baseline');
  add(features.sharedDeviceAccounts24h >= 2, 'shared_device', 8, 'Device seen on at least two other accounts in 24 hours');
  add(features.sharedNetworkAccounts24h >= 2, 'shared_network', 4, 'Network seen on at least two other accounts in 24 hours');

  // An observation is never enforced. A later sensitive action must independently link
  // account pressure to the unfamiliar device and an explicit synthetic session.
  if (earlySession) {
    const challengedReset = kind === 'password_reset' && loginPressure && features.newDevice &&
      features.historyCount30d > 0 && (features.deviceContext?.failedLoginsOnDevice15m ?? 0) >= 2;
    const payeeAfterRiskShift = kind === 'payee_added' && behaviouralShift &&
      (features.passwordResets30m > 0 || features.transfers10m >= 2);
    add(challengedReset, 'reset_after_device_failures', 12, 'Sensitive reset followed repeated failed authentication on this unfamiliar device');
    add(payeeAfterRiskShift, 'sensitive_payee_transition', 12, 'New payee registration follows a reset or recent transfers during an independent timing shift');
  }

  // Analyst-confirmed knowledge is the only memory allowed to change an action. Provisional
  // observations never reach this function.
  if (memory) evidence.push({ id: 'verified_pattern_match', points: memory.points, detail: memory.detail, provenance: 'verified_memory' });

  const score = Math.min(100, evidence.reduce((sum, item) => sum + item.points, 0));
  const hardBlock = (loginPressure && impossibleTravel && features.newDevice) ||
    (transfer && amountSpike && burst && freshPayee);
  const eligible = kind !== 'login_failed';
  const memoryBlock = eligible && Boolean(memory);
  const block = eligible && ((hardBlock && score >= policy.block) || memoryBlock);
  const needsInvestigation = eligible && !block && score >= policy.challenge;

  return {
    score, evidence, thresholds: policy, hardBlock, memoryBlock, needsInvestigation,
    preliminaryAction: (block ? 'BLOCK' : needsInvestigation ? 'STEP_UP_VERIFICATION' : 'ALLOW') as Action,
  };
}

// Traces stored before the verified-pattern policy have no memoryBlock field.
export type RiskAssessment = Omit<ReturnType<typeof scoreRisk>, 'memoryBlock'> & { memoryBlock?: boolean };
