import assert from 'node:assert/strict';

import {
  renderTodosLine,
  renderTokenLine,
} from '../../dist/render/lines/activity-line.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';

const longStep =
  'Refactor the incremental rollout parser to support size-based short-circuiting everywhere';
const plan = {
  steps: [{ step: longStep, status: 'in_progress' }],
  todos: [],
  completedSteps: 0,
  totalSteps: 1,
  completedTodos: 0,
  totalTodos: 0,
  lastUpdate: new Date(0),
};

// width 80 keeps the historical 30-char floor (cap 32); width 200 raises the
// in-progress cap to 64, so more of the step survives.
const narrow = stripAnsi(renderTodosLine(plan, 80) ?? '');
const wide = stripAnsi(renderTodosLine(plan, 200) ?? '');
const beyondNarrowCap = longStep.slice(34, 60);
assert.ok(
  wide.includes(beyondNarrowCap),
  `a wide pane shows step text past the narrow cap: ${wide}`
);
assert.ok(
  !narrow.includes(beyondNarrowCap),
  `a narrow pane keeps the compact cut: ${narrow}`
);

// The plan line never overflows the pane it was given.
const tight = renderTodosLine(plan, 40) ?? '';
assert.ok(
  visualLength(tight) <= 40,
  `plan line respects the width budget (${visualLength(tight)})`
);

// The token line drops the in/cache/out breakdown on narrow panes instead of
// letting the outer truncation slice through it.
const data = {
  contextUsage: {
    used: 50_000,
    total: 128_000,
    percent: 39,
    inputTokens: 12_000,
    outputTokens: 9_000,
    cachedTokens: 130_000,
    compactCount: 0,
  },
  tokenUsage: {
    model_context_window: 128_000,
    last_token_usage: {
      total_tokens: 50_000,
      input_tokens: 142_000,
      cached_input_tokens: 130_000,
      output_tokens: 9_000,
    },
  },
};

const full = stripAnsi(renderTokenLine(data) ?? '');
assert.match(full, /cache:/, 'unconstrained width keeps the breakdown');

const narrowToken = stripAnsi(renderTokenLine(data, 46) ?? '');
assert.doesNotMatch(
  narrowToken,
  /cache:/,
  `narrow panes drop the breakdown: ${narrowToken}`
);
assert.match(narrowToken, /Ctx:/, 'the capacity signal survives');
assert.match(narrowToken, /Turn:/, 'the turn count stays visible');

// The context gauge is a fuel bar: filled cells are what REMAINS, matching
// the "% left" label — nearly exhausted context shows a nearly empty bar.
const countGlyph = (line, glyph) => line.split(glyph).length - 1;
const roomy = stripAnsi(renderTokenLine(data) ?? '');
assert.equal(
  countGlyph(roomy, '█'),
  7,
  '39% used leaves a mostly full 12-cell gauge'
);
const nearlyOut = stripAnsi(
  renderTokenLine({
    contextUsage: { ...data.contextUsage, percent: 88 },
  }) ?? ''
);
assert.equal(
  countGlyph(nearlyOut, '█'),
  1,
  '88% used leaves a sliver (12% of 12 cells)'
);
assert.equal(countGlyph(nearlyOut, '▁'), 11);
assert.match(nearlyOut, /12% left/);

console.log('test-plan-token-width: PASS');
