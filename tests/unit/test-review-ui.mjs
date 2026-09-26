import assert from 'node:assert/strict';
import { normalizePreferences, filteredSessions, moveSelection } from '../../dist/ui/state.js';
import { renderHud } from '../../dist/render/header.js';
import { renderToStdout } from '../../dist/render/index.js';
import { stripAnsi,visualLength } from '../../dist/render/colors.js';
import { setHudDetails } from '../../dist/render/detail-level.js';
import { renderHealthLine,renderNoteLine } from '../../dist/render/lines/activity-line.js';
const now=Date.now();
const rows=['idle','failed','awaiting-approval'].map((phase,i)=>({id:String(i),projectName:'same',title:`Task ${i}`,tmuxSession:`hud-${i}`,turnActivity:{phase,since:new Date(now-1000),lastActivityAt:new Date(now-1000)}}));
assert.deepEqual(filteredSessions(rows,'attention').map(r=>r.id),['1','2']);
assert.equal(moveSelection(rows,'2',1),'0');assert.equal(moveSelection([],'2',1),undefined);
assert.equal(normalizePreferences({label:'\x1b[31m hello\nworld',layout:'invalid',mode:'overview'}).label,'hello world');
assert.equal(normalizePreferences({layout:'invalid'}).layout,'standard');
const data={config:{model:'gpt-6-astra',sandbox_mode:'danger-full-access'},git:{isGitRepo:false},
 project:{cwd:'/tmp',projectName:'same',skillsCount:0,mcpCount:0,hooksCount:0},sessionStart:new Date(now),
 session:{id:'0',title:'long original title',cwd:'/tmp',startTime:new Date(now)},sessionLabel:'My task',
 turnActivity:rows[0].turnActivity,contextUsage:{used:20000,total:100000,percent:20},
 overview:{sessions:rows,updatedAt:new Date(now)},overviewSelfSessionId:'0'};
const render=(d,width=120,height=6)=>renderHud(d,{width,maxLines:height,showDetails:true}).map(stripAnsi);
assert.match(render(data).join('\n'),/My task/);assert.doesNotMatch(render(data).join('\n'),/long original title/);
assert.doesNotMatch(render({...data,layoutPreset:'coexist'}).join('\n'),/Ctx:/);
assert.match(render({...data,layoutPreset:'coexist',contextUsage:{...data.contextUsage,percent:85}}).join('\n'),/Ctx:/);
const filtered=render({...data,displayMode:'overview',overviewFilter:'attention',overviewSelectionId:'2'}).join('\n');
assert.match(filtered,/> .*Approval/);assert.doesNotMatch(filtered,/Idle/);
const help=render({...data,helpVisible:true}).join('\n');assert.match(help,/Esc return/);assert.match(help,/Enter open/);
const protocol={...data,protocolHealth:{unknownTopLevelTypes:{meta:1},unknownResponseTypes:{future:2},unknownEventTypes:{},malformedLines:0}};
assert.match(stripAnsi(renderHealthLine(protocol)),/2 types/);assert.equal(renderNoteLine(protocol),null);
setHudDetails(true);assert.match(stripAnsi(renderHealthLine(protocol)),/future/);assert.match(stripAnsi(renderNoteLine(protocol)),/meta/);setHudDetails(false);
for(const width of [28,48,80,120,180])for(const preset of ['standard','coexist']){
 const measure={wantedRows:0};const output=renderHud({...data,layoutPreset:preset},{width,maxLines:5,showDetails:true,measure});
 assert.ok(output.every(row=>visualLength(row)<=width));assert.ok(measure.wantedRows>0);
}
console.log('test-review-ui: PASS');
