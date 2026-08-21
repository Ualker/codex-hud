/**
 * Open codex-hud panes, as reported by tmux.
 *
 * The overview used to define "active session" as "rollout file written
 * recently", which is not what the dashboard is for. Measured on this machine:
 * two Codex sessions open in tmux, and no mtime window surfaced either of them
 * — one had not written since a resume five days earlier, and the other had no
 * rollout file at all, because Codex creates a rollout lazily on the first
 * turn. Every window from one minute to twelve hours returned zero rows.
 *
 * Each HUD publishes what it is bound to onto its own tmux session, so the
 * dashboard can enumerate the sessions that are genuinely open right now
 * instead of inferring it from file timestamps.
 */

import { execFile } from 'child_process';

/**
 * Matches the pane-probe timeout in session-finder, for the same measured
 * reason: on a loaded machine a bare `/bin/sh` spawn takes 0.7-2.1s here, so a
 * two-second budget expired on 10 of 25 consecutive calls. Timing out returns
 * no bindings, which silently drops every open HUD from the overview and
 * leaves the mtime scan — the source this collector exists to replace — as the
 * only answer. Nothing waits on this call: it refreshes a cache that keeps
 * serving its previous snapshot, so a late result costs nothing.
 */
const TMUX_TIMEOUT_MS = 8000;
const TMUX_MAX_BUFFER = 1024 * 1024;

/**
 * One option carrying the whole binding.
 *
 * Per-field options are not an alternative: publishing three of them
 * concurrently let an unbind and the rebind that followed it interleave, and
 * the live HUDs ended up advertising a session id from the new binding beside
 * an empty cwd from the old one.
 *
 * The payload is base64 because tmux escapes non-printable bytes *as it
 * stores them* — a `\x1f`-joined value came back as the four literal
 * characters `\`, `0`, `3`, `7` from both show-option and a format string, so
 * no control-character delimiter can survive the round trip. Base64's
 * alphabet is stored verbatim and cannot collide with a path or a session
 * name, which removes the delimiter question entirely.
 */
const BOUND_OPTION = '@codex_hud_bound';

interface BoundPayload {
  tmuxSession: string;
  sessionId: string;
  rolloutPath?: string;
  cwd?: string;
  approvalNeeded?: boolean;
  likelyInterrupted?: boolean;
  codexExited?: boolean;
}

export interface OpenHudBinding {
  tmuxSession: string;
  sessionId: string;
  /** Absent when the bound session has not produced a rollout yet. */
  rolloutPath?: string;
  /**
   * The HUD's working directory. A session with no rollout has no parsed cwd,
   * and the dashboard's leading column is the project name.
   */
  cwd?: string;
  /** The owning HUD confirmed an approval prompt in its current main pane. */
  approvalNeeded?: boolean;
  /**
   * The owning HUD confirmed a stream-error banner on its main pane. Same
   * kind of evidence as `approvalNeeded` — pane text only the owning HUD can
   * read — and the dashboard exists to say which session needs a human, so a
   * dead turn must not keep reading as "Thinking" on every other HUD.
   */
  likelyInterrupted?: boolean;
  /** The owning HUD confirmed the Codex process left the main pane. */
  codexExited?: boolean;
}

function tmux(args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'tmux',
      args,
      {
        encoding: 'utf8',
        timeout: TMUX_TIMEOUT_MS,
        maxBuffer: TMUX_MAX_BUFFER,
      },
      (error, stdout) => {
        // Running outside tmux, a dead server, or a tmux too old for the
        // format used here are all "no data", never a HUD failure.
        resolve(error ? null : stdout);
      }
    );
  });
}

// Bindings are published in call order. Without this an unbind issued before
// a rebind could still land after it, leaving a stale advertisement behind.
let publishQueue: Promise<unknown> = Promise.resolve();

/**
 * Publish this HUD's binding onto its own tmux session. Called on every
 * binding change; a missing tmux session name simply makes it a no-op.
 */
export function publishHudBinding(
  tmuxSession: string | undefined,
  sessionId: string | null,
  rolloutPath: string | null,
  cwd: string,
  approvalNeeded: boolean = false,
  likelyInterrupted: boolean = false,
  codexExited: boolean = false
): Promise<void> {
  if (!tmuxSession) {
    return Promise.resolve();
  }

  const payload: BoundPayload | null = sessionId
    ? {
        tmuxSession,
        sessionId,
        ...(rolloutPath ? { rolloutPath } : {}),
        ...(cwd ? { cwd } : {}),
        ...(approvalNeeded ? { approvalNeeded: true } : {}),
        ...(likelyInterrupted ? { likelyInterrupted: true } : {}),
        ...(codexExited ? { codexExited: true } : {}),
      }
    : null;
  const value = payload
    ? Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    : '';

  const next = publishQueue.then(() =>
    tmux(['set-option', '-t', tmuxSession, '-q', BOUND_OPTION, value])
  );
  // Keep the chain alive even if one publish fails.
  publishQueue = next.catch(() => undefined);
  return next.then(() => undefined);
}

function decodeBinding(encoded: string): OpenHudBinding | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(encoded, 'base64').toString('utf8')
    );
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const {
      tmuxSession,
      sessionId,
      rolloutPath,
      cwd,
      approvalNeeded,
      likelyInterrupted,
      codexExited,
    } = parsed as Record<string, unknown>;
    if (typeof tmuxSession !== 'string' || typeof sessionId !== 'string') {
      return null;
    }
    if (!tmuxSession || !sessionId) {
      return null;
    }
    return {
      tmuxSession,
      sessionId,
      ...(typeof rolloutPath === 'string' && rolloutPath
        ? { rolloutPath }
        : {}),
      ...(typeof cwd === 'string' && cwd ? { cwd } : {}),
      ...(approvalNeeded === true ? { approvalNeeded: true } : {}),
      ...(likelyInterrupted === true ? { likelyInterrupted: true } : {}),
      ...(codexExited === true ? { codexExited: true } : {}),
    };
  } catch {
    // A HUD from a different build, or a hand-edited option.
    return null;
  }
}

/**
 * Every tmux session currently running a HUD bound to a Codex session.
 * Returns an empty list when tmux is unavailable, so callers degrade to
 * whatever else they know rather than showing an error.
 */
export async function listOpenHudBindings(): Promise<OpenHudBinding[]> {
  // The payload names its own tmux session, so the format needs no delimiter
  // and no second field.
  const stdout = await tmux(['list-sessions', '-F', `#{${BOUND_OPTION}}`]);
  if (stdout === null) {
    return [];
  }

  const bindings: OpenHudBinding[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split('\n')) {
    const encoded = line.trim();
    // A tmux session with no HUD, or a HUD that is not bound, renders empty.
    if (!encoded) {
      continue;
    }
    const binding = decodeBinding(encoded);
    if (!binding) {
      continue;
    }
    // The same Codex session can be bound by more than one pane; the dashboard
    // shows a session once.
    if (seen.has(binding.sessionId)) {
      continue;
    }
    seen.add(binding.sessionId);
    bindings.push(binding);
  }
  return bindings;
}
