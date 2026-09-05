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
  ['printf a\nprintf b', 'printf ×2'],
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
  ['printf a \\\n  b\nmake test', 'make test'],
  // Shell function definitions are declarations, not commands. The complete
  // body is skipped, and later invocations never keep a dangling `(`.
  [
    [
      'canary_root="$(mktemp -d /tmp/canary.XXXXXX)"',
      'run_canary() {',
      '  cmux-codex-wrapper "$1"',
      '  printf "%s\\n" "$?"',
      '}',
      'run_canary one &',
      'run_canary two &',
      'wait "$!"',
    ].join('\n'),
    // mktemp runs inside the first line's assignment substitution; the
    // function body itself still never leaks into the head.
    'mktemp ; run_canary ×2',
  ],
  ['run_canary() {\n  printf ok\n}', undefined],
  ['function cleanup() { rm -f /tmp/x; }\ncleanup', 'cleanup'],
  // Shell control-flow words and test expressions describe syntax, not the
  // program doing the work. Keep the real commands that follow them.
  [
    'set -e; if [ -f /tmp/ready ]; then tmux capture-pane -p -t %1; tmux capture-pane -p -t %2; fi',
    'tmux capture-pane ×2',
  ],
  ['if grep -q needle file; then echo found; fi', 'grep'],
  ['while test -f /tmp/busy; do sleep 1; done', 'sleep'],
  ['until [[ -e /tmp/ready ]]; do make test; done', 'make test'],
  ['export FOO=bar; cd /repo; npm test', 'npm test'],
  // Operators inside `$(...)` join that segment's data flow, not the top
  // level, and an assignment wrapping a substitution names the real program
  // right after `$(`. Splitting there put the flags after the assignment
  // prefix on screen: a live pane showed `-a | awk ; -f` for the command
  // below.
  [
    [
      'db_path=/Users/zyb/.cc-switch/cc-switch.db',
      'settings_path=/Users/zyb/.cc-switch/settings.json',
      `db_hash_before=$(shasum -a 256 "$db_path" | awk '{print $1}')`,
      `db_mtime_before=$(stat -f '%m' "$db_path")`,
      `settings_hash_before=$(shasum -a 256 "$settings_path" | awk '{print $1}')`,
      'python3 -B /Users/zyb/.codex/skills/sync_codex_skills.py --dry-run',
    ].join('\n'),
    'shasum ; stat ; shasum …',
  ],
  ['result=$(rg -n foo src | head -5)', 'rg'],
  ['v=$(dirname $(which node)) && ls', 'dirname && ls'],
  ['x=$( git rev-parse HEAD )', 'git rev-parse'],
  // `$((…))` arithmetic is an assignment, not a command.
  ['x=$((1+2)); echo done', 'echo'],
  // A flag is never a program name, wherever segment splitting leaves it.
  ['-a | awk', 'awk'],
  // Heredoc bodies are data. Splitting them on newlines minted fake heads
  // (`import`, `EOF`) and spent the segment budget real commands needed —
  // measured live as `python3 <<PY ; import ; from …`.
  ['python3 <<PY\nimport os\nfrom pathlib import Path\nprint(1)\nPY', 'python3'],
  ['cat <<EOF > /tmp/x\nhello world\nEOF', 'cat'],
  ["python3 - <<'PY'\nimport sys\nPY", 'python3'],
  ['cat <<-EOF\n\tindented\nEOF', 'cat'],
  // The heredoc body starts after the full command line; `&&` still splits.
  ['python3 <<PY && echo done\nimport x\nPY', 'python3'],
  // After the closing delimiter, later lines are commands again.
  ['cat <<EOF\nbody line\nEOF\ngit status', 'cat ; git status'],
  // Two heredocs on one line queue two bodies.
  ['cat <<A <<B\nfirst\nA\nsecond\nB\necho ok', 'cat'],
  // An unterminated body swallows to the end instead of minting heads.
  ['python3 <<PY\nimport never_closed', 'python3'],
  // A here-string stays inline and keeps following commands visible.
  ['grep -c x <<< "$data" && echo done', 'grep'],
  // Shell builtins never describe what a command did (measured live as
  // `ffmpeg ; echo ; exit`); echo/printf stay only when they are all there is.
  ['ffmpeg -i in.mp4 out.mp4 ; echo done ; exit 0', 'ffmpeg'],
  ['exit 1', undefined],
  ['true', undefined],
  ['echo hello', 'echo'],
  ['printf "%s" a; printf b', 'printf ×2'],
  ['make build || exit 1', 'make build'],
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
  // A bare flag where a program belongs means the extractor mis-parsed the
  // segment; better no head at all than `-a`.
  assert.equal(
    /(?:^|[|;&] )-/.test(head),
    false,
    `no segment head of ${JSON.stringify(command)} is a flag: ${JSON.stringify(head)}`
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
