import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getFastModeDisplay } from '../../dist/collectors/codex-config.js';
import { FileWatcher } from '../../dist/collectors/file-watcher.js';
import { RolloutParser } from '../../dist/collectors/rollout.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-fast-refresh-'));
const rolloutPath = path.join(root, 'rollout-fast-refresh.jsonl');
const sessionId = '019f9db5-0000-7000-8000-000000000000';

function writeLine(entry) {
  fs.appendFileSync(rolloutPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve(Date.now() - started);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`condition was not met within ${timeoutMs} ms`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

let watcher;
try {
  fs.writeFileSync(rolloutPath, '', 'utf8');
  writeLine({
    timestamp: '2026-07-28T14:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: sessionId,
      timestamp: '2026-07-28T14:00:00.000Z',
      cwd: root,
      originator: 'codex-tui',
      cli_version: '0.144.4',
      source: 'cli',
    },
  });
  writeLine({
    timestamp: '2026-07-28T14:00:01.000Z',
    type: 'event_msg',
    payload: {
      type: 'thread_settings_applied',
      thread_settings: { service_tier: 'priority' },
    },
  });

  const parser = new RolloutParser(5);
  parser.setRolloutPath(rolloutPath);
  let latest = await parser.parse();
  assert.equal(latest?.session?.serviceTier, 'priority');
  assert.equal(
    getFastModeDisplay({ service_tier: 'default' }, { serviceTier: latest?.session?.serviceTier }),
    'Fast: on'
  );

  let callbackCount = 0;
  watcher = new FileWatcher([rolloutPath], { usePolling: true });
  watcher.onChange(async () => {
    callbackCount += 1;
    latest = await parser.parse();
  });
  watcher.start();

  await new Promise((resolve) => setTimeout(resolve, 1200));

  writeLine({
    timestamp: '2026-07-28T14:00:02.000Z',
    type: 'event_msg',
    payload: {
      type: 'thread_settings_applied',
      thread_settings: { service_tier: null },
    },
  });

  const observedMs = await waitFor(() => latest?.session?.serviceTier === null, 5000);

  assert.equal(
    getFastModeDisplay({ service_tier: 'priority' }, { serviceTier: latest.session.serviceTier }),
    'Fast: off',
    'runtime default tier must override a stale static priority tier'
  );
  assert.ok(callbackCount > 0, 'rollout watcher must invoke its callback');
  assert.ok(observedMs <= 5000, `fast mode refresh took ${observedMs} ms`);
  console.log(`test-runtime-fast-mode-refresh: PASS (observed_ms=${observedMs}, callbacks=${callbackCount})`);
} finally {
  await watcher?.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
