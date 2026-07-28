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

console.log('test-runtime-hooks: PASS (6 unique runtime hooks, guarded parsing)');
