import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hu-'));
const repo=process.cwd(),socket=path.join(root,'tmux');fs.mkdirSync(socket);
const home=path.join(root,'home'),codexHome=path.join(home,'.codex');
fs.mkdirSync(path.join(codexHome,'sessions'),{recursive:true});fs.mkdirSync(path.join(codexHome,'shell_snapshots'));
fs.writeFileSync(path.join(codexHome,'config.toml'),'model="gpt-6-astra"\n');
const env={...process.env,HOME:home,CODEX_HOME:codexHome,TMUX_TMPDIR:socket,TERM:'xterm-256color'};
for(const key of Object.keys(env))if(key.startsWith('CODEX_HUD_')||key.startsWith('CMUX_')||['TMUX','TMUX_PANE','NO_COLOR','FORCE_COLOR'].includes(key))delete env[key];
const tmux=args=>execFileSync('tmux',args,{env,encoding:'utf8',timeout:8000}).trim();
const quote=s=>`'${s.replaceAll("'", "'\\''")}'`;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(check,label){for(let i=0;i<120;i++){if(check())return;await delay(50);}assert.fail(label);}
let client;
try {
 tmux(['-f','/dev/null','new-session','-d','-s','hud-one','-x','150','-y','35','exec sleep 180']);
 tmux(['set-option','-t','hud-one','status','off']);
 const main=tmux(['display-message','-p','-t','hud-one','#{pane_id}']);
 const command=`exec env CODEX_HUD_CWD=${quote(root)} CODEX_HUD_TMUX_SESSION=hud-one CODEX_HUD_LABEL='Runtime label' CODEX_HUD_HEIGHT_FIT=0 CODEX_HUD_LOG_FILE=${quote(path.join(root,'hud.log'))} ${quote(process.execPath)} ${quote(path.join(repo,'dist/index.js'))}`;
 const hud=tmux(['split-window','-d','-v','-l','9','-t','hud-one','-P','-F','#{pane_id}',command]);
 tmux(['set-option','-t','hud-one','@codex_hud_main_pane',main]);tmux(['set-option','-t','hud-one','@codex_hud_pane',hud]);
 const capture=()=>tmux(['capture-pane','-p','-t',hud]);
 await waitFor(()=>capture().includes('Runtime label'),'real renderer paints label');
 tmux(['send-keys','-t',hud,'?']);await waitFor(()=>capture().includes('HUD help'),'help opens');
 tmux(['send-keys','-t',hud,'Escape']);await waitFor(()=>!capture().includes('HUD help'),'Escape closes help');
 tmux(['send-keys','-t',hud,'c','d','t','C-t']);
 await waitFor(()=>{try{const v=JSON.parse(Buffer.from(tmux(['show-option','-qv','-t','hud-one','@codex_hud_ui']),'base64'));return v.preferences.mode==='overview' && v.preferences.layout==='coexist' && v.preferences.details==='full' && v.preferences.tools==='full';}catch{return false;}},'keyboard choices persisted');
 const mainPid=tmux(['display-message','-p','-t',main,'#{pane_pid}']);
 tmux(['respawn-pane','-k','-t',hud,command]);
 await waitFor(()=>capture().includes('No active sessions'),'overview survives renderer reload');
 const saved=JSON.parse(Buffer.from(tmux(['show-option','-qv','-t','hud-one','@codex_hud_ui']),'base64'));
 assert.equal(saved.preferences.details,'full');assert.equal(saved.preferences.tools,'full');assert.equal(saved.preferences.layout,'coexist');
 assert.equal(tmux(['display-message','-p','-t',main,'#{pane_pid}']),mainPid,'main process unchanged');
 // A real client is needed for switch-client. It only attaches to this private server.
 client=spawn('tmux',['-C','attach-session','-t','hud-one'],{env,stdio:['pipe','pipe','pipe']});client.stdout.on('data',()=>{});client.stderr.on('data',()=>{});
 await waitFor(()=>tmux(['list-clients','-F','#{session_name}']).includes('hud-one'),'control client attached');
 tmux(['select-pane','-t',hud]);tmux(['send-keys','-t',hud,'Escape']);
 await waitFor(()=>tmux(['display-message','-p','-t','hud-one','#{pane_id}'])===main,'Escape focuses real main pane');
 const second='hud-two',thread='fixture-target';
 tmux(['new-session','-d','-s',second,'exec sleep 180']);
 const secondMain=tmux(['display-message','-p','-t',second,'#{pane_id}']);
 const secondHud=tmux(['split-window','-d','-t',second,'-P','-F','#{pane_id}','exec sleep 180']);
 const rollout=path.join(root,'target.jsonl'),stamp=new Date().toISOString();
 fs.writeFileSync(rollout,[{timestamp:stamp,type:'session_meta',payload:{id:thread,cwd:root,timestamp:stamp}},
  {timestamp:stamp,type:'event_msg',payload:{type:'task_complete',turn_id:'t',error:{message:'fixture failed'}}}].map(JSON.stringify).join('\n')+'\n');
 tmux(['set-option','-t',second,'@codex_hud_main_pane',secondMain]);tmux(['set-option','-t',second,'@codex_hud_pane',secondHud]);
 tmux(['set-option','-t',second,'@codex_hud_bound',Buffer.from(JSON.stringify({tmuxSession:second,sessionId:thread,rolloutPath:rollout,cwd:root,label:'Target label'})).toString('base64')]);
 tmux(['send-keys','-t',hud,'C-t','C-t']);
 await waitFor(()=>capture().includes('Target label'),'other HUD label arrives in overview');
 tmux(['send-keys','-t',hud,'f','j']);
 await waitFor(()=>capture().includes('> '),'selected overview row is visible');
 tmux(['send-keys','-t',hud,'Enter']);
 await waitFor(()=>tmux(['list-clients','-F','#{session_name}']).includes(second),'Enter switches the real client to selected session');
 assert.equal(tmux(['display-message','-p','-t',second,'#{pane_id}']),secondMain);
 const doctor=JSON.parse(execFileSync(path.join(repo,'bin/codex-hud'),['--doctor','--json'],{env,encoding:'utf8',timeout:8000}));
 const diagnostic=doctor.panes.find(p=>p.pane===hud);
 assert.ok(diagnostic?.diagnosticsFresh,JSON.stringify(doctor));
 assert.ok('offset' in diagnostic.runtime.rollout);assert.ok('source' in diagnostic.runtime.binding);
 assert.equal(tmux(['display-message','-p','-t',main,'#{pane_pid}']),mainPid);
 console.log('test-review-interaction-runtime: PASS (label/help/keys/reload/Escape/Enter/filter/doctor, main panes preserved)');
}finally{
 client?.kill();try{tmux(['kill-server']);}catch{}
 fs.rmSync(root,{recursive:true,force:true});
}
