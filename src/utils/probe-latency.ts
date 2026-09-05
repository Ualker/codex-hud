/**
 * Wall time of the subprocess probes the HUD depends on (tmux, ps, git).
 *
 * On a loaded machine a single tmux round trip measured 0.3-5.4s and a full
 * `ps` table 0.5-0.8s (2026-09-05, load average 96). Past their 8s budgets the
 * probes time out and every consumer degrades silently — the overview loses
 * bindings, liveness stays unknown — while the pane looks healthy. The recent
 * durations are kept here so the note row can say `probes slow · tmux 5.4s`
 * instead of leaving the user to wonder why the dashboard is stale.
 */

export type ProbeName = 'tmux' | 'ps' | 'git' | 'sqlite';

export interface SlowProbe {
  name: ProbeName;
  ms: number;
}

/** A probe slower than this is worth a note. */
export const SLOW_PROBE_THRESHOLD_MS = 2000;
/** How long a slow sample stays on the row after it was taken. */
export const SLOW_PROBE_TTL_MS = 60_000;

interface Sample {
  ms: number;
  atMs: number;
}

const latest = new Map<ProbeName, Sample>();

/**
 * Start timing one probe; call the returned function when it finishes
 * (success or failure — a timeout is the slowest sample of all).
 */
export function startProbe(
  name: ProbeName,
  now: () => number = Date.now
): () => void {
  const startedAt = now();
  let done = false;
  return () => {
    if (done) {
      return;
    }
    done = true;
    const finishedAt = now();
    latest.set(name, { ms: finishedAt - startedAt, atMs: finishedAt });
  };
}

/** Probes whose most recent sample is both slow and recent, slowest first. */
export function slowProbes(
  nowMs: number = Date.now(),
  thresholdMs: number = SLOW_PROBE_THRESHOLD_MS,
  ttlMs: number = SLOW_PROBE_TTL_MS
): SlowProbe[] {
  const result: SlowProbe[] = [];
  for (const [name, sample] of latest) {
    if (sample.ms >= thresholdMs && nowMs - sample.atMs <= ttlMs) {
      result.push({ name, ms: sample.ms });
    }
  }
  return result.sort((left, right) => right.ms - left.ms);
}

/** Test hook. */
export function resetProbeLatency(): void {
  latest.clear();
}
