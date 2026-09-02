import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RolloutParser } from '../../dist/collectors/rollout.js';
import { retainRateLimitWindows } from '../../dist/collectors/rate-limit-windows.js';
import { rateLimitAlertKind } from '../../dist/render/lines/activity-line.js';
import {
  renderRateLimitLine,
  renderTurnActivityLine,
} from '../../dist/render/lines/index.js';
import { stripAnsi } from '../../dist/render/colors.js';

// The 2026-08-31 exhaustion, record for record: the 5h window reads 100%,
// one second later Codex writes the windowless "premium" snapshot, and the
// turn ends with `task_complete.error`. Everything the HUD showed for that
// stretch was a green check and a quota row without the reset time.
//
// Windows sit relative to the real clock: the renderer and the alert
// predicate expire them against Date.now() (a fixture pinned to a fixed
// epoch goes red on its own a few days later).
const nowMs = Date.now();
const nowSec = Math.floor(nowMs / 1000);
const FIVE_H_RESETS = nowSec + 3 * 3600 + 47 * 60;
const WEEKLY_RESETS = nowSec + 6 * 86400;
const at = (offsetSec) => new Date(nowMs + offsetSec * 1000).toISOString();

const USAGE_LIMIT_MESSAGE =
  "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), " +
  'visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 9:18 PM.';

const credits = { has_credits: false, unlimited: false, balance: '0' };
const spent = {
  limit_id: 'codex',
  limit_name: null,
  primary: { used_percent: 100, window_minutes: 300, resets_at: FIVE_H_RESETS },
  secondary: { used_percent: 31, window_minutes: 10080, resets_at: WEEKLY_RESETS },
  credits,
  individual_limit: null,
  spend_control_reached: null,
  plan_type: 'plus',
  rate_limit_reached_type: null,
};
const windowless = {
  limit_id: 'premium',
  limit_name: null,
  primary: null,
  secondary: null,
  credits,
  individual_limit: null,
  spend_control_reached: null,
  plan_type: 'plus',
  rate_limit_reached_type: null,
};

const tokenCount = (offsetSec, rateLimits) => ({
  timestamp: at(offsetSec),
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { model_context_window: 258400, last_token_usage: { total_tokens: 1000 } },
    rate_limits: rateLimits,
  },
});

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-turn-failure-'));
const rolloutPath = path.join(
  tempRoot,
  'rollout-2026-08-31T11-30-22-01a055de-398f-7253-bbe9-37f5631590a0.jsonl'
);
const appendRecords = (records) =>
  fs.appendFileSync(
    rolloutPath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8'
  );

const baseData = (rateLimits) => ({
  config: { model: 'gpt-5.6-sol' },
  git: { isGitRepo: false },
  project: { cwd: '/tmp', projectName: 'prj', agentsMdCount: 0, mcpCount: 0, skillsCount: 0, hooksCount: 0 },
  sessionStart: new Date(nowMs - 3600_000),
  collectorHealth: {},
  displayMode: 'single',
  rateLimits,
});

try {
  appendRecords([
    {
      timestamp: at(-1000),
      type: 'session_meta',
      payload: {
        id: '01a055de-398f-7253-bbe9-37f5631590a0',
        timestamp: at(-1000),
        cwd: '/tmp/turn-failure',
        originator: 'codex-tui',
        cli_version: '0.151.0',
        source: 'cli',
      },
    },
    {
      timestamp: at(-980),
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-1', model_context_window: 258400 },
    },
    tokenCount(-2, spent),
  ]);

  const parser = new RolloutParser(10);
  parser.setRolloutPath(rolloutPath);

  const beforeExhaustion = await parser.parse();
  assert.equal(beforeExhaustion?.turnActivity?.phase, 'thinking');
  assert.equal(beforeExhaustion?.rateLimits?.primary?.used_percent, 100);
  assert.equal(
    beforeExhaustion?.rateLimits?.windowsRetained,
    undefined,
    'a snapshot that states its windows is kept as written'
  );

  // The next batch is the exhaustion: retained across the incremental parse,
  // not only within one pass.
  appendRecords([
    tokenCount(-1, windowless),
    {
      timestamp: at(0),
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-1',
        last_agent_message: null,
        error: { message: USAGE_LIMIT_MESSAGE, codex_error_info: 'usage_limit_exceeded' },
        // codex 0.151 writes these as epoch seconds.
        started_at: nowSec - 977,
        completed_at: nowSec,
        duration_ms: 976568,
        time_to_first_token_ms: 10842,
      },
    },
  ]);

  const failed = await parser.parse();
  assert.equal(failed?.turnActivity?.phase, 'failed', 'an errored task_complete is not idle');
  assert.equal(failed?.turnActivity?.lastTurnError?.code, 'usage_limit_exceeded');
  assert.match(failed?.turnActivity?.lastTurnError?.message ?? '', /^You've hit your usage limit/);
  assert.equal(failed?.turnActivity?.lastTurnDurationMs, 976568);

  const limits = failed?.rateLimits;
  assert.equal(limits?.windowsRetained, true, 'the windowless snapshot keeps the spent window');
  assert.equal(limits?.primary?.used_percent, 100);
  assert.equal(limits?.primary?.resets_at, FIVE_H_RESETS, 'the reset time survives the exhaustion');
  assert.equal(limits?.secondary?.used_percent, 31);
  assert.equal(limits?.limit_id, 'codex', 'the windows keep naming their own pool');
  assert.equal(limits?.credits?.has_credits, false, 'the exhaustion itself is the newest fact');
  assert.equal(
    rateLimitAlertKind(limits, nowMs),
    'credits-exhausted',
    'retained windows do not hide the exhaustion from the alert (and the limit-reached notification)'
  );

  const quotaRow = stripAnsi(renderRateLimitLine(baseData(limits), 200, nowMs) ?? '');
  assert.match(quotaRow, /5h 0% left/, `the spent window stays on the row: ${quotaRow}`);
  assert.match(quotaRow, /resets in 3h4[67]m/, `with the moment work can resume: ${quotaRow}`);
  assert.match(quotaRow, /credits: 0/, `and the exhaustion beside it: ${quotaRow}`);

  const activityRow = stripAnsi(renderTurnActivityLine(failed.turnActivity, 200, nowMs));
  assert.match(activityRow, /^✗ Turn failed · usage limit/, `the provider's verdict, not a completion: ${activityRow}`);
  assert.match(activityRow, /after 16m1[67]s/, `the work lost, never "last turn": ${activityRow}`);
  assert.doesNotMatch(activityRow, /last turn|Idle|waiting for you/);

  // The next turn, after the reset: a completed task_complete clears the
  // failure, and a snapshot that states its windows replaces the retained one.
  appendRecords([
    {
      timestamp: at(60),
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-2', model_context_window: 258400 },
    },
    tokenCount(120, {
      ...spent,
      primary: { used_percent: 0, window_minutes: 300, resets_at: FIVE_H_RESETS + 18000 },
    }),
    {
      timestamp: at(180),
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn-2',
        last_agent_message: 'done',
        started_at: nowSec + 60,
        completed_at: nowSec + 180,
        duration_ms: 120000,
      },
    },
  ]);
  const recovered = await parser.parse();
  assert.equal(recovered?.turnActivity?.phase, 'idle');
  assert.equal(recovered?.turnActivity?.lastTurnError, undefined, 'a completed turn clears the failure');
  assert.equal(recovered?.rateLimits?.windowsRetained, undefined);
  assert.equal(recovered?.rateLimits?.primary?.used_percent, 0);
  assert.equal(recovered?.rateLimits?.limit_id, 'codex');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

// ---- the retention rule on its own ------------------------------------------

{
  const previous = spent;
  const retained = retainRateLimitWindows(previous, windowless, nowMs);
  assert.equal(retained.windowsRetained, true);
  assert.equal(retained.primary?.resets_at, FIVE_H_RESETS);
  assert.equal(retained.secondary?.resets_at, WEEKLY_RESETS);
  assert.equal(retained.plan_type, 'plus');

  // A window whose own reset has passed says nothing about the current block.
  const expired = retainRateLimitWindows(
    { ...spent, primary: { ...spent.primary, resets_at: nowSec - 60 } },
    windowless,
    nowMs
  );
  assert.equal(expired.primary, null, 'an expired window is not carried forward');
  assert.equal(expired.secondary?.used_percent, 31, 'the live one is');
  assert.equal(expired.windowsRetained, true);

  // Nothing to retain from: the windowless snapshot stands as written.
  assert.deepEqual(retainRateLimitWindows(null, windowless, nowMs), windowless);
  assert.deepEqual(
    retainRateLimitWindows(
      { ...spent, primary: { ...spent.primary, resets_at: nowSec - 60 }, secondary: null },
      windowless,
      nowMs
    ),
    windowless,
    'only expired windows behind it: nothing is retained, nothing is marked'
  );

  // A snapshot that states a window is never rewritten.
  const fresh = { ...spent, primary: { ...spent.primary, used_percent: 3 } };
  assert.equal(retainRateLimitWindows(windowless, fresh, nowMs), fresh);
}

// ---- the other verdicts Codex writes -----------------------------------------

{
  const failedTurn = (error, durationMs = 2_102_116) => ({
    phase: 'failed',
    since: new Date(nowMs - 3600_000),
    lastActivityAt: new Date(nowMs - 3600_000),
    lastTurnDurationMs: durationMs,
    lastTurnError: error,
  });
  const row = (error, width = 200) =>
    stripAnsi(renderTurnActivityLine(failedTurn(error), width, nowMs));

  // Measured 2026-08-31 17:01: a 35-minute turn died on this one.
  assert.match(
    row({ code: 'server_overloaded', message: 'Selected model is at capacity. Please try a different model.' }),
    /^✗ Turn failed · model at capacity · after 35m0[23]s · event 1h ago$/
  );
  // An unmapped code falls back to the message's first clause.
  assert.match(
    row({
      code: 'other',
      message: 'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)',
    }),
    /^✗ Turn failed · stream disconnected before completion · after/
  );
  assert.match(row({ code: 'some_new_code' }), /^✗ Turn failed · some_new_code/);
  assert.match(row(undefined), /^✗ Turn failed · after/);
  // Narrow panes give the duration up first; the verdict stays.
  const narrow = row({ code: 'usage_limit_exceeded' }, 32);
  assert.match(narrow, /Turn failed · usage limit/);
  assert.doesNotMatch(narrow, /after/);
  assert.ok(narrow.length <= 32);
}

console.log('test-rollout-turn-failure: PASS');
