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
  /** A tool is running, a turn is active, or agents are visible. */
  hasActiveWork: boolean;
  /** A session is currently bound. */
  bound: boolean;
  /** The overview dashboard is being displayed (the user is watching). */
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
}

const RENDER_ACTIVE_MS = 500;
const RENDER_IDLE_MS = 1500;
const RENDER_UNBOUND_MS = 2500;
const RENDER_DEEP_IDLE_MS = 3000;

const GIT_BASE_MS = 5_000;
const GIT_SLOW_MS = 60_000;
const AGENTS_BASE_MS = 1_000;
const AGENTS_DEEP_IDLE_MS = 5_000;
const ROLLOUT_FALLBACK_BASE_MS = 2_000;
const ROLLOUT_FALLBACK_DEEP_IDLE_MS = 10_000;

export function planCadence(inputs: CadenceInputs): CadencePlan {
  const idleForMs = inputs.nowMs - inputs.lastActivityMs;
  const deepIdle =
    !inputs.hasActiveWork &&
    !inputs.overviewVisible &&
    idleForMs >= DEEP_IDLE_AFTER_MS;

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
  };
}
