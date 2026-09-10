import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RolloutParser } from '../../dist/collectors/rollout.js';
import { renderHud } from '../../dist/render/header.js';
import { stripAnsi, visualLength } from '../../dist/render/colors.js';
import { renderTokenLine, renderToolsLine, cycleToolDetailsMode } from '../../dist/render/lines/activity-line.js';
import { getCodexDataNamespace } from '../../dist/utils/codex-path.js';

const now = Date.now();
const data = {
  config: { model: 'gpt-6-astra' },
  git: { isGitRepo: false },
  project: { cwd: '/work/project', projectName: 'project', mcpCount: 6, skillsCount: 20 },
  session: { id: 'session-1234', model: 'gpt-6-astra', startTime: new Date(now - 60_000) },
  contextUsage: { used: 71_093, total: 258_400, percent: 28, compactCount: 3 },
  tokenUsage: {
    last_token_usage: { total_tokens: 71_093, input_tokens: 70_000, cached_input_tokens: 60_000, output_tokens: 1093 },
    total_token_usage: { total_tokens: 325_845 },
  },
  rateLimits: { primary: { used_percent: 82, window_minutes: 300, resets_at: now / 1000 + 3600 } },
  turnActivity: { phase: 'awaiting-approval', since: new Date(now - 30_000), lastActivityAt: new Date(now) },
  collectorHealth: { git: { status: 'error', lastAttemptAt: new Date(now) } },
  hudBuildUpdated: true,
};
const layout = { mode: 'expanded', showSeparators: false, showDuration: true, showContextBreakdown: true, barWidth: 12 };
for (const width of [60, 80, 100, 116, 140, 146, 180]) {
  const lines = renderHud(data, { width, maxLines: 5, showDetails: true, layout }).map(stripAnsi);
  assert.ok(lines.slice(0, 5).some((line) => line.includes('Approval needed')), `${width}: approval remains visible`);
  assert.ok(lines.slice(0, 5).some((line) => line.includes('↻3')), `${width}: compact survives full HUD and quota compression`);
  assert.ok(lines.every((line) => visualLength(line) <= width));
}
assert.doesNotMatch(stripAnsi(renderTokenLine(data)), /Last call:|Total:|cache:/);
process.env.CODEX_HUD_DETAILS = 'full';
const tokenText = stripAnsi(renderTokenLine(data));
assert.match(tokenText, /Last call: 71\.1K/);
assert.match(tokenText, /Total: 325\.8K/);
assert.doesNotMatch(tokenText, /Turn:/, 'last call never claims to be an entire user turn');
assert.match(tokenText, /cache:/);
assert.ok(tokenText.indexOf('↻3') < tokenText.indexOf('Last call:'));
const totalOnly = stripAnsi(renderTokenLine({ tokenUsage: { total_token_usage: { total_tokens: 5000 } } }));
assert.equal(totalOnly, 'Total: 5.0K', 'old logs with only a total do not invent a last call');

const sessions = [11111, 22222].map((suffix) => ({
  id: `session-${suffix}`, tmuxSession: `codex-hud-project-hash-20260909000000-${suffix}`,
  projectName: 'same-long-project', title: `task ${suffix}`, model: `model-${suffix}`,
  turnActivity: { phase: 'idle' }, contextUsage: data.contextUsage,
}));
for (const width of [40, 50, 60, 68, 80, 100, 140]) {
  const lines = renderHud({ ...data, rateLimits: undefined, displayMode: 'overview', overview: { sessions, updatedAt: new Date() } },
    { width, maxLines: 5, showDetails: true, layout }).map(stripAnsi);
  for (const [index, suffix] of [11111, 22222].entries()) {
    assert.ok(lines[index].includes(String(suffix)), `${width}: row keeps its distinguishing address`);
    assert.match(lines[index], /Idle/);
    assert.ok(visualLength(lines[index]) <= width);
  }
}
const failedScan = renderHud({ ...data, displayMode: 'overview', overview: { sessions: [], updatedAt: new Date() },
  collectorHealth: { overview: { status: 'error', lastAttemptAt: new Date() } } },
  { width: 100, maxLines: 5, showDetails: true, layout }).map(stripAnsi).join('\n');
assert.match(failedScan, /session overview unavailable/);
assert.doesNotMatch(failedScan, /No active sessions/);
const unavailable = renderHud({ ...data, rateLimits: undefined, displayMode: 'overview',
  overview: { sessions: [{ ...sessions[0], unavailable: true }], updatedAt: new Date() } },
  { width: 100, maxLines: 5, showDetails: true, layout }).map(stripAnsi).join('\n');
assert.match(unavailable, /session log unavailable/);
assert.match(unavailable, /Unknown.*--/);
assert.match(unavailable, /11111/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-review-regression-'));
const originalHome = process.env.CODEX_HOME;
const originalSessions = process.env.CODEX_SESSIONS_PATH;
try {
  const file = path.join(root, 'rollout.jsonl');
  const record = (type, payload) => JSON.stringify({ timestamp: new Date(now).toISOString(), type, payload }) + '\n';
  fs.writeFileSync(file, record('session_meta', { id: 'session-test', cwd: '/work' })
    + record('event_msg', { type: 'task_started', turn_id: 'turn-test' })
    + Array.from({ length: 6 }, (_, i) => record('response_item', {
      type: 'function_call', name: 'exec_command', call_id: `call-${i}`, arguments: JSON.stringify({ cmd: `sleep ${10 + i}` }),
    })).join(''));
  const parser = new RolloutParser(3);
  parser.setRolloutPath(file);
  const result = await parser.parse();
  assert.equal(result.toolActivity.recentCalls.length, 3);
  assert.equal(result.toolActivity.runningCalls.length, 6, 'live calls outlive the recent-history cap');
  for (const width of [40, 60, 100, 146]) {
    const line = stripAnsi(renderToolsLine(result.toolActivity, width));
    assert.match(line, /6 tools running/);
    assert.ok(visualLength(line) <= width);
  }
  cycleToolDetailsMode(now); // targets -> full
  assert.match(stripAnsi(renderTokenLine(data)), /cache:/);
  cycleToolDetailsMode(now); // full -> off
  assert.match(stripAnsi(renderToolsLine(result.toolActivity, 60)), /6 tools running/);
  fs.appendFileSync(file, Array.from({ length: 6 }, (_, i) => record('response_item', {
    type: 'function_call_output', call_id: `call-${i}`, output: 'Process exited with code 0',
  })).join(''));
  assert.equal((await parser.parse()).toolActivity.runningCalls.length, 0, 'completed calls leave the live count');
  cycleToolDetailsMode(now); // off -> targets

  const homeA = path.join(root, 'home-a');
  const homeB = path.join(root, 'home-b');
  for (const home of [homeA, homeB]) fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  process.env.CODEX_HOME = homeA;
  delete process.env.CODEX_SESSIONS_PATH;
  const keyA = getCodexDataNamespace();
  process.env.CODEX_HOME = homeB;
  assert.notEqual(getCodexDataNamespace(), keyA, 'different Codex homes do not share quota');
  process.env.CODEX_HOME = homeA;
  process.env.CODEX_SESSIONS_PATH = path.join(homeB, 'sessions');
  assert.notEqual(getCodexDataNamespace(), keyA, 'a sessions override has its own quota');
  const alias = path.join(root, 'alias');
  fs.symlinkSync(path.join(homeA, 'sessions'), alias);
  process.env.CODEX_SESSIONS_PATH = alias;
  assert.equal(getCodexDataNamespace(), keyA, 'aliases to the same source share state');
} finally {
  if (originalHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalHome;
  if (originalSessions === undefined) delete process.env.CODEX_SESSIONS_PATH;
  else process.env.CODEX_SESSIONS_PATH = originalSessions;
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('test-review-regressions: PASS');
