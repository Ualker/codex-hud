import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DaemonLedger,
  connectionThreads,
  isInteractiveCodexCommand,
  isManagedDaemonCommand,
  mapConnectionsToClients,
  parseConnectionSpan,
  reviveLedgerSnapshot,
} from '../../dist/collectors/codex-daemon.js';
import { SessionFinder } from '../../dist/collectors/session-finder.js';
import { getCodexDataNamespace } from '../../dist/utils/codex-path.js';
import { resolveHudStateFile } from '../../dist/utils/state-dir.js';
import { executeSql } from '../helpers/sqlite.mjs';

// With features.daemon_auto_start (Codex 0.156+) every TUI is a client of one
// `codex app-server --managed-daemon`: the daemon writes the rollouts and every
// thread_id log row, the TUIs none. Shapes below are from three Linux hosts
// (2026-09-23), where panes showed no session, or another pane's.

const DAEMON = '/root/.codex/packages/app-server-daemon/releases/0.156.1-x86_64-unknown-linux-musl/bin/codex';
const NATIVE = '/root/.local/nodejs/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex';
const WRAPPER = 'node /root/.local/nodejs/bin/codex';
const THREAD_START_BODY =
  'app_server.request{otel.kind="server" otel.name="thread/start" rpc.system="jsonrpc" ' +
  'rpc.method="thread/start" rpc.transport="unix_socket" rpc.request_id=25 ' +
  'app_server.connection_id=2 app_server.api_version="v2" app_server.client_name="codex-tui" ' +
  'app_server.client_version="0.156.1"}:app_server.thread_start.create_thread{otel.name=' +
  '"app_server.thread_start.create_thread" thread_start.dynamic_tool_count=0}:shell_snapshot' +
  '{thread_id=01a0cd66-960e-7300-85f4-a302e3c3e015}: Shell snapshot successfully created';

function span(method, connectionId, client = 'codex-tui') {
  return (
    `app_server.request{otel.kind="server" otel.name="${method}" rpc.system="jsonrpc" ` +
    `rpc.method="${method}" rpc.transport="unix_socket" rpc.request_id=7 ` +
    `app_server.connection_id=${connectionId} app_server.api_version="v2" ` +
    `app_server.client_name="${client}" app_server.client_version="0.156.1"}: handled`
  );
}

// ---------------------------------------------------------------- commands

assert.equal(isManagedDaemonCommand(`${DAEMON} app-server --listen unix:// --managed-daemon`), true);
assert.equal(
  isManagedDaemonCommand(`${DAEMON} app-server daemon pid-update-loop`),
  false,
  'the updater launched alongside the daemon is not the daemon'
);
assert.equal(isManagedDaemonCommand(`${NATIVE} app-server`), false, 'an editor app-server is not managed');
assert.equal(isInteractiveCodexCommand(`${NATIVE} --ask-for-approval never --sandbox danger-full-access`), true);
assert.equal(isInteractiveCodexCommand(`${WRAPPER} resume --last`), true);
assert.equal(isInteractiveCodexCommand(`${DAEMON} app-server --listen unix:// --managed-daemon`), false);
assert.equal(isInteractiveCodexCommand(`${NATIVE} exec "run tests"`), false);
assert.equal(isInteractiveCodexCommand('-zsh'), false);

// ---------------------------------------------------------------- spans

assert.deepEqual(parseConnectionSpan(THREAD_START_BODY), {
  connectionId: 2,
  method: 'thread/start',
  client: 'codex-tui',
});
assert.deepEqual(parseConnectionSpan(span('account/rateLimits/read', 8)), {
  connectionId: 8,
  method: 'account/rateLimits/read',
  client: 'codex-tui',
});
for (const body of [
  '',
  'app-server request: initialize connection_id=ConnectionId(15) request_id=Integer(1)',
  'session_loop{thread_id=01a0cd68-193f-70f1-a693-f34605672562}: Submission',
  'app_server.request{otel.kind="server" rpc.method="x"}: no connection id',
]) {
  assert.equal(parseConnectionSpan(body), null, body);
}

// ---------------------------------------------------------------- ledger

{
  const ledger = new DaemonLedger('49747');
  ledger.ingest([
    { id: 1, tsMs: 1000, threadId: '', processUuid: 'pid:49030:u', body: 'connected app-server platform has_platform_family=true' },
    { id: 2, tsMs: 1100, threadId: '', processUuid: 'pid:49747:u', body: span('thread/start', 2) },
    { id: 3, tsMs: 13000, threadId: 'aaaa', processUuid: 'pid:49747:u', body: THREAD_START_BODY },
    { id: 4, tsMs: 40000, threadId: 'bbbb', processUuid: 'pid:49747:u', body: span('thread/resume', 2) },
    // previewing another session does not move the connection
    { id: 5, tsMs: 50000, threadId: 'cccc', processUuid: 'pid:49747:u', body: span('thread/read', 2) },
    { id: 6, tsMs: 90000, threadId: '', processUuid: 'pid:49747:u', body: span('account/rateLimits/read', 2) },
    // another app-server (an editor's) has its own connection numbering
    { id: 7, tsMs: 95000, threadId: 'dddd', processUuid: 'pid:31747:u', body: span('thread/start', 2, 'vscode') },
  ]);
  const connection = ledger.connections.get(2);
  assert.equal(ledger.lastRowId, 7);
  assert.equal(connection.firstMs, 1100);
  assert.equal(connection.lastMs, 90000);
  assert.equal(connection.client, 'codex-tui');
  assert.deepEqual(connection.events.map((e) => [e.method, e.threadId]), [
    ['thread/start', 'aaaa'],
    ['thread/resume', 'bbbb'],
  ]);
  assert.equal(ledger.connectedAtMs.get('49030'), 1000);
  assert.deepEqual(connectionThreads(connection), { current: 'bbbb', before: ['aaaa'] });
  assert.deepEqual(connectionThreads(undefined), { current: null, before: [] });
  assert.equal(ledger.processUuid, 'pid:49747:u');
}

{
  // Rows of one stay fold into the latest; switches are all kept.
  const ledger = new DaemonLedger('49747');
  ledger.ingest(
    [[1, 1000, 'aaaa'], [2, 1500, 'aaaa'], [3, 2000, 'bbbb'], [4, 2500, 'aaaa'], [5, 2600, 'aaaa']].map(
      ([id, tsMs, threadId]) => ({ id, tsMs, threadId, processUuid: 'pid:49747:u', body: span('thread/start', 2) })
    )
  );
  assert.deepEqual(ledger.connections.get(2).events.map((e) => [e.atMs, e.threadId]), [
    [1500, 'aaaa'], [2000, 'bbbb'], [2600, 'aaaa'],
  ]);
}

{
  // A snapshot handed to the next HUD process: pruned rows only live on there.
  const DAY = 24 * 60 * 60_000;
  const now = 10 * DAY;
  const row = (id, tsMs, connection, method, threadId = '') => ({
    id, tsMs, threadId, processUuid: 'pid:49747:u', body: span(method, connection),
  });
  const old = new DaemonLedger('49747');
  old.ingest([
    { id: 1, tsMs: now - 3_600_000, threadId: '', processUuid: 'pid:49030:u', body: 'connected app-server platform' },
    row(2, now - 3_599_900, 2, 'account/read'),
    row(3, now - 3_599_000, 2, 'thread/start', 'aaaa'),
    row(4, now - 1_800_000, 2, 'thread/resume', 'bbbb'),
    row(5, now - 2 * DAY, 9, 'thread/start', 'gone'),
  ]);
  const saved = old.snapshot();
  assert.equal(saved.processUuid, 'pid:49747:u');
  assert.deepEqual(reviveLedgerSnapshot(JSON.parse(JSON.stringify(saved))), saved, 'survives the JSON round trip');

  // What a fresh ledger reads after Codex pruned: 2's first rows and the
  // resume row of the long session it moved to are gone.
  const fresh = new DaemonLedger('49747');
  assert.equal(fresh.merge(saved), false, 'nothing is merged before the daemon process is known');
  fresh.ingest([
    { id: 1, tsMs: now - 3_600_000, threadId: '', processUuid: 'pid:49030:u', body: 'connected app-server platform' },
    row(3, now - 3_599_000, 2, 'thread/start', 'aaaa'),
    row(7, now - 60_000, 2, 'account/rateLimits/read'),
  ]);
  assert.equal(connectionThreads(fresh.connections.get(2)).current, 'aaaa', 'the pruned view is stale');
  assert.equal(fresh.merge(saved), true);
  const merged = fresh.connections.get(2);
  assert.equal(merged.firstMs, now - 3_599_900);
  assert.equal(merged.lastMs, now - 60_000);
  assert.equal(connectionThreads(merged).current, 'bbbb');
  assert.equal(fresh.lastRowId, 7);

  // Another daemon process (same pid, new uuid) shares nothing.
  const other = new DaemonLedger('49747');
  other.ingest([{ ...row(8, now, 2, 'thread/start', 'cccc'), processUuid: 'pid:49747:v' }]);
  assert.equal(other.merge(saved), false);
  assert.equal(connectionThreads(other.connections.get(2)).current, 'cccc');

  // A day without requests ends a connection; old connect lines go with it.
  fresh.connectedAtMs.set('11111', now - 2 * DAY);
  fresh.prune(now);
  assert.deepEqual([...fresh.connections.keys()].sort((a, b) => a - b), [2]);
  assert.deepEqual([...fresh.connectedAtMs.keys()], ['49030']);
  fresh.connectedAtMs.set('49030', now - 2 * DAY);
  fresh.connections.get(2).firstMs = now - 2 * DAY + 300;
  fresh.prune(now);
  assert.deepEqual([...fresh.connectedAtMs.keys()], ['49030'], "kept while it meets a live connection's first request");

  for (const junk of [null, 'x', {}, { ...saved, processUuid: 'nope' }, { ...saved, lastRowId: 'x' }]) {
    assert.equal(reviveLedgerSnapshot(junk), null);
  }
  const partial = reviveLedgerSnapshot({
    ...saved,
    connections: [[2, saved.connections[0][1]], ['x', {}], [3, { firstMs: 1 }]],
    connectedAtMs: [['49030', 5], ['bad', 6], ['7', 'x']],
  });
  assert.deepEqual(partial.connections.map(([id]) => id), [2]);
  assert.deepEqual(partial.connectedAtMs, [['49030', 5]]);
}

// ---------------------------------------------------------------- pairing

const T = Date.UTC(2026, 8, 23, 3, 38, 20);
const NOW = T + 25_000_000;
// A session connection: it started a thread right after connecting.
function book(spec) {
  return new Map(
    Object.entries(spec).map(([id, [firstMs, lastMs, client]]) => [
      Number(id),
      {
        firstMs,
        lastMs: lastMs ?? NOW - 30_000,
        client,
        events: [{ atMs: firstMs + 100, method: 'thread/start', threadId: `thread-${id}` }],
      },
    ])
  );
}
// A TUI's startup probe: one experimentalFeature/list, never a thread.
const probe = (atMs) => ({ firstMs: atMs, lastMs: atMs, client: 'codex-tui', events: [] });
const asObject = (pairs) => Object.fromEntries([...pairs].sort());

{
  // Trainh3: every TUI logged its connect line, 0.08-0.13s before the daemon
  // saw that connection's first request.
  const clients = [
    { pid: '49030', startMs: T + 10_590 },
    { pid: '50926', startMs: T + 14_980 },
    { pid: '52175', startMs: T + 19_460 },
  ];
  const conns = book({
    2: [T + 14_880, null, 'codex-tui'],
    5: [T + 16_760, null, 'codex-tui'],
    8: [T + 21_200, null, 'codex-tui'],
  });
  const connected = new Map([['49030', T + 14_800], ['50926', T + 16_630], ['52175', T + 21_100]]);
  assert.deepEqual(asObject(mapConnectionsToClients(clients, conns, connected, NOW)), {
    49030: 2, 50926: 5, 52175: 8,
  });
}

{
  // Train2: 2 and 5 belong to panes that exited long ago; 6904 never logged
  // its connect line. Order alone pairs the same way.
  const clients = [
    { pid: '6904', startMs: T },
    { pid: '7803', startMs: T + 2_750 },
    { pid: '27437', startMs: T + 480_000 },
  ];
  const conns = book({
    2: [T - 411_000, T - 411_000, 'codex-tui'],
    5: [T - 401_000, T - 389_000, 'codex-tui'],
    9: [T + 1_740, null, 'codex-tui'],
    12: [T + 4_530, null, 'codex-tui'],
    15: [T + 481_740, null, 'codex-tui'],
  });
  const expected = { 27437: 15, 6904: 9, 7803: 12 };
  const connected = new Map([['7803', T + 4_390], ['27437', T + 481_620]]);
  assert.deepEqual(asObject(mapConnectionsToClients(clients, conns, connected, NOW)), expected);
  assert.deepEqual(asObject(mapConnectionsToClients(clients, conns, new Map(), NOW)), expected);
}

{
  // B opened and closed between A and C: its dead connection must not shift C.
  const clients = [{ pid: 'A', startMs: T }, { pid: 'C', startMs: T + 62_000 }];
  const conns = book({
    2: [T + 1_000, null, 'codex-tui'],
    5: [T + 61_500, T + 70_000, 'codex-tui'],
    8: [T + 63_000, null, 'codex-tui'],
  });
  assert.deepEqual(asObject(mapConnectionsToClients(clients, conns, new Map(), NOW)), { A: 2, C: 8 });
}

{
  // A's own connection is missing from the logs: it must not reach past B's
  // id for C's connection.
  const clients = [
    { pid: 'A', startMs: T },
    { pid: 'B', startMs: T + 1_000 },
    { pid: 'C', startMs: T + 2_000 },
  ];
  const conns = book({ 5: [T + 1_500, null, 'codex-tui'], 8: [T + 4_000, null, 'codex-tui'] });
  assert.deepEqual(
    asObject(mapConnectionsToClients(clients, conns, new Map([['B', T + 1_400]]), NOW)),
    { B: 5, C: 8 }
  );
}

{
  // Two TUIs connecting within the tolerance of each other: fall back to
  // start order.
  const clients = [{ pid: 'A', startMs: T }, { pid: 'B', startMs: T + 500 }];
  const conns = book({ 2: [T + 1_100, null, 'codex-tui'], 5: [T + 1_700, null, 'codex-tui'] });
  const connected = new Map([['A', T + 1_000], ['B', T + 1_600]]);
  assert.deepEqual(asObject(mapConnectionsToClients(clients, conns, connected, NOW)), { A: 2, B: 5 });
}

{
  // Panes launched a couple of seconds apart (Trainh3: 1.88s between the two
  // connections): the connect lines alone still pair every pane.
  const clients = [{ pid: 'A', startMs: Number.NaN }, { pid: 'B', startMs: Number.NaN }];
  const conns = book({ 2: [T + 14_880, null, 'codex-tui'], 5: [T + 16_760, null, 'codex-tui'] });
  const connected = new Map([['A', T + 14_800], ['B', T + 16_630]]);
  assert.deepEqual(asObject(mapConnectionsToClients(clients, conns, connected, NOW)), { A: 2, B: 5 });
}

{
  // A remembered pairing is kept, but a fresh connect line corrects it.
  const clients = [{ pid: 'A', startMs: T }, { pid: 'B', startMs: T + 30_000 }];
  const conns = book({ 2: [T + 1_100, null, 'codex-tui'], 5: [T + 31_200, null, 'codex-tui'] });
  assert.deepEqual(
    asObject(
      mapConnectionsToClients(
        clients, conns, new Map([['A', T + 1_000], ['B', T + 31_000]]), NOW,
        new Map([['A', 5], ['B', 2]])
      )
    ),
    { A: 2, B: 5 }
  );
  assert.deepEqual(
    asObject(mapConnectionsToClients(clients, conns, new Map(), NOW, new Map([['A', 2]]))),
    { A: 2, B: 5 }
  );
}

{
  // Other clients of the daemon are not panes; a TUI without a start time
  // still pairs by its connect line; one whose connection never appeared stays
  // unpaired.
  const conns = book({ 3: [T + 1_000, null, 'vscode'], 4: [T + 1_200, null, 'codex-tui'] });
  assert.deepEqual(
    asObject(mapConnectionsToClients([{ pid: 'A', startMs: T }], conns, new Map([['A', T + 1_100]]), NOW)),
    { A: 4 }
  );
  assert.deepEqual(
    asObject(mapConnectionsToClients([{ pid: 'A', startMs: Number.NaN }], conns, new Map([['A', T + 1_100]]), NOW)),
    { A: 4 }
  );
  assert.deepEqual(
    asObject(mapConnectionsToClients([{ pid: 'A', startMs: T }], book({ 2: [T + 900_000, null, 'codex-tui'] }), new Map(), NOW)),
    {}
  );
}

{
  // Train_52, 12:48:31: TUI 1054 opened probe connection 7, then 8; its
  // connect line came 45ms after the probe's request and 14ms after 8's
  // first. The probe took the pane (connect line ambiguous, lower id first
  // in order) and kept it unbound for 15 minutes.
  const S = Date.UTC(2026, 8, 23, 12, 48, 31, 500);
  const now = S + 60_000;
  const conns = book({ 2: [S - 8_590_000, S + 55_000, 'codex-tui'], 8: [S + 1_511, now - 5_000, 'codex-tui'] });
  conns.set(7, probe(S + 1_480));
  const clients = [{ pid: '1054', startMs: S }];
  const connected = new Map([['1054', S + 1_525]]);
  assert.deepEqual(asObject(mapConnectionsToClients(clients, conns, connected, now)), { 1054: 8 });
  assert.deepEqual(asObject(mapConnectionsToClients(clients, conns, new Map(), now)), { 1054: 8 });
  // Until 8's thread row is read the pane waits instead of taking the probe.
  conns.get(8).events = [];
  assert.deepEqual(asObject(mapConnectionsToClients(clients, conns, connected, now)), {});
}

{
  // Three panes opened ten-odd seconds apart while the ones they replace are
  // closing: every new TUI brings a probe, and the old connections stay live.
  const S = Date.UTC(2026, 8, 23, 12, 46, 51, 950);
  const now = S + 120_000;
  const conns = book({
    9: [S - 33_860_000, S + 73_000, 'codex-tui'],
    12: [S - 33_858_000, S + 44_000, 'codex-tui'],
    15: [S - 33_380_000, S + 45_000, 'codex-tui'],
    29: [S + 1_300, now - 5_000, 'codex-tui'],
    32: [S + 18_100, now - 5_000, 'codex-tui'],
    35: [S + 29_500, now - 5_000, 'codex-tui'],
  });
  conns.set(28, probe(S + 1_200));
  conns.set(31, probe(S + 18_000));
  conns.set(34, probe(S + 29_400));
  const clients = [
    { pid: '15107', startMs: S },
    { pid: '16839', startMs: S + 17_130 },
    { pid: '18096', startMs: S + 27_520 },
  ];
  const connected = new Map([['15107', S + 1_350], ['16839', S + 18_150], ['18096', S + 29_560]]);
  const expected = { 15107: 29, 16839: 32, 18096: 35 };
  assert.deepEqual(asObject(mapConnectionsToClients(clients, conns, connected, now)), expected);
  assert.deepEqual(asObject(mapConnectionsToClients(clients, conns, new Map(), now)), expected);
}

// ---------------------------------------------------------------- SessionFinder

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-daemon-'));
const home = path.join(root, 'codex-home');
const cwd = path.join(root, 'project');
const binDir = path.join(root, 'bin');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });

const THREAD_A = '01a0cd66-960e-7300-85f4-a302e3c3e015';
const THREAD_B = '01a0cd70-1111-7222-8333-944455556666';
const THREAD_C = '01a0cdc2-dd83-7832-884b-aa0a34d4aeff';
// The session %2's TUI started on before moving to B.
const THREAD_X = '01a0cd66-0000-7000-8000-000000000001';
const T0 = Date.now() - 3_600_000;

// Pane %1's Codex launched the daemon; %4's TUI never shows up in its logs.
const table = [
  `100 1 -zsh`,
  `101 100 ${WRAPPER} --sandbox danger-full-access`,
  `102 101 ${NATIVE} --sandbox danger-full-access`,
  `103 102 ${DAEMON} app-server --listen unix:// --managed-daemon`,
  `104 102 ${DAEMON} app-server daemon pid-update-loop`,
  `200 1 -zsh`,
  `202 200 ${NATIVE} --sandbox danger-full-access`,
  `300 1 -zsh`,
  `302 300 ${NATIVE} --sandbox danger-full-access`,
  `400 1 -zsh`,
  `402 400 ${NATIVE} --sandbox danger-full-access`,
].join('\n');
fs.writeFileSync(path.join(root, 'table'), `${table}\n`);
fs.writeFileSync(path.join(root, 'starts'), '');
fs.writeFileSync(
  path.join(binDir, 'ps'),
  `#!/usr/bin/env bash
if [[ "\${1:-}" == "-o" && "\${2:-}" == pid=,lstart= ]]; then cat ${JSON.stringify(path.join(root, 'starts'))}; exit 0; fi
# The HUD pane exports COLUMNS; procps then cuts each line at that width unless
# asked for unlimited width (-ww). Without it the daemon loses --managed-daemon.
case "$1" in
  *ww*) cat ${JSON.stringify(path.join(root, 'table'))} ;;
  *) cut -c1-100 ${JSON.stringify(path.join(root, 'table'))} ;;
esac
`
);
fs.writeFileSync(
  path.join(binDir, 'tmux'),
  `#!/usr/bin/env bash
target=""
while [[ "\${1:-}" != "" ]]; do
  if [[ "$1" == "-t" ]]; then shift; target="\${1:-}"; fi
  shift || true
done
case "$target" in
  %1) echo 100 ;; %2) echo 200 ;; %3) echo 300 ;; %4) echo 400 ;;
  *) exit 1 ;;
esac
`
);
fs.chmodSync(path.join(binDir, 'ps'), 0o755);
fs.chmodSync(path.join(binDir, 'tmux'), 0o755);

function writeRollout(threadId, modifiedAt) {
  const now = new Date();
  const dir = path.join(
    home, 'sessions', String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')
  );
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-2026-09-23T08-34-07-${threadId}.jsonl`);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'session_meta',
      payload: { id: threadId, cwd, originator: 'codex-tui', cli_version: '0.156.1', source: 'vscode' },
    }) + '\n'
  );
  fs.utimesSync(filePath, modifiedAt, modifiedAt);
  return fs.realpathSync(filePath);
}

const q = (value) => String(value).replaceAll("'", "''");
const dbPath = path.join(home, 'logs_2.sqlite');
executeSql(dbPath, `CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  ts_nanos INTEGER NOT NULL,
  level TEXT NOT NULL,
  target TEXT NOT NULL,
  feedback_log_body TEXT,
  thread_id TEXT,
  process_uuid TEXT
);`);
function log(atMs, pid, body, threadId = null, target = 't') {
  executeSql(
    dbPath,
    `INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, thread_id, process_uuid)
     VALUES (${Math.floor(atMs / 1000)}, ${(atMs % 1000) * 1_000_000}, 'INFO', '${q(target)}', '${q(body)}',
       ${threadId ? `'${q(threadId)}'` : 'NULL'}, 'pid:${pid}:uuid-${pid}');`
  );
}

// Each TUI opens a probe connection just before its real one (Train_52).
log(T0 + 4_790, 103, span('experimentalFeature/list', 1));
log(T0 + 4_800, 102, 'connected app-server platform has_platform_family=true');
log(T0 + 4_880, 103, span('thread/start', 2));
log(T0 + 6_600, 103, span('experimentalFeature/list', 4));
log(T0 + 6_630, 202, 'connected app-server platform has_platform_family=true');
log(T0 + 6_760, 103, span('thread/start', 5));
log(T0 + 7_000, 103, span('thread/start', 5), THREAD_X);
log(T0 + 11_100, 302, 'connected app-server platform has_platform_family=true');
log(T0 + 11_200, 103, span('thread/start', 8));
log(T0 + 17_000, 103, span('thread/start', 2), THREAD_A);
log(T0 + 26_000, 103, span('thread/start', 5), THREAD_B);
log(T0 + 34_000, 103, span('thread/start', 8), THREAD_C);
for (const connection of [2, 5, 8]) {
  log(Date.now() - 30_000, 103, span('account/rateLimits/read', connection));
}
// Rows a daemon client does log can name other panes' threads: %3's TUI
// mentions A, and %4's agents overview lists A and B (Train2, 12:49).
log(Date.now() - 20_000, 302, 'thread named by the TUI', THREAD_A);
for (const threadId of [THREAD_A, THREAD_B]) {
  log(Date.now() - 20_000, 402, 'agents overview row', threadId, 'codex_tui::app::agents_overview_threads');
}

const rolloutA = writeRollout(THREAD_A, new Date(Date.now() - 20 * 60_000));
const rolloutB = writeRollout(THREAD_B, new Date(Date.now() - 60_000));
// The daemon writes every shell snapshot; the one naming %4 belongs to B.
fs.mkdirSync(path.join(home, 'shell_snapshots'), { recursive: true });
fs.writeFileSync(
  path.join(home, 'shell_snapshots', `${THREAD_B}.${BigInt(Date.now()) * 1_000_000n}.sh`),
  "export TMUX_PANE='%4'\n"
);

const saved = {
  PATH: process.env.PATH,
  CODEX_HOME: process.env.CODEX_HOME,
  CODEX_SESSIONS_PATH: process.env.CODEX_SESSIONS_PATH,
  CODEX_HUD_MAIN_PANE: process.env.CODEX_HUD_MAIN_PANE,
  HOME: process.env.HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
process.env.CODEX_HOME = home;
delete process.env.CODEX_SESSIONS_PATH;
// HUDs share their daemon ledger through a state file: keep it out of the real home.
process.env.HOME = path.join(root, 'home');
process.env.XDG_STATE_HOME = path.join(root, 'state');

async function resolve(pane, finder = new SessionFinder(cwd, undefined, new Date(T0))) {
  process.env.CODEX_HUD_MAIN_PANE = pane;
  return { finder, session: await finder.check(true) };
}

try {
  const a = await resolve('%1');
  assert.equal(
    a.session?.path, rolloutA,
    "the pane that launched the daemon follows its own connection, not the daemon's newest session"
  );

  const b = await resolve('%2');
  assert.equal(
    b.session?.path, rolloutB,
    'a pane outside the daemon tree binds through its connection, not its TUI probe'
  );

  const c = await resolve('%3');
  assert.equal(
    c.session?.path, `codex-log://${THREAD_C}`,
    "a new session without a rollout yet is followed through the logs, not the TUI's own rows"
  );

  const d = await resolve('%4');
  assert.equal(
    d.session, null,
    'an unpaired daemon client stays unbound: no agents-overview row, cwd guess or daemon-written snapshot'
  );

  // /new in pane %1: the connection moves on and only new rows are read.
  const THREAD_A2 = '01a0cdd0-2222-7333-8444-a55566667777';
  log(Date.now() - 5_000, 103, span('thread/start', 2), THREAD_A2);
  const again = await resolve('%1', a.finder);
  assert.equal(again.session?.path, `codex-log://${THREAD_A2}`, 'the pane follows its /new session');

  // A HUD reloaded hours later. B and C grew into long sessions, and Codex
  // keeps 1000 rows per thread and 1000 thread-less rows per process: the
  // thread/start rows of B and C are gone, and so are the daemon's early
  // requests. What survives says %2 is still on X and %3 on nothing.
  const sharedFile = resolveHudStateFile(`shared-daemon-ledger-${getCodexDataNamespace()}.json`);
  assert.ok(sharedFile && fs.existsSync(sharedFile), 'the HUDs shared their ledger');
  const record = fs.readFileSync(sharedFile);
  const rolloutC = writeRollout(THREAD_C, new Date());
  executeSql(
    dbPath,
    `DELETE FROM logs WHERE thread_id IN ('${THREAD_B}', '${THREAD_C}')
       OR (process_uuid = 'pid:103:uuid-103' AND thread_id IS NULL
           AND ts < ${Math.floor((Date.now() - 600_000) / 1000)});`
  );
  // Each reload is a new process: nothing of this one's ledger carries over.
  const sessionFinderUrl = new URL('../../dist/collectors/session-finder.js', import.meta.url).href;
  const reload = () => {
    const script = `
      const { SessionFinder } = await import(${JSON.stringify(sessionFinderUrl)});
      const paths = {};
      for (const pane of ['%2', '%3']) {
        process.env.CODEX_HUD_MAIN_PANE = pane;
        const finder = new SessionFinder(${JSON.stringify(cwd)}, undefined, new Date(${T0}));
        paths[pane] = (await finder.check(true))?.path ?? null;
      }
      console.log(JSON.stringify(paths));`;
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: process.env,
    });
    return JSON.parse(stdout.trim().split('\n').pop());
  };

  fs.rmSync(sharedFile);
  const blind = reload();
  assert.notEqual(blind['%2'], rolloutB, 'without the shared ledger the pruned logs mislead');
  assert.notEqual(blind['%3'], rolloutC, 'without the shared ledger the pruned logs mislead');

  fs.writeFileSync(sharedFile, record);
  assert.deepEqual(
    reload(),
    { '%2': rolloutB, '%3': rolloutC },
    'a reloaded HUD picks up the ledger its predecessors recorded'
  );

  console.log('test-session-finder-daemon: PASS');
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
}
