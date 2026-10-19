import assert from 'node:assert/strict';
import { DaemonLedger, mapConnectionsToClients } from '../../dist/collectors/codex-daemon.js';

// Train1009: five surviving TUIs, but only the third and fifth connection
// have recent request logs. The third TUI's connect line has been pruned.
const start = Date.UTC(2026, 9, 16, 4, 27);
const now = start + 3 * 24 * 3600_000;
const clients = [0, 22_000, 25_000, 28_000, 31_000].map((offset, i) => ({
  pid: String(100 + i), startMs: start + offset,
}));
const connections = new Map(clients.map((client, i) => [14 + i * 3, {
  firstMs: client.startMs + 2_000,
  lastMs: now - (i === 2 || i === 4 ? 60_000 : 5 * 3600_000),
  client: 'codex-tui',
  events: [{ atMs: client.startMs + 3_000, method: 'thread/resume', threadId: `thread-${i}` }],
}]));
const connected = new Map(clients.filter((_, i) => i !== 2).map(c => [c.pid, c.startMs + 2_050]));
const lifecycle = { daemonStartedAtMs: start - 3600_000 };
const expected = { 100: 14, 101: 17, 102: 20, 103: 23, 104: 26 };
const pair = (book, fixed) => Object.fromEntries(mapConnectionsToClients(clients, book, connected, now, fixed, lifecycle));
assert.deepEqual(pair(connections), expected, 'idle live clients keep their own connections');
assert.deepEqual(pair(connections, new Map([['100', 20]])), expected, 'exact evidence repairs an earlier cross-binding');
for (const active of [14, 17, 20, 23, 26, null]) {
  const book = new Map([...connections].map(([id, c]) => [id, {
    ...c, lastMs: now - (id === active ? 0 : 5 * 3600_000),
  }]));
  assert.deepEqual(pair(book), expected, 'activity changes never change identity');
}

const ambiguousClients = [{ pid: 'A', startMs: start }, { pid: 'B', startMs: start + 500 }];
const ambiguous = new Map([[2, { ...connections.get(14), firstMs: start + 1000 }]]);
assert.deepEqual(Object.fromEntries(mapConnectionsToClients(ambiguousClients, ambiguous, new Map(), now)), {},
  'one connection cannot be guessed onto the first of two possible owners');
assert.deepEqual(Object.fromEntries(mapConnectionsToClients(
  [{ pid: 'A', startMs: start + 10_000 }], ambiguous, new Map([['A', start + 1000]]), now
)), {}, 'a reused PID cannot inherit a connect line older than its process');

const ledger = new DaemonLedger('500');
ledger.processUuid = 'pid:500:daemon';
for (const [id, c] of connections) ledger.connections.set(id, { ...c, lastMs: now - 2 * 24 * 3600_000 });
for (const [pid, atMs] of connected) ledger.connectedAtMs.set(pid, atMs);
ledger.connections.set(99, { ...connections.get(14), firstMs: start - 600_000, lastMs: start - 500_000 });
const retained = new Set(Object.values(expected));
ledger.prune(now, retained);
assert.deepEqual([...ledger.connections.keys()], [...retained], 'quiet verified owners survive history pruning; unowned old rows expire');
assert.deepEqual([...ledger.connectedAtMs], [...connected], 'retained connections keep their identity evidence');
ledger.prune(now, new Set());
assert.equal(ledger.connections.size, 0, 'history expires after its owners leave');
assert.equal(ledger.connectedAtMs.size, 0);
console.log('test-daemon-idle-identity: PASS');
