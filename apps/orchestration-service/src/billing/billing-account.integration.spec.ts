import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import type { VerifyServiceHandlerClient } from "@alterx/adapters";
import { NodeExecutionLedgerService } from "../runs/node-execution-ledger.service";
import { PostgresRunAcceptanceCheck } from "../registry/run-acceptance-check";
import { VerifyGateService } from "../registry/verify-gate.service";
import { type CompiledDag } from "@alterx/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RunLauncherService } from "../runs/run-launcher.service";
import { RunOutcomeService } from "../runs/run-outcome.service";
import { DurableRunQueue } from "../runs/durable-run-queue.service";
import { TriggerEventDispatchService } from "../trigger-registry/trigger-event-dispatch.service";
import { EventReplayService } from "../trigger-registry/event-replay.service";
import { OrchestrationDeletionService } from "../deletion/deletion.service";
import { sweepRunHistory } from "../run-retention/run-retention.service";
import { uuidV7 } from "../trigger-bindings/ids";
import { EngineBillingAccountService, type BillingAccountPolicy } from "./billing-account.service";

const tenant=uuidV7(), other=uuidV7(), workspace=uuidV7();
const ten=`ten_${tenant}`, ws=`ws_${workspace}`, workflow=`wf_${uuidV7()}`, version=`wfv_${uuidV7()}`, trigger=`trg_${uuidV7()}`;
const migrationsFolder=resolve("apps/orchestration-service/drizzle");
const dag: CompiledDag={ schema_version:"v1", entry_node_keys:["receive"], nodes:[{ key:"receive",type:"Merge",config:{},metadata:{ui:{}} }],edges:[],waves:[{key:"first",order:0,node_keys:["receive"],depends_on:[]}] };
const policy=(changes: Partial<BillingAccountPolicy>={}): BillingAccountPolicy => ({tenantId:ten,plan:"free",revision:"2026-10-05T00:00:00.000Z",accessState:"active",emailVerified:true,free:true,maxRunsPerDay:3,creditsPerVerifiedRun:null,...changes});

describe.sequential("billing admission and verified settlement on ordinary PostgreSQL",()=>{
  let postgres: StartedPostgreSqlContainer, admin: PostgresOrchestrationStoreProvider, store: PostgresOrchestrationStoreProvider;
  let billing: EngineBillingAccountService, launcher: RunLauncherService, outcomes: RunOutcomeService, dispatch: TriggerEventDispatchService;
  const durable={startWorkflow:vi.fn(async ()=>({workflowId:"fixture",runId:"temporal-edge"})),terminateWorkflow:vi.fn(async ()=>{})};
  const audit={recordEvent:vi.fn(async ()=>({}))};
  beforeAll(async()=>{
    postgres=await new PostgreSqlContainer("postgres:16.6-alpine").start();
    admin=new PostgresOrchestrationStoreProvider({authentication:"static",connectionString:postgres.getConnectionUri(),migrationsFolder});
    await admin.migrate();
    const role=`billing_${randomBytes(6).toString("hex")}`, password=randomBytes(24).toString("hex");
    await admin.withTenant(tenant,async tx=>{
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOBYPASSRLS NOSUPERUSER`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await tx.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
    });
    const uri=new URL(postgres.getConnectionUri());uri.username=role;uri.password=password;
    store=new PostgresOrchestrationStoreProvider({authentication:"static",connectionString:uri.href,migrationsFolder});
    await store.withTenant(tenant,async tx=>{
      await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'billing fixture')",[workflow,tenant,workspace]);
      await tx.query("INSERT INTO workflow_versions(id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version,status) VALUES($1,$2,$3,1,$4::jsonb,'v1','promoted')",[version,tenant,workflow,JSON.stringify(dag)]);
      await tx.query("INSERT INTO triggers(id,tenant_id,workspace_id,workflow_id,name,type,status) VALUES($1,$2,$3,$4,'billing ingress','webhook','enabled')",[trigger,tenant,workspace,workflow]);
      await tx.query("INSERT INTO trigger_versions(id,tenant_id,trigger_id,version,workflow_version_id,config,status) VALUES($1,$2,$3,1,$4,'{}','active')",[`trv_${uuidV7()}`,tenant,trigger,version]);
    });
    billing=new EngineBillingAccountService(store);outcomes=new RunOutcomeService(store,undefined,undefined,billing);
    launcher=new RunLauncherService(store,durable as never,outcomes,undefined,new DurableRunQueue(store),undefined,audit as never,undefined,billing);
    dispatch=new TriggerEventDispatchService(store,launcher,undefined,billing);
  },120000);
  beforeEach(async()=>{
    durable.startWorkflow.mockClear();audit.recordEvent.mockClear();
    for(const id of [tenant,other]) await store.withTenant(id,async tx=>{
      for(const table of ["billing_run_reservations","billing_credit_grants","billing_accounts","run_dispatch_queue","run_outcomes","verification_results","blackboard_checkpoints","node_executions","runs","events"]) await tx.query(`DELETE FROM ${table}`);
    });
  });
  afterAll(async()=>{await store?.close();await admin?.close();await postgres?.stop();},60000);
  const balance=()=>store.withTenant(tenant,async tx=>(await tx.query("SELECT credit_balance::text AS balance,reserved_credits::text AS reserved FROM billing_accounts")).rows[0]);
  const start=()=>launcher.createRun(ten,workflow);
  const deliver=(key=uuidV7())=>dispatch.createRun({tenant_id:ten,workspace_id:ws,trigger_id:trigger,trigger_version:1,event_type:"billing.fixture",schema_version:"1",source:"native",idempotency_key:key,payload_json:'{"value":"native"}'});
  async function finish(id:string,status:"completed"|"failed"|"cancelled",acceptance?:"pass"|"warn"|"fail"){
    await store.withTenant(tenant,async tx=>{
      if(acceptance) await tx.query("INSERT INTO verification_results(id,tenant_id,run_id,gate_type,verdict) VALUES($1,$2,$3,'acceptance',$4)",[`vrf_${uuidV7()}`,tenant,id,acceptance]);
      await tx.query("UPDATE runs SET status=$2,ended_at=clock_timestamp() WHERE id=$1",[id,status]);
    });
    await outcomes.recordOutcome(ten,id,status);
  }
  it("has actual ordinary privileges, tenant isolation and default deny",async()=>{
    await billing.syncPolicy(policy());await billing.syncPolicy(policy({tenantId:`ten_${other}`}));
    const role=await store.withTenant(tenant,tx=>tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"));
    expect(role.rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
    expect((await store.withTenant(other,tx=>tx.query("SELECT tenant_id FROM billing_accounts"))).rows).toEqual([{tenant_id:other}]);
    expect((await store.withTenant(tenant,async tx=>{await tx.query("SELECT set_config('app.current_tenant_id','',true)");return tx.query("SELECT * FROM billing_accounts");})).rows).toEqual([]);
    await expect(store.withTenant(other,tx=>tx.query("UPDATE billing_accounts SET tenant_id=$1",[tenant]))).rejects.toThrow();
  });
  it("rejects missing, unverified and suspended policy before any durable start",async()=>{
    await expect(start()).rejects.toMatchObject({code:"BILLING_POLICY_UNAVAILABLE"});
    await billing.syncPolicy(policy({emailVerified:false}));await expect(start()).rejects.toMatchObject({code:"EMAIL_VERIFICATION_REQUIRED"});
    await billing.syncPolicy(policy({revision:"2026-10-05T00:00:01.000Z",accessState:"suspended"}));await expect(start()).rejects.toMatchObject({code:"BILLING_ACCOUNT_SUSPENDED"});
    expect(durable.startWorkflow).not.toHaveBeenCalled();expect((await store.withTenant(tenant,tx=>tx.query("SELECT * FROM runs"))).rows).toEqual([]);
  });
  it("accepts exactly configured concurrent manual starts and rolls back refused runs",async()=>{
    await billing.syncPolicy(policy());const attempts=await Promise.allSettled(Array.from({length:10},start));
    expect(attempts.filter(r=>r.status==="fulfilled")).toHaveLength(3);
    for(const result of attempts) if(result.status==="rejected") expect(result.reason).toMatchObject({code:"DAILY_RUN_LIMIT_REACHED"});
    expect(durable.startWorkflow).toHaveBeenCalledTimes(3);
    expect((await store.withTenant(tenant,tx=>tx.query("SELECT * FROM runs"))).rows).toHaveLength(3);expect(await balance()).toEqual({balance:"0",reserved:"0"});
  });
  it("enforces the same cap on actual trigger dispatch and leaves no refused event",async()=>{
    await billing.syncPolicy(policy({maxRunsPerDay:1}));await deliver("first");await expect(deliver("second")).rejects.toMatchObject({code:"DAILY_RUN_LIMIT_REACHED"});
    expect((await store.withTenant(tenant,tx=>tx.query("SELECT * FROM events"))).rows).toHaveLength(1);
    expect(await deliver("first")).toEqual({run_id:"",event_inserted:false});expect(durable.startWorkflow).toHaveBeenCalledTimes(1);
  });
  it("refuses actual replay at the cap without creating another run or audited confirmation",async()=>{
    await billing.syncPolicy(policy({maxRunsPerDay:1}));await deliver();
    const event=await store.withTenant(tenant,tx=>tx.query("SELECT event_id FROM events"));
    const actor={tenantId:ten,workspaceId:ws,userId:`usr_${uuidV7()}`}, replay=new EventReplayService(store,launcher);
    const preview=await replay.preview(actor,String(event.rows[0]!.event_id));
    await expect(replay.replay(actor,String(event.rows[0]!.event_id),{confirmed:true,confirmationToken:preview.confirmationToken},"native-replay-key-12345")).rejects.toMatchObject({code:"DAILY_RUN_LIMIT_REACHED"});
    expect(audit.recordEvent).not.toHaveBeenCalled();expect(durable.startWorkflow).toHaveBeenCalledTimes(1);
  });
  it("version conflicts and old policy cannot overwrite current configuration or balances",async()=>{
    await billing.syncPolicy(policy({free:false,creditsPerVerifiedRun:2}));await billing.grant(ten,"payment-one",10);
    await expect(billing.syncPolicy(policy({maxRunsPerDay:7}))).rejects.toMatchObject({code:"BILLING_POLICY_REVISION_CONFLICT"});
    await billing.syncPolicy(policy({revision:"2026-10-04T23:00:00.000Z",maxRunsPerDay:7}));
    expect((await store.withTenant(tenant,tx=>tx.query("SELECT max_runs_per_day FROM billing_accounts"))).rows[0]).toEqual({max_runs_per_day:3});expect(await balance()).toEqual({balance:"10",reserved:"0"});
  });
  it("deduplicates credit grants and fences simultaneous credit reservations",async()=>{
    await billing.syncPolicy(policy({free:false,creditsPerVerifiedRun:3,maxRunsPerDay:10}));
    expect((await Promise.all([billing.grant(ten,"payment-one",7),billing.grant(ten,"payment-one",7)])).sort()).toEqual([false,true]);
    await expect(billing.grant(ten,"payment-one",8)).rejects.toMatchObject({code:"BILLING_GRANT_CONFLICT"});
    const results=await Promise.allSettled(Array.from({length:6},start));expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(2);
    expect(await balance()).toEqual({balance:"7",reserved:"6"});expect(durable.startWorkflow).toHaveBeenCalledTimes(2);
  });
  it("requires paid credit configuration and rejects fractional grants",async()=>{
    await billing.syncPolicy(policy({free:false}));await expect(start()).rejects.toMatchObject({code:"BILLING_PRICE_UNCONFIGURED"});
    await expect(billing.grant(ten,"payment-one",1.5)).rejects.toThrow();expect(await balance()).toEqual({balance:"0",reserved:"0"});
  });
  it("charges actual accepted completion once at the original reservation quantity",async()=>{
    await billing.syncPolicy(policy({free:false,creditsPerVerifiedRun:2}));await billing.grant(ten,"payment-one",20);
    const run=await start();await billing.syncPolicy(policy({revision:"2026-10-05T00:00:01.000Z",free:false,creditsPerVerifiedRun:5}));
    await finish(run.id,"completed","pass");await Promise.all([billing.settle(ten,run.id),outcomes.recordOutcome(ten,run.id,"completed")]);
    expect(await balance()).toEqual({balance:"18",reserved:"0"});expect((await store.withTenant(tenant,tx=>tx.query("SELECT credits,state FROM billing_run_reservations"))).rows).toEqual([{credits:2,state:"charged"}]);
  });
  it.each(["failed","cancelled","warn","fail","missing"] as const)("never charges %s, even when node success could look billable",async kind=>{
    await billing.syncPolicy(policy({free:false,creditsPerVerifiedRun:2}));await billing.grant(ten,"payment-one",10);const run=await start();
    await finish(run.id,kind==="failed"||kind==="cancelled"?kind:"completed",kind==="missing"?undefined:kind==="failed"||kind==="cancelled"?"pass":kind);
    expect(await balance()).toEqual({balance:"10",reserved:"0"});expect((await store.withTenant(tenant,tx=>tx.query("SELECT state FROM billing_run_reservations"))).rows[0]).toEqual({state:"released"});
  });
  it.each(["pass","fail","unavailable"] as const)("settles credits from actual run acceptance and node ledger when verification is %s",async verdict=>{
    await billing.syncPolicy(policy({free:false,creditsPerVerifiedRun:2}));await billing.grant(ten,"accepted-run-fixture",10);
    const run=await start(),ledger=new NodeExecutionLedgerService(store),nodeExecutionId=`node_${uuidV7()}`;
    const criteria=["The combined outcome has accepted equal to true"];
    await store.withTenant(tenant,tx=>tx.query("UPDATE workflow_versions SET compiled_dag=$2::jsonb WHERE id=$1",[version,JSON.stringify({...dag,success_criteria:criteria})]));
    try {
      await ledger.recordStarted({tenantId:ten,runId:run.id,nodeExecutionId,dagNodeId:"receive",nodeType:"Merge"});
      await ledger.recordSucceeded({tenantId:ten,runId:run.id,nodeExecutionId});
      await store.withTenant(tenant,tx=>tx.query("INSERT INTO blackboard_checkpoints(tenant_id,run_id,context_key,value_json) VALUES($1,$2,'receive',$3::jsonb)",[tenant,run.id,JSON.stringify({accepted:verdict==="pass"})]));
      const scoreNodeInline=vi.fn(async(request:{success_criteria:readonly string[];output_json:string})=>{
        expect(request.success_criteria).toEqual(criteria);expect(JSON.parse(request.output_json)).toEqual({final_outputs:{receive:{accepted:verdict==="pass"}},actions_taken:{},upstream_outputs:{}});
        if(verdict==="unavailable")throw new Error("Verification edge unavailable");
        return {verdict,score:verdict==="pass"?1:0,threshold:1,reviewer_model:"native-verification-edge",details_json:"{}"};
      });
      const check=new PostgresRunAcceptanceCheck(store,new VerifyGateService({scoreNodeInline} as unknown as VerifyServiceHandlerClient),ledger);
      expect(await check.check(ten,run.id)).toMatchObject({checked:true,passed:verdict==="pass"});
      const rows=(await store.withTenant(tenant,tx=>tx.query("SELECT node_execution_id,gate_type,verdict FROM verification_results WHERE run_id=$1",[run.id]))).rows;
      expect(rows).toEqual(verdict==="unavailable"?[]:[{node_execution_id:null,gate_type:"acceptance",verdict}]);
      await finish(run.id,"completed");
      expect(await balance()).toEqual({balance:verdict==="pass"?"8":"10",reserved:"0"});
      await billing.settle(ten,run.id);expect(await balance()).toEqual({balance:verdict==="pass"?"8":"10",reserved:"0"});
      expect(scoreNodeInline).toHaveBeenCalledTimes(1);
    } finally {await store.withTenant(tenant,tx=>tx.query("UPDATE workflow_versions SET compiled_dag=$2::jsonb WHERE id=$1",[version,JSON.stringify(dag)]));}
  });

  it("leaves nonterminal runs held and ignores legacy runs without billing reservations",async()=>{
    await billing.syncPolicy(policy({free:false,creditsPerVerifiedRun:2}));await billing.grant(ten,"payment-one",10);const run=await start();await billing.settle(ten,run.id);
    expect(await balance()).toEqual({balance:"10",reserved:"2"});await billing.settle(`ten_${other}`,`run_${uuidV7()}`);
  });
  it("recovers terminal reservations in bounded batches from actual outcomes while unfinished acceptance stays held",async()=>{
    await billing.syncPolicy(policy({free:false,creditsPerVerifiedRun:2,maxRunsPerDay:50}));await billing.grant(ten,"batch-fixture",100);
    const runs=[];for(let i=0;i<30;i++)runs.push(await start());
    const outcomeWriter=new RunOutcomeService(store);
    for(const run of runs){
      await store.withTenant(tenant,async tx=>{
        await tx.query("INSERT INTO verification_results(id,tenant_id,run_id,gate_type,verdict) VALUES($1,$2,$3,'acceptance','pass')",[`vrf_${uuidV7()}`,tenant,run.id]);
        await tx.query("UPDATE runs SET status='completed',ended_at=clock_timestamp() WHERE id=$1",[run.id]);
      });
      await outcomeWriter.recordOutcome(ten,run.id,"completed");
    }
    expect(await balance()).toEqual({balance:"100",reserved:"60"});
    expect(await billing.readAccount(ten)).toEqual({balance:"50",reserved:"10",available:"40"});
    expect(await billing.readAccount(ten)).toEqual({balance:"40",reserved:"0",available:"40"});
    const unfinished=await start();await store.withTenant(tenant,tx=>tx.query("UPDATE runs SET status='completed' WHERE id=$1",[unfinished.id]));
    await billing.settle(ten,unfinished.id);expect(await billing.readAccount(ten)).toEqual({balance:"40",reserved:"2",available:"38"});
    await outcomeWriter.recordOutcome(ten,unfinished.id,"completed");
    expect(await billing.readAccount(ten)).toEqual({balance:"40",reserved:"0",available:"40"});
  });

  it("rolls back debit, reservation and outcome together on a settlement failure",async()=>{
    await billing.syncPolicy(policy({free:false,creditsPerVerifiedRun:2}));await billing.grant(ten,"payment-one",10);const run=await start();
    await admin.withTenant(tenant,async tx=>{await tx.query("CREATE FUNCTION fail_billing_settle() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'native settlement failure'; END;$$");await tx.query("CREATE TRIGGER native_billing_failure BEFORE UPDATE ON billing_run_reservations FOR EACH ROW EXECUTE FUNCTION fail_billing_settle()");});
    try {await expect(finish(run.id,"completed","pass")).rejects.toThrow("native settlement failure");expect(await balance()).toEqual({balance:"10",reserved:"2"});expect((await store.withTenant(tenant,tx=>tx.query("SELECT * FROM run_outcomes"))).rows).toEqual([]);}
    finally {await admin.withTenant(tenant,tx=>tx.query("DROP TRIGGER native_billing_failure ON billing_run_reservations;DROP FUNCTION fail_billing_settle()"));}
    await outcomes.recordOutcome(ten,run.id,"completed");expect(await balance()).toEqual({balance:"8",reserved:"0"});
  });
  it("retains charged balances and releases unfinished holds before actual run-history erasure",async()=>{
    await billing.syncPolicy(policy({free:false,creditsPerVerifiedRun:2,maxRunsPerDay:10}));await billing.grant(ten,"retention-fixture",20);
    const charged=await start(),missed=await start(),unfinished=await start(),recent=await start();
    await finish(charged.id,"completed","pass");
    await store.withTenant(tenant,async tx=>{
      for(const id of [missed.id,unfinished.id])await tx.query("UPDATE runs SET status='completed',ended_at=now()-interval '366 days' WHERE id=$1",[id]);
      await tx.query("UPDATE runs SET ended_at=now()-interval '366 days' WHERE id=$1",[charged.id]);
      await tx.query("INSERT INTO verification_results(id,tenant_id,run_id,gate_type,verdict) VALUES($1,$2,$3,'acceptance','pass')",[`vrf_${uuidV7()}`,tenant,missed.id]);
    });
    await new RunOutcomeService(store).recordOutcome(ten,missed.id,"completed");
    expect(await balance()).toEqual({balance:"18",reserved:"6"});
    expect(await store.withTenant(tenant,tx=>sweepRunHistory(tx,tenant))).toBe(3);
    expect(await balance()).toEqual({balance:"16",reserved:"2"});
    expect((await store.withTenant(tenant,tx=>tx.query("SELECT run_id FROM billing_run_reservations"))).rows).toEqual([{run_id:recent.id}]);
    await expect(billing.grant(ten,"retention-fixture",20)).resolves.toBe(false);
    expect(await store.withTenant(tenant,tx=>sweepRunHistory(tx,tenant))).toBe(0);
  });
  it("workspace erasure settles accepted runs and preserves tenant grants and another workspace",async()=>{
    await billing.syncPolicy(policy({free:false,creditsPerVerifiedRun:2,maxRunsPerDay:10}));await billing.grant(ten,"workspace-fixture",20);
    const accepted=await start(),held=await start(),otherWorkspace=uuidV7();
    await store.withTenant(tenant,async tx=>{
      await tx.query("UPDATE runs SET workspace_id=$2 WHERE id=$1",[held.id,otherWorkspace]);
      await tx.query("UPDATE runs SET status='completed' WHERE id=$1",[accepted.id]);
      await tx.query("INSERT INTO verification_results(id,tenant_id,run_id,gate_type,verdict) VALUES($1,$2,$3,'acceptance','pass')",[`vrf_${uuidV7()}`,tenant,accepted.id]);
    });
    await new RunOutcomeService(store).recordOutcome(ten,accepted.id,"completed");
    // One workflow is shared only by this synthetic history fixture. Keep the other run's parent outside the erased workspace.
    const keepWorkflow=`wf_${uuidV7()}`,keepVersion=`wfv_${uuidV7()}`;
    await store.withTenant(tenant,async tx=>{
      await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'kept')",[keepWorkflow,tenant,otherWorkspace]);
      await tx.query("INSERT INTO workflow_versions(id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version) VALUES($1,$2,$3,1,$4::jsonb,'v1')",[keepVersion,tenant,keepWorkflow,JSON.stringify(dag)]);
      await tx.query("UPDATE runs SET workflow_id=$2,workflow_version_id=$3 WHERE id=$1",[held.id,keepWorkflow,keepVersion]);
    });
    const deletion=new OrchestrationDeletionService(store);
    await deletion.deleteWorkspaceData(ten,ws,`del_${uuidV7()}`);
    await expect(deletion.verifyWorkspaceDeletion(ten,ws,`del_${uuidV7()}`)).resolves.toMatchObject({deleted:true});
    expect(await balance()).toEqual({balance:"18",reserved:"2"});
    expect((await store.withTenant(tenant,tx=>tx.query("SELECT run_id FROM billing_run_reservations"))).rows).toEqual([{run_id:held.id}]);
    await expect(billing.grant(ten,"workspace-fixture",20)).resolves.toBe(false);
    // Restore the shared fixture for subsequent rollback verification.
    await store.withTenant(tenant,async tx=>{
      await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'billing fixture')",[workflow,tenant,workspace]);
      await tx.query("INSERT INTO workflow_versions(id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version,status) VALUES($1,$2,$3,1,$4::jsonb,'v1','promoted')",[version,tenant,workflow,JSON.stringify(dag)]);
    });
  });
  it("applies paired migration rollback and reapplies actual policies",async()=>{
    const down=await readFile(resolve(migrationsFolder,"rollback/0054_drop_billing_accounts.sql"),"utf8"),up=await readFile(resolve(migrationsFolder,"0054_billing_accounts.sql"),"utf8");
    await admin.withTenant(tenant,async tx=>{for(const sql of down.split("--> statement-breakpoint"))if(sql.trim())await tx.query(sql);});
    expect((await admin.withTenant(tenant,tx=>tx.query("SELECT to_regclass('public.billing_accounts') AS relation"))).rows[0]).toEqual({relation:null});
    await admin.withTenant(tenant,async tx=>{for(const sql of up.split("--> statement-breakpoint"))if(sql.trim())await tx.query(sql);});
    await billing.syncPolicy(policy());expect(await balance()).toEqual({balance:"0",reserved:"0"});
  });
});
