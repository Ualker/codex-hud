import assert from 'node:assert/strict';
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
} from '../../dist/collectors/codex-daemon.js';
import { SessionFinder } from '../../dist/collectors/session-finder.js';
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
}

// ---------------------------------------------------------------- pairing

const T = Date.UTC(2026, 8, 23, 3, 38, 20);
const NOW = T + 25_000_000;
function book(spec) {
  return new Map(
    Object.entries(spec).map(([id, [firstMs, lastMs, client]]) => [
      Number(id),
      { firstMs, lastMs: lastMs ?? NOW - 30_000, client, events: [] },
    ])
  );
}
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
cat ${JSON.stringify(path.join(root, 'table'))}
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
function log(atMs, pid, body, threadId = null) {
  executeSql(
    dbPath,
    `INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, thread_id, process_uuid)
     VALUES (${Math.floor(atMs / 1000)}, ${(atMs % 1000) * 1_000_000}, 'INFO', 't', '${q(body)}',
       ${threadId ? `'${q(threadId)}'` : 'NULL'}, 'pid:${pid}:uuid-${pid}');`
  );
}

log(T0 + 4_800, 102, 'connected app-server platform has_platform_family=true');
log(T0 + 4_880, 103, span('thread/start', 2));
log(T0 + 6_630, 202, 'connected app-server platform has_platform_family=true');
log(T0 + 6_760, 103, span('thread/start', 5));
log(T0 + 11_100, 302, 'connected app-server platform has_platform_family=true');
log(T0 + 11_200, 103, span('thread/start', 8));
log(T0 + 17_000, 103, span('thread/start', 2), THREAD_A);
log(T0 + 26_000, 103, span('thread/start', 5), THREAD_B);
log(T0 + 34_000, 103, span('thread/start', 8), THREAD_C);
for (const connection of [2, 5, 8]) {
  log(Date.now() - 30_000, 103, span('account/rateLimits/read', connection));
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
};
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
process.env.CODEX_HOME = home;
delete process.env.CODEX_SESSIONS_PATH;

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
  assert.equal(b.session?.path, rolloutB, 'a pane outside the daemon tree binds through its connection');

  const c = await resolve('%3');
  assert.equal(
    c.session?.path, `codex-log://${THREAD_C}`,
    'a new session without a rollout yet is followed through the logs, not guessed by cwd'
  );

  const d = await resolve('%4');
  assert.equal(
    d.session, null,
    'an unpaired daemon client stays unbound: no cwd guess, no daemon-written snapshot'
  );

  // /new in pane %1: the connection moves on and only new rows are read.
  const THREAD_A2 = '01a0cdd0-2222-7333-8444-a55566667777';
  log(Date.now() - 5_000, 103, span('thread/start', 2), THREAD_A2);
  const again = await resolve('%1', a.finder);
  assert.equal(again.session?.path, `codex-log://${THREAD_A2}`, 'the pane follows its /new session');

  console.log('test-session-finder-daemon: PASS');
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
}
