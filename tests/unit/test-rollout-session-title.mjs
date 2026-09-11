import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RolloutParser } from '../../dist/collectors/rollout.js';

// Two sessions open in one project rendered identical headers, and the
// overview told them apart only by the tail of an opaque tmux name. The
// session's first real prompt — the label `codex resume` lists it under — is
// recovered from the rollout, skipping the user-role messages Codex injects
// around it (measured live on 0.153: the AGENTS.md wrapper before the prompt,
// a `<skill>` body right after a `$skill` invocation).

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hud-title-'));
const rolloutPath = path.join(tempRoot, 'rollout-2026-09-05T09-27-44-01a06f2d-bf84-7091-84b9-3236fa3fb994.jsonl');

const record = (timestamp, type, payload) =>
  JSON.stringify({ timestamp, type, payload }) + '\n';
const userMessage = (timestamp, text) =>
  record(timestamp, 'response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  });
const meta = record('2026-09-05T01:27:44.000Z', 'session_meta', {
  id: '01a06f2d-bf84-7091-84b9-3236fa3fb994',
  timestamp: '2026-09-05T01:27:44.000Z',
  cwd: '/Users/zyb/Desktop/prj',
  originator: 'codex_cli_rs',
  cli_version: '0.153.4',
});

try {
  // ---- injected messages are skipped; the real prompt is the title --------
  fs.writeFileSync(
    rolloutPath,
    meta +
      record('2026-09-05T01:27:45.000Z', 'response_item', {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '## Memory\n\nYou have access…' }],
      }) +
      userMessage('2026-09-05T01:27:45.100Z', '# AGENTS.md instructions\n\n<INSTRUCTIONS>\n# 协作规范\n</INSTRUCTIONS>') +
      userMessage('2026-09-05T01:27:45.200Z', '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>') +
      record('2026-09-05T01:27:46.000Z', 'turn_context', { model: 'gpt-6-astra' }) +
      userMessage('2026-09-05T01:27:47.000Z', '把视频转成 1080p\n并检查音轨是否同步 sk-abcdef') +
      userMessage('2026-09-05T01:27:47.500Z', '<skill>\n<name>codex-config-sync-advisor</name>\n</skill>')
  );
  const parser = new RolloutParser(10);
  parser.setRolloutPath(rolloutPath);
  const initial = await parser.parse();
  assert.equal(
    initial?.session?.title,
    '把视频转成 1080p ↵ 并检查音轨是否同步 sk-abcdef',
    'the first real prompt, whitespace-normalized, is the title'
  );

  // ---- a later prompt never replaces it; incremental batches keep it -------
  fs.appendFileSync(
    rolloutPath,
    userMessage('2026-09-05T01:30:00.000Z', 'now do the other thing') +
      record('2026-09-05T01:30:01.000Z', 'event_msg', { type: 'task_started', turn_id: 't2' })
  );
  const later = await parser.parse();
  assert.equal(later?.session?.title, '把视频转成 1080p ↵ 并检查音轨是否同步 sk-abcdef');

  // ---- bounded: a long prompt is cut with an ellipsis -----------------------
  fs.writeFileSync(rolloutPath, meta + userMessage('2026-09-05T01:27:47.000Z', 'x'.repeat(600)));
  const bounded = new RolloutParser(10);
  bounded.setRolloutPath(rolloutPath);
  const long = (await bounded.parse())?.session?.title ?? '';
  assert.ok(long.length <= 240, `the stored title is bounded: ${long.length}`);
  assert.ok(long.endsWith('…'));

  const pathPrompt = '优化下/Users/zyb/Desktop/prj/scripts/agent_fleet_monitor.py这个的界面和交互';
  fs.writeFileSync(rolloutPath, meta + userMessage('2026-09-05T01:27:47.000Z', pathPrompt));
  const withPath = new RolloutParser(10);
  withPath.setRolloutPath(rolloutPath);
  assert.equal((await withPath.parse())?.session?.title, pathPrompt,
    'keep the task after a long path for display-time normalization');

  // ---- only injected messages: no title at all ------------------------------
  fs.writeFileSync(rolloutPath, meta + userMessage('2026-09-05T01:27:47.000Z', '<user_instructions>\nfoo\n</user_instructions>'));
  const none = new RolloutParser(10);
  none.setRolloutPath(rolloutPath);
  assert.equal((await none.parse())?.session?.title, undefined);

  // ---- a large rollout's bounded first read still finds it in the head -----
  // The head window keeps only state records; the first prompt sits right
  // after session_meta and the injected preamble, so it is recovered from
  // there while the transcript in the middle is skipped.
  const filler = record('2026-09-05T01:28:00.000Z', 'response_item', {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'y'.repeat(4000) }],
  });
  let body = meta + userMessage('2026-09-05T01:27:47.000Z', 'find the leak in the parser');
  for (let index = 0; index < 700; index++) {
    body += filler;
  }
  body += record('2026-09-05T02:00:00.000Z', 'event_msg', {
    type: 'token_count',
    info: {
      total_token_usage: { total_tokens: 1000 },
      last_token_usage: { total_tokens: 500 },
      model_context_window: 258000,
    },
  });
  fs.writeFileSync(rolloutPath, body);
  assert.ok(fs.statSync(rolloutPath).size > 2 * 1024 * 1024 + 64 * 1024, 'fixture exceeds the head+tail budget');
  const large = new RolloutParser(10);
  large.setRolloutPath(rolloutPath);
  const bounded2 = await large.parse();
  assert.equal(bounded2?.partialHistory, true, 'the first read was bounded');
  assert.equal(bounded2?.session?.title, 'find the leak in the parser');

  // A large injected preamble puts the first real prompt after the 64 KiB
  // head. Cold reload and incremental parsing must keep the same first title.
  const preamble = userMessage('2026-09-05T01:27:45.000Z',
    '# AGENTS.md instructions\n\n<INSTRUCTIONS>' + 'p'.repeat(90_000) + '</INSTRUCTIONS>');
  const original = userMessage('2026-09-05T01:27:47.000Z', 'ORIGINAL request after a large preamble');
  fs.writeFileSync(rolloutPath, meta + preamble + original);
  const warm = new RolloutParser(10);
  warm.setRolloutPath(rolloutPath);
  await warm.parse();
  fs.appendFileSync(rolloutPath, filler.repeat(700) + userMessage('2026-09-05T02:00:00.000Z', 'FOLLOWUP request') + record('2026-09-05T02:00:01.000Z', 'event_msg', { type: 'token_count', info: { last_token_usage: { total_tokens: 500 }, model_context_window: 258000 } }));
  const warmTitle = (await warm.parse())?.session?.title;
  const cold = new RolloutParser(10);
  cold.setRolloutPath(rolloutPath);
  const coldResult = await cold.parse();
  assert.equal(coldResult?.partialHistory, true);
  assert.equal(warmTitle, 'ORIGINAL request after a large preamble');
  assert.equal(coldResult?.session?.title, warmTitle);

  console.log('test-rollout-session-title: PASS');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
