import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { getCodexDataNamespace } from '../../dist/utils/codex-path.js';

const repo = process.cwd();
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hud-rc-')));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEX_|CMUX_|TMUX|NODE_OPTIONS)/.test(key)));
const report = {};
const children = new Set();
async function until(test, label) {
  for (let i = 0; i < 220; i++) { if (test()) return; await delay(50); }
  throw new Error(label);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
try {
  const now = Date.now();
  const home = path.join(root, 'notify-home'), codexHome = path.join(home, '.codex');
  const date = new Date(now);
  const parts = [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].map(String);
  const sessions = path.join(codexHome, 'sessions', ...parts); fs.mkdirSync(sessions, { recursive:true });
  const file = path.join(sessions, `rollout-${parts.join('-')}T00-00-00-019fffff-7777-7000-8000-777777777777.jsonl`);
  const rec = (type,payload,at) => JSON.stringify({timestamp:new Date(at).toISOString(),type,payload})+'\n';
  fs.writeFileSync(file, rec('session_meta',{id:'019fffff-7777-7000-8000-777777777777',cwd:root,timestamp:new Date(now-300000).toISOString()},now-300000)
    +rec('event_msg',{type:'task_started',turn_id:'historical-turn'},now-250000)
    +rec('event_msg',{type:'task_complete',turn_id:'historical-turn',duration_ms:240000},now-10000));
  const preload = path.join(root,'delay-parse.mjs');
  const trace = path.join(root, 'trace.jsonl');
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    import { RolloutParser } from ${JSON.stringify('file://'+path.join(repo,'dist/collectors/rollout.js'))};
    import { HudNotifier } from ${JSON.stringify('file://'+path.join(repo,'dist/notify.js'))};
    const log = value => fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(value)+'\\n');
    const parse = RolloutParser.prototype.parse;
    let once = true;
    RolloutParser.prototype.parse = async function(...args) {
      if (once) { once = false; await new Promise(r => setTimeout(r, Number(process.env.REVIEW_DELAY_MS))); }
      const result = await parse.apply(this, args);
      log({parse: result?.turnActivity, pending: result?.pendingBytes});
      return result;
    };
    const observe = HudNotifier.prototype.observe;
    HudNotifier.prototype.observe = function(states, context, ...args) {
      const fired = observe.call(this, states, context, ...args);
      log({states, context, fired});
      return fired;
    };
  `);
  const fakeBin = path.join(root, 'fakebin'); fs.mkdirSync(fakeBin); fs.writeFileSync(path.join(fakeBin, 'tmux'), '#!/bin/sh\nexit 1\n', {mode:0o755});
  fs.mkdirSync(path.join(codexHome, 'shell_snapshots'));
  fs.writeFileSync(path.join(codexHome, 'shell_snapshots', `019fffff-7777-7000-8000-777777777777.${BigInt(now) * 1000000n}.sh`), "export TMUX_PANE='%999999'\n");
  report.historicalNotifications = [];
  for (const ms of [0,3800]) {
    const events = path.join(root,`events-${ms}.jsonl`);
    const child = spawn(process.execPath,['--import',preload,path.join(repo,'dist/index.js')],{cwd:root,env:{...cleanEnv,HOME:home,CODEX_HOME:codexHome,CODEX_HUD_CWD:root,CODEX_HUD_MAIN_PANE:'%999999',PATH:fakeBin+path.delimiter+cleanEnv.PATH,CODEX_HUD_HEIGHT_FIT:'0',CODEX_HUD_LOG_FILE:'off',CODEX_HUD_NOTIFY_CMD:`cat >> ${quote(events)}`,REVIEW_DELAY_MS:String(ms),COLUMNS:'120',LINES:'8'},stdio:['pipe','pipe','pipe']});
    children.add(child);
    let out='',err=''; child.stdout.on('data',b=>out=(out+b).slice(-32000));child.stderr.on('data',b=>err+=b);
    await until(() => out.includes('Idle'), 'the initial authoritative snapshot must actually render');
    await delay(100);
    assert.equal(fs.existsSync(events), false, 'startup must not announce a historical completion');
    const turn = `live-${ms}`;
    fs.appendFileSync(file, rec('event_msg', { type: 'task_started', turn_id: turn }, Date.now() - 240000)
      + rec('event_msg', { type: 'task_complete', turn_id: turn, duration_ms: 240000 }, Date.now()));
    try {
      await until(() => fs.existsSync(events) && fs.readFileSync(events, 'utf8').includes('turn-completed'), 'new completion still notifies');
    } catch (error) {
      throw new Error(`${error.message}; delay=${ms}; exit=${child.exitCode}; stderr=${err}; trace=${fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').slice(-6000) : 'missing'}; screen=${out.slice(-500)}`);
    }
    await stop(child);
    assert.equal(fs.readFileSync(events, 'utf8').trim().split('\n').length, 1, 'only the new turn is announced');
    report.historicalNotifications.push({parseDelayMs:ms,events:fs.existsSync(events)?fs.readFileSync(events,'utf8'):null,renderedIdle:out.includes('Idle'),stderr:err});
  }

  {
  const navHome=path.join(root,'nav-home'), navCodex=path.join(navHome,'.codex'), socket=path.join(root,'tmux.sock');
  fs.mkdirSync(path.join(navCodex,'sessions'),{recursive:true});
  const env={...cleanEnv,HOME:navHome,CODEX_HOME:navCodex,TERM:'xterm-256color'};
  const tmux=args=>execFileSync('tmux',['-S',socket,...args],{env,encoding:'utf8',timeout:3000}).trim();
  let client;
  try {
    const main=tmux(['-f','/dev/null','new-session','-d','-s','hud-origin','-x','140','-y','35','-P','-F','#{pane_id}','exec sleep 120']);
    const cmd=`exec env CODEX_HUD_CWD=${quote(root)} CODEX_HUD_TMUX_SESSION=hud-origin CODEX_HUD_MODE=overview CODEX_HUD_HEIGHT_FIT=0 CODEX_HUD_LOG_FILE=off ${quote(process.execPath)} ${quote(path.join(repo,'dist/index.js'))}`;
    const hud=tmux(['split-window','-d','-v','-l','8','-t','hud-origin','-P','-F','#{pane_id}',cmd]);
    tmux(['set-option','-t','hud-origin','@codex_hud_pane',hud]);tmux(['set-option','-t','hud-origin','@codex_hud_main_pane',main]);
    for (const [n,label] of [[0,'Selected task'],[1,'Unrelated task']]) {
      const session=`target-${n}`, id=`fixture-${n}`, rollout=path.join(root,`nav-${n}.jsonl`);
      const pane=tmux(['new-session','-d','-s',session,'-P','-F','#{pane_id}','exec sleep 120']);
      const hp=tmux(['split-window','-d','-t',session,'-P','-F','#{pane_id}','exec sleep 120']);
      fs.writeFileSync(rollout,rec('session_meta',{id,cwd:root,timestamp:new Date(now).toISOString()},now)+rec('event_msg',{type:'task_complete',turn_id:'t'},now-n*1000));
      tmux(['set-option','-t',session,'@codex_hud_pane',hp]);tmux(['set-option','-t',session,'@codex_hud_main_pane',pane]);
      tmux(['set-option','-t',session,'@codex_hud_bound',Buffer.from(JSON.stringify({namespace:getCodexDataNamespace(env),tmuxSession:session,sessionId:id,rolloutPath:rollout,cwd:root,label})).toString('base64')]);
    }
    const screen=()=>tmux(['capture-pane','-p','-t',hud]);
    await until(()=>screen().includes('Selected task')&&screen().includes('Unrelated task'),'overview targets missing');
    client=spawn('tmux',['-S',socket,'-C','attach-session','-t','hud-origin'],{env,stdio:['pipe','pipe','pipe']});client.stdout.on('data',()=>{});client.stderr.on('data',()=>{});
    await until(()=>tmux(['list-clients','-F','#{session_name}']).includes('hud-origin'),'client missing');
    tmux(['send-keys','-t',hud,'j']);
    await until(()=>screen().split('\n').some(s=>s.startsWith('> ')&&s.includes('Selected task')),'selection missing');
    tmux(['kill-session','-t','target-0']);
    await until(()=>!screen().includes('Selected task')&&screen().includes('Unrelated task'),'removed target still shown');
    const before=screen();
    tmux(['send-keys','-t',hud,'Enter']);
    await until(() => screen().includes('Session unavailable'), 'removed selection reports unavailable');
    assert.equal(tmux(['list-clients','-F','#{session_name}']), 'hud-origin', 'Enter must not switch to an unrelated session');
    report.removedSelection={selectedTarget:'target-0',visibleAfterRemoval:before,clientSessionAfterEnter:tmux(['list-clients','-F','#{session_name}'])};
  } finally {
    client?.kill();try{tmux(['kill-server']);}catch{}
  }
  }
  console.log('test-review-state-runtime: PASS (slow startup, live notification, removed selection)');
} finally { await Promise.all([...children].map(stop)); fs.rmSync(root,{recursive:true,force:true}); }
