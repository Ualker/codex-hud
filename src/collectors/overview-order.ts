/**
 * Ranking policy for the session overview.
 *
 * Kept as a pure function for the same reason the cadence policy is: it
 * encodes a product decision about what deserves the top of a seven-row pane,
 * and that decision should be provable without standing up a HUD.
 */

import type { SessionOverviewItem } from '../types.js';

function phaseRank(activity: SessionOverviewItem['turnActivity']): number {
  switch (activity?.phase) {
    case 'running-tool':
    case 'thinking':
      return 0;
    case 'responding':
      return 1;
    case 'aborted':
      return 2;
    case 'idle':
    default:
      return 3;
  }
}

/**
 * Working sessions first, then the most recently touched.
 *
 * Context fullness used to outrank recency, which pushed the session you left
 * a minute ago below an older one that had merely spent more of its window —
 * and on a seven-row pane that means below the fold. "Which of my sessions did
 * I just leave" is the question the dashboard answers; "which is nearest its
 * limit" is the tiebreak, and the context column states it either way.
 */
export function compareOverviewSessions(
  left: SessionOverviewItem,
  right: SessionOverviewItem
): number {
  const phaseDelta = phaseRank(left.turnActivity) - phaseRank(right.turnActivity);
  if (phaseDelta !== 0) {
    return phaseDelta;
  }
  const activityDelta =
    (right.lastActivityAt?.getTime() ?? 0) -
    (left.lastActivityAt?.getTime() ?? 0);
  if (activityDelta !== 0) {
    return activityDelta;
  }
  return (
    (right.contextUsage?.percent ?? 0) - (left.contextUsage?.percent ?? 0)
  );
}
