/**
 * Collector cadence policy.
 *
 * Watchers deliver the real-time updates; the intervals planned here drive
 * polling safety nets and spawn-heavy probes (git, ps, sqlite). A session
 * that has been quiet for a while stops paying full price for those probes
 * (measured 2.1-2.5% CPU per fully idle HUD, dominated by subprocess
 * spawns). Any rollout event, keypress, or session activity restores the
 * base cadence on the next tick, so recovery latency is bounded by the
 * deep-idle render interval.
 */

export const DEEP_IDLE_AFTER_MS = 10 * 60_000;

export interface CadenceInputs {
  nowMs: number;
  /**
   * Latest of: rollout event time, turn activity, bound rollout mtime, and
   * the last local wake signal (keypress, mode toggle, resize, watcher
   * event). 0 when nothing is known.
   */
  lastActivityMs: number;
  /**
   * A tool is running, a turn is active, or agents are visible. While the
   * overview is displayed this also covers the sessions it lists: they are
   * what the user is watching, and none of them is the bound one.
   */
  hasActiveWork: boolean;
  /** A session is currently bound. */
  bound: boolean;
  /** The overview dashboard is being displayed. */
  overviewVisible: boolean;
  /** Last git probe found a repository at the HUD cwd. */
  gitIsRepo: boolean;
}

export interface CadencePlan {
  deepIdle: boolean;
  renderMs: number;
  gitMs: number;
  agentsMs: number;
  rolloutFallbackMs: number;
  /** Only consulted while the overview is displayed. */
  overviewMs: number;
}

const RENDER_ACTIVE_MS = 500;
const RENDER_IDLE_MS = 1500;
const RENDER_UNBOUND_MS = 2500;
const RENDER_DEEP_IDLE_MS = 3000;

// Fifteen seconds, not five: Codex's own file changes trigger a refresh the
// moment a tool call completes (index.ts), so the poll only covers edits made
// outside the session, where a few seconds of latency on the dirty marker
// costs nothing and each poll is a spawn.
const GIT_BASE_MS = 15_000;
/**
 * Exported: the git snapshot's staleness threshold must cover this slowest
 * planned cadence, or the health line reports "git stale" between perfectly
 * scheduled refreshes.
 */
export const GIT_SLOW_MS = 60_000;
const AGENTS_BASE_MS = 1_000;
const AGENTS_DEEP_IDLE_MS = 5_000;
const ROLLOUT_FALLBACK_BASE_MS = 2_000;
const ROLLOUT_FALLBACK_DEEP_IDLE_MS = 10_000;
/** Matches the overview snapshot TTL, which was the effective rate anyway. */
const OVERVIEW_BASE_MS = 5_000;
const OVERVIEW_DEEP_IDLE_MS = 30_000;

export function planCadence(inputs: CadenceInputs): CadencePlan {
  const idleForMs = inputs.nowMs - inputs.lastActivityMs;
  // Displaying the overview used to veto deep idle outright, on the assumption
  // that the dashboard is only up because someone is watching it. That stops
  // being true the moment the user switches tmux window or detaches, and the
  // HUD cannot see either — so an overview left up cost 2.8x an idle single
  // view (0.48s vs 0.17s CPU per minute, measured) for as long as it was up.
  // The caller folds the listed sessions' own activity into hasActiveWork, so
  // backing off here requires the whole fleet on screen to have gone quiet.
  const deepIdle = !inputs.hasActiveWork && idleForMs >= DEEP_IDLE_AFTER_MS;

  const renderMs = inputs.hasActiveWork
    ? RENDER_ACTIVE_MS
    : deepIdle
      ? RENDER_DEEP_IDLE_MS
      : inputs.bound || inputs.overviewVisible
        ? RENDER_IDLE_MS
        : RENDER_UNBOUND_MS;

  // A non-repo cwd cannot gain a repository behind the HUD's back often;
  // a later `git init` is noticed within a minute instead of paying one
  // doomed spawn every five seconds forever.
  const gitMs = deepIdle || !inputs.gitIsRepo ? GIT_SLOW_MS : GIT_BASE_MS;

  return {
    deepIdle,
    renderMs,
    gitMs,
    agentsMs: deepIdle ? AGENTS_DEEP_IDLE_MS : AGENTS_BASE_MS,
    rolloutFallbackMs: deepIdle
      ? ROLLOUT_FALLBACK_DEEP_IDLE_MS
      : ROLLOUT_FALLBACK_BASE_MS,
    overviewMs: deepIdle ? OVERVIEW_DEEP_IDLE_MS : OVERVIEW_BASE_MS,
  };
}
