import assert from 'node:assert/strict';

import {
  extractCodexRuntimeHookOverrides,
  extractCodexRuntimeHookState,
} from '../../dist/collectors/runtime-hooks.js';

const hook = (event, command) =>
  `hooks.${event}=[{hooks=[{type="command",command='''${command}''',timeout=10000}]}]`;

const injected = [
  hook('SessionStart', '/hooks/session-start'),
  hook('UserPromptSubmit', '/hooks/prompt-submit'),
  hook('Stop', '/hooks/stop'),
  hook('PreToolUse', '/hooks/pre-tool-use'),
  hook('PostToolUse', '/hooks/post-tool-use'),
  hook('PermissionRequest', '/hooks/notification'),
];

const flags = injected.map((override) => `-c ${override}`).join(' ');
const nodeCommand =
  `/opt/node /opt/bin/codex --enable hooks --dangerously-bypass-hook-trust ${flags} `
  + '--ask-for-approval never --sandbox danger-full-access';
const rustCommand =
  `/opt/codex --enable hooks --dangerously-bypass-hook-trust ${flags} `
  + '--ask-for-approval never --sandbox danger-full-access';

assert.deepEqual(
  extractCodexRuntimeHookOverrides([nodeCommand, rustCommand]),
  [...injected].sort(),
  'the Node launcher and Rust child must collapse to one runtime hook set'
);
assert.deepEqual(
  extractCodexRuntimeHookState([nodeCommand, rustCommand]),
  { overrides: [...injected].sort(), enabled: true },
  'the final runtime feature state should be preserved with the overrides'
);

const commandWithFlagLikeText = hook(
  'Stop',
  "sh -c \"printf '%s' '-c hooks.Fake=[{type=\\\"command\\\"}]'\""
);
assert.deepEqual(
  extractCodexRuntimeHookOverrides([
    `/opt/codex --enable hooks -c ${commandWithFlagLikeText}`,
  ]),
  [commandWithFlagLikeText],
  'flag-like text inside a TOML hook command must not become another hook'
);

assert.deepEqual(
  extractCodexRuntimeHookState([
    `/opt/codex --enable hooks -c ${hook('Stop', '/hooks/stop')} `
      + `--disable hooks -c ${hook('PreToolUse', '/hooks/pre-tool-use')}`,
  ]),
  { overrides: [], enabled: false },
  'a final explicit --disable hooks must suppress runtime hook overrides'
);

assert.deepEqual(
  extractCodexRuntimeHookOverrides([
    `/opt/codex --enable hooks -c ${hook('Stop', '/hooks/stop')} `
      + `"prompt mentioning -c ${hook('Fake', '/hooks/fake')}"`,
  ]),
  [hook('Stop', '/hooks/stop')],
  'hook-like prompt text after the first bare argument must be ignored'
);

assert.deepEqual(
  extractCodexRuntimeHookOverrides([
    `/bin/bash -lc "/opt/codex --enable hooks -c ${hook('Fake', '/hooks/fake')}"`,
    '/opt/codex --version',
  ]),
  [],
  'non-Codex processes and non-session commands without overrides must be ignored'
);

// ---- launch-flag policy ---------------------------------------------------
// CLI flags override the config file; while a 0.149 session has no rollout
// they are the only truth. Measured live: a `--ask-for-approval never
// --sandbox danger-full-access` pane whose HUD read the config's
// `ask for approval | workspace-write` instead. A walk that reaches the end
// of the argv (no bare argument, no profile, no unparseable policy word)
// additionally reports `exhaustive`: the argv provably overrides nothing
// beyond the parsed fields, so a plain launch may trust the config again.

const { extractCodexCliPolicy } = await import(
  '../../dist/collectors/runtime-hooks.js'
);

// The live 2026-08-24 invocation shape, hooks and all.
assert.deepEqual(
  extractCodexCliPolicy(
    `node /Users/zyb/.nvm/versions/node/v25.8.1/bin/codex --enable hooks ` +
      `--dangerously-bypass-hook-trust -c ${hook('Stop', '/hooks/stop')} ` +
      `--ask-for-approval never --sandbox danger-full-access`
  ),
  {
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    exhaustive: true,
  }
);

assert.deepEqual(extractCodexCliPolicy('/opt/homebrew/bin/codex --yolo'), {
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
  exhaustive: true,
});
assert.deepEqual(
  extractCodexCliPolicy(
    '/opt/codex --dangerously-bypass-approvals-and-sandbox'
  ),
  {
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    exhaustive: true,
  }
);
assert.deepEqual(extractCodexCliPolicy('/opt/codex --full-auto'), {
  approvalPolicy: 'on-failure',
  sandboxMode: 'workspace-write',
  exhaustive: true,
});
assert.deepEqual(
  extractCodexCliPolicy('/opt/codex -a on-request -s read-only'),
  {
    approvalPolicy: 'on-request',
    sandboxMode: 'read-only',
    exhaustive: true,
  }
);
assert.deepEqual(
  extractCodexCliPolicy('/opt/codex --sandbox=workspace-write'),
  { sandboxMode: 'workspace-write', exhaustive: true }
);
assert.deepEqual(
  extractCodexCliPolicy(
    '/opt/codex -c approval_policy="never" --config sandbox_mode=read-only'
  ),
  { approvalPolicy: 'never', sandboxMode: 'read-only', exhaustive: true }
);

// Later flags override earlier ones, matching the CLI.
assert.deepEqual(
  extractCodexCliPolicy('/opt/codex --full-auto --ask-for-approval never'),
  {
    approvalPolicy: 'never',
    sandboxMode: 'workspace-write',
    exhaustive: true,
  }
);

// A plain launch is the certification case: no flags at all, walked to the
// end, so the config file is provably what the process runs.
assert.deepEqual(extractCodexCliPolicy('/opt/codex'), { exhaustive: true });
assert.deepEqual(extractCodexCliPolicy('/opt/codex --enable hooks'), {
  exhaustive: true,
});

// A profile swaps in config values this parser does not resolve; flags
// around it still parse, but nothing may be certified.
assert.deepEqual(
  extractCodexCliPolicy('/opt/codex --profile speed --yolo'),
  { approvalPolicy: 'never', sandboxMode: 'danger-full-access' }
);
assert.deepEqual(extractCodexCliPolicy('/opt/codex -c profile="speed"'), {});

// A word Codex would reject must never reach the security cells — and a
// policy flag whose value this parser cannot read (a future vocabulary)
// forfeits the exhaustive claim too.
assert.deepEqual(extractCodexCliPolicy('/opt/codex --sandbox sideways'), {});

// Prompt text mentioning a flag is not a flag: the walk stops at the first
// bare argument, and flags after a subcommand read as unknown, not wrong.
assert.deepEqual(
  extractCodexCliPolicy('/opt/codex fix the --sandbox danger-full-access bug'),
  {}
);
assert.deepEqual(extractCodexCliPolicy('/opt/codex resume abc --yolo'), {});

// Values consumed by unrelated options stay values.
assert.deepEqual(
  extractCodexCliPolicy('/opt/codex -m gpt-5.6-sol --yolo'),
  {
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access',
    exhaustive: true,
  }
);

// Non-Codex commands claim nothing.
assert.deepEqual(extractCodexCliPolicy('tail -f codex --yolo'), {});

console.log('test-runtime-hooks: PASS (6 unique runtime hooks, guarded parsing)');
