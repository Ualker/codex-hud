/**
 * Pane binding under Codex's managed app-server daemon.
 *
 * With `features.daemon_auto_start` (experimental, Codex 0.156+) the first TUI
 * launches `codex app-server --listen unix:// --managed-daemon` and every TUI
 * on the same CODEX_HOME becomes a thin client of it. The daemon owns rollout
 * files, thread writer locks and every log row that carries a thread_id; the
 * TUI processes log none. Walking a pane's process tree therefore finds no
 * thread for most panes — and every pane's threads for the one pane whose TUI
 * happens to be the daemon's parent. Shell snapshots are written by the daemon
 * too, so their TMUX_PANE names whichever pane launched it.
 *
 * What ties a pane to its thread instead (measured on three Linux hosts):
 * - every daemon request span logs `app_server.connection_id=N` and the
 *   client name; thread/start, thread/resume, thread/fork and turn/start rows
 *   also carry the thread_id that connection is on;
 * - the TUI logs `connected app-server platform ...` when it connects, within
 *   0.08-0.44s of that connection's first request on the daemon side;
 * - connection ids grow in connection order and each TUI connects right after
 *   it starts, so when that log line is missing (1 of 7 panes) the live
 *   connections sorted by id line up with the TUIs sorted by start time.
 */

import { codexSubcommand, isCodexProcessCommand } from './runtime-hooks.js';

/** Codex subcommands that never host an interactive session (bin/codex-hud). */
const NON_INTERACTIVE_SUBCOMMANDS = new Set([
  'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'mcp-server',
  'app-server', 'exec-server', 'remote-control', 'app', 'completion', 'update',
  'doctor', 'sandbox', 'debug', 'apply', 'a', 'archive', 'delete', 'unarchive',
  'cloud', 'features', 'help', 'agents', 'queue', 'migrate-rollouts',
]);

/** Requests that put a connection on a thread; previews (thread/read) do not. */
const THREAD_METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork', 'turn/start']);

/**
 * TUI-side connect line vs the daemon's first request on that connection
 * (measured 0.08-0.44s). Panes launched together connect 2-5s apart, so a
 * wider window already sees the neighbour's connection and pairs nobody.
 */
export const CONNECT_TOLERANCE_MS = 1_000;
/** Order fallback: a connection may appear this early (tick/second rounding)... */
export const START_SLACK_MS = 2_000;
/** ...and at most this late after its TUI started (first request 0.1-21s). */
export const STARTUP_WINDOW_MS = 300_000;
/**
 * TUIs poll account/rateLimits/read every 1-5 minutes. A connection silent
 * for longer belongs to a TUI that already exited; left in the ordered
 * fallback it would shift every later pairing by one.
 */
export const LIVE_WINDOW_MS = 15 * 60_000;

export interface ThreadEvent {
  atMs: number;
  method: string;
  threadId: string;
}

export interface DaemonConnection {
  firstMs: number;
  lastMs: number;
  client: string | null;
  /** Thread-bearing requests, oldest first. */
  events: ThreadEvent[];
}

export interface DaemonClient {
  pid: string;
  startMs: number;
}

export interface LedgerRow {
  id: number;
  tsMs: number;
  threadId: string;
  processUuid: string;
  body: string;
}

export function isManagedDaemonCommand(command: string): boolean {
  return (
    isCodexProcessCommand(command) &&
    /\sapp-server(?=\s|$)/.test(command) &&
    /\s--managed-daemon(?=\s|$)/.test(command)
  );
}

/** A Codex process that can host an interactive session (a TUI, or its wrapper). */
export function isInteractiveCodexCommand(command: string): boolean {
  if (!isCodexProcessCommand(command) || /\sapp-server(?=\s|$)/.test(command)) {
    return false;
  }
  const subcommand = codexSubcommand(command);
  return subcommand === null || !NON_INTERACTIVE_SUBCOMMANDS.has(subcommand);
}

/** `pid:<PID>:<UUID>` -> PID, or null for any other shape. */
export function pidOfProcessUuid(processUuid: string): string | null {
  const match = /^pid:(\d+):/.exec(processUuid);
  return match ? match[1] : null;
}

export function parseConnectionSpan(
  body: string
): { connectionId: number; method: string | null; client: string | null } | null {
  const span = /app_server\.request\{([^}]*)\}/.exec(body);
  if (!span) {
    return null;
  }
  const fields = span[1];
  const id = /app_server\.connection_id=(\d+)/.exec(fields);
  if (!id) {
    return null;
  }
  const method = /rpc\.method="([^"]+)"/.exec(fields);
  const client = /app_server\.client_name="([^"]*)"/.exec(fields);
  return {
    connectionId: Number(id[1]),
    method: method ? method[1] : null,
    client: client ? client[1] : null,
  };
}

/**
 * Connection book of one daemon, fed incrementally with log rows (oldest
 * first). Rows of other processes only contribute TUI connect lines.
 */
export class DaemonLedger {
  readonly connections = new Map<number, DaemonConnection>();
  /** Latest `connected app-server` line per TUI pid. */
  readonly connectedAtMs = new Map<string, number>();
  lastRowId = 0;

  constructor(readonly daemonPid: string) {}

  ingest(rows: readonly LedgerRow[]): void {
    for (const row of rows) {
      if (row.id > this.lastRowId) {
        this.lastRowId = row.id;
      }
      const pid = pidOfProcessUuid(row.processUuid);
      if (!pid) {
        continue;
      }
      if (row.body.startsWith('connected app-server')) {
        this.connectedAtMs.set(pid, Math.max(this.connectedAtMs.get(pid) ?? row.tsMs, row.tsMs));
        continue;
      }
      if (pid !== this.daemonPid) {
        continue;
      }
      const span = parseConnectionSpan(row.body);
      if (!span) {
        continue;
      }
      let connection = this.connections.get(span.connectionId);
      if (!connection) {
        connection = { firstMs: row.tsMs, lastMs: row.tsMs, client: null, events: [] };
        this.connections.set(span.connectionId, connection);
      }
      connection.firstMs = Math.min(connection.firstMs, row.tsMs);
      connection.lastMs = Math.max(connection.lastMs, row.tsMs);
      if (span.client) {
        connection.client = span.client;
      }
      if (row.threadId && span.method && THREAD_METHODS.has(span.method)) {
        connection.events.push({ atMs: row.tsMs, method: span.method, threadId: row.threadId });
        connection.events.sort((left, right) => left.atMs - right.atMs);
      }
    }
  }
}

/**
 * Pair daemon connections with TUI processes: pid -> connection id.
 *
 * - Only TUI connections are paired (client name mentions `tui`, or no name
 *   but at least one thread request); when any of them was active within
 *   LIVE_WINDOW_MS, only the live ones take part.
 * - First pass: the TUI's own connect line, when exactly one connection and
 *   exactly one TUI meet within CONNECT_TOLERANCE_MS. This pass may correct a
 *   remembered pairing (`fixed`).
 * - Second pass: connection ids grow with TUI start order, so each remaining
 *   TUI takes the smallest free id above the ids of TUIs started before it
 *   and below those started after it, whose first request falls into its
 *   startup window.
 * TUIs left unpaired stay unbound; callers must not guess for them.
 */
export function mapConnectionsToClients(
  clients: readonly DaemonClient[],
  connections: ReadonlyMap<number, DaemonConnection>,
  connectedAtMs: ReadonlyMap<string, number>,
  nowMs: number,
  fixed?: ReadonlyMap<string, number>
): Map<string, number> {
  let candidates = [...connections.entries()]
    .filter(([, connection]) => {
      const client = (connection.client ?? '').toLowerCase();
      return client.includes('tui') || (!client && connection.events.length > 0);
    })
    .map(([id]) => id);
  const live = candidates.filter(
    (id) => (connections.get(id)?.lastMs ?? 0) >= nowMs - LIVE_WINDOW_MS
  );
  if (live.length > 0) {
    candidates = live;
  }
  candidates.sort((left, right) => left - right);

  const pairs = new Map<string, number>();
  const taken = (id: number) => [...pairs.values()].includes(id);
  for (const client of clients) {
    const remembered = fixed?.get(client.pid);
    if (remembered !== undefined && candidates.includes(remembered) && !taken(remembered)) {
      pairs.set(client.pid, remembered);
    }
  }

  const nearByConnection = new Map<number, string[]>();
  for (const client of clients) {
    const connectedAt = connectedAtMs.get(client.pid);
    if (connectedAt === undefined) {
      continue;
    }
    const near = candidates.filter(
      (id) => Math.abs((connections.get(id)?.firstMs ?? 0) - connectedAt) <= CONNECT_TOLERANCE_MS
    );
    if (near.length === 1) {
      nearByConnection.set(near[0], [...(nearByConnection.get(near[0]) ?? []), client.pid]);
    }
  }
  for (const [id, pids] of nearByConnection) {
    if (pids.length !== 1) {
      continue;
    }
    for (const [pid, pairedId] of [...pairs]) {
      if (pairedId === id && pid !== pids[0]) {
        pairs.delete(pid);
      }
    }
    pairs.set(pids[0], id);
  }

  // A client without a known start time can only pair by its connect line.
  const ordered = clients
    .filter((client) => Number.isFinite(client.startMs))
    .sort((left, right) => left.startMs - right.startMs);
  ordered.forEach((client, index) => {
    if (pairs.has(client.pid)) {
      return;
    }
    const before = ordered.slice(0, index).map((c) => pairs.get(c.pid)).filter(
      (id): id is number => id !== undefined
    );
    const after = ordered.slice(index + 1).map((c) => pairs.get(c.pid)).filter(
      (id): id is number => id !== undefined
    );
    const low = Math.max(-1, ...before);
    const high = Math.min(Number.POSITIVE_INFINITY, ...after);
    for (const id of candidates) {
      if (id <= low || id >= high || taken(id)) {
        continue;
      }
      const firstMs = connections.get(id)?.firstMs ?? 0;
      if (firstMs >= client.startMs - START_SLACK_MS && firstMs <= client.startMs + STARTUP_WINDOW_MS) {
        pairs.set(client.pid, id);
        break;
      }
    }
  });
  return pairs;
}

/** The thread a connection is on (its latest thread request), and the ones it left. */
export function connectionThreads(
  connection: DaemonConnection | undefined
): { current: string | null; before: string[] } {
  const events = connection?.events ?? [];
  const last = events[events.length - 1];
  if (!last) {
    return { current: null, before: [] };
  }
  const before: string[] = [];
  for (const event of events) {
    if (event.threadId !== last.threadId && !before.includes(event.threadId)) {
      before.push(event.threadId);
    }
  }
  return { current: last.threadId, before };
}
