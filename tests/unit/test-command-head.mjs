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
];

for (const [command, expected] of cases) {
  assert.equal(
    extractCommandHead(command),
    expected,
    `extractCommandHead(${JSON.stringify(command)})`
  );
}

console.log('test-command-head: PASS');
