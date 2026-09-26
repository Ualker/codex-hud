import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RolloutParser } from '../../dist/collectors/rollout.js';
import { canonicalSessionMeta, taskStarted, taskComplete } from '../helpers/agent-rollout-fixture.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hud-backlog-'));
const encode = r => JSON.stringify(r)+'\n';
try {
 const file=path.join(dir,'rollout.jsonl');
 fs.writeFileSync(file,encode(canonicalSessionMeta())+encode(taskStarted()));
 const parser=new RolloutParser();parser.setRolloutPath(file);await parser.parse();
 const filler=encode({timestamp:'2026-09-26T00:00:00Z',type:'response_item',payload:{type:'reasoning',summary:[],content:'x'.repeat(1000)}});
 const block=filler.repeat(Math.ceil(1024*1024/filler.length));
 for(let i=0;i<65;i++)fs.appendFileSync(file,block);
 fs.appendFileSync(file,encode(taskComplete()));
 let result=await parser.parse();
 assert.ok(result.pendingBytes>60*1024*1024,'first pass is bounded');
 let passes=1;
 while(result.pendingBytes>0 && passes<40){result=await parser.parse();passes++;}
 assert.equal(result.pendingBytes,0);
 assert.equal(result.turnActivity.phase,'idle');
 assert.ok(passes>1 && passes<40,'backlog advances instead of retrying the same offset');
 console.log(`test-review-log-backlog: PASS (${passes} bounded passes)`);
} finally {fs.rmSync(dir,{recursive:true,force:true});}
