import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEMP_PREFIX = 'codex-hud-file-watcher-';

function createTestRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
}

function removeTestRoot(testRoot) {
  const resolvedRoot = fs.realpathSync(testRoot);
  assert.equal(
    path.dirname(resolvedRoot),
    fs.realpathSync(os.tmpdir()),
    'cleanup must stay directly under the operating-system temp directory'
  );
  assert.ok(
    path.basename(resolvedRoot).startsWith(TEMP_PREFIX),
    'cleanup requires the test-owned directory prefix'
  );
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(50);
  }
  assert.fail(message);
}

const testRoot = createTestRoot();
const sessionsDir = path.join(testRoot, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
process.env.CODEX_SESSIONS_PATH = sessionsDir;

// Import after the env override so createSessionWatcher resolves the temp dir.
const { createSessionWatcher, isStaleSessionDatePath } = await import(
  '../../dist/collectors/file-watcher.js'
);

// Deterministic predicate checks with a pinned clock: date directories whose
// whole range ended before the 48h window are stale; structure, files, and
// non-date names never are.
{
  const root = '/sessions';
  const nowMs = Date.parse('2026-08-06T12:00:00');
  assert.equal(isStaleSessionDatePath(root, root, nowMs), false, 'root is kept');
  assert.equal(isStaleSessionDatePath(root, '/sessions/2025', nowMs), true);
  assert.equal(isStaleSessionDatePath(root, '/sessions/2026/07', nowMs), true);
  assert.equal(isStaleSessionDatePath(root, '/sessions/2026/08/03', nowMs), true);
  assert.equal(
    isStaleSessionDatePath(root, '/sessions/2026/08/05', nowMs),
    false,
    'yesterday stays inside the active window'
  );
  assert.equal(isStaleSessionDatePath(root, '/sessions/2026/08/06', nowMs), false);
  assert.equal(isStaleSessionDatePath(root, '/sessions/2026/08', nowMs), false);
  assert.equal(
    isStaleSessionDatePath(root, '/sessions/2026/08/03/rollout-x.jsonl', nowMs),
    false,
    'files defer to their directory'
  );
  assert.equal(
    isStaleSessionDatePath(root, '/sessions/archive', nowMs),
    false,
    'non-date names are never pruned'
  );
  assert.equal(isStaleSessionDatePath(root, '/elsewhere/2020', nowMs), false);
}

// A conclusively old date directory exists before the watcher arms: it must
// be pruned from the watch tree, so files appearing inside it stay silent.
const staleDayDir = path.join(sessionsDir, '2020', '01', '01');
fs.mkdirSync(staleDayDir, { recursive: true });

const watcher = createSessionWatcher();
const seen = [];
watcher.onChange((filePath, event) => {
  seen.push({ filePath, event });
});

try {
  watcher.start();
  // Let chokidar finish arming before mutating the tree.
  await delay(400);

  // The day directory is created after the watcher starts, as happens at
  // midnight rollover or on the first session of a new day. Today's real
  // date keeps the directory inside the pruning window. Build paths from
  // the resolved root: getSessionsDir() realpaths the override, so watcher
  // events carry resolved paths (on macOS /var/... resolves to /private/var).
  const watchRoot = fs.realpathSync(sessionsDir);
  const today = new Date();
  const dayDir = path.join(
    watchRoot,
    String(today.getFullYear()),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0')
  );
  fs.mkdirSync(dayDir, { recursive: true });
  const rolloutPath = path.join(
    dayDir,
    'rollout-2026-08-05T00-00-01-0123abcd.jsonl'
  );
  fs.writeFileSync(rolloutPath, '{"type":"session_meta"}\n');
  const ignoredPath = path.join(dayDir, 'notes.txt');
  fs.writeFileSync(ignoredPath, 'ignored');
  const staleRolloutPath = path.join(
    fs.realpathSync(staleDayDir),
    'rollout-2020-01-01T00-00-01-0123abcd.jsonl'
  );
  fs.writeFileSync(staleRolloutPath, '{"type":"session_meta"}\n');

  await waitFor(
    () => seen.some((e) => e.filePath === rolloutPath && e.event === 'add'),
    5000,
    'a rollout file created in a new day directory must fire an add event'
  );
  await delay(200);
  assert.ok(
    !seen.some((e) => e.filePath === ignoredPath),
    'non-rollout files must be filtered out'
  );
  assert.ok(
    !seen.some((e) => e.filePath === staleRolloutPath),
    'stale date directories are pruned from the watch tree'
  );

  console.log('test-file-watcher: PASS');
} finally {
  await watcher.stop();
  removeTestRoot(testRoot);
}
