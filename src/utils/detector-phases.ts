import type { TurnActivity } from '../types.js';
import { isLivenessProbeCandidate } from '../collectors/codex-liveness.js';

/** Fresh rollout activity outranks a cached exit; a confirmed exit outranks
 * stale approval and interruption flags, including crashes mid-turn. */
export function withDetectorPhases(
  activity: TurnActivity | null | undefined,
  approvalNeeded: boolean,
  likelyInterrupted: boolean = false,
  codexExited: boolean = false,
  lastEventAt?: Date,
  nowMs: number = Date.now()
): TurnActivity | undefined {
  if (!activity) return undefined;
  if (codexExited && isLivenessProbeCandidate({ turnActivity: activity, lastEventAt }, nowMs)) {
    return { ...activity, phase: 'exited' };
  }
  if (approvalNeeded && activity.phase === 'running-tool') {
    return { ...activity, phase: 'awaiting-approval' };
  }
  if (likelyInterrupted && (activity.phase === 'thinking' || activity.phase === 'responding')) {
    return { ...activity, phase: 'interrupted' };
  }
  return activity;
}
