import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RolloutParser } from '../../dist/collectors/rollout.js';
import { createParseQueue } from '../../dist/utils/parse-queue.js';
import { HudNotifier } from '../../dist/notify.js';
import { getCodexHome } from '../../dist/utils/codex-path.js';
import { canonicalSessionMeta, taskStarted, taskComplete } from '../helpers/agent-rollout-fixture.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-review-recovery-'));
const lines = records => records.map(JSON.stringify).join('\n') + '\n';
const oldHome = process.env.CODEX_HOME;
try {
  const a = path.join(dir, 'a.jsonl'), b = path.join(dir, 'b.jsonl');
  fs.writeFileSync(a, lines([canonicalSessionMeta({id:'session-a'}), taskStarted()]));
  fs.writeFileSync(b, lines([canonicalSessionMeta({id:'session-b'}), taskStarted()]));
  assert.equal(fs.statSync(a).size, fs.statSync(b).size);
  const parser = new RolloutParser(), parse = createParseQueue(() => parser.parse());
  parser.setRolloutPath(a);
  const pending = parse();
  // Let the queue start A, but do not let its asynchronous file read finish.
  await Promise.resolve();
  parser.setRolloutPath(b);
  await Promise.all([pending, parse()]);
  assert.equal((await parse()).session.id, 'session-b');
  parser.setRolloutPath(a);
  const clearing = parser.parse();
  parser.setRolloutPath(null);
  await clearing;
  assert.equal(parser.getCached(), null);

  parser.setRolloutPath(b);
  await parser.parse();
  fs.appendFileSync(b, lines([null, [], {timestamp:'2026-09-26T00:00:00Z',type:'event_msg',payload:null}, taskComplete()]));
  const recovered = await parser.parse();
  assert.equal(recovered.turnActivity.phase, 'idle');
  assert.equal(recovered.protocolHealth.malformedLines, 3);
  assert.equal(recovered.runtimeStateComplete, false);
  assert.equal((await parser.parse()).protocolHealth.malformedLines, 3);

  process.env.CODEX_HOME = path.join(dir, 'missing');
  assert.throws(() => getCodexHome(), /CODEX_HOME.*does not exist/);
  fs.writeFileSync(process.env.CODEX_HOME, 'not a directory');
  assert.throws(() => getCodexHome(), /CODEX_HOME/);
  fs.mkdirSync(path.join(dir,'profile'));
  fs.symlinkSync(path.join(dir,'profile'),path.join(dir,'linked'));
  process.env.CODEX_HOME = path.join(dir,'linked');
  assert.equal(getCodexHome(),fs.realpathSync(path.join(dir,'profile')));

  const calls = [];
  const notifier = new HudNotifier({command:'fake',runCommand:async (_,p)=>{calls.push(JSON.parse(p));}});
  const quiet = Object.fromEntries(['approval-needed','turn-interrupted','limit-reached','turn-completed','turn-failed'].map(k=>[k,false]));
  const waiting = {...quiet,'approval-needed':true};
  const context = {sessionId:'a',cwd:dir,turnId:'turn-a'};
  notifier.observe(quiet,context,1000);
  notifier.observe(waiting,context,2000);
  notifier.reset();
  notifier.observe(quiet,{...context,sessionId:'b'},3000);
  assert.deepEqual(notifier.observe(waiting,{...context,sessionId:'b'},4000),['approval-needed']);
  notifier.observe(quiet,{...context,sessionId:'b',turnId:'turn-b'},5000);
  assert.deepEqual(notifier.observe(waiting,{...context,sessionId:'b',turnId:'turn-b'},6000),['approval-needed']);
  assert.equal(calls.length,3);
} finally {
  if(oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME=oldHome;
  fs.rmSync(dir,{recursive:true,force:true});
}
console.log('test-review-recovery: PASS');
