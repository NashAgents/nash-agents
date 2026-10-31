import { ClusterDatabase } from '../../dist/cluster/storage/db.js';
import { PostgresClusterStore } from '../../dist/cluster/storage/cluster-store.js';
import fs from 'node:fs';
import path from 'node:path';
import { ExecutionJournal } from '../../dist/cluster/worker/execution-journal.js';
import { ClusterCoordinator } from '../../dist/cluster/coordinator/cluster-coordinator.js';
const { connection, patch, stage, directory, targetNodeId, projectId } = JSON.parse(process.env.NASH_CRASH_FIXTURE);
if (stage.startsWith('outbox_')) {
  // Actual Coordinator, Scheduler, PostgreSQL and journal; transport and side effect are simulated.
  const coordinator = new ClusterCoordinator({ customDir: path.join(directory,'coordinator'), databaseUrl: connection, listenHost:'127.0.0.1',listenPort:0 });
  await coordinator.start();
  const journal=new ExecutionJournal(path.join(directory,'journal'));
  const counter=path.join(directory,'counter.txt');
  coordinator.getRegistry().getConnection=()=>({generation:1,ws:{readyState:1,send(raw){
    if(stage==='outbox_before_send')process.kill(process.pid,'SIGKILL');
    const envelope=JSON.parse(raw); const payload=envelope.payload;
    fs.appendFileSync(path.join(directory,'frames.jsonl'),JSON.stringify({messageId:envelope.messageId,taskId:payload.taskId,runId:payload.runId})+'\n',{flush:true});
    if(journal.claim(payload.taskId,payload.runId))fs.writeFileSync(counter,String((fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0)+1),{flush:true});
    console.log('SIMULATED_DELIVERY_WITHOUT_ACK');
    process.kill(process.pid,'SIGKILL');
  }}});
  if(stage==='outbox_replay') {
    await coordinator.getScheduler().flushOutbox();
    console.log('RECOVERY_PRESERVED_UNKNOWN_WITHOUT_SEND');process.kill(process.pid,'SIGKILL');
  } else await coordinator.getScheduler().createTask({nodeId:targetNodeId,projectId,goal:'Controlled outbox delivery fixture',contextOverrides:{operation:'execute'}});
  throw new Error('Outbox crash injection did not fire');
} else if (stage === 'supervisor') {
  const coordinator = new ClusterCoordinator({ customDir: directory, databaseUrl: connection, listenHost: '127.0.0.1', listenPort: 0 });
  await coordinator.start(); await coordinator.getGlobalSupervisor().superviseGraphs();
  console.log('SUPERVISOR_RECOVERED');
  process.kill(process.pid,'SIGKILL');
} else {
  class CrashDatabase extends ClusterDatabase {
    async query(sql,params) {
      const result=await super.query(sql,params);
      if ((stage==='before_commit' && /INSERT INTO cluster_graph_patch_operations/.test(sql))
        || (stage==='after_node' && /INSERT INTO cluster_graph_nodes/.test(sql))) process.kill(process.pid,'SIGKILL');
      return result;
    }
  }
  const db=new CrashDatabase(connection);if(!await db.connect())throw new Error('Isolated crash database unavailable');
  const result=await new PostgresClusterStore(db).applyGraphPatchAtomic(patch);
  if(stage==='after_commit' && result.success){console.log('PATCH_COMMITTED');process.kill(process.pid,'SIGKILL');}
  throw new Error('Crash injection did not fire');
}
