import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hud-fatal-'));
try {
 const result=spawnSync(process.execPath,['--input-type=module','-e',`import {installFatalHandlers} from ${JSON.stringify(new URL('../../dist/utils/fatal-error.js',import.meta.url).href)};installFatalHandlers();setTimeout(()=>{throw new Error('fixture fatal');},0);setTimeout(()=>console.log('MUST_NOT_CONTINUE'),100);`],{env:{...process.env,CODEX_HUD_LOG_FILE:'off'},encoding:'utf8',timeout:3000});
 assert.equal(result.status,75,result.stderr);assert.doesNotMatch(result.stdout,/MUST_NOT_CONTINUE/);assert.match(result.stdout,/restarting/);
 const count=path.join(dir,'count');
 fs.writeFileSync(path.join(dir,'node'),`#!/bin/sh\nn=0; test ! -f "$HUD_TEST_COUNT" || n=$(cat "$HUD_TEST_COUNT")\nn=$((n+1)); echo "$n" > "$HUD_TEST_COUNT"\nif test "$HUD_TEST_MODE" = normal; then exit 0; fi\nif test "$HUD_TEST_MODE" = once && test "$n" -gt 1; then exit 0; fi\nexit 75\n`,{mode:0o755});
 fs.writeFileSync(path.join(dir,'sleep'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 for(const [mode,wantRuns,wantStatus] of [['normal',1,0],['once',2,0],['always',4,75]]){
  fs.rmSync(count,{force:true});
  const run=spawnSync('bash',['bin/codex-hud-renderer'],{env:{...process.env,PATH:dir+path.delimiter+process.env.PATH,HUD_TEST_COUNT:count,HUD_TEST_MODE:mode},encoding:'utf8',timeout:3000});
  assert.equal(run.status,wantStatus,run.stderr);assert.equal(Number(fs.readFileSync(count,'utf8')),wantRuns);
 }
 console.log('test-fatal-recovery: PASS (fatal exits; bounded retries; ordinary exit stays stopped)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
