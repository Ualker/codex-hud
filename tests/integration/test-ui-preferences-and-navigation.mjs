import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPreferences,savePreferences,focusSession } from '../../dist/ui/state.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hud-ui-'));
const env={...process.env};
try{
 const state=path.join(dir,'state'),log=path.join(dir,'actions');
 process.env.PATH=dir+path.delimiter+process.env.PATH;
 process.env.HUD_TEST_UI=state;process.env.HUD_TEST_ACTIONS=log;
 for(const key of Object.keys(process.env))if(key.startsWith('CODEX_HUD_'))delete process.env[key];
 process.env.HUD_TEST_BOUND=Buffer.from(JSON.stringify({sessionId:'thread',tmuxSession:'target'})).toString('base64');
 fs.writeFileSync(path.join(dir,'tmux'),`#!/bin/sh
case "$1" in
 show-option) case "$5" in
  @codex_hud_ui) cat "$HUD_TEST_UI";;
  @codex_hud_main_pane) echo %11;;
  @codex_hud_bound) echo "$HUD_TEST_BOUND";;
 esac;;
 set-option) printf '%s' "$6" > "$HUD_TEST_UI";;
 display-message) echo 'target|0';;
 switch-client|select-pane) printf '%s\\n' "$*" >> "$HUD_TEST_ACTIONS";;
esac
`,{mode:0o755});
 const prefs={mode:'overview',details:'full',tools:'off',layout:'coexist',label:'Review job',filter:'attention'};
 await savePreferences('target',prefs);assert.deepEqual(await loadPreferences('target'),prefs);
 process.env.CODEX_HUD_LAYOUT='standard';assert.equal((await loadPreferences('target')).layout,'standard');
 delete process.env.CODEX_HUD_LAYOUT;
 assert.equal(await focusSession('target','stale-thread'),false);assert.equal(fs.existsSync(log),false,'stale binding causes no navigation');
 assert.equal(await focusSession('target','thread'),true);
 assert.match(fs.readFileSync(log,'utf8'),/switch-client -t %11\nselect-pane -t %11/);
 fs.writeFileSync(state,'bad-base64');assert.equal((await loadPreferences('target')).mode,'single');
 console.log('test-ui-preferences-and-navigation: PASS');
}finally{
 for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);
 fs.rmSync(dir,{recursive:true,force:true});
}
