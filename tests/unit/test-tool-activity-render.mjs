import assert from 'node:assert/strict';

import { renderToolsLine } from '../../dist/render/lines/activity-line.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';

process.env.CODEX_HUD_TOOL_DETAILS = 'full';

function activity(recentCalls, totalCalls = recentCalls.length) {
  return {
    recentCalls,
    totalCalls,
    callsByType: {},
    lastUpdateTime: new Date(0),
  };
}

function call(id, name, status, extra = {}) {
  return {
    id,
    name,
    status,
    timestamp: new Date(0),
    ...extra,
  };
}

const completedWaits = Array.from({ length: 10 }, (_, index) =>
  call(`wait-${index}`, 'wait', 'completed')
);

assert.equal(
  renderToolsLine(activity(completedWaits, 21)),
  null,
  'completed wait-only history should not render a stale activity line'
);

const runningWait = stripAnsi(
  renderToolsLine(activity([call('wait-running', 'wait', 'running')])) ?? ''
);
assert.match(runningWait, /wait/, 'a currently running wait should remain visible');

const mixed = stripAnsi(
  renderToolsLine(activity([
    call('exec-1', 'exec_command', 'completed'),
    call('wait-1', 'wait', 'completed'),
    call('wait-2', 'wait', 'completed'),
  ])) ?? ''
);
assert.equal(mixed, '✓ exec_command', 'completed waits should not obscure useful tools');

const capped = stripAnsi(
  renderToolsLine(activity([
    call('exec-2', 'exec_command', 'completed'),
    ...Array.from({ length: 9 }, (_, index) => call(`capped-wait-${index}`, 'wait', 'completed')),
  ], 21)) ?? ''
);
assert.equal(capped, '✓ exec_command | (21 total)');

const failedWait = stripAnsi(
  renderToolsLine(activity([call('wait-error', 'wait', 'error')])) ?? ''
);
assert.match(failedWait, /wait/, 'failed waits should remain visible for diagnosis');

const detailedError = call('exec-error', 'exec_command', 'error', {
  summary: 'rg --files src',
  workdir: '/tmp/repo/codex-hud',
  duration: 50,
  result: {
    kind: 'exited',
    exitCode: 1,
    wallTimeMs: 48,
  },
});
const detailedErrorLine = stripAnsi(
  renderToolsLine(activity([detailedError]), 146, 2_500) ?? ''
);
assert.equal(
  detailedErrorLine,
  '✗ exec_command: rg --files src @codex-hud 48ms exit 1'
);

const yielded = call('exec-yielded', 'exec_command', 'completed', {
  summary: 'npm test',
  workdir: '/tmp/repo/codex-hud',
  result: {
    kind: 'yielded',
    sessionId: '4242',
    wallTimeMs: 30_000,
  },
});
const yieldedLine = stripAnsi(
  renderToolsLine(activity([yielded]), 146, 2_500) ?? ''
);
assert.equal(
  yieldedLine,
  '↻ exec_command: npm test @codex-hud 30s session 4242'
);

const running = call('exec-running', 'exec_command', 'running', {
  timestamp: new Date(1_000),
  summary: 'npm run build -- --watch',
  workdir: '/tmp/repo/codex-hud',
});
for (const width of [80, 120, 146]) {
  const rendered = renderToolsLine(
    activity([detailedError, yielded, running], 42),
    width,
    2_500
  );
  assert.ok(rendered, `width ${width} should render tool activity`);
  assert.ok(
    visualLength(rendered) <= width,
    `width ${width} must not overflow (${visualLength(rendered)})`
  );
  assert.doesNotMatch(stripAnsi(rendered), /[\r\n]/);
  assert.match(stripAnsi(rendered), /exec_command/);
  assert.match(stripAnsi(rendered), /1\.5s/);
}

const detailedWide = stripAnsi(
  renderToolsLine(
    activity([detailedError, running], 42),
    146,
    2_500
  ) ?? ''
);
assert.match(detailedWide, /exit 1/, 'wide output should retain the latest exit code');
assert.match(detailedWide, /\(42 total\)/, 'wide output should retain the total count');

console.log('test-tool-activity-render: PASS (8 cases)');
