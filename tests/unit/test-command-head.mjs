import assert from 'node:assert/strict';

import { extractCommandHead } from '../../dist/utils/command-head.js';

const cases = [
  // Simple commands keep just the program name.
  ['ls -la /private/dir', 'ls'],
  ['rg -n "secret pattern" src/', 'rg'],
  // Known multi-command tools keep one subcommand.
  ['git status --short', 'git status'],
  ['npm test', 'npm test'],
  ['npm run build -- --watch', 'npm run build'],
  ['docker compose up -d', 'docker compose'],
  // Interpreters and shells keep the script basename.
  ['python3 /home/user/scripts/train.py --epochs 3', 'python3 train.py'],
  ['node ./scripts/sync.js --force', 'node sync.js'],
  ['bash ./scripts/deploy.sh production', 'bash deploy.sh'],
  // Wrappers and assignments are skipped.
  ['FOO=1 BAR=2 npm test', 'npm test'],
  ['sudo -u admin systemctl restart nginx', 'systemctl restart'],
  ['env TOKEN=abc make build', 'make build'],
  ['timeout 30 ./scripts/e2e.sh', 'e2e.sh'],
  // shell -c payloads are unwrapped.
  ["bash -lc 'git rebase --continue'", 'git rebase'],
  ['sh -c "npm run lint"', 'npm run lint'],
  // Compound commands keep the joining operators.
  ['sed -n 1,240p file.md && rg -n pattern src', 'sed && rg'],
  ['ps aux | grep node', 'ps | grep'],
  ['cd /repo && npm run test:unit', 'npm run test:unit'],
  ['mkdir -p out; cp a out/', 'mkdir ; cp'],
  ['printf a\nprintf b', 'printf ; printf'],
  // More than three segments truncate with an ellipsis marker.
  ['a && b && c && d', 'a && b && c …'],
  // Redirections do not split segments.
  ['make build 2>&1', 'make build'],
  // Secrets never appear: only the program head is kept.
  [
    'MY_TOKEN=abc curl -H "Authorization: Bearer xyz" https://internal.example',
    'curl',
  ],
  // Empty input has no head.
  ['', undefined],
  ['   ', undefined],
  // A backslash before a newline continues the line; it is not a command of
  // its own. Keeping the pair made the newline itself the head of a segment,
  // which the pane printed as a lone `↵` between two real commands.
  ['env \\\n  A=1 \\\n  /bin/echo hi', 'echo'],
  ['printf a \\\n  b\nmake test', 'printf ; make test'],
];

// Whatever a head contains reaches the pane verbatim, so no control character
// may survive the extraction.
for (const [command] of cases) {
  const head = extractCommandHead(command);
  if (head === undefined) {
    continue;
  }
  assert.equal(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(head),
    false,
    `head of ${JSON.stringify(command)} is printable: ${JSON.stringify(head)}`
  );
}

for (const [command, expected] of cases) {
  assert.equal(
    extractCommandHead(command),
    expected,
    `extractCommandHead(${JSON.stringify(command)})`
  );
}

console.log('test-command-head: PASS');
