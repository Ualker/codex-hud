import assert from 'node:assert/strict';

import { HeightFitPolicy } from '../../dist/utils/height-fit.js';
import { parsePaneHeightSettings } from '../../dist/collectors/pane-height.js';

// The wrapper sizes the pane to a sixth of the window; at the live 46-row
// terminal that is seven rows, two of them blank on an idle session and one
// too few the moment agents or a plan appear. The policy asks for the rows
// the content wants, promptly on the way up and reluctantly on the way down.

const t0 = Date.parse('2026-09-05T10:00:00Z');
const policy = () =>
  new HeightFitPolicy({ minRows: 5, maxRows: 12, growThrottleMs: 10_000, shrinkAfterMs: 120_000 });

// ---- growth is prompt, clamped, and throttled --------------------------------
{
  const fit = policy();
  assert.equal(fit.observe(7, 7, t0), null, 'a pane that fits is left alone');
  assert.equal(fit.observe(9, 7, t0 + 1000), 9, 'more content grows the pane at once');
  assert.equal(fit.observe(11, 9, t0 + 2000), null, 'but not twice within the throttle');
  assert.equal(fit.observe(11, 9, t0 + 12_000), 11, 'the throttle expires');
  assert.equal(fit.observe(20, 11, t0 + 30_000), 12, 'never above the maximum');
}

// ---- shrinking waits for the content to stay small ----------------------------
{
  const fit = policy();
  assert.equal(fit.observe(9, 7, t0), 9);
  assert.equal(fit.observe(6, 9, t0 + 20_000), null, 'a smaller frame starts the clock');
  assert.equal(fit.observe(6, 9, t0 + 100_000), null, 'and is not acted on early');
  assert.equal(fit.observe(8, 9, t0 + 110_000), null, 'content coming back resets it');
  assert.equal(fit.observe(6, 9, t0 + 120_000), null);
  assert.equal(fit.observe(6, 9, t0 + 245_000), 6, 'two quiet minutes later the pane shrinks');
  assert.equal(fit.observe(2, 6, t0 + 400_000), null, 'never below the minimum: 5 wanted, 6 shown');
  assert.equal(fit.observe(2, 6, t0 + 530_000), 5);
}

// ---- a height set by hand is respected until the content changes -------------
{
  const fit = policy();
  assert.equal(fit.observe(9, 7, t0), 9);
  // The pane reads 11, not the 9 requested: the user dragged it.
  assert.equal(fit.observe(9, 11, t0 + 20_000), null, 'a manual height is not fought');
  assert.equal(fit.observe(9, 11, t0 + 200_000), null, 'not even after the shrink delay');
  assert.equal(fit.observe(12, 11, t0 + 210_000), 12, 'different content resumes fitting');
}

// ---- nonsense input is ignored -------------------------------------------------
{
  const fit = policy();
  assert.equal(fit.observe(Number.NaN, 7, t0), null);
  assert.equal(fit.observe(7, 0, t0), null);
}

// ---- the tmux option dump is what the fitter reads its bounds from ------------
{
  const settings = parsePaneHeightSettings(
    [
      '@codex_hud_auto 1',
      '@codex_hud_base_height 7',
      '@codex_hud_height_adaptive 1',
      '@codex_hud_height_max 12',
      '@codex_hud_height_min 5',
      '@codex_hud_main_pane "%47"',
      'mouse on',
    ].join('\n')
  );
  assert.deepEqual(settings, { adaptive: true, minRows: 5, maxRows: 12 });
  assert.equal(
    parsePaneHeightSettings('mouse on\n'),
    null,
    'a session without the wrapper options gets no fitter'
  );
  assert.deepEqual(
    parsePaneHeightSettings('@codex_hud_height_adaptive 0\n'),
    { adaptive: false, minRows: 5, maxRows: 12 },
    'an explicit CODEX_HUD_HEIGHT reads as non-adaptive'
  );
  assert.equal(parsePaneHeightSettings('@codex_hud_height_adaptive 1\n@codex_hud_height_min 9\n@codex_hud_height_max 3\n'), null);
}

console.log('test-height-fit: PASS');
