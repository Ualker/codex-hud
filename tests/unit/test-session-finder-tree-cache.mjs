import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The pane's process tree was re-walked with a full `ps` table every 4-12s
// while nothing in it changed — 520-800ms of wall time per walk on this
// machine. A tree that holds a live Codex process is now trusted while that
// process answers a signal-0 check; a tree without one is walked again, so a
// Codex launched into an idle pane is still noticed.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-tree-cache-'));
const binDir = path.join(root, 'bin');
const counter = path.join(root, 'ps-calls');
const treeFile = path.join(root, 'tree');
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(path.join(root, 'codex-home'), { recursive: true });
fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });

// The test process itself is the "Codex" pid: it is alive for the whole run.
const alivePid = process.pid;
fs.writeFileSync(
  path.join(binDir, 'tmux'),
  `#!/usr/bin/env bash
if [[ "\${1:-}" == "display" ]]; then echo "${alivePid}"; exit 0; fi
exit 1
`
);
fs.writeFileSync(
  path.join(binDir, 'ps'),
  `#!/usr/bin/env bash
echo x >> ${JSON.stringify(counter)}
cat ${JSON.stringify(treeFile)}
`
);
fs.chmodSync(path.join(binDir, 'tmux'), 0o755);
fs.chmodSync(path.join(binDir, 'ps'), 0o755);

const saved = {
  PATH: process.env.PATH,
  CODEX_HOME: process.env.CODEX_HOME,
  CODEX_SESSIONS_PATH: process.env.CODEX_SESSIONS_PATH,
  CODEX_HUD_MAIN_PANE: process.env.CODEX_HUD_MAIN_PANE,
};
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
process.env.CODEX_HOME = path.join(root, 'codex-home');
process.env.CODEX_SESSIONS_PATH = path.join(root, 'sessions');
process.env.CODEX_HUD_MAIN_PANE = '%9';

const psCalls = () => {
  try {
    return fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
};

try {
  const { SessionFinder } = await import('../../dist/collectors/session-finder.js');

  // A tree with a live Codex process: one walk, then the cache answers.
  fs.writeFileSync(treeFile, `${alivePid} 1 node /Users/x/.nvm/versions/node/v25/bin/codex\n`);
  const finder = new SessionFinder(root, () => {});
  await finder.check(true);
  await finder.check(true);
  await finder.check(true);
  assert.equal(psCalls(), 1, 'a live Codex tree is walked once');

  // A tree without Codex is never cached: the pane may get one any moment.
  fs.rmSync(counter, { force: true });
  fs.writeFileSync(treeFile, `${alivePid} 1 -zsh\n`);
  const shellOnly = new SessionFinder(root, () => {});
  await shellOnly.check(true);
  await shellOnly.check(true);
  assert.equal(psCalls(), 2, 'a shell-only tree is walked every time');

  // A Codex pid that died is walked again.
  fs.rmSync(counter, { force: true });
  fs.writeFileSync(treeFile, `${alivePid} 1 -zsh\n999999 ${alivePid} node /x/bin/codex\n`);
  const deadCodex = new SessionFinder(root, () => {});
  await deadCodex.check(true);
  await deadCodex.check(true);
  assert.equal(psCalls(), 2, 'a dead Codex pid invalidates the cache');

  console.log('test-session-finder-tree-cache: PASS');
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
}
