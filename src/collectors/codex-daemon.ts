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
 *   client name; some rows of thread/start, thread/resume and thread/fork
 *   spans also carry the thread_id that connection is on;
 * - the TUI logs `connected app-server platform ...` when it connects, within
 *   0.44s (before or after) of that connection's first request on the daemon
 *   side;
 * - just before, each TUI opens a probe connection (`experimentalFeature/list`
 *   only, 45ms ahead of the connect line on Train_52) that never carries a
 *   thread;
 * - connection ids grow in connection order and each TUI connects right after
 *   it starts, so when that log line is missing (1 of 7 panes) the live
 *   connections sorted by id line up with the TUIs sorted by start time.
 *
 * Codex keeps only the newest 1000 thread-less rows per process (and 1000 per
 * thread), so a daemon's request rows cover minutes to hours: the ledger has
 * to be read as it grows. A fresh one sees old connections start late and
 * misses the resume row of a long session, so HUDs hand their ledgers on
 * through a shared state file (see session-finder).
 */

import { codexSubcommand, isCodexProcessCommand } from './runtime-hooks.js';

/** Codex subcommands that never host an interactive session (bin/codex-hud). */
const NON_INTERACTIVE_SUBCOMMANDS = new Set([
  'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'mcp-server',
  'app-server', 'exec-server', 'remote-control', 'app', 'completion', 'update',
  'doctor', 'sandbox', 'debug', 'apply', 'a', 'archive', 'delete', 'unarchive',
  'cloud', 'features', 'help', 'agents', 'queue', 'migrate-rollouts',
]);

/** Session/fork candidates; previews (thread/read) do not change selection. */
const THREAD_METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork', 'turn/start']);

/**
 * TUI-side connect line vs the daemon's first request on that connection
 * (measured within 0.44s, either side). Panes launched together connect 2-5s
 * apart, so a wider window already sees the neighbour's connection and pairs
 * nobody.
 */
export const CONNECT_TOLERANCE_MS = 1_000;
/** Order fallback: a connection may appear this early (tick/second rounding)... */
export const START_SLACK_MS = 2_000;
/** ...and at most this late after its TUI started (first request 0.1-21s). */
export const STARTUP_WINDOW_MS = 300_000;
/** Unowned history expires after a day; quiet live owners keep their evidence. */
export const LEDGER_KEEP_MS = 24 * 60 * 60_000;

export interface ThreadEvent {
  atMs: number;
  method: string;
  threadId: string;
  /** This stay began with thread/fork, before compacted turn/start rows. */
  forked?: boolean;
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

/** A ledger as plain JSON, handed from one HUD process to the next. */
export interface LedgerSnapshot {
  /** `pid:<PID>:<UUID>` of the daemon process the facts belong to. */
  processUuid: string;
  lastRowId: number;
  connections: Array<[number, DaemonConnection]>;
  connectedAtMs: Array<[string, number]>;
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
 * Thread events oldest first, each run on one thread folded into its latest
 * row: only the switches between threads matter, and a long stay would
 * otherwise keep every row of it.
 */
function compactEvents(events: readonly ThreadEvent[]): ThreadEvent[] {
  const compacted: ThreadEvent[] = [];
  for (const event of [...events].sort((left, right) => left.atMs - right.atMs)) {
    const previous = compacted[compacted.length - 1];
    if (previous?.threadId === event.threadId) {
      // Temporary side threads can use the TUI's own connection. Keep their
      // fork origin when later turns compact the creation row; an explicit
      // thread/start or thread/resume is separate selection evidence.
      compacted[compacted.length - 1] = event.method === 'turn/start' &&
        (previous.method === 'thread/fork' || previous.forked)
        ? { ...event, forked: true }
        : event;
    } else {
      compacted.push(event);
    }
  }
  return compacted;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** A LedgerSnapshot read back from disk; malformed entries are dropped. */
export function reviveLedgerSnapshot(raw: unknown): LedgerSnapshot | null {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (
    typeof value.processUuid !== 'string' ||
    !pidOfProcessUuid(value.processUuid) ||
    !isFiniteNumber(value.lastRowId) ||
    !Array.isArray(value.connections) ||
    !Array.isArray(value.connectedAtMs)
  ) {
    return null;
  }
  const connections: Array<[number, DaemonConnection]> = [];
  for (const entry of value.connections as unknown[]) {
    const [id, item] = Array.isArray(entry) ? entry : [];
    const { firstMs, lastMs, client, events } = (item ?? {}) as Record<string, unknown>;
    if (
      !Number.isInteger(id) ||
      !isFiniteNumber(firstMs) ||
      !isFiniteNumber(lastMs) ||
      (client !== null && typeof client !== 'string') ||
      !Array.isArray(events)
    ) {
      continue;
    }
    const kept = (events as unknown[]).filter(
      (event): event is ThreadEvent =>
        typeof event === 'object' &&
        event !== null &&
        isFiniteNumber((event as ThreadEvent).atMs) &&
        typeof (event as ThreadEvent).method === 'string' &&
        typeof (event as ThreadEvent).threadId === 'string' &&
        (event as ThreadEvent).threadId !== '' &&
        ((event as ThreadEvent).forked === undefined || typeof (event as ThreadEvent).forked === 'boolean')
    );
    connections.push([id as number, { firstMs, lastMs, client, events: compactEvents(kept) }]);
  }
  const connectedAtMs = (value.connectedAtMs as unknown[]).filter(
    (entry): entry is [string, number] =>
      Array.isArray(entry) && /^\d+$/.test(String(entry[0])) && isFiniteNumber(entry[1])
  );
  return { processUuid: value.processUuid, lastRowId: value.lastRowId, connections, connectedAtMs };
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
  /** `pid:<PID>:<UUID>` of the daemon, once one of its rows was read. */
  processUuid: string | null = null;

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
      this.processUuid = row.processUuid;
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
        connection.events = compactEvents([
          ...connection.events,
          { atMs: row.tsMs, method: span.method, threadId: row.threadId },
        ]);
      }
    }
  }

  /** Facts as plain JSON; null until a row of the daemon itself was read. */
  snapshot(): LedgerSnapshot | null {
    if (!this.processUuid) {
      return null;
    }
    return {
      processUuid: this.processUuid,
      lastRowId: this.lastRowId,
      connections: [...this.connections].map(([id, connection]) => [
        id,
        { ...connection, events: [...connection.events] },
      ]),
      connectedAtMs: [...this.connectedAtMs],
    };
  }

  /**
   * Fold in what another HUD process recorded of this same daemon process.
   * Rows Codex has pruned since live on only there, so facts are united:
   * the earliest first request, the latest activity, every thread switch.
   * False (and nothing merged) until this ledger has seen its daemon's rows,
   * and for any other daemon process.
   */
  merge(snapshot: LedgerSnapshot): boolean {
    if (!this.processUuid || snapshot.processUuid !== this.processUuid) {
      return false;
    }
    for (const [id, theirs] of snapshot.connections) {
      const mine = this.connections.get(id);
      this.connections.set(id, {
        firstMs: Math.min(mine?.firstMs ?? theirs.firstMs, theirs.firstMs),
        lastMs: Math.max(mine?.lastMs ?? theirs.lastMs, theirs.lastMs),
        client: mine?.client ?? theirs.client,
        events: compactEvents([...(mine?.events ?? []), ...theirs.events]),
      });
    }
    for (const [pid, atMs] of snapshot.connectedAtMs) {
      this.connectedAtMs.set(pid, Math.max(this.connectedAtMs.get(pid) ?? atMs, atMs));
    }
    this.lastRowId = Math.max(this.lastRowId, snapshot.lastRowId);
    return true;
  }

  /**
   * Expire old unowned connections. Callers retain connections identified
   * for surviving TUIs: request silence is not evidence of process exit.
   * Keep connect lines next to retained connections as identity evidence.
   */
  prune(nowMs: number, retainedConnections: ReadonlySet<number> = new Set()): void {
    for (const [id, connection] of this.connections) {
      if (connection.lastMs < nowMs - LEDGER_KEEP_MS && !retainedConnections.has(id)) {
        this.connections.delete(id);
      }
    }
    const firsts = [...this.connections.values()].map((connection) => connection.firstMs);
    for (const [pid, atMs] of this.connectedAtMs) {
      if (
        atMs < nowMs - LEDGER_KEEP_MS &&
        !firsts.some((firstMs) => Math.abs(firstMs - atMs) <= CONNECT_TOLERANCE_MS)
      ) {
        this.connectedAtMs.delete(pid);
      }
    }
  }
}

/**
 * Pair daemon connections with TUI processes: pid -> connection id.
 *
 * - Only session connections are paired: at least one thread request, and a
 *   client name that mentions `tui` (or none). A TUI's probe connection meets
 *   its connect line as closely as the real one does and, with the lower id,
 *   won the old order pass. Activity timestamps never determine ownership:
 *   a surviving TUI may be silent for hours while another pane is active.
 * - First pass: the TUI's own connect line, when exactly one connection and
 *   exactly one TUI meet within CONNECT_TOLERANCE_MS. This pass may correct a
 *   remembered pairing (`fixed`).
 * - Startup evidence is a fallback only when one connection has one possible
 *   owner. Known neighbours bound the connection IDs; overlapping startup
 *   windows without enough evidence remain unpaired.
 * TUIs left unpaired stay unbound; callers must not guess for them.
 */
export function mapConnectionsToClients(
  clients: readonly DaemonClient[],
  connections: ReadonlyMap<number, DaemonConnection>,
  connectedAtMs: ReadonlyMap<string, number>,
  _nowMs: number,
  fixed?: ReadonlyMap<string, number>,
  lifecycle?: { daemonStartedAtMs: number | undefined }
): Map<string, number> {
  const candidates = [...connections.entries()]
    .filter(([, connection]) => {
      const client = (connection.client ?? '').toLowerCase();
      return connection.events.length > 0 && (!client || client.includes('tui'));
    })
    .map(([id]) => id);
  candidates.sort((left, right) => left - right);

  const pairs = new Map<string, number>();
  const taken = (id: number) => [...pairs.values()].includes(id);
  for (const client of clients) {
    const remembered = fixed?.get(client.pid);
    const firstMs = remembered === undefined ? undefined : connections.get(remembered)?.firstMs;
    if (remembered !== undefined && candidates.includes(remembered) && !taken(remembered) &&
      [...(fixed?.values() ?? [])].filter(id => id === remembered).length === 1 &&
      (!Number.isFinite(client.startMs) || (firstMs ?? 0) >= client.startMs - START_SLACK_MS)) {
      pairs.set(client.pid, remembered);
    }
  }

  const nearByConnection = new Map<number, string[]>();
  for (const client of clients) {
    const connectedAt = connectedAtMs.get(client.pid);
    if (connectedAt === undefined ||
      (Number.isFinite(client.startMs) && connectedAt < client.startMs - START_SLACK_MS)) {
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
  let changed = true;
  while (changed) {
    changed = false;
    const possible = new Map<string, number[]>();
    for (const [index, client] of ordered.entries()) {
      if (pairs.has(client.pid)) continue;
      // Reconnecting clients race after a daemon restart. Their original
      // process start order says nothing about the new connection numbering.
      if (lifecycle && (lifecycle.daemonStartedAtMs === undefined ||
        client.startMs < lifecycle.daemonStartedAtMs - START_SLACK_MS)) {
        continue;
      }
      const before = ordered.slice(0, index).map((c) => pairs.get(c.pid)).filter(
        (id): id is number => id !== undefined
      );
      const after = ordered.slice(index + 1).map((c) => pairs.get(c.pid)).filter(
        (id): id is number => id !== undefined
      );
      const low = Math.max(-1, ...before);
      const high = Math.min(Number.POSITIVE_INFINITY, ...after);
      possible.set(client.pid, candidates.filter(id => {
        const firstMs = connections.get(id)?.firstMs ?? 0;
        return id > low && id < high && !taken(id) &&
          firstMs >= client.startMs - START_SLACK_MS && firstMs <= client.startMs + STARTUP_WINDOW_MS;
      }));
    }
    for (const [pid, ids] of possible) {
      if (ids.length === 1 && [...possible.values()].filter(other => other.includes(ids[0])).length === 1) {
        pairs.set(pid, ids[0]);
        changed = true;
      }
    }
  }
  return pairs;
}

/**
 * Recover a reconnect only from a unique continuity chain: an exact old
 * connect-line pairing, its final thread, and the new connection's initial
 * thread/resume. Missing/pruned history or duplicate readers stay unpaired.
 */
export function mapReconnectedClients(
  clients: readonly DaemonClient[],
  connections: ReadonlyMap<number, DaemonConnection>,
  previousLedgers: readonly DaemonLedger[],
  daemonStartedAtMs: number
): Map<string, number> {
  const priorThreads = new Map<string, Set<string>>();
  const oldClients = clients.filter((c) => c.startMs < daemonStartedAtMs - START_SLACK_MS);
  for (const ledger of previousLedgers) {
    // NaN disables every order-based guess for historical evidence.
    const exact = mapConnectionsToClients(oldClients.map(c => ({ ...c, startMs: NaN })),
      ledger.connections, ledger.connectedAtMs, daemonStartedAtMs);
    for (const [pid, id] of exact) {
      const threadId = connectionThreads(ledger.connections.get(id)).current;
      if (!threadId) continue;
      const threads = priorThreads.get(pid) ?? new Set<string>();
      threads.add(threadId);
      priorThreads.set(pid, threads);
    }
  }
  const candidates = new Map<string, number[]>();
  for (const [pid, threads] of priorThreads) {
    if (threads.size !== 1) continue;
    const ids: number[] = [];
    for (const [id, connection] of connections) {
      const first = connection.events[0];
      const client = (connection.client ?? '').toLowerCase();
      if (client && !client.includes('tui')) continue;
      if (first?.method === 'thread/resume' && threads.has(first.threadId) &&
        connection.firstMs >= daemonStartedAtMs - START_SLACK_MS &&
        first.atMs - connection.firstMs >= 0 && first.atMs - connection.firstMs <= 30_000) {
        ids.push(id);
      }
    }
    candidates.set(pid, ids);
  }
  const pairs = new Map<string, number>();
  for (const [pid, ids] of candidates) {
    if (ids.length === 1 && [...candidates.values()].filter(v => v.includes(ids[0])).length === 1) {
      pairs.set(pid, ids[0]);
    }
  }
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
