import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SessionFinder } from '../../dist/collectors/session-finder.js';

function makeTempCodexHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-session-finder-'));
}

function todayParts() {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return { year, month, day };
}

function rolloutTimestampLabel(offsetMinutes = 0) {
  const now = new Date(Date.now() + offsetMinutes * 60_000);
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}-${minute}-${second}`;
}

function writeRollout(home, { sessionId, cwd, fileOffsetMinutes = 0, modifiedAt, extraLines = [] }) {
  const { year, month, day } = todayParts();
  const dir = path.join(home, 'sessions', year, month, day);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `rollout-${rolloutTimestampLabel(fileOffsetMinutes)}-${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp: new Date().toISOString(),
        cwd,
        originator: 'codex-tui',
        cli_version: '0.118.0',
        source: 'cli',
        model_provider: 'openai',
      },
    }),
    ...extraLines.map((line) => JSON.stringify(line)),
  ];

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

  if (modifiedAt) {
    fs.utimesSync(filePath, modifiedAt, modifiedAt);
  }

  return filePath;
}

function writeSnapshot(home, threadId, paneId, nonce) {
  const dir = path.join(home, 'shell_snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${threadId}.${nonce}.sh`);
  fs.writeFileSync(
    filePath,
    [
      '# Snapshot file',
      `export TMUX_PANE='${paneId}'`,
      "export PATH='/usr/bin'",
      '',
    ].join('\n'),
    'utf8'
  );
  return filePath;
}

function sql(value) {
  return String(value).replaceAll("'", "''");
}

function writeLogsDb(home, rows) {
  const dbPath = path.join(home, 'logs_2.sqlite');
  const statements = [
    `CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL,
      level TEXT NOT NULL,
      target TEXT NOT NULL,
      feedback_log_body TEXT,
      thread_id TEXT,
      process_uuid TEXT
    );`,
    ...rows.map(
      (row, index) =>
        `INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, thread_id, process_uuid)
         VALUES (${row.ts}, ${index}, 'INFO', 'codex_otel.log_only', '${sql(row.body)}', '${sql(row.threadId)}', ${row.processUuid ? `'${sql(row.processUuid)}'` : 'NULL'});`
    ),
  ];

  execFileSync('sqlite3', [dbPath, statements.join('\n')]);
  return dbPath;
}

function appendLogRow(home, row, tsNanos = 0) {
  const dbPath = path.join(home, 'logs_2.sqlite');
  execFileSync('sqlite3', [
    dbPath,
    `INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, thread_id, process_uuid)
     VALUES (${row.ts}, ${tsNanos}, 'INFO', 'codex_otel.log_only', '${sql(row.body ?? '')}', '${sql(row.threadId)}', ${row.processUuid ? `'${sql(row.processUuid)}'` : 'NULL'});`,
  ]);
}

function clearLogRows(home) {
  const dbPath = path.join(home, 'logs_2.sqlite');
  execFileSync('sqlite3', [dbPath, 'DELETE FROM logs;']);
}

function writeStateDb(home, { threads = [], edges = [] } = {}) {
  const dbPath = path.join(home, 'state_5.sqlite');
  const statements = [
    `CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      thread_source TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    );`,
    `CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL PRIMARY KEY,
      status TEXT NOT NULL
    );`,
    ...threads.map(
      (thread) =>
        `INSERT INTO threads (id, rollout_path, thread_source, archived)
         VALUES ('${sql(thread.id)}', '${sql(thread.rolloutPath ?? '')}', '${sql(thread.threadSource ?? 'user')}', ${thread.archived ? 1 : 0});`
    ),
    ...edges.map(
      (edge) =>
        `INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status)
         VALUES ('${sql(edge.parent)}', '${sql(edge.child)}', '${sql(edge.status ?? 'open')}');`
    ),
  ];

  execFileSync('sqlite3', [dbPath, statements.join('\n')]);
  return dbPath;
}

function installFakeTmux(panePids, psOutput = '') {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-fake-tmux-'));
  const scriptPath = path.join(binDir, 'tmux');
  const cases = Object.entries(panePids)
    .map(
      ([pane, pid]) => `
if [[ "$target" == "${pane}" && "$format" == "#{pane_pid}" ]]; then
  echo "${pid}"
  exit 0
fi`
    )
    .join('\n');

  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "display" ]]; then
  target=""
  format=""
  while [[ "\${1:-}" != "" ]]; do
    case "$1" in
      -t)
        shift
        target="\${1:-}"
        ;;
      '#{pane_pid}')
        format="$1"
        ;;
    esac
    shift || true
  done
${cases}
fi
exit 1
`,
    'utf8'
  );
  fs.chmodSync(scriptPath, 0o755);

  const psPath = path.join(binDir, 'ps');
  const resolvedPsOutput =
    psOutput ||
    Object.values(panePids)
      .map((pid) => `${pid} 1 fake-process-${pid}`)
      .join('\n');
  fs.writeFileSync(
    psPath,
    `#!/usr/bin/env bash
cat <<'PS_OUTPUT'
${resolvedPsOutput}
PS_OUTPUT
`,
    'utf8'
  );
  fs.chmodSync(psPath, 0o755);

  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  return () => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    fs.rmSync(binDir, { recursive: true, force: true });
  };
}

function snapshotNonce(date = new Date()) {
  return BigInt(date.getTime()) * 1_000_000n;
}

const originalCodexHome = process.env.CODEX_HOME;
const originalMainPane = process.env.CODEX_HUD_MAIN_PANE;
const originalSessionsPath = process.env.CODEX_SESSIONS_PATH;
const originalPath = process.env.PATH;

try {
  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;
    process.env.CODEX_HUD_MAIN_PANE = '%70';

    const modifiedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const rolloutPath = writeRollout(home, {
      sessionId: '019d7291-a135-7fe1-b46f-8f3eca4fa451',
      cwd,
      modifiedAt,
    });

    const finder = new SessionFinder(cwd, undefined, new Date());
    const resolved = finder.check();
    assert.ok(
      resolved,
      'fresh launch without a bound shell snapshot should fall back to a recent cwd rollout'
    );
    assert.equal(
      resolved.path,
      fs.realpathSync(rolloutPath),
      'fallback should bind to the recent rollout in the current working directory'
    );
  }

  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;
    process.env.CODEX_HUD_MAIN_PANE = '%70';

    const launchThread = '019d7291-a135-7fe1-b46f-8f3eca4fa451';
    const latestThread = '019d7295-3ef8-7292-a039-fdf7ecd4f53e';
    const targetStartTime = new Date(Date.now() - 4 * 60 * 60 * 1000);

    const launchRollout = writeRollout(home, {
      sessionId: launchThread,
      cwd,
      fileOffsetMinutes: -240,
      modifiedAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
    });
    writeRollout(home, {
      sessionId: latestThread,
      cwd,
      modifiedAt: new Date(),
    });

    const finder = new SessionFinder(cwd, undefined, targetStartTime);
    const resolved = finder.check();
    assert.ok(resolved, 'expected fallback to resolve the launch-scoped rollout');
    assert.equal(
      resolved.path,
      fs.realpathSync(launchRollout),
      'missing shell snapshots should not drift to a newer unrelated active rollout'
    );
  }

  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;
    process.env.CODEX_HUD_MAIN_PANE = '%70';

    const staleBoundThread = '019d7291-a135-7fe1-b46f-8f3eca4fa451';
    const freshThread = '019d7295-3ef8-7292-a039-fdf7ecd4f53e';
    const targetStartTime = new Date();

    writeRollout(home, {
      sessionId: staleBoundThread,
      cwd,
      fileOffsetMinutes: -120,
      modifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const freshRollout = writeRollout(home, {
      sessionId: freshThread,
      cwd,
      modifiedAt: new Date(),
    });
    writeSnapshot(home, staleBoundThread, '%70', 1775743639864947215n);

    const finder = new SessionFinder(cwd, undefined, targetStartTime);
    const resolved = finder.check();
    assert.ok(resolved, 'expected a fresh rollout to resolve when pane binding is stale');
    assert.equal(
      resolved.path,
      fs.realpathSync(freshRollout),
      'stale pane-bound snapshots should yield to the current rollout for this HUD launch'
    );
  }

  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;
    process.env.CODEX_HUD_MAIN_PANE = '%70';

    const staleBoundThread = '019d7291-a135-7fe1-b46f-8f3eca4fa451';
    const earlierThread = '019d7295-3ef8-7292-a039-fdf7ecd4f53e';
    const latestThread = '019d729a-1b73-7cc0-b738-fd0ca9f9c6f3';
    const targetStartTime = new Date(Date.now() - 4 * 60 * 60 * 1000);

    writeRollout(home, {
      sessionId: staleBoundThread,
      cwd,
      fileOffsetMinutes: -360,
      modifiedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });
    const earlierRollout = writeRollout(home, {
      sessionId: earlierThread,
      cwd,
      fileOffsetMinutes: -235,
      modifiedAt: new Date(Date.now() - 235 * 60 * 1000),
    });
    writeRollout(home, {
      sessionId: latestThread,
      cwd,
      modifiedAt: new Date(),
    });
    writeSnapshot(home, staleBoundThread, '%70', 1775743639864947216n);

    const finder = new SessionFinder(cwd, undefined, targetStartTime);
    const resolved = finder.check();
    assert.ok(resolved, 'expected a launch-scoped rollout to resolve when pane binding is stale');
    assert.equal(
      resolved.path,
      fs.realpathSync(earlierRollout),
      'stale pane-bound snapshots should prefer the launch-scoped rollout over the newest unrelated activity'
    );
  }

  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;
    process.env.CODEX_HUD_MAIN_PANE = '%70';

    const previousThread = '019d7291-a135-7fe1-b46f-8f3eca4fa451';
    const targetStartTime = new Date();

    writeRollout(home, {
      sessionId: previousThread,
      cwd,
      fileOffsetMinutes: -120,
      modifiedAt: new Date(),
    });

    const finder = new SessionFinder(cwd, undefined, targetStartTime);
    const resolved = finder.check();
    assert.equal(
      resolved,
      null,
      'fresh HUD launch should not show a previous active rollout before pane binding is available'
    );
  }

  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;
    process.env.CODEX_HUD_MAIN_PANE = '%70';

    const firstThread = '019d7291-a135-7fe1-b46f-8f3eca4fa451';
    const secondThread = '019d7295-3ef8-7292-a039-fdf7ecd4f53e';
    const targetStartTime = new Date();

    writeRollout(home, {
      sessionId: firstThread,
      cwd,
      modifiedAt: new Date(),
    });
    writeRollout(home, {
      sessionId: secondThread,
      cwd,
      modifiedAt: new Date(),
    });

    const finder = new SessionFinder(cwd, undefined, targetStartTime);
    const resolved = finder.check();
    assert.equal(
      resolved,
      null,
      'ambiguous same-directory launch candidates should not bind to an arbitrary active session'
    );
  }

  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;
    process.env.CODEX_HUD_MAIN_PANE = '%70';

    const boundThread = '019d7291-a135-7fe1-b46f-8f3eca4fa451';
    const newerThread = '019d7295-3ef8-7292-a039-fdf7ecd4f53e';
    const targetStartTime = new Date();

    const boundRollout = writeRollout(home, {
      sessionId: boundThread,
      cwd,
      modifiedAt: new Date(Date.now() - 60 * 1000),
    });
    writeRollout(home, {
      sessionId: newerThread,
      cwd,
      fileOffsetMinutes: 1,
      modifiedAt: new Date(),
    });
    writeSnapshot(home, boundThread, '%70', snapshotNonce(targetStartTime));

    const finder = new SessionFinder(cwd, undefined, targetStartTime);
    const resolved = finder.check();
    assert.ok(resolved, 'expected fresh pane snapshot to resolve its bound rollout');
    assert.equal(
      resolved.path,
      fs.realpathSync(boundRollout),
      'fresh pane snapshot should keep each HUD on its own session even when another rollout is newer'
    );
  }

  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;
    process.env.CODEX_HUD_MAIN_PANE = '%70';

    const activeThread = '019d7291-a135-7fe1-b46f-8f3eca4fa451';
    const boundThread = '019d7295-3ef8-7292-a039-fdf7ecd4f53e';

    writeRollout(home, {
      sessionId: activeThread,
      cwd,
      modifiedAt: new Date(),
    });
    const boundRollout = writeRollout(home, {
      sessionId: boundThread,
      cwd,
      fileOffsetMinutes: -1,
      modifiedAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    writeSnapshot(home, boundThread, '%70', 1775743876858615370n);

    const finder = new SessionFinder(cwd);
    const resolved = finder.check();
    assert.ok(resolved, 'expected a pane-bound session to resolve');
    assert.equal(
      resolved.path,
      fs.realpathSync(boundRollout),
      'pane-bound shell snapshot should override the newest unrelated rollout'
    );
  }

  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;

    const paneOneThread = '019d7291-a135-7fe1-b46f-8f3eca4fa451';
    const paneTwoThread = '019d7295-3ef8-7292-a039-fdf7ecd4f53e';

    const paneOneRollout = writeRollout(home, {
      sessionId: paneOneThread,
      cwd,
      modifiedAt: new Date(Date.now() - 60 * 1000),
    });
    const paneTwoRollout = writeRollout(home, {
      sessionId: paneTwoThread,
      cwd,
      fileOffsetMinutes: -1,
      modifiedAt: new Date(),
    });

    writeSnapshot(home, paneOneThread, '%70', 1775743639864947215n);
    writeSnapshot(home, paneTwoThread, '%72', 1775743876858615370n);

    process.env.CODEX_HUD_MAIN_PANE = '%70';
    const finderOne = new SessionFinder(cwd);
    const resultOne = finderOne.check();
    assert.ok(resultOne, 'expected pane one to resolve');
    assert.equal(
      resultOne.path,
      fs.realpathSync(paneOneRollout),
      'pane one should stay on its own thread'
    );

    process.env.CODEX_HUD_MAIN_PANE = '%72';
    const finderTwo = new SessionFinder(cwd);
    const resultTwo = finderTwo.check();
    assert.ok(resultTwo, 'expected pane two to resolve');
    assert.equal(
      resultTwo.path,
      fs.realpathSync(paneTwoRollout),
      'pane two should stay on its own thread'
    );
  }

  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;
    process.env.CODEX_HUD_MAIN_PANE = '%70';

    const threadId = '019eb165-2031-79a1-bb82-9f59b0dc4c0a';
    const targetStartTime = new Date();
    writeSnapshot(home, threadId, '%70', snapshotNonce(targetStartTime));
    writeLogsDb(home, [
      {
        threadId,
        ts: Math.floor(targetStartTime.getTime() / 1000),
        body:
          `session_loop{thread_id=${threadId}}:` +
          `turn{model=gpt-5.5 codex.turn.reasoning_effort=medium}:` +
          `run_sampling_request{cwd=${cwd}}`,
      },
    ]);

    const finder = new SessionFinder(cwd, undefined, targetStartTime);
    const resolved = finder.check();
    assert.ok(
      resolved,
      'fresh pane snapshot should resolve sqlite-backed Codex threads even when no rollout exists'
    );
    assert.equal(resolved.sessionId, threadId);
    assert.equal(
      resolved.metadata?.model,
      'gpt-5.5',
      'sqlite-backed thread should expose model metadata for HUD rendering'
    );
    assert.equal(
      resolved.metadata?.reasoningEffort,
      'medium',
      'sqlite-backed thread should expose reasoning effort metadata for HUD rendering'
    );
  }

  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;

    const paneOneThread = '019eb165-2031-79a1-bb82-9f59b0dc4c0a';
    const paneTwoThread = '019eb166-2d2c-7c42-83ec-7ef750c43e18';
    const now = new Date();
    writeSnapshot(home, paneOneThread, '%70', snapshotNonce(now));
    writeSnapshot(home, paneTwoThread, '%72', snapshotNonce(now));
    writeLogsDb(home, [
      {
        threadId: paneOneThread,
        ts: Math.floor(now.getTime() / 1000),
        body: `turn{model=gpt-5.5 codex.turn.reasoning_effort=low}:run_sampling_request{cwd=${cwd}}`,
      },
      {
        threadId: paneTwoThread,
        ts: Math.floor(now.getTime() / 1000),
        body: `turn{model=gpt-5.5 codex.turn.reasoning_effort=high}:run_sampling_request{cwd=${cwd}}`,
      },
    ]);

    process.env.CODEX_HUD_MAIN_PANE = '%70';
    const finderOne = new SessionFinder(cwd, undefined, now);
    const resultOne = finderOne.check();
    assert.ok(resultOne, 'expected sqlite-backed pane one to resolve');
    assert.equal(
      resultOne.sessionId,
      paneOneThread,
      'sqlite-backed pane one should stay on its own thread'
    );
    assert.equal(resultOne.metadata?.reasoningEffort, 'low');

    process.env.CODEX_HUD_MAIN_PANE = '%72';
    const finderTwo = new SessionFinder(cwd, undefined, now);
    const resultTwo = finderTwo.check();
    assert.ok(resultTwo, 'expected sqlite-backed pane two to resolve');
    assert.equal(
      resultTwo.sessionId,
      paneTwoThread,
      'sqlite-backed pane two should stay on its own thread'
    );
    assert.equal(resultTwo.metadata?.reasoningEffort, 'high');
  }

  {
    const cleanupTmux = installFakeTmux({ '%70': '11111' });
    try {
      const home = makeTempCodexHome();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
      fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
      process.env.CODEX_HOME = home;
      delete process.env.CODEX_SESSIONS_PATH;
      process.env.CODEX_HUD_MAIN_PANE = '%70';

      const olderThread = '019eb165-2031-79a1-bb82-9f59b0dc4c0a';
      const latestThread = '019eb166-2d2c-7c42-83ec-7ef750c43e18';
      const now = new Date();
      writeLogsDb(home, [
        {
          threadId: olderThread,
          processUuid: 'pid:11111:older',
          ts: Math.floor(now.getTime() / 1000) - 60,
          body: `turn{model=gpt-5.5 codex.turn.reasoning_effort=low}:run_sampling_request{cwd=${cwd}}`,
        },
        {
          threadId: latestThread,
          processUuid: 'pid:11111:latest',
          ts: Math.floor(now.getTime() / 1000),
          body: `turn{model=gpt-5.5 codex.turn.reasoning_effort=high}:run_sampling_request{cwd=${cwd}}`,
        },
      ]);

      const finder = new SessionFinder(cwd, undefined, now);
      const resolved = finder.check();
      assert.ok(
        resolved,
        'missing shell snapshot should resolve the latest sqlite thread for the bound pane process'
      );
      assert.equal(resolved.sessionId, latestThread);
      assert.equal(resolved.metadata?.reasoningEffort, 'high');
    } finally {
      cleanupTmux();
    }
  }

  {
    const cleanupTmux = installFakeTmux({ '%70': '11111' });
    try {
      const home = makeTempCodexHome();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
      fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
      process.env.CODEX_HOME = home;
      delete process.env.CODEX_SESSIONS_PATH;
      process.env.CODEX_HUD_MAIN_PANE = '%70';

      const previousThread = '019eb165-2031-79a1-bb82-9f59b0dc4c0a';
      const currentThread = '019eb166-2d2c-7c42-83ec-7ef750c43e18';
      const now = new Date();
      writeSnapshot(home, previousThread, '%70', snapshotNonce(now));
      const currentRollout = writeRollout(home, {
        sessionId: currentThread,
        cwd,
        modifiedAt: now,
      });
      writeLogsDb(home, [
        {
          threadId: previousThread,
          processUuid: 'pid:99999:previous',
          ts: Math.floor(now.getTime() / 1000) - 60,
          body: `turn{model=gpt-5.5 codex.turn.reasoning_effort=low}:run_sampling_request{cwd=${cwd}}`,
        },
        {
          threadId: currentThread,
          processUuid: 'pid:11111:current',
          ts: Math.floor(now.getTime() / 1000),
          body: `turn{model=gpt-5.5 codex.turn.reasoning_effort=high}:run_sampling_request{cwd=${cwd}}`,
        },
      ]);

      const finder = new SessionFinder(cwd, undefined, now);
      const resolved = finder.check();
      assert.ok(resolved, 'expected current pane process to resolve a session');
      assert.equal(
        resolved.sessionId,
        currentThread,
        'current pane process should override a stale shell snapshot for another thread'
      );
      assert.equal(
        resolved.path,
        fs.realpathSync(currentRollout),
        'current pane process should bind to the normal rollout when it exists'
      );
    } finally {
      cleanupTmux();
    }
  }

  {
    const cleanupTmux = installFakeTmux({ '%70': '11111', '%72': '22222' });
    try {
      const home = makeTempCodexHome();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
      fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
      process.env.CODEX_HOME = home;
      delete process.env.CODEX_SESSIONS_PATH;

      const paneOneThread = '019eb165-2031-79a1-bb82-9f59b0dc4c0a';
      const paneTwoThread = '019eb166-2d2c-7c42-83ec-7ef750c43e18';
      const now = new Date();
      writeLogsDb(home, [
        {
          threadId: paneOneThread,
          processUuid: 'pid:11111:pane-one',
          ts: Math.floor(now.getTime() / 1000),
          body: `turn{model=gpt-5.5 codex.turn.reasoning_effort=low}:run_sampling_request{cwd=${cwd}}`,
        },
        {
          threadId: paneTwoThread,
          processUuid: 'pid:22222:pane-two',
          ts: Math.floor(now.getTime() / 1000),
          body: `turn{model=gpt-5.5 codex.turn.reasoning_effort=high}:run_sampling_request{cwd=${cwd}}`,
        },
      ]);

      process.env.CODEX_HUD_MAIN_PANE = '%70';
      const finderOne = new SessionFinder(cwd, undefined, now);
      const resultOne = finderOne.check();
      assert.ok(resultOne, 'expected pane one process to resolve');
      assert.equal(
        resultOne.sessionId,
        paneOneThread,
        'pane one process should stay on its own sqlite thread'
      );

      process.env.CODEX_HUD_MAIN_PANE = '%72';
      const finderTwo = new SessionFinder(cwd, undefined, now);
      const resultTwo = finderTwo.check();
      assert.ok(resultTwo, 'expected pane two process to resolve');
      assert.equal(
        resultTwo.sessionId,
        paneTwoThread,
        'pane two process should stay on its own sqlite thread'
      );
    } finally {
      cleanupTmux();
    }
  }

  {
    const cleanupTmux = installFakeTmux(
      { '%70': '11110' },
      [
        '11110 1 /bin/zsh',
        '11111 11110 node /path/to/codex',
        '11112 11111 /path/to/codex-rust',
      ].join('\n')
    );
    try {
      const home = makeTempCodexHome();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
      fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
      process.env.CODEX_HOME = home;
      delete process.env.CODEX_SESSIONS_PATH;
      process.env.CODEX_HUD_MAIN_PANE = '%70';

      const threadId = '019eb166-2d2c-7c42-83ec-7ef750c43e18';
      const now = new Date();
      writeLogsDb(home, [
        {
          threadId,
          processUuid: 'pid:11112:child-process',
          ts: Math.floor(now.getTime() / 1000),
          body: `turn{model=gpt-5.5 codex.turn.reasoning_effort=medium}:run_sampling_request{cwd=${cwd}}`,
        },
      ]);

      const finder = new SessionFinder(cwd, undefined, now);
      const resolved = finder.check();
      assert.ok(
        resolved,
        'pane process fallback should inspect child processes because Codex logs use the Rust child pid'
      );
      assert.equal(resolved.sessionId, threadId);
    } finally {
      cleanupTmux();
    }
  }

  {
    // Internal helper threads (memories/compaction: no rollout file, no state
    // row) must never steal the binding from an established session.
    const cleanupTmux = installFakeTmux({ '%70': '11111' });
    try {
      const home = makeTempCodexHome();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
      fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
      process.env.CODEX_HOME = home;
      delete process.env.CODEX_SESSIONS_PATH;
      process.env.CODEX_HUD_MAIN_PANE = '%70';

      const userThread = '019eb200-0000-7000-8000-000000000001';
      const internalThread = '019eb200-0000-7000-8000-000000000002';
      const now = new Date();
      const nowTs = Math.floor(now.getTime() / 1000);

      const userRollout = writeRollout(home, {
        sessionId: userThread,
        cwd,
        modifiedAt: new Date(now.getTime() - 20 * 1000),
      });
      writeStateDb(home, {
        threads: [{ id: userThread, rolloutPath: userRollout }],
      });
      writeLogsDb(home, [
        {
          threadId: userThread,
          processUuid: 'pid:11111:proc',
          ts: nowTs - 20,
          body: `turn{model=gpt-5.5}:run_sampling_request{cwd=${cwd}}`,
        },
      ]);

      const finder = new SessionFinder(cwd, undefined, now);
      const bound = finder.check();
      assert.ok(bound, 'expected the user session to bind first');
      assert.equal(bound.sessionId, userThread);

      appendLogRow(home, {
        threadId: internalThread,
        processUuid: 'pid:11111:proc',
        ts: nowTs,
        body: 'memories{}:flush',
      }, 1);

      const resolved = finder.check(true);
      assert.ok(resolved, 'expected the binding to survive internal thread activity');
      assert.equal(
        resolved.sessionId,
        userThread,
        'an internal log-only thread must not steal the pane binding'
      );
    } finally {
      cleanupTmux();
    }
  }

  {
    // Subagent threads (thread_spawn_edges children) must never steal the
    // binding even when they are newer and have their own state rows.
    const cleanupTmux = installFakeTmux({ '%70': '11111' });
    try {
      const home = makeTempCodexHome();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
      fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
      process.env.CODEX_HOME = home;
      delete process.env.CODEX_SESSIONS_PATH;
      process.env.CODEX_HUD_MAIN_PANE = '%70';

      const mainThread = '019eb201-0000-7000-8000-000000000001';
      const subagentThread = '019eb201-0000-7000-8000-000000000002';
      const now = new Date();
      const nowTs = Math.floor(now.getTime() / 1000);

      const mainRollout = writeRollout(home, {
        sessionId: mainThread,
        cwd,
        modifiedAt: new Date(now.getTime() - 30 * 1000),
      });
      const subagentRollout = writeRollout(home, {
        sessionId: subagentThread,
        cwd,
        fileOffsetMinutes: 0,
        modifiedAt: now,
      });
      writeStateDb(home, {
        threads: [
          { id: mainThread, rolloutPath: mainRollout },
          { id: subagentThread, rolloutPath: subagentRollout },
        ],
        edges: [{ parent: mainThread, child: subagentThread }],
      });
      writeLogsDb(home, [
        {
          threadId: mainThread,
          processUuid: 'pid:11111:proc',
          ts: nowTs - 30,
          body: `turn{model=gpt-5.5}:run_sampling_request{cwd=${cwd}}`,
        },
      ]);

      const finder = new SessionFinder(cwd, undefined, now);
      const bound = finder.check();
      assert.ok(bound, 'expected the main session to bind first');
      assert.equal(bound.sessionId, mainThread);

      appendLogRow(home, {
        threadId: subagentThread,
        processUuid: 'pid:11111:proc',
        ts: nowTs,
        body: `turn{model=gpt-5.5}:run_sampling_request{cwd=${cwd}}`,
      }, 1);

      const resolved = finder.check(true);
      assert.ok(resolved, 'expected the binding to survive subagent activity');
      assert.equal(
        resolved.sessionId,
        mainThread,
        'a spawned subagent thread must not steal the pane binding'
      );
    } finally {
      cleanupTmux();
    }
  }

  {
    // An in-process session switch (/new or /resume): the newly active
    // established session takes over once it clearly leads the old one.
    const cleanupTmux = installFakeTmux({ '%70': '11111' });
    try {
      const home = makeTempCodexHome();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
      fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
      process.env.CODEX_HOME = home;
      delete process.env.CODEX_SESSIONS_PATH;
      process.env.CODEX_HUD_MAIN_PANE = '%70';

      const firstThread = '019eb202-0000-7000-8000-000000000001';
      const resumedThread = '019eb202-0000-7000-8000-000000000002';
      const now = new Date();
      const nowTs = Math.floor(now.getTime() / 1000);

      const firstRollout = writeRollout(home, {
        sessionId: firstThread,
        cwd,
        modifiedAt: new Date(now.getTime() - 60 * 1000),
      });
      const resumedRollout = writeRollout(home, {
        sessionId: resumedThread,
        cwd,
        fileOffsetMinutes: -120,
        modifiedAt: now,
      });
      writeStateDb(home, {
        threads: [
          { id: firstThread, rolloutPath: firstRollout },
          { id: resumedThread, rolloutPath: resumedRollout },
        ],
      });
      writeLogsDb(home, [
        {
          threadId: firstThread,
          processUuid: 'pid:11111:proc',
          ts: nowTs - 30,
          body: `turn{model=gpt-5.5}:run_sampling_request{cwd=${cwd}}`,
        },
      ]);

      const finder = new SessionFinder(cwd, undefined, now);
      const bound = finder.check();
      assert.ok(bound, 'expected the first session to bind');
      assert.equal(bound.sessionId, firstThread);

      appendLogRow(home, {
        threadId: resumedThread,
        processUuid: 'pid:11111:proc',
        ts: nowTs,
        body: `turn{model=gpt-5.5}:run_sampling_request{cwd=${cwd}}`,
      }, 1);

      const resolved = finder.check(true);
      assert.ok(resolved, 'expected the resumed session to resolve');
      assert.equal(
        resolved.sessionId,
        resumedThread,
        'a clearly leading established session (/resume) should take over the binding'
      );
      assert.equal(
        resolved.path,
        fs.realpathSync(resumedRollout),
        'the resumed binding should use the rollout file recorded in the state DB'
      );
    } finally {
      cleanupTmux();
    }
  }

  {
    // When the candidate probe comes back empty (Codex exited or went quiet),
    // the HUD must keep the current binding instead of guessing by mtime.
    const cleanupTmux = installFakeTmux({ '%70': '11111' });
    try {
      const home = makeTempCodexHome();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-'));
      fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
      process.env.CODEX_HOME = home;
      delete process.env.CODEX_SESSIONS_PATH;
      process.env.CODEX_HUD_MAIN_PANE = '%70';

      const boundThread = '019eb203-0000-7000-8000-000000000001';
      const otherThread = '019eb203-0000-7000-8000-000000000002';
      const now = new Date();
      const nowTs = Math.floor(now.getTime() / 1000);

      const boundRollout = writeRollout(home, {
        sessionId: boundThread,
        cwd,
        modifiedAt: new Date(now.getTime() - 10 * 1000),
      });
      writeStateDb(home, {
        threads: [{ id: boundThread, rolloutPath: boundRollout }],
      });
      writeLogsDb(home, [
        {
          threadId: boundThread,
          processUuid: 'pid:11111:proc',
          ts: nowTs - 10,
          body: `turn{model=gpt-5.5}:run_sampling_request{cwd=${cwd}}`,
        },
      ]);

      const finder = new SessionFinder(cwd, undefined, now);
      const bound = finder.check();
      assert.ok(bound, 'expected the session to bind');
      assert.equal(bound.sessionId, boundThread);

      // Codex goes quiet and an unrelated session in the same cwd keeps writing.
      clearLogRows(home);
      writeRollout(home, {
        sessionId: otherThread,
        cwd,
        fileOffsetMinutes: 1,
        modifiedAt: new Date(),
      });

      const resolved = finder.check(true);
      assert.ok(resolved, 'expected the binding to survive an empty candidate probe');
      assert.equal(
        resolved.sessionId,
        boundThread,
        'an empty probe must keep the current binding instead of drifting by mtime'
      );
    } finally {
      cleanupTmux();
    }
  }
} finally {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }

  if (originalMainPane === undefined) {
    delete process.env.CODEX_HUD_MAIN_PANE;
  } else {
    process.env.CODEX_HUD_MAIN_PANE = originalMainPane;
  }

  if (originalSessionsPath === undefined) {
    delete process.env.CODEX_SESSIONS_PATH;
  } else {
    process.env.CODEX_SESSIONS_PATH = originalSessionsPath;
  }

  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
}

console.log('test-session-finder-pane-binding: PASS');
