import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import { createMockDurableExecutionProvider, createMockMutableSecretsProvider, createMockObjectStorageProvider } from "@alterx/shared-clients";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { Test } from "@nestjs/testing";
import { HttpException } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SecurityModule } from "./security.module";
import { identityTenantGatewayEnvironment, orchestrationStore } from "./orchestration-infrastructure.module";
import { RunLauncherService } from "./runs/run-launcher.service";
import { RunsController } from "./runs/runs.controller";
import { RunOutcomeService } from "./runs/run-outcome.service";
import { RunEstimateService } from "./budgets/run-estimate.service";
import { ApprovalsService } from "./approvals/approvals.service";
import { ApprovalsController } from "./approvals/approvals.controller";
import { ClarificationsService } from "./clarifications/clarifications.service";
import { ClarificationsController } from "./clarifications/clarifications.controller";
import { EscalationsService } from "./escalations/escalations.service";
import { EscalationsController } from "./escalations/escalations.controller";
import { TriggerRegistryService } from "./trigger-registry/trigger-registry.service";
import { TriggerRegistryController } from "./trigger-registry/trigger-registry.controller";
import { EventQueryService } from "./trigger-registry/event-query.service";
import { EventController } from "./trigger-registry/event.controller";
import { EventReplayService } from "./trigger-registry/event-replay.service";
import { NodeExecutionLedgerService } from "./runs/node-execution-ledger.service";
import { NodeExecutionsController } from "./runs/node-executions.controller";
import { RunObservabilityService } from "./runs/run-observability.service";
import { RunObservabilityController } from "./runs/run-observability.controller";
import { RunStreamEventService } from "./runs/run-stream-event.service";
import { RunStreamController } from "./runs/run-stream.controller";
import { ArtifactsService } from "./artifacts/artifacts.service";
import { ArtifactsController } from "./artifacts/artifacts.controller";
import { WorkflowReadService } from "./workflow-read/workflow-read.service";
import { WorkflowReadController } from "./workflow-read/workflow-read.controller";
import { TemplateVariablesService } from "./template-variables/template-variables.service";
import { TemplateVariablesController } from "./template-variables/template-variables.controller";
import { TriggerBindingService } from "./trigger-bindings/trigger-binding.service";
import { PostgresTriggerBindingStore } from "./trigger-bindings/postgres-trigger-binding.store";
import { TriggerBindingController } from "./trigger-bindings/trigger-binding.controller";
import { ProjectReadService } from "./project-read/project-read.service";
import { ProjectDomainService } from "./project-read/project-domain.service";
import { ProjectReadController } from "./project-read/project-read.controller";
import { workspaceReadScope } from "./workspace-read-scope";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";

const audit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./runs/run-learning-audit", () => ({ runLearningAuditClient: () => ({ recordEvent: audit }) }));

const tenant = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1", otherTenant = "018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const workspace = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1", otherWorkspace = "018f4d6e-2b4a-7a3e-8c1a-1234567890b2";
const id = (prefix: string, n: number) => `${prefix}_018f4d6e-2b4a-7a3e-8c1a-${String(n).padStart(12, "0")}`;
const never = async () => { throw new Error("Collection reads must not invoke execution, planning or replay"); };
const scope = { workspaceId: workspace }, tenantId = `ten_${tenant}`;

describe.sequential("engine workspace collection reads", () => {
  let postgres: StartedPostgreSqlContainer, admin: PostgresOrchestrationStoreProvider, store: PostgresOrchestrationStoreProvider;
  let runtimeUri: string, launcher: RunLauncherService, approvals: ApprovalsService, clarifications: ClarificationsService;
  let escalations: EscalationsService, triggers: TriggerRegistryService, events: EventQueryService, ledger: NodeExecutionLedgerService;
  let observations: RunObservabilityService, artifacts: ArtifactsService, workflows: WorkflowReadService, templates: TemplateVariablesService;
  let bindings: TriggerBindingService, projects: ProjectDomainService, streams: RunStreamEventService;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16-alpine").start();
    const migrationsFolder = resolve("apps/orchestration-service/drizzle");
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    const role = `collection_${randomBytes(5).toString("hex")}`, password = randomBytes(24).toString("hex");
    await admin.withTenant(tenant, async tx => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOBYPASSRLS NOSUPERUSER`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await tx.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    });
    for (let n = 1; n <= 8; n++) {
      const ten = n <= 6 ? tenant : otherTenant, ws = n <= 3 || n >= 7 ? workspace : otherWorkspace;
      const at = new Date(Date.now() - n * 60000).toISOString();
      await admin.withTenant(ten, async tx => {
        await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'Collection fixture')", [id("wf", n), ten, ws]);
        await tx.query("INSERT INTO projects(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'Collection project')", [id("prj", n), ten, ws]);
        await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,workflow_id,status,created_at) VALUES($1,$2,$3,'workflow',$4,'completed',$5)", [id("run", n), ten, ws, id("wf", n), at]);
        await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,project_id,status) VALUES($1,$2,$3,'project',$4,'completed')", [id("run", n + 100), ten, ws, id("prj", n)]);
        await tx.query("INSERT INTO node_executions(id,tenant_id,run_id,dag_node_id,node_type,status) VALUES($1,$2,$3,'step','tool','succeeded')", [id("node", n), ten, id("run", n)]);
        await tx.query("INSERT INTO approvals(id,tenant_id,workspace_id,run_id,node_execution_id,requested_action,expiry_at,requested_at) VALUES($1,$2,$3,$4,$5,'{}',now()+interval '1 day',$6)", [id("apr", n), ten, ws, id("run", n), id("node", n), at]);
        await tx.query("INSERT INTO conversations(id,tenant_id,workspace_id,channel,temporal_workflow_id) VALUES($1,$2,$3,'web',$1)", [id("cnv", n), ten, ws]);
        await tx.query("INSERT INTO clarifications(id,tenant_id,workspace_id,conversation_id,question,expiry_at,requested_at) VALUES($1,$2,$3,$4,'Which account?',now()+interval '1 day',$5)", [id("clr", n), ten, ws, id("cnv", n), at]);
        await tx.query("INSERT INTO project_plans(tenant_id,project_id,conversation_id,brief,status) VALUES($1,$2,$3,'Collection fixture','awaiting_clarification')", [ten, id("prj", n), id("cnv", n)]);
        await tx.query("INSERT INTO recovery_actions(id,tenant_id,run_id,node_execution_id,failure_class) VALUES($1,$2,$3,$4,'unknown')", [id("rec", n), ten, id("run", n), id("node", n)]);
        await tx.query("INSERT INTO escalations(id,tenant_id,workspace_id,run_id,node_execution_id,recovery_action_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,'Connect account',$7)", [id("esc", n), ten, ws, id("run", n), id("node", n), id("rec", n), at]);
        await tx.query("INSERT INTO triggers(id,tenant_id,workspace_id,workflow_id,name,type,created_at) VALUES($1,$2,$3,$4,'Collection trigger','webhook',$5)", [id("trg", n), ten, ws, id("wf", n), at]);
        await tx.query("INSERT INTO events(event_id,event_type,schema_version,tenant_id,workspace_id,source,idempotency_key,occurred_at,received_at,payload,signature_status) VALUES($1,'native','1',$2,$3,'native',$1,$4,$4,'{}','failed')", [id("evt", n), ten, ws, at]);
        await tx.query("INSERT INTO verification_results(id,tenant_id,run_id,gate_type,verdict) VALUES($1,$2,$3,'quality','pass')", [id("ver", n), ten, id("run", n)]);
        await tx.query("INSERT INTO artifacts(id,tenant_id,run_id,storage_reference,content_type,size_bytes) VALUES($1,$2,$3,'fixture://output','text/plain',1)", [id("art", n), ten, id("run", n)]);
        await tx.query("INSERT INTO workflow_versions(id,tenant_id,workflow_id,version,compiled_dag,dag_schema_version) VALUES($1,$2,$3,1,'{}','1')", [id("wfv", n), ten, id("wf", n)]);
        await tx.query("INSERT INTO workflow_template_variable_definitions(id,tenant_id,workflow_id,workflow_version_id,name,value_type) VALUES($1,$2,$3,$4,'account','text')", [id("tvd", n), ten, id("wf", n), id("wfv", n)]);
        await tx.query("INSERT INTO webhook_endpoints(id,tenant_id,workspace_id,integration_id,path_token) VALUES($1,$2,$3,$4,$1)", [id("whe", n), ten, ws, id("int", n).slice(4)]);
        await tx.query("INSERT INTO trigger_integration_bindings(id,tenant_id,workspace_id,trigger_id,integration_id,webhook_endpoint_id,config) VALUES($1,$2,$3,$4,$5,$6,'{}')", [id("tbn", n), ten, ws, id("trg", n), id("int", n).slice(4), id("whe", n)]);
      });
    }
    await admin.withTenant(tenant, async tx => {
      for (const n of [1,4]) await tx.query("INSERT INTO trigger_versions(id,tenant_id,trigger_id,version,config) VALUES($1,$2,$3,1,'{}')", [id("trv",n),tenant,id("trg",n)]);
      await tx.query("UPDATE events SET trigger_id=$2,trigger_version=1 WHERE event_id=$1", [id("evt",1),id("trg",1)]);
      await tx.query("UPDATE events SET trigger_id=$2,trigger_version=1 WHERE event_id=$1", [id("evt",3),id("trg",4)]);
      await tx.query("UPDATE runs SET triggering_event_id=$2 WHERE id=$1", [id("run",1),id("evt",1)]);
      await tx.query("UPDATE runs SET triggering_event_id=$2 WHERE id=$1", [id("run",4),id("evt",3)]);
    });
    const uri = new URL(postgres.getConnectionUri()); uri.username = role; uri.password = password; runtimeUri = uri.href;
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: runtimeUri, migrationsFolder });
    launcher = new RunLauncherService(store, createMockDurableExecutionProvider());
    approvals = new ApprovalsService(store, { signalWorkflow: never }); clarifications = new ClarificationsService(store);
    escalations = new EscalationsService(store); triggers = new TriggerRegistryService(store); events = new EventQueryService(store);
    ledger = new NodeExecutionLedgerService(store); observations = new RunObservabilityService(store); streams = new RunStreamEventService(store);
    artifacts = new ArtifactsService(store, createMockObjectStorageProvider(), "fixture"); workflows = new WorkflowReadService(store); templates = new TemplateVariablesService(store);
    bindings = new TriggerBindingService(new PostgresTriggerBindingStore(store), createMockMutableSecretsProvider(), { webhookBaseUrl: "https://fixture.test" });
    projects = new ProjectDomainService(store, { understand: never, decompose: never, selectStrategy: never, replan: never }, { classifyIntent: never, getGoalState: never, mergeClarification: never }, launcher);
  }, 120000);
  afterAll(async () => { await store?.close(); await admin?.close(); await postgres?.stop(); });

  it("filters real collection pages and cursor ownership before pagination under tenant RLS", async () => {
    expect((await store.withTenant(tenant, tx => tx.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"))).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const readers = [
      { prefix: "run", read: (cursor?: string) => launcher.listRuns(tenantId, { ...scope, mode: "workflow", status: "completed", limit: 2, ...(cursor ? { cursor } : {}) }) },
      { prefix: "apr", read: (cursor?: string) => approvals.list(tenantId, { ...scope, status: "pending", limit: 2, ...(cursor ? { cursor } : {}) }) },
      { prefix: "clr", read: (cursor?: string) => clarifications.list(tenantId, { ...scope, limit: 2, ...(cursor ? { cursor } : {}) }) },
      { prefix: "esc", read: (cursor?: string) => escalations.list(tenantId, { ...scope, status: "open", limit: 2, ...(cursor ? { cursor } : {}) }) },
    ];
    for (const reader of readers) {
      const first = await reader.read(); expect(first.data).toHaveLength(2); expect(first.page.has_more).toBe(true);
      const second = await reader.read(first.page.next_cursor!); expect(second.data).toHaveLength(1); expect(second.page.has_more).toBe(false);
      expect([...first.data, ...second.data].map(row => row.id).sort()).toEqual([1,2,3].map(n => id(reader.prefix, n)).sort());
      const foreignCursorError = await reader.read(id(reader.prefix, 4)).then(() => undefined, (error: unknown) => error);
      expect(foreignCursorError).toBeInstanceOf(Error);
      expect(foreignCursorError).toMatchObject({ message: expect.stringMatching(/cursor/) });
    }
    const first = await events.list(tenantId, { ...scope, source: "native", status: "failed", limit: 2 });
    expect(first.page.has_more).toBe(true); expect(first.data).toHaveLength(2);
    const second = await events.list(tenantId, { ...scope, source: "native", status: "failed", limit: 2, cursor: first.page.next_cursor! });
    expect(second.page.has_more).toBe(false);
    expect([...first.data, ...second.data].map(row => row["event_id"]).sort()).toEqual([1,2,3].map(n => id("evt", n)).sort());
    await expect(events.list(tenantId, { ...scope, cursor: id("evt", 4) })).rejects.toThrow(/cursor/);
    const joined = (await events.list(tenantId, scope)).data;
    expect(joined.find(row => row["event_id"] === id("evt",1))).toMatchObject({workflow_id:id("wf",1),run_id:id("run",1)});
    expect(joined.find(row => row["event_id"] === id("evt",3))).toMatchObject({workflow_id:null,run_id:null});
    expect((await triggers.listTriggers(tenantId, undefined, workspace)).map(row => row.id).sort()).toEqual([1,2,3].map(n => id("trg", n)));
    expect(await triggers.listTriggers(tenantId, id("wf", 4), workspace)).toEqual([]);
    expect((await launcher.listRuns(tenantId, { ...scope, workflowId: id("wf", 1) })).data.map(row => row.id)).toEqual([id("run", 1)]);
    expect((await launcher.listRuns(`ten_${otherTenant}`, { ...scope, mode: "workflow" })).data.map(row => row.id).sort()).toEqual([7,8].map(n => id("run", n)));
    expect((await store.withTenant(tenant, tx => tx.query("SELECT id FROM runs WHERE tenant_id=$1", [otherTenant]))).rows).toEqual([]);
    // Expiration maintenance stays within the workspace selected for the read.
    await admin.withTenant(tenant, tx => tx.query("UPDATE approvals SET expiry_at=now()-interval '1 minute' WHERE id=ANY($1::text[])", [[id("apr",1),id("apr",4)]]));
    await approvals.list(tenantId, scope);
    expect((await store.withTenant(tenant, tx => tx.query("SELECT id,status FROM approvals WHERE id=ANY($1::text[]) ORDER BY id", [[id("apr",1),id("apr",4)]]))).rows).toEqual([{ id:id("apr",1),status:"expired" },{ id:id("apr",4),status:"pending" }]);
    await admin.withTenant(tenant, tx => tx.query("UPDATE approvals SET expiry_at=now()+interval '1 day',status='pending' WHERE id=ANY($1::text[])", [[id("apr",1),id("apr",4)]]));
  });

  it("checks actual parent workspace for nested collections and stream visibility", async () => {
    const owned = id("run", 1), foreign = id("run", 4);
    expect((await ledger.list(tenantId, owned, scope)).data).toHaveLength(1);
    await expect(ledger.list(tenantId, foreign, scope)).rejects.toThrow(/not found/i);
    for (const read of [observations.verificationResults.bind(observations), observations.recoveryActions.bind(observations), observations.qualityGates.bind(observations)]) {
      expect((await read(tenantId, owned, scope)).data).toHaveLength(1);
      await expect(read(tenantId, foreign, scope)).rejects.toThrow(/not found/i);
    }
    expect(await artifacts.list(tenantId, owned, workspace)).toHaveLength(1); expect(await artifacts.list(tenantId, foreign, workspace)).toEqual([]);
    expect((await workflows.listVersions(tenantId, id("wf",1), undefined, 50, workspace)).data).toHaveLength(1);
    await expect(workflows.listVersions(tenantId, id("wf",4), undefined, 50, workspace)).rejects.toThrow(/not found/i);
    expect(await templates.list(tenantId, id("wf",1), workspace)).toHaveLength(1);
    await expect(templates.list(tenantId, id("wf",4), workspace)).rejects.toThrow(/not found/i);
    expect((await projects.clarifications(tenantId, id("prj",1), workspace)).data).toHaveLength(1);
    await expect(projects.clarifications(tenantId, id("prj",4), workspace)).rejects.toThrow(/not found/i);
    const integration = randomUUID();
    const created = await bindings.bindTrigger({tenantId,workspaceId:`ws_${workspace}`,triggerId:id("trg",2),integrationId:integration,config:{eventTypes:["native"]}});
    expect(created).toMatchObject({tenantId,workspaceId:`ws_${workspace}`,triggerId:id("trg",2)});
    expect(await bindings.getEndpointForIntegration(tenantId,`ws_${workspace}`,integration)).toMatchObject({workspaceId:`ws_${workspace}`});
    expect((await bindings.listBindings(tenantId, id("trg",1), workspace)).bindings).toMatchObject([{ workspaceId:`ws_${workspace}`,triggerId:id("trg",1) }]);
    await expect(bindings.listBindings(tenantId, id("trg",4), workspace)).rejects.toThrow(/not found/i);
    expect(await streams.runIsVisible(tenantId, owned, workspace)).toBe(true); expect(await streams.runIsVisible(tenantId, foreign, workspace)).toBe(false);
    expect(await streams.projectRunIsVisible(tenantId, id("prj",1), id("run",101), workspace)).toBe(true);
    expect(await streams.projectRunIsVisible(tenantId, id("prj",4), id("run",104), workspace)).toBe(false);
  });

  it("derives signed HTTP scope and preserves audited read-only system access", async () => {
    const redis = await new RedisContainer("redis:7.4.2-alpine").start(), pair = generateKeyPairSync("rsa", { modulusLength:2048 });
    const issuer = createServer((_request,response) => { response.setHeader("content-type","application/json"); response.end(JSON.stringify({ keys:[{ ...pair.publicKey.export({format:"jwk"}),kid:"collection-native",alg:"RS256",use:"sig" }] })); });
    await new Promise<void>(done => issuer.listen(0,"127.0.0.1",done));
    const jwks = `http://127.0.0.1:${(issuer.address() as {port:number}).port}/jwks`;
    for (const [name,value] of Object.entries({ NODE_ENV:"test",AUTH0_DOMAIN:"collection.test",AUTH0_API_AUDIENCE:"alter-engine",AUTH0_JWKS_URL:jwks,
      ACTOR_TOKEN_ISSUER:"alter-platform-api.identity-broker",ACTOR_TOKEN_AUDIENCE:"alter-engine",ACTOR_TOKEN_JWKS_URL:jwks,
      REDIS_ENDPOINT:redis.getConnectionUrl(),AWS_REGION:"ap-south-1",ALTER_ARTIFACTS_BUCKET_PARAM:"/fixture/artifacts",
      ORCHESTRATION_DATABASE_AUTHENTICATION:"static",ORCHESTRATION_DATABASE_URL:runtimeUri })) vi.stubEnv(name,value);
    let app:NestFastifyApplication|undefined, guardStore:PostgresOrchestrationStoreProvider|undefined;
    try {
      guardStore = orchestrationStore(identityTenantGatewayEnvironment(process.env));
      const module = await Test.createTestingModule({ imports:[SecurityModule], controllers:[RunsController,ApprovalsController,ClarificationsController,EscalationsController,TriggerRegistryController,EventController,NodeExecutionsController,RunObservabilityController,ArtifactsController,WorkflowReadController,TemplateVariablesController,TriggerBindingController,ProjectReadController,RunStreamController], providers:[
        {provide:RunLauncherService,useValue:launcher},{provide:RunOutcomeService,useValue:new RunOutcomeService(store)},{provide:RunEstimateService,useValue:{estimate:never}},
        {provide:ApprovalsService,useValue:approvals},{provide:ClarificationsService,useValue:clarifications},{provide:EscalationsService,useValue:escalations},
        {provide:TriggerRegistryService,useValue:triggers},{provide:EventQueryService,useValue:events},{provide:EventReplayService,useValue:{preview:never,replay:never}},
        {provide:NodeExecutionLedgerService,useValue:ledger},{provide:RunObservabilityService,useValue:observations},{provide:ArtifactsService,useValue:artifacts},
        {provide:WorkflowReadService,useValue:workflows},{provide:TemplateVariablesService,useValue:templates},{provide:TriggerBindingService,useValue:bindings},
        {provide:RunStreamEventService,useValue:streams},{provide:ProjectReadService,useValue:new ProjectReadService(store)},{provide:ProjectDomainService,useValue:projects},
      ] }).compile();
      app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter()); await app.listen(0,"127.0.0.1");
      const base = await app.getUrl();
      const jwt = (claims:Record<string,unknown>) => { const input = [{alg:"RS256",kid:"collection-native"},claims].map(part => Buffer.from(JSON.stringify(part)).toString("base64url")).join("."); return `${input}.${sign("RSA-SHA256",Buffer.from(input),pair.privateKey).toString("base64url")}`; };
      const headers = (overrides:Record<string,unknown> = {}, system = false) => { const now = Math.floor(Date.now()/1000); const identity = system ? {principal_type:"system",principal:"system:platform-jobs",permissions:["runs:read","human-actions:read","workflows:read"]} : {user_id:`usr_${tenant}`,workspace_id:`ws_${workspace}`,roles:["viewer"],permissions:["runs:read"],session_id:"collection-native"}; return {
        authorization:`Bearer ${jwt({iss:"https://collection.test/",aud:"alter-engine",iat:now,exp:now+60})}`,
        "x-alter-actor-token":jwt({tenant_id:tenantId,auth_time:now,jti:randomUUID(),iss:"alter-platform-api.identity-broker",aud:"alter-engine",iat:now,exp:now+60,...identity,...overrides}),
      }; };
      for (const path of ["runs?mode=workflow","approvals","clarifications","escalations","events"]) {
        const response = await fetch(`${base}/api/v1/${path}${path.includes("?")?"&":"?"}workspace_id=ws_${otherWorkspace}`,{headers:headers()});
        expect(response.status).toBe(200); const body = await response.json() as {data:{workspace_id:string}[]}; expect(body.data).toHaveLength(3);
        expect(body.data.every(row => row.workspace_id === workspace || row.workspace_id === `ws_${workspace}`)).toBe(true);
        const other = await fetch(`${base}/api/v1/${path}`,{headers:headers({workspace_id:`ws_${otherWorkspace}`})}); expect(other.status).toBe(200);
        expect(((await other.json()) as {data:unknown[]}).data).toHaveLength(3);
      }
      const otherTenantRuns = await fetch(`${base}/api/v1/runs?mode=workflow`,{headers:headers({tenant_id:`ten_${otherTenant}`})}); expect(otherTenantRuns.status).toBe(200);
      expect(((await otherTenantRuns.json()) as {data:unknown[]}).data).toHaveLength(2);
      const registered = await fetch(`${base}/api/v1/triggers`,{headers:headers()}); expect(registered.status).toBe(200); expect(((await registered.json()) as {triggers:unknown[]}).triggers).toHaveLength(3);
      for (const suffix of ["node-executions","verification-results","recovery-actions","quality-gates"]) {
        expect((await fetch(`${base}/api/v1/runs/${id("run",1)}/${suffix}`,{headers:headers()})).status).toBe(200);
        expect((await fetch(`${base}/api/v1/runs/${id("run",4)}/${suffix}`,{headers:headers()})).status).toBe(404);
      }
      for (const [owned,foreign] of [[`workflows/${id("wf",1)}/versions`,`workflows/${id("wf",4)}/versions`],[`workflows/${id("wf",1)}/template-variables`,`workflows/${id("wf",4)}/template-variables`],[`projects/${id("prj",1)}/clarifications`,`projects/${id("prj",4)}/clarifications`]]) {
        expect((await fetch(`${base}/api/v1/${owned}`,{headers:headers()})).status).toBe(200);
        expect((await fetch(`${base}/api/v1/${foreign}`,{headers:headers()})).status).toBe(404);
      }
      expect((await fetch(`${base}/v1/triggers/${id("trg",1)}/bindings`,{headers:headers()})).status).toBe(200);
      expect((await fetch(`${base}/v1/triggers/${id("trg",4)}/bindings`,{headers:headers()})).status).toBe(404);
      const foreignArtifacts = await fetch(`${base}/api/v1/artifacts?run_id=${id("run",4)}`,{headers:headers()}); expect(foreignArtifacts.status).toBe(200); expect(await foreignArtifacts.json()).toEqual({data:[]});
      expect((await fetch(`${base}/api/v1/runs/${id("run",4)}/stream`,{headers:headers()})).status).toBe(404);
      expect((await fetch(`${base}/api/v1/projects/${id("prj",4)}/builds/${id("run",104)}/stream`,{headers:headers()})).status).toBe(404);
      await streams.ensureRunRunning(tenantId,id("run",1));
      const abort = new AbortController();
      try {
        const live = await fetch(`${base}/api/v1/runs/${id("run",1)}/stream`,{headers:headers(),signal:abort.signal}); expect(live.status).toBe(200);
        const first = await live.body!.getReader().read(); expect(new TextDecoder().decode(first.value)).toContain("event: run.status");
      } finally { abort.abort(); }
      const terminalAbort = new AbortController();
      try { expect((await fetch(`${base}/api/v1/projects/${id("prj",1)}/builds/${id("run",101)}/stream`,{headers:headers(),signal:terminalAbort.signal})).status).toBe(200); }
      finally { terminalAbort.abort(); }
      const reused = headers(); expect((await fetch(`${base}/api/v1/runs`,{headers:reused})).status).toBe(200); expect((await fetch(`${base}/api/v1/runs`,{headers:reused})).status).toBe(401);
      expect((await fetch(`${base}/api/v1/runs`)).status).toBe(401);
      expect((await fetch(`${base}/api/v1/runs`,{headers:headers({workspace_id:null})})).status).toBe(401);
      expect((await fetch(`${base}/api/v1/runs`,{headers:headers({workspace_id:"invalid"})})).status).toBe(401);
      expect(() => workspaceReadScope({headers:{},url:"/api/v1/runs"})).toThrow(HttpException);
      const ordinary = {headers:{},url:"/api/v1/runs",actorContext:{actor_type:"user",tenant_id:tenantId,workspace_id:null,user_id:`usr_${tenant}`,roles:[],permissions:[],session_id:null,jti:null}} satisfies IdentityTenantGatewayRequest;
      expect(() => workspaceReadScope(ordinary)).toThrow(HttpException);
      audit.mockClear();
      const system = await fetch(`${base}/api/v1/runs?mode=workflow`,{headers:headers({},true)}); expect(system.status).toBe(200); expect(((await system.json()) as {data:unknown[]}).data).toHaveLength(6);
      await vi.waitFor(() => expect(audit).toHaveBeenCalledWith(expect.objectContaining({actor_type:"system",actor_ref:"system:platform-jobs",action:"system.read",result:"success"})));
      expect((await fetch(`${base}/api/v1/runs`,{method:"POST",headers:headers({},true),body:"{}"})).status).toBe(403);
    } finally { await app?.close(); await guardStore?.close(); vi.unstubAllEnvs(); await new Promise<void>(done => issuer.close(() => done())); await redis.stop(); }
  }, 120000);
});
