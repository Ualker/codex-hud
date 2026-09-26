// Repeatable, offline benchmark. --build /path/to/dist compares another build.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
let subprocesses=0;
for(const name of ['execFile','execFileSync','spawn','spawnSync']){
  const original=childProcess[name];
  childProcess[name]=function(...args){subprocesses++;return original.apply(this,args);};
}
syncBuiltinESMExports();
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
const args=process.argv.slice(2);
function option(name,fallback){const i=args.indexOf(name);return i<0?fallback:args[i+1];}
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const build=path.resolve(option('--build',path.join(root,'dist')));
const iterations=Number(option('--iterations','1000'));
const fileMiB=Number(option('--file-mib','32'));
if(!Number.isInteger(iterations)||iterations<1||iterations>100000||!Number.isInteger(fileMiB)||fileMiB<1||fileMiB>128)throw new Error('iterations: 1..100000; file-mib: 1..128');
for(const key of Object.keys(process.env))if(key.startsWith('CODEX_HUD_'))delete process.env[key];
process.env.NO_COLOR='1';
const {renderToStdout,invalidateRenderedFrame}=await import(pathToFileURL(path.join(build,'render/index.js')));
const {RolloutParser}=await import(pathToFileURL(path.join(build,'collectors/rollout.js')));
const now=Date.parse('2026-09-26T00:00:00Z'),at=new Date(now);
const calls=Array.from({length:6},(_,i)=>({id:`call-${i}`,name:'exec_command',status:'running',timestamp:at,summary:'npm test -- workspace',workdir:'/work/hud'}));
const data={config:{model:'gpt-6-astra',sandbox_mode:'danger-full-access'},git:{isGitRepo:true,branch:'review',isDirty:true},
 project:{cwd:'/work/hud',projectName:'hud',skillsCount:10,mcpCount:2,hooksCount:1},sessionStart:at,
 session:{id:'root',title:'验证日志解析与多会话导航',cwd:'/work/hud',startTime:at,model:'gpt-6-astra'},
 turnActivity:{phase:'running-tool',since:at,lastActivityAt:at},contextUsage:{used:42000,total:100000,percent:42},
 toolActivity:{recentCalls:calls,runningCalls:calls,totalCalls:6,callsByType:{exec_command:6},lastUpdateTime:at},
 agentActivity:{visibleAgentCount:0,rows:[]},
 overview:{sessions:Array.from({length:20},(_,i)=>({id:`session-${i}`,projectName:'hud',title:`Task ${i}`,tmuxSession:`codex-hud-bench-${i}`,turnActivity:{phase:i%3?'thinking':'awaiting-approval',since:at,lastActivityAt:at},contextUsage:{used:100,total:1000,percent:10},lastActivityAt:at})),updatedAt:at}};
const report={schemaVersion:1,node:process.version,build,iterations,fileMiB,render:[],logs:{},subprocesses:0};
const originalWrite=process.stdout.write,originalNow=Date.now;
Date.now=()=>now+42000;
try {
 for(const rows of [5,8,12])for(const mode of ['single','overview']){
  process.stdout.columns=140;process.stdout.rows=rows;
  let writes=0;process.stdout.write=()=>{writes++;return true;};
  const input={...data,displayMode:mode};
  for(let i=0;i<25;i++)renderToStdout(input);
  invalidateRenderedFrame();writes=0;
  const cpu=process.cpuUsage(),started=performance.now();
  for(let i=0;i<iterations;i++)renderToStdout(input);
  const elapsed=performance.now()-started,used=process.cpuUsage(cpu);
  report.render.push({mode,width:140,rows,msPerFrame:Number((elapsed/iterations).toFixed(4)),cpuMs:(used.user+used.system)/1000,stdoutWrites:writes,rssMiB:Math.round(process.memoryUsage().rss/1048576)});
 }
} finally {Date.now=originalNow;process.stdout.write=originalWrite;}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hud-bench-'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try {
 const file=path.join(dir,'rollout.jsonl'),line=payload=>JSON.stringify(payload)+'\n';
 const envelope=(type,payload)=>({timestamp:at.toISOString(),type,payload});
 fs.writeFileSync(file,line(envelope('session_meta',{id:'root',cwd:'/work/hud',timestamp:at.toISOString()})));
 const filler=line(envelope('response_item',{type:'reasoning',summary:[],content:'x'.repeat(1000)}));
 const block=filler.repeat(Math.ceil(1048576/filler.length));
 for(let i=0;i<fileMiB;i++)fs.appendFileSync(file,block);
 fs.appendFileSync(file,line(envelope('event_msg',{type:'token_count',info:{total_token_usage:{total_tokens:1000},last_token_usage:{total_tokens:1000},model_context_window:128000}})));
 const parsers=Array.from({length:4},()=>{const p=new RolloutParser();p.setRolloutPath(file);return p;});
 const delayMonitor=monitorEventLoopDelay({resolution:10});delayMonitor.enable();await delay(30);
 const cpu=process.cpuUsage(),started=performance.now(),rssBefore=process.memoryUsage().rss;
 await Promise.all(parsers.map(p=>p.parse()));
 const coldMs=performance.now()-started;
 const warmStart=performance.now();await Promise.all(parsers.map(p=>p.parse()));
 const warmMs=performance.now()-warmStart;
 await delay(30);delayMonitor.disable();const used=process.cpuUsage(cpu);
 report.logs={readers:4,bytes:fs.statSync(file).size,coldMs:Math.round(coldMs),unchangedMs:Number(warmMs.toFixed(2)),cpuMs:(used.user+used.system)/1000,
  eventLoopP95Ms:Number((delayMonitor.percentile(95)/1e6).toFixed(2)),eventLoopMaxMs:Number((delayMonitor.max/1e6).toFixed(2)),
  rssDeltaMiB:Math.round((process.memoryUsage().rss-rssBefore)/1048576),rssMiB:Math.round(process.memoryUsage().rss/1048576)};
}finally{fs.rmSync(dir,{recursive:true,force:true});}
report.subprocesses=subprocesses;
console.log(JSON.stringify(report,null,2));
