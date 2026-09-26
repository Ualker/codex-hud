import assert from 'node:assert/strict';
import { AgentActivityCollector } from '../../dist/collectors/agent-activity.js';
import { makeAgentTestRoot,cleanupAgentTestRoot,canonicalSessionMeta,legacyAgentStart,taskStarted,writeRolloutFile,rolloutSessionFile } from '../helpers/agent-rollout-fixture.mjs';
const dir=makeAgentTestRoot();
try {
 const sessions=new Map();
 for(const suffix of ['a','b']){
  const id=`root-${suffix}`,child=`child-${suffix}`;
  const rootPath=writeRolloutFile(dir,{sessionId:id,records:[canonicalSessionMeta({id}),taskStarted(),legacyAgentStart({childThreadId:child,agentPath:`/root/${child}`})]});
  sessions.set(id,rolloutSessionFile(rootPath,id));
  const childPath=writeRolloutFile(dir,{sessionId:child,records:[canonicalSessionMeta({id:child,source:{subagent:{thread_spawn:{parent_thread_id:id,agent_path:`/root/${child}`}}}}),taskStarted()]});
  sessions.set(child,rolloutSessionFile(childPath,child));
 }
 const collector=new AgentActivityCollector({inactivityTimeoutMs:900000,resolveRollout:id=>sessions.get(id)??null,logError:()=>{}});
 collector.setRootSession(sessions.get('root-a'));
 const pending=collector.collect(Date.parse('2026-07-12T00:00:01Z'));
 collector.setRootSession(sessions.get('root-b'));await pending;
 const result=await collector.collect(Date.parse('2026-07-12T00:00:01Z'));
 assert.deepEqual(result.rows.map(r=>r.threadId),['child-b']);
 collector.setRootSession(sessions.get('root-a'));
 const clearing=collector.collect();collector.setRootSession(null);await clearing;
 assert.equal((await collector.collect()).visibleAgentCount,0);
 console.log('test-agent-rebind-race: PASS');
} finally {cleanupAgentTestRoot(dir);}
