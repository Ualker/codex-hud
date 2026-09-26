import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRootRolloutForCwd } from '../../dist/utils/rollout-wake.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hud-wake-'));
try{
 const file=path.join(dir,'test.jsonl'),cwd=fs.realpathSync(dir);
 const write=(source,cwdValue=cwd)=>fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{source,cwd:cwdValue}})+'\n');
 write('cli');assert.equal(await isRootRolloutForCwd(file,cwd),true);
 write({subagent:{thread_spawn:{}}});assert.equal(await isRootRolloutForCwd(file,cwd),false);
 write('cli',os.homedir());assert.equal(await isRootRolloutForCwd(file,cwd),false);
 assert.equal(await isRootRolloutForCwd(file+'.missing',cwd),false);
 fs.writeFileSync(file,'{partial');assert.equal(await isRootRolloutForCwd(file,cwd),false);
 console.log('test-rollout-wake: PASS');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
