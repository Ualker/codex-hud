import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SessionFinder,
  findActiveRollouts,
} from '../../dist/collectors/session-finder.js';

function makeTempCodexHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-scan-cache-'));
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  return home;
}

function todayDir(home) {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const dir = path.join(home, 'sessions', year, month, day);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

function sessionMetaLine(sessionId, cwd) {
  return JSON.stringify({
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
  });
}

function writeRollout(home, { sessionId, cwd, fileOffsetMinutes = 0, modifiedAt }) {
  const filePath = path.join(
    todayDir(home),
    `rollout-${rolloutTimestampLabel(fileOffsetMinutes)}-${sessionId}.jsonl`
  );
  fs.writeFileSync(filePath, `${sessionMetaLine(sessionId, cwd)}\n`, 'utf8');
  if (modifiedAt) {
    fs.utimesSync(filePath, modifiedAt, modifiedAt);
  }
  return filePath;
}

const originalCodexHome = process.env.CODEX_HOME;
const originalSessionsPath = process.env.CODEX_SESSIONS_PATH;
const originalMainPane = process.env.CODEX_HUD_MAIN_PANE;

try {
  // --- Rollout cwd cache: resolved first lines are cached permanently. ---
  {
    const home = makeTempCodexHome();
    const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-a-'));
    const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-b-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;

    const sessionId = '019d7291-a135-7fe1-b46f-8f3eca4fa451';
    const rolloutPath = writeRollout(home, { sessionId, cwd: cwdA });

    assert.equal(
      findActiveRollouts(60, cwdA).length,
      1,
      'a fresh rollout with a matching cwd must be found'
    );

    // Real rollouts never rewrite their first line; the cache pins the first
    // successful read so fallback scans stop re-opening every file.
    fs.writeFileSync(rolloutPath, `${sessionMetaLine(sessionId, cwdB)}\n`, 'utf8');
    assert.equal(
      findActiveRollouts(60, cwdA).length,
      1,
      'a resolved first line must be served from the cache without re-reading'
    );
  }

  // --- Rollout cwd cache: unresolved entries re-read after the file grows. ---
  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-grow-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;

    const sessionId = '019d7295-3ef8-7292-a039-fdf7ecd4f53e';
    const filePath = path.join(
      todayDir(home),
      `rollout-${rolloutTimestampLabel()}-${sessionId}.jsonl`
    );
    const fullLine = sessionMetaLine(sessionId, cwd);

    // First line still being written: no newline yet, JSON incomplete.
    fs.writeFileSync(filePath, fullLine.slice(0, 40), 'utf8');
    assert.equal(
      findActiveRollouts(60, cwd).length,
      0,
      'an incomplete first line must not resolve a cwd'
    );

    // Same size on disk: the cached negative result short-circuits.
    assert.equal(
      findActiveRollouts(60, cwd).length,
      0,
      'an unchanged unresolved file stays unresolved'
    );

    // The writer finishes the line: growth invalidates the negative entry.
    fs.writeFileSync(filePath, `${fullLine}\n`, 'utf8');
    assert.equal(
      findActiveRollouts(60, cwd).length,
      1,
      'growth must trigger a re-read that resolves the cwd'
    );
  }

  // --- Adaptive resolve cadence (white-box: fullResolveIntervalMs). ---
  {
    const home = makeTempCodexHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-cwd-adaptive-'));
    process.env.CODEX_HOME = home;
    delete process.env.CODEX_SESSIONS_PATH;
    delete process.env.CODEX_HUD_MAIN_PANE;

    const firstRollout = writeRollout(home, {
      sessionId: '019d7291-a135-7fe1-b46f-8f3eca4fa451',
      cwd,
      fileOffsetMinutes: -1,
      modifiedAt: new Date(Date.now() - 30_000),
    });

    const finder = new SessionFinder(cwd, undefined, new Date());
    const first = await finder.check();
    assert.ok(first, 'the fallback path must bind the fresh rollout');
    assert.equal(first.path, fs.realpathSync(firstRollout));
    assert.equal(
      finder.fullResolveIntervalMs,
      4000,
      'the first bind is a change and stays at the base cadence'
    );

    await finder.check(true);
    assert.equal(
      finder.fullResolveIntervalMs,
      6000,
      'a stable binding backs the cadence off'
    );
    await finder.check(true);
    await finder.check(true);
    assert.equal(
      finder.fullResolveIntervalMs,
      12000,
      'the backoff is capped at the maximum cadence'
    );

    const secondRollout = writeRollout(home, {
      sessionId: '019d729a-1b73-7cc0-b738-fd0ca9f9c6f3',
      cwd,
    });
    const switched = await finder.check(true);
    assert.ok(switched, 'the newer rollout must take over the binding');
    assert.equal(switched.path, fs.realpathSync(secondRollout));
    assert.equal(
      finder.fullResolveIntervalMs,
      4000,
      'a binding change restores the base cadence'
    );
  }
} finally {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
  if (originalSessionsPath === undefined) {
    delete process.env.CODEX_SESSIONS_PATH;
  } else {
    process.env.CODEX_SESSIONS_PATH = originalSessionsPath;
  }
  if (originalMainPane === undefined) {
    delete process.env.CODEX_HUD_MAIN_PANE;
  } else {
    process.env.CODEX_HUD_MAIN_PANE = originalMainPane;
  }
}

console.log('test-session-finder-scan-cache: PASS');
