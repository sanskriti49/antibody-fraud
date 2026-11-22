import type { Action, EventKind } from './api';

export const ruleLabels: Record<string, string> = {
  login_pressure: 'Repeated failed sign-ins', recent_reset: 'Recent password reset', new_device: 'Unfamiliar device',
  new_payee: 'New payee', fresh_payee: 'Payee added minutes ago', amount_spike: 'Amount far above usual',
  transfer_burst: 'Burst of transfers', impossible_travel: 'Impossible travel', behaviour_shift: 'Typing rhythm shift',
  shared_device: 'Device shared across accounts', shared_network: 'Network shared across accounts',
  reset_after_device_failures: 'Reset after failures on this device', sensitive_payee_transition: 'Payee added during a risk shift',
  verified_pattern_match: 'Repeats a confirmed attack',
};
export const kindLabels: Record<EventKind, string> = {
  login: 'Sign-in', login_failed: 'Failed sign-in', password_reset: 'Password reset', payee_added: 'New payee', transfer: 'Transfer',
};
export const actionLabels: Record<Action, string> = { ALLOW: 'Allowed', STEP_UP_VERIFICATION: 'Step-up', BLOCK: 'Blocked' };
export const agentLabels: Record<string, string> = {
  'contextcon-behaviour-login': 'Behaviour / Login', 'contextcon-device-ip': 'Device / IP', 'contextcon-transactions': 'Transaction',
  'contextcon-graph': 'Graph', 'contextcon-investigator': 'Investigator',
};

export const rule = (id: string) => ruleLabels[id] ?? id.replaceAll('_', ' ');
export const shortId = (id: string | null | undefined, size = 8) => id ? id.replace(/^(acct|dev|net|payee|sess)-/, '').slice(0, size) : '—';
export const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export const dateTime = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const amount = (minor: number | null) => minor === null ? '' :
  (minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function ago(iso: string, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
  return Math.round(seconds / 3600) + 'h ago';
}
