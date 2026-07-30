import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectGitStatusAsync,
  parsePorcelainV2Status,
} from '../../dist/collectors/git.js';

const porcelain = [
  '# branch.oid 0123456789abcdef',
  '# branch.head feature/hud',
  '# branch.upstream origin/feature/hud',
  '# branch.ab +3 -2',
  '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb modified.ts',
  '1 A. N... 000000 100644 100644 0000000 bbbbbbb added.ts',
  '1 .D N... 100644 100644 000000 aaaaaaa aaaaaaa deleted.ts',
  '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 renamed.ts\told.ts',
  '? untracked.ts',
  '',
].join('\n');

assert.deepEqual(parsePorcelainV2Status(porcelain), {
  branch: 'feature/hud',
  isDirty: true,
  isGitRepo: true,
  ahead: 3,
  behind: 2,
  modified: 2,
  added: 1,
  deleted: 1,
  untracked: 1,
});

const detached = parsePorcelainV2Status(
  '# branch.oid fedcba9876543210\n# branch.head (detached)\n'
);
assert.equal(detached.branch, 'fedcba9');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-git-once-'));
const bin = path.join(root, 'bin');
const counter = path.join(root, 'calls');
const fakeGit = path.join(bin, 'git');
const originalPath = process.env.PATH;
const originalCounter = process.env.GIT_CALL_COUNTER;

try {
  fs.mkdirSync(bin);
  fs.writeFileSync(
    fakeGit,
    `#!/bin/sh
if [ "\${GIT_OPTIONAL_LOCKS:-}" != "0" ]; then
  exit 9
fi
printf x >> "\$GIT_CALL_COUNTER"
case "\${GIT_FAKE_MODE:-success}" in
  nonrepo)
    echo 'fatal: not a git repository (or any of the parent directories): .git' >&2
    exit 128
    ;;
  error)
    echo 'fatal: fixture status failure' >&2
    exit 128
    ;;
esac
printf '%s\\n' '# branch.oid 0123456789abcdef' '# branch.head main' '# branch.ab +1 -4' '? new.txt'
`,
    'utf8'
  );
  fs.chmodSync(fakeGit, 0o755);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  process.env.GIT_CALL_COUNTER = counter;

  const status = await collectGitStatusAsync(root);
  assert.equal(status.branch, 'main');
  assert.equal(status.ahead, 1);
  assert.equal(status.behind, 4);
  assert.equal(status.untracked, 1);
  assert.equal(
    fs.readFileSync(counter, 'utf8'),
    'x',
    'one refresh must spawn exactly one Git process'
  );

  process.env.GIT_FAKE_MODE = 'nonrepo';
  assert.equal(
    (await collectGitStatusAsync(root)).isGitRepo,
    false,
    'a non-repository directory is a valid fresh snapshot'
  );

  process.env.GIT_FAKE_MODE = 'error';
  await assert.rejects(
    collectGitStatusAsync(root),
    /fixture status failure/,
    'an operational Git failure must reach cache health instead of masquerading as a clean directory'
  );
  assert.equal(fs.readFileSync(counter, 'utf8'), 'xxx');
} finally {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalCounter === undefined) delete process.env.GIT_CALL_COUNTER;
  else process.env.GIT_CALL_COUNTER = originalCounter;
  delete process.env.GIT_FAKE_MODE;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('test-git-porcelain-v2: PASS');
