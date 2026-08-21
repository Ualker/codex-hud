import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);
const modulePath = path.join(
  repoRoot,
  'dist',
  'collectors',
  'account-limits.js'
);

const { preferFreshestRateLimits } = await import(modulePath);

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'codex-hud-account-limits-')
);

const WEEKLY_WINDOW = 10080;
/** A window that has not reset yet, shared by every fixture snapshot. */
const RESETS_AT = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;

function window(usedPercent) {
  return {
    used_percent: usedPercent,
    window_minutes: WEEKLY_WINDOW,
    resets_at: RESETS_AT,
  };
}

/**
 * The snapshot codex writes once the weekly window is spent: a different
 * limit_id, both windows null, and a zeroed credit pool. Measured live on
 * 2026-08-19, the first turn after exhaustion recorded exactly this.
 */
function exhaustedSnapshot() {
  return {
    limit_id: 'premium',
    limit_name: null,
    primary: null,
    secondary: null,
    credits: { has_credits: false, unlimited: false, balance: '0' },
    individual_limit: null,
    spend_control_reached: null,
    plan_type: null,
    rate_limit_reached_type: null,
  };
}

/**
 * Write a rollout whose last token_count reports `usedPercent`, aged
 * `ageMinutes` in the past. `padBytes` pushes that record out of the tail when
 * a case needs a file the bounded read cannot reach into. `trailingSnapshot`
 * appends one more token_count after it, for the degenerate-record cases.
 */
function writeRollout(
  codexHome,
  id,
  ageMinutes,
  usedPercent,
  padBytes = 0,
  trailingSnapshot = null
) {
  const at = new Date(Date.now() - ageMinutes * 60_000);
  const dir = path.join(
    codexHome,
    'sessions',
    String(at.getFullYear()),
    String(at.getMonth() + 1).padStart(2, '0'),
    String(at.getDate()).padStart(2, '0')
  );
  fs.mkdirSync(dir, { recursive: true });

  const stamp = at.toISOString().slice(0, 19).replace(/:/g, '-');
  const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`);

  const lines = [
    JSON.stringify({
      timestamp: at.toISOString(),
      type: 'session_meta',
      payload: {
        id,
        timestamp: at.toISOString(),
        cwd: '/tmp/account-limits',
        originator: 'codex-tui',
        cli_version: '0.147.0',
        source: 'cli',
      },
    }),
  ];
  if (usedPercent !== null) {
    lines.push(
      JSON.stringify({
        timestamp: at.toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { model_context_window: 258400 },
          rate_limits: {
            limit_id: 'codex',
            plan_type: 'plus',
            primary: window(usedPercent),
            secondary: null,
          },
        },
      })
    );
  }
  if (padBytes > 0) {
    lines.push(
      JSON.stringify({
        timestamp: at.toISOString(),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'x'.repeat(padBytes) }],
        },
      })
    );
  }
  if (trailingSnapshot) {
    lines.push(
      JSON.stringify({
        timestamp: new Date(at.getTime() + 60_000).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: null,
          rate_limits: trailingSnapshot,
        },
      })
    );
  }

  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  fs.utimesSync(file, at, at);
  return file;
}

/** Run the scan against a fixture CODEX_HOME in a child process. */
function scan(codexHome) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const { findLatestAccountRateLimits } = await import(${JSON.stringify(
        modulePath
      )});
       const found = await findLatestAccountRateLimits();
       process.stdout.write(JSON.stringify(found));`,
    ],
    { env: { ...process.env, CODEX_HOME: codexHome }, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

try {
  {
    // Rate limits are account state. Measured live, two open sessions on one
    // account reported 9% and 84% while the newest snapshot on the machine
    // said 27% — all three naming the same window. The newest one is the
    // account's answer regardless of which session happened to write it.
    const codexHome = path.join(tempRoot, 'many');
    writeRollout(codexHome, '019f1111-a111-7111-8111-111111111111', 600, 9);
    writeRollout(codexHome, '019f2222-b222-7222-8222-222222222222', 30, 74);
    writeRollout(codexHome, '019f3333-c333-7333-8333-333333333333', 300, 41);

    const found = scan(codexHome);
    assert.equal(
      found?.limits?.primary?.used_percent,
      74,
      'the newest snapshot on the machine wins'
    );
    assert.equal(found?.limits?.limit_id, 'codex');
  }

  {
    // A session that has never reported limits must not shadow one that has.
    const codexHome = path.join(tempRoot, 'partial');
    writeRollout(codexHome, '019f4444-d444-7444-8444-444444444444', 120, 55);
    writeRollout(codexHome, '019f5555-e555-7555-8555-555555555555', 5, null);

    const found = scan(codexHome);
    assert.equal(
      found?.limits?.primary?.used_percent,
      55,
      'a rollout with no snapshot contributes nothing instead of blanking'
    );
  }

  {
    // Nothing to read is not a failure; the caller falls back to the bound
    // session's own snapshot.
    const codexHome = path.join(tempRoot, 'empty');
    fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
    assert.equal(scan(codexHome), null);
  }

  {
    // Once the weekly window is spent, the next turn writes a snapshot with
    // no windows at all. It is the newest record in the file, so the backward
    // walk used to stop on it and report a quota with nothing in it — the
    // quota row then went dark at exactly 100% used. Keep walking to the
    // reading that still states the number.
    const codexHome = path.join(tempRoot, 'exhausted');
    writeRollout(
      codexHome,
      '019f7777-a777-7777-8777-777777777777',
      20,
      100,
      0,
      exhaustedSnapshot()
    );

    const found = scan(codexHome);
    assert.equal(
      found?.limits?.primary?.used_percent,
      100,
      'a windowless snapshot does not shadow the informative one behind it'
    );
    assert.equal(found?.limits?.limit_id, 'codex');
  }

  {
    // The degenerate record must not win across files either: it is newer
    // than every real reading on the machine.
    const codexHome = path.join(tempRoot, 'exhausted-across-files');
    writeRollout(codexHome, '019f8888-b888-7888-8888-888888888888', 90, 96);
    writeRollout(
      codexHome,
      '019f9999-c999-7999-8999-999999999999',
      5,
      null,
      0,
      exhaustedSnapshot()
    );

    const found = scan(codexHome);
    assert.equal(
      found?.limits?.primary?.used_percent,
      96,
      'the newest informative snapshot wins over a newer empty one'
    );
  }

  {
    // An exhaustion window in progress: every new session's first turn writes
    // only a degenerate snapshot, so degenerate-only files pile up in front of
    // the last informative reading. A fixed six-file budget stopped exactly
    // there and lost the one field that says when the quota comes back
    // (`resets_at`); the walk now continues until a reading is found.
    const codexHome = path.join(tempRoot, 'exhaustion-era');
    for (let index = 0; index < 7; index++) {
      writeRollout(
        codexHome,
        `019faaa${index}-d${index}${index}${index}-7${index}${index}${index}-8${index}${index}${index}-aaaaaaaaaaa${index}`,
        5 + index * 5,
        null,
        0,
        exhaustedSnapshot()
      );
    }
    writeRollout(codexHome, '019fbbbb-eeee-7bbb-8bbb-bbbbbbbbbbbb', 90, 100);

    const found = scan(codexHome);
    assert.equal(
      found?.limits?.primary?.used_percent,
      100,
      'seven degenerate-only rollouts must not bury the informative reading'
    );
    assert.equal(found?.limits?.limit_id, 'codex');
  }

  {
    // The scan reads a bounded tail, so a snapshot buried behind a megabyte of
    // transcript is simply not found — it must not throw or report garbage.
    const codexHome = path.join(tempRoot, 'buried');
    writeRollout(
      codexHome,
      '019f6666-f666-7666-8666-666666666666',
      10,
      63,
      512 * 1024
    );
    const found = scan(codexHome);
    assert.ok(
      found === null || found.limits.primary.used_percent === 63,
      'a buried snapshot is either found or absent, never wrong'
    );
  }

  // ---- choosing between the session and the account snapshot --------------
  const accountAt = new Date('2026-08-12T08:00:00.000Z');
  const account = {
    limits: { limit_id: 'codex', primary: window(37) },
    observedAt: accountAt,
  };
  const sessionLimits = { limit_id: 'codex', primary: window(9) };

  assert.equal(
    preferFreshestRateLimits(
      sessionLimits,
      new Date('2026-08-11T03:36:00.000Z'),
      account
    )?.primary?.used_percent,
    37,
    'an idle session yields to the newer account-wide reading'
  );
  assert.equal(
    preferFreshestRateLimits(
      sessionLimits,
      new Date('2026-08-12T23:00:00.000Z'),
      account
    )?.primary?.used_percent,
    9,
    'the session being worked right now keeps its own fresher reading'
  );
  assert.equal(
    preferFreshestRateLimits(sessionLimits, undefined, account)?.primary
      ?.used_percent,
    37,
    'a snapshot with no observation time cannot outrank a dated one'
  );
  assert.equal(
    preferFreshestRateLimits(null, null, account)?.primary?.used_percent,
    37,
    'an unbound session still learns the account state'
  );
  assert.equal(
    preferFreshestRateLimits(sessionLimits, new Date(0), null)?.primary
      ?.used_percent,
    9,
    'a failed scan degrades to the previous behavior'
  );
  assert.equal(preferFreshestRateLimits(null, null, null), undefined);

  // Two accounts are two sets of limits; the newer one is not the truer one.
  assert.equal(
    preferFreshestRateLimits(
      { limit_id: 'other-account', primary: window(5) },
      new Date(0),
      account
    )?.primary?.used_percent,
    5,
    'a snapshot from a different account never substitutes'
  );

  // A windowless snapshot states nothing, so it cannot outrank one that does
  // — in either direction, and regardless of which is newer. The limit_id
  // guard must not fire here: one account writes several ids ("codex" for the
  // weekly window, "premium" for credits), so a different id on an empty
  // snapshot is not evidence of a different account.
  const emptyAccount = {
    limits: {
      limit_id: 'premium',
      primary: null,
      secondary: null,
      credits: { has_credits: false, unlimited: false, balance: '0' },
    },
    observedAt: new Date('2026-08-19T12:00:00.000Z'),
  };
  assert.equal(
    preferFreshestRateLimits(
      sessionLimits,
      new Date('2026-08-11T03:36:00.000Z'),
      emptyAccount
    )?.primary?.used_percent,
    9,
    'a newer empty account snapshot never replaces a stated session reading'
  );
  assert.equal(
    preferFreshestRateLimits(
      emptyAccount.limits,
      new Date('2026-08-19T12:00:00.000Z'),
      account
    )?.primary?.used_percent,
    37,
    'an empty session snapshot yields to the account reading that states one'
  );
  assert.equal(
    preferFreshestRateLimits(
      { limit_id: 'codex', rate_limit_reached_type: 'weekly' },
      new Date('2026-08-19T12:00:00.000Z'),
      account
    )?.rate_limit_reached_type,
    'weekly',
    'a reached flag is a statement even with no window percentages'
  );

  console.log('test-account-limits: PASS');
} finally {
  const resolvedRoot = fs.realpathSync(tempRoot);
  assert.equal(path.dirname(resolvedRoot), fs.realpathSync(os.tmpdir()));
  assert.ok(
    path.basename(resolvedRoot).startsWith('codex-hud-account-limits-')
  );
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}
