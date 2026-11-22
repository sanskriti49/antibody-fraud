import { createHash } from 'node:crypto';
import { eventSchema, type FraudEvent } from './events.js';
import type { Action } from './risk.js';

export const earlyScenarios = [
  'credential-stuffing', 'velocity', 'takeover', 'coordinated',
  'ordinary', 'legitimate-travel', 'shared-household', 'shared-office', 'legitimate-burst',
] as const;
/**
 * Opt-in legitimate sessions that reproduce an attack's opening steps. The default corpus
 * excludes them so earlier benchmarks stay reproducible.
 */
export const hardNegativeScenarios = ['legitimate-recovery'] as const;
export const allEarlyScenarios = [...earlyScenarios, ...hardNegativeScenarios] as const;
export type EarlyScenario = typeof allEarlyScenarios[number];
export type CorpusSplit = 'development' | 'evaluation';

type Phase = 'warmup' | 'observation' | 'action' | 'impact';
type Episode = {
  id: string;
  scenario: EarlyScenario;
  malicious: boolean;
  impactId: string | null;
  impactKind: 'account_access' | 'transfer' | null;
  challengePasses: boolean;
};
type EventLabel = { episodeId: string; phase: Phase };

export type EarlyCorpus = {
  split: CorpusSplit;
  seed: number;
  maxEvents: number;
  episodes: Episode[];
  events: FraudEvent[];
  labels: ReadonlyMap<string, EventLabel>;
};

const attacks = new Set<EarlyScenario>(['credential-stuffing', 'velocity', 'takeover', 'coordinated']);
const evaluationAnchor = Date.parse('2026-11-01T12:00:00.000Z');
const developmentAnchor = Date.parse('2026-08-01T12:00:00.000Z');
const minuteMs = 60_000;
const home = { latitude: 19.076, longitude: 72.8777 };
const near = { latitude: 18.5204, longitude: 73.8567 };
const away = { latitude: 51.5072, longitude: -0.1276 };

function hash(value: string) {
  return createHash('sha256').update(value).digest();
}

function id(key: string) {
  const bytes = hash(key).subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20);
}

type EventDetails = Partial<Pick<FraudEvent, 'accountId' | 'sessionId' | 'deviceId' | 'networkId' | 'location' | 'behaviour'>> & {
  payeeId?: string;
  amountMinor?: number;
};

function createEpisode(split: CorpusSplit, seed: number, ordinal: number, scenario: EarlyScenario) {
  const namespace = 'early-evaluation-v1:' + split + ':' + seed + ':' + ordinal + ':' + scenario;
  const handle = hash(namespace).subarray(0, 12).toString('hex');
  const scenarioRandom = hash(namespace + ':variation');
  const malicious = attacks.has(scenario);
  const episode: Episode = {
    id: 'ep-' + handle, scenario, malicious, impactId: null, impactKind: null,
    // A synthetic policy-independent challenge response. Some attacks can pass.
    challengePasses: !malicious || scenarioRandom[0]! % 5 === 0,
  };

  const minuteAnchor = (split === 'evaluation' ? evaluationAnchor : developmentAnchor) + ordinal * 51 * minuteMs;
  const accountId = 'acct-' + handle;
  const sessionId = 'sess-' + handle + '-current';
  const deviceId = 'dev-' + handle;
  const unfamiliar = 'dev-' + handle + '-recent';
  const networkId = 'net-' + handle;
  const changedNetwork = 'net-' + handle + '-secondary';
  const sharedNetwork = 'net-' + handle + '-shared';
  const usualPayee = 'payee-' + handle;
  const newPayee = 'payee-' + handle + '-current';
  const baselineAmount = 5200 + scenarioRandom[1]! * 15;
  const regular = {
    dwellMs: 91 + scenarioRandom[2]! % 23,
    flightMs: 133 + scenarioRandom[3]! % 29,
    interactionMs: 610 + scenarioRandom[4]! % 71,
  };
  const shifted = {
    dwellMs: 19 + scenarioRandom[5]! % 12,
    flightMs: 22 + scenarioRandom[6]! % 18,
    interactionMs: 139 + scenarioRandom[7]! % 49,
  };
  const shiftedLocation = scenarioRandom[8]! % 3 === 0 ? away : near;
  const events: FraudEvent[] = [];
  const labels = new Map<string, EventLabel>();

  function emit(minutes: number, kind: FraudEvent['kind'], phase: Phase, details: EventDetails = {},
    impactKind: Episode['impactKind'] = null) {
    const eventId = id(namespace + ':event:' + events.length);
    const event = eventSchema.parse({
      id: eventId, kind, timestamp: new Date(minuteAnchor + minutes * minuteMs).toISOString(),
      accountId, sessionId, deviceId, networkId, location: home, ...details,
    });
    events.push(event);
    labels.set(eventId, { episodeId: episode.id, phase });
    if (impactKind) {
      episode.impactId = eventId;
      episode.impactKind = impactKind;
    }
  }

  // Establish a point-in-time baseline for this account without exposing labels.
  for (let age = 5; age >= 1; age--) {
    const jitter = scenarioRandom[age + 11]! % 9 - 4;
    const historySession = 'sess-' + handle + '-history-' + age;
    emit(-1440 * age, 'login', 'warmup', {
      sessionId: historySession,
      behaviour: {
        dwellMs: regular.dwellMs + jitter,
        flightMs: regular.flightMs - jitter,
        interactionMs: regular.interactionMs + 3 * jitter,
      },
    });
    emit(-1440 * age + 6, 'transfer', 'warmup', {
      sessionId: historySession, payeeId: usualPayee, amountMinor: baselineAmount + 30 * jitter,
    });
  }

  const newDeviceSession = { deviceId: unfamiliar, networkId: changedNetwork, location: shiftedLocation };
  const impactAmount = 52_000 + scenarioRandom[9]! * 200;
  const burstSize = 2 + scenarioRandom[10]! % 2;

  switch (scenario) {
    case 'credential-stuffing': {
      const failureCount = 4 + scenarioRandom[10]! % 2;
      // Failed attempts are observations. An attempted reset can trigger a gate
      // before the later successful-credential access attempt.
      for (let step = 0; step < failureCount; step++) {
        emit(step * 0.75, 'login_failed', 'observation', newDeviceSession);
      }
      emit(4, 'password_reset', 'action', { ...newDeviceSession, behaviour: shifted });
      emit(8, 'login', 'impact', { ...newDeviceSession, behaviour: shifted }, 'account_access');
      break;
    }
    case 'velocity':
    case 'legitimate-burst': {
      emit(-1, 'login', 'action', { behaviour: regular });
      for (let step = 0; step < burstSize; step++) {
        emit(0.5 + step, 'transfer', 'action', { payeeId: usualPayee, amountMinor: baselineAmount + 270 });
      }
      emit(3.5, 'payee_added', 'action', { payeeId: newPayee, behaviour: shifted });
      emit(8, 'transfer', malicious ? 'impact' : 'action', {
        payeeId: newPayee, amountMinor: malicious ? impactAmount : baselineAmount + 3100,
      }, malicious ? 'transfer' : null);
      break;
    }
    case 'takeover':
      emit(0, 'login', 'action', { ...newDeviceSession, behaviour: shifted });
      emit(2, 'password_reset', 'action', { ...newDeviceSession, behaviour: shifted });
      emit(4, 'payee_added', 'action', { ...newDeviceSession, payeeId: newPayee, behaviour: shifted });
      emit(9, 'transfer', 'impact', {
        ...newDeviceSession, payeeId: newPayee, amountMinor: impactAmount, behaviour: shifted,
      }, 'transfer');
      break;
    case 'coordinated': {
      // The peers intentionally overlap device, network and destination with the target.
      for (let peer = 1; peer <= 3; peer++) {
        const linked = {
          accountId: accountId + '-' + peer, sessionId: sessionId + '-' + peer,
          deviceId: peer === 3 ? 'dev-' + handle + '-peer' : unfamiliar, networkId: sharedNetwork,
        };
        emit(-7 + peer, 'login', 'action', linked);
        emit(-3 + peer * 0.5, 'transfer', 'action', {
          ...linked, payeeId: newPayee, amountMinor: baselineAmount + peer * 110,
        });
      }
      const target = { deviceId: unfamiliar, networkId: sharedNetwork, behaviour: shifted };
      emit(1, 'login', 'action', target);
      emit(3, 'payee_added', 'action', { ...target, payeeId: newPayee });
      emit(8, 'transfer', 'impact', { ...target, payeeId: newPayee, amountMinor: impactAmount }, 'transfer');
      break;
    }
    case 'shared-household':
    case 'shared-office':
      for (let peer = 1; peer <= 3; peer++) {
        const linked = {
          accountId: accountId + '-' + peer, sessionId: sessionId + '-' + peer,
          deviceId: scenario === 'shared-household' ? deviceId : deviceId + '-work-' + peer,
          networkId: sharedNetwork,
        };
        emit(-7 + peer, 'login', 'action', { ...linked, behaviour: regular });
        emit(-3 + peer * 0.5, 'transfer', 'action', {
          ...linked, payeeId: usualPayee, amountMinor: baselineAmount + 140 * peer,
        });
      }
      emit(1, 'login', 'action', { networkId: sharedNetwork, behaviour: regular });
      emit(5, 'transfer', 'action', { networkId: sharedNetwork, payeeId: usualPayee, amountMinor: baselineAmount + 350 });
      break;
    case 'legitimate-travel': {
      const itinerary = { deviceId: unfamiliar, networkId: changedNetwork, location: away };
      emit(0, 'login', 'action', { ...itinerary, behaviour: regular });
      emit(7, 'transfer', 'action', { ...itinerary, payeeId: usualPayee, amountMinor: baselineAmount + 240 });
      break;
    }
    case 'legitimate-recovery':
      // A customer on a new phone and mobile network types differently, resets a forgotten
      // password and pays a new contact a modest amount. Until the transfer it looks like a takeover.
      emit(0, 'login', 'action', { ...newDeviceSession, behaviour: shifted });
      emit(2, 'password_reset', 'action', { ...newDeviceSession, behaviour: shifted });
      emit(4, 'payee_added', 'action', { ...newDeviceSession, payeeId: newPayee, behaviour: shifted });
      emit(9, 'transfer', 'action', {
        ...newDeviceSession, payeeId: newPayee, amountMinor: baselineAmount + 900, behaviour: shifted,
      });
      break;
    case 'ordinary':
      emit(0, 'login', 'action', { behaviour: regular });
      emit(3, 'transfer', 'action', { payeeId: usualPayee, amountMinor: baselineAmount + 300 });
      break;
  }
  return { episode, events, labels };
}

export function generateEarlyCorpus(options: {
  split: CorpusSplit; seed: number; maxEvents: number; scenario?: EarlyScenario; hardNegatives?: boolean;
}): EarlyCorpus {
  const { split, seed, maxEvents } = options;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 999_999_999 ||
      !Number.isSafeInteger(maxEvents) || maxEvents < 20 || maxEvents > 50_000) {
    throw new Error('Use an integer seed from 0 to 999999999 and an event budget from 20 to 50000.');
  }
  const selection: readonly EarlyScenario[] = options.scenario ? [options.scenario]
    : options.hardNegatives ? allEarlyScenarios : earlyScenarios;
  const events: FraudEvent[] = [];
  const episodes: Episode[] = [];
  const labels = new Map<string, EventLabel>();

  for (let index = 0; events.length < maxEvents; index++) {
    const scenario = selection[index % selection.length]!;
    const part = createEpisode(split, seed, index, scenario);
    // Preserve complete histories and impact events. Never truncate an episode.
    if (events.length + part.events.length > maxEvents) break;
    events.push(...part.events);
    episodes.push(part.episode);
    for (const [eventId, label] of part.labels) labels.set(eventId, label);
  }
  events.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id));
  return { split, seed, maxEvents, episodes, events, labels };
}

export type EvaluationDecision = {
  action: Action;
  modelCalls?: number;
  measuredUsageCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  verifiedReuse?: boolean;
  priorObservationCount?: number;
  rankedSearches?: number;
  rankedHits?: number;
  rejectedCandidates?: number;
  /** A verified session pattern matched this event (shadow or enforce). */
  patternMatched?: boolean;
  /** The verified-pattern policy changed this event's action. */
  patternApplied?: boolean;
};

/** Simulated time from which an analyst-confirmed pattern of each attack scenario was active. */
export type KnowledgeTimeline = ReadonlyMap<EarlyScenario, number>;

const emptyConfusion = () => ({ tp: 0, fp: 0, tn: 0, fn: 0 });
type Confusion = ReturnType<typeof emptyConfusion>;
type Gate = 'block' | 'challenge_failed';

function ratio(numerator: number, denominator: number) {
  return denominator ? numerator / denominator : null;
}

function percentiles(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
  };
}

function metrics(counts: Confusion) {
  const { tp, fp, tn, fn } = counts;
  return {
    ...counts,
    precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn),
    f1: ratio(2 * tp, 2 * tp + fp + fn),
    falsePositiveRate: ratio(fp, fp + tn), falseNegativeRate: ratio(fn, fn + tp),
  };
}

export function evaluateEarlyCorpus(
  corpus: EarlyCorpus, decisions: ReadonlyMap<string, EvaluationDecision>, knowledge: KnowledgeTimeline = new Map(),
) {
  const episodes = new Map(corpus.episodes.map((episode) => [episode.id, {
    ...episode, counts: emptyConfusion(), step: 0, startTime: null as number | null,
    firstAlert: null as { time: number; step: number } | null,
    held: new Map<string, Gate>(), impactExecuted: false,
    impact: null as { time: number; step: number } | null,
    impactGate: null as { type: Gate; stage: 'before_impact' | 'at_impact' } | null,
    impactAmountMinor: 0,
  }]));
  const counts = emptyConfusion();
  const latency: number[] = [];
  const actions = { ALLOW: 0, STEP_UP_VERIFICATION: 0, BLOCK: 0 };
  const simulatedGates = { challengePassed: 0, challengeFailed: 0, directBlock: 0, precludedAttempts: 0 };
  let ordinarySteps = 0;
  let ordinaryActionable = 0;
  let observedFailedAuth = 0;
  let ignoredWarmup = 0;
  let totalCalls = 0;
  let measuredUsageCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let verifiedReuse = 0;
  let earlierObservations = 0;
  let rankedSearches = 0;
  let rankedHits = 0;
  let rejectedCandidates = 0;
  let patternMatches = 0;
  let patternMatchesOnLegitimate = 0;
  let patternActionChanges = 0;

  for (const event of corpus.events) {
    const decision = decisions.get(event.id);
    if (!decision) throw new Error('Missing shadow-replay decision for event ' + event.id);
    const label = corpus.labels.get(event.id)!;
    const episode = episodes.get(label.episodeId)!;
    totalCalls += decision.modelCalls ?? 0;
    measuredUsageCalls += decision.measuredUsageCalls ?? 0;
    inputTokens += decision.inputTokens ?? 0;
    outputTokens += decision.outputTokens ?? 0;
    if (typeof decision.latencyMs === 'number' && Number.isFinite(decision.latencyMs)) latency.push(decision.latencyMs);
    if (decision.verifiedReuse) verifiedReuse++;
    if (decision.priorObservationCount) earlierObservations++;
    rankedSearches += decision.rankedSearches ?? 0;
    rankedHits += decision.rankedHits ?? 0;
    rejectedCandidates += decision.rejectedCandidates ?? 0;

    if (label.phase === 'warmup') {
      ignoredWarmup++;
      continue;
    }
    episode.step++;
    episode.startTime ??= Date.parse(event.timestamp);
    if (label.phase === 'observation') {
      observedFailedAuth++;
      continue;
    }

    const alert = decision.action !== 'ALLOW';
    actions[decision.action]++;
    if (decision.patternMatched) {
      patternMatches++;
      if (!episode.malicious) patternMatchesOnLegitimate++;
    }
    if (decision.patternApplied) patternActionChanges++;
    const outcome = episode.malicious ? alert ? 'tp' : 'fn' : alert ? 'fp' : 'tn';
    counts[outcome]++;
    episode.counts[outcome]++;
    if (!episode.malicious) {
      ordinaryActionable++;
      if (decision.action === 'STEP_UP_VERIFICATION') ordinarySteps++;
    }
    const position = { time: Date.parse(event.timestamp), step: episode.step };
    if (episode.malicious && alert && episode.firstAlert === null) episode.firstAlert = position;

    const sessionKey = event.accountId + ':' + (event.sessionId ?? event.id);
    const existingHold = episode.held.get(sessionKey);
    let newHold: Gate | null = null;
    if (existingHold) {
      simulatedGates.precludedAttempts++;
    } else if (decision.action === 'BLOCK') {
      newHold = 'block';
      simulatedGates.directBlock++;
    } else if (decision.action === 'STEP_UP_VERIFICATION') {
      if (episode.challengePasses) simulatedGates.challengePassed++;
      else {
        newHold = 'challenge_failed';
        simulatedGates.challengeFailed++;
      }
    }
    if (newHold) episode.held.set(sessionKey, newHold);
    if (label.phase === 'impact') {
      episode.impact = position;
      if (existingHold) episode.impactGate = { type: existingHold, stage: 'before_impact' };
      else if (newHold) episode.impactGate = { type: newHold, stage: 'at_impact' };
      episode.impactExecuted = episode.impactGate === null;
      if (event.kind === 'transfer') episode.impactAmountMinor = event.amountMinor;
    }
  }

  const episodeReports = [...episodes.values()].map((episode) => {
    const { firstAlert, impact } = episode;
    const lead = firstAlert && impact && firstAlert.time < impact.time
      ? { seconds: (impact.time - firstAlert.time) / 1000, steps: impact.step - firstAlert.step } : null;
    return {
      episodeId: episode.id,
      scenario: episode.scenario,
      attackEpisode: episode.malicious,
      impactKind: episode.impactKind,
      challengeOutcomeIfRequested: episode.challengePasses ? 'pass' : 'fail',
      alertLeadSeconds: lead?.seconds ?? null,
      alertLeadSteps: lead?.steps ?? null,
      impactOutcome: impact === null ? null : episode.impactExecuted ? 'executed' : 'prevented',
      intervention: episode.impactGate,
      intendedTransferMinor: episode.impactAmountMinor,
      // Whether a confirmed pattern of this attack type was active before the episode began.
      encounter: !episode.malicious ? null :
        (knowledge.get(episode.scenario) ?? Infinity) <= (episode.startTime ?? -Infinity) ? 'repeat' as const : 'first' as const,
      counts: episode.counts,
    };
  });
  const attacks = episodeReports.filter((episode) => episode.attackEpisode && episode.impactKind !== null);
  const leadSeconds = attacks.flatMap((episode) => episode.alertLeadSeconds !== null ? [episode.alertLeadSeconds] : []);
  const leadSteps = attacks.flatMap((episode) => episode.alertLeadSteps !== null ? [episode.alertLeadSteps] : []);
  const preventions = attacks.filter((episode) => episode.intervention);
  const encounterSummary = (group: typeof attacks) => ({
    total: group.length,
    prevented: group.filter((episode) => episode.impactOutcome === 'prevented').length,
    preventedBeforeImpact: group.filter((episode) => episode.intervention?.stage === 'before_impact').length,
    preventedByBlock: group.filter((episode) => episode.intervention?.type === 'block').length,
    executed: group.filter((episode) => episode.impactOutcome === 'executed').length,
    executedHarmMinor: group.filter((episode) => episode.impactOutcome === 'executed')
      .reduce((sum, episode) => sum + episode.intendedTransferMinor, 0),
  });
  const byScenario = Object.fromEntries(allEarlyScenarios.flatMap((scenario) => {
    const rows = episodeReports.filter((episode) => episode.scenario === scenario);
    if (!rows.length) return [];
    const confusion = rows.reduce((sum, row) => {
      sum.tp += row.counts.tp;
      sum.fp += row.counts.fp;
      sum.tn += row.counts.tn;
      sum.fn += row.counts.fn;
      return sum;
    }, emptyConfusion());
    const attackRows = rows.filter((episode) => episode.attackEpisode);
    return [[scenario, {
      episodes: rows.length, classification: metrics(confusion),
      attacksAlertedBeforeImpact: attackRows.filter((episode) => episode.alertLeadSeconds !== null).length,
      attacksPrevented: attackRows.filter((episode) => episode.impactOutcome === 'prevented').length,
    }]];
  }));

  return {
    interventionSemantics: 'Identical attempted events are shadow-replayed. In a separate effect ledger, a BLOCK or failed synthetic challenge holds that account/session; a passed challenge permits the attempt. An earlier hold can prevent a later impact only in that same session. These outcomes are simulated, not counterfactual engine retraining.',
    classificationSemantics: 'Unweighted event-level TP/FP/TN/FN for recommendations. BLOCK or STEP_UP_VERIFICATION is positive, including when a challenge passes. Malicious episode action and impact rows are ground-truth positives. Warmup and failed-authentication observation rows are excluded.',
    eventCount: corpus.events.length,
    warmupExcluded: ignoredWarmup, failedAuthObservationsExcluded: observedFailedAuth,
    actionCounts: actions, simulatedGates,
    classification: metrics(counts), byScenario,
    legitimateStepUpRate: ratio(ordinarySteps, ordinaryActionable),
    legitimateActionableEvents: ordinaryActionable,
    attacks: {
      total: attacks.length,
      alertedBeforeImpact: leadSeconds.length,
      alertLeadSeconds: percentiles(leadSeconds),
      alertLeadSteps: percentiles(leadSteps),
      preventedBeforeImpact: preventions.filter((episode) => episode.intervention?.stage === 'before_impact').length,
      preventedAtImpact: preventions.filter((episode) => episode.intervention?.stage === 'at_impact').length,
      preventedByBlock: preventions.filter((episode) => episode.intervention?.type === 'block').length,
      preventedByFailedChallenge: preventions.filter((episode) => episode.intervention?.type === 'challenge_failed').length,
      executed: attacks.filter((episode) => episode.impactOutcome === 'executed').length,
      byImpactKind: Object.fromEntries((['account_access', 'transfer'] as const).map((kind) => {
        const group = attacks.filter((episode) => episode.impactKind === kind);
        return [kind, {
          total: group.length, alertedBeforeImpact: group.filter((episode) => episode.alertLeadSeconds !== null).length,
          prevented: group.filter((episode) => episode.impactOutcome === 'prevented').length,
        }];
      })),
      simulatedTransferHarmPreventedMinor: preventions.reduce((sum, episode) => sum + episode.intendedTransferMinor, 0),
      simulatedTransferHarmExecutedMinor: attacks.filter((episode) => episode.impactOutcome === 'executed')
        .reduce((sum, episode) => sum + episode.intendedTransferMinor, 0),
      byEncounter: {
        first: encounterSummary(attacks.filter((episode) => episode.encounter === 'first')),
        repeat: encounterSummary(attacks.filter((episode) => episode.encounter === 'repeat')),
      },
    },
    telemetry: {
      totalCalls, measuredUsageCalls, inputTokens, outputTokens, latencyMs: percentiles(latency),
      casesWithVerifiedFingerprintReuse: verifiedReuse, casesWithEarlierPublishedObservations: earlierObservations,
      rankedSearches, rankedHits, rejectedCandidates,
      verifiedPatternMatches: patternMatches,
      verifiedPatternMatchesOnLegitimate: patternMatchesOnLegitimate,
      verifiedPatternActionChanges: patternActionChanges,
    },
    episodes: episodeReports,
  };
}