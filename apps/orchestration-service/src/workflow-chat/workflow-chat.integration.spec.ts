import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import { COMPILER_HANDLER, CompilerGrpcController, connectCompilerGrpcTransport, PostgresOrchestrationStoreProvider,
 ModelGatewayClient, RUNS_HANDLER, RunsGrpcController, connectRunsGrpcTransport, type ModelGatewayHandler } from "@alterx/adapters";
import type { ActorContext } from "@alterx/auth";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowReadService } from "../workflow-read/workflow-read.service";
import { WorkflowReadController } from "../workflow-read/workflow-read.controller";
import { GraphCompilerService } from "../compiler/graph-compiler.service";
import { CONNECTION_LOOKUP_TOKEN_HASH, CONNECTION_REGISTRY_TOKEN_HASH, ConnectionRegistryController } from "../connections/connection-registry.controller";
import { ConnectionRegistryService } from "../connections/connection-registry.service";
import { OrchestrationDeletionService } from "../deletion/deletion.service";
import { uuidV7 } from "../trigger-bindings/ids";
import { WorkflowChatService } from "./workflow-chat.service";
import { WorkflowChatController } from "./workflow-chat.controller";
import { RunWorkspaceLookupService } from "../runs/run-workspace-lookup.service";
import { createMockDurableExecutionProvider } from "@alterx/shared-clients";
import { RunLauncherService } from "../runs/run-launcher.service";
import { RunOutcomeService } from "../runs/run-outcome.service";
import { RunsController } from "../runs/runs.controller";
import { RunEstimateService } from "../budgets/run-estimate.service";
import { NodeExecutionLedgerService } from "../runs/node-execution-ledger.service";
import { NodeExecutionsController } from "../runs/node-executions.controller";
import { RunObservabilityService } from "../runs/run-observability.service";
import { RunObservabilityController } from "../runs/run-observability.controller";
import { SecurityModule } from "../security.module";
import { identityTenantGatewayEnvironment, orchestrationStore } from "../orchestration-infrastructure.module";

const tenant=uuidV7(),otherTenant=uuidV7(),workspace=uuidV7(),otherWorkspace=uuidV7(),user=uuidV7(),otherUser=uuidV7();
const actor=(overrides:Partial<ActorContext>={}):ActorContext=>({actor_type:'user',tenant_id:`ten_${tenant}`,workspace_id:`ws_${workspace}`,user_id:`usr_${user}`,roles:['admin'],permissions:[],session_id:'session-fixture',jti:'chat-fixture',...overrides});
const migrationsFolder=resolve('apps/orchestration-service/drizzle');

describe.sequential('Workflow chats on restricted PostgreSQL',()=>{
 let postgres:StartedPostgreSqlContainer,admin:PostgresOrchestrationStoreProvider,store:PostgresOrchestrationStoreProvider,chats:WorkflowChatService,workflows:WorkflowReadService;
 let modelGateway:ModelGatewayHandler|undefined;
 const role=`chat_${randomBytes(5).toString('hex')}`;
 beforeAll(async()=>{
  postgres=await new PostgreSqlContainer('postgres:16-alpine').start();
  admin=new PostgresOrchestrationStoreProvider({authentication:'static',connectionString:postgres.getConnectionUri(),migrationsFolder});await admin.migrate();
  await admin.withTenant(tenant,async tx=>{
   await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD 'chat-fixture-only' NOBYPASSRLS NOSUPERUSER`);
   await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
   await tx.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
   await tx.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  });
  const uri=new URL(postgres.getConnectionUri());uri.username=role;uri.password='chat-fixture-only';
  store=new PostgresOrchestrationStoreProvider({authentication:'static',connectionString:uri.href,migrationsFolder});
  chats=new WorkflowChatService(store,{invoke:async request=>{if(modelGateway)return modelGateway.invoke(request);throw Error('Storage proof must not invoke a model');}});workflows=new WorkflowReadService(store);
 },120000);
 beforeEach(async()=>{
  for(const id of [tenant,otherTenant])await admin.withTenant(id,async tx=>{await tx.query('DELETE FROM runs WHERE tenant_id=$1',[id]);await tx.query('DELETE FROM conversation_messages WHERE tenant_id=$1',[id]);await tx.query('DELETE FROM conversations WHERE tenant_id=$1',[id]);await tx.query('DELETE FROM workflow_versions WHERE tenant_id=$1',[id]);await tx.query('DELETE FROM workflows WHERE tenant_id=$1',[id]);});
 });
 afterAll(async()=>{await store?.close();await admin?.close();await postgres?.stop();});

 it('uses actual row policies through an ordinary runtime role',async()=>{
  const result=await store.withTenant(tenant,tx=>tx.query<{rolsuper:boolean;rolbypassrls:boolean}>(`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`));expect(result.rows).toEqual([{rolsuper:false,rolbypassrls:false}]);
 });
 it('creates exactly one linked chat in the shared workflow transaction and uses the current workflow name',async()=>{
  const wf=await workflows.createWorkflow({tenantId:`ten_${tenant}`,workspaceId:`ws_${workspace}`,name:'Invoice checks',createdBy:`usr_${user}`});
  const chat=await chats.get(actor(),`cnv_${wf.id.slice(3)}`);expect(chat).toMatchObject({title:'Invoice checks',linkedWorkflowId:wf.id,type:'workflow_builder',createdBy:{id:`usr_${user}`}});
  expect(await chats.create(actor(),{type:'workflow_builder',title:'Ignored rename',linkedWorkflowId:wf.id})).toMatchObject({id:chat.id,title:'Invoice checks'});
  const count=await store.withTenant(tenant,tx=>tx.query<{count:number}>('SELECT count(*)::int AS count FROM conversations WHERE tenant_id=$1 AND workflow_id=$2',[tenant,wf.id]));expect(count.rows[0]!.count).toBe(1);
  await workflows.updateWorkflow({tenantId:`ten_${tenant}`,workflowId:wf.id,name:'Invoice review'});expect((await chats.get(actor(),chat.id)).title).toBe('Invoice review');
 });
 it('rolls back workflow creation if its chat cannot be created',async()=>{
  const failing=new WorkflowReadService({withTenant:(id,operation)=>store.withTenant(id,tx=>operation({query:async(statement,values)=>{if(statement.startsWith('INSERT INTO conversations'))throw Error('chat-write-fixture');return tx.query(statement,values);}}))});
  await expect(failing.createWorkflow({tenantId:`ten_${tenant}`,workspaceId:`ws_${workspace}`,name:'Atomic create'})).rejects.toThrow('chat-write-fixture');
  const rows=await store.withTenant(tenant,tx=>tx.query('SELECT id FROM workflows WHERE tenant_id=$1',[tenant]));expect(rows.rows).toEqual([]);
 });
 it('exposes an existing workflow without writes, then stores ordered messages under the same chat identity',async()=>{
  const wf=`wf_${uuidV7()}`,id=`cnv_${wf.slice(3)}`;
  await store.withTenant(tenant,tx=>tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'Existing')",[wf,tenant,workspace]));
  expect((await chats.list(actor())).map(c=>c.id)).toEqual([id]);expect((await chats.get(actor(),id)).linkedWorkflowId).toBe(wf);
  const before=await store.withTenant(tenant,tx=>tx.query('SELECT id FROM conversations WHERE tenant_id=$1',[tenant]));expect(before.rows).toEqual([]);
  const first=await chats.begin(actor(),id,{content:'Build monthly invoice checks'});
  await chats.reply(actor(),id,first.userMessage.id,'clarification',{text:'Which day?',questions:['Which day?']});
  await chats.begin(actor(),id,{content:'First day of the month'});
  const messages=await chats.messages(actor(),id);expect(messages.map(m=>m.role)).toEqual(['user','assistant','user']);expect(messages[0]!.content).toBe('Build monthly invoice checks');expect(messages[1]!.content).toMatchObject({text:'Which day?',replyTo:first.userMessage.id});
  expect((await chats.get(actor(),id)).id).toBe(id);
 });
 it('archives only the chat and refuses further messages',async()=>{
  const chat=await chats.create(actor(),{type:'workflow_builder',title:'Archive proof'});await chats.archive(actor(),chat.id);
  expect((await chats.get(actor(),chat.id)).status).toBe('archived');expect((await workflows.getWorkflow(`ten_${tenant}`,chat.linkedWorkflowId!)).status).toBe('draft');
  await expect(chats.begin(actor(),chat.id,{content:'Change the workflow'})).rejects.toMatchObject({code:'CHAT_ARCHIVED'});
 });
 it('serializes concurrent builder messages without losing earlier context',async()=>{
  const chat=await chats.create(actor(),{type:'workflow_builder',title:'Concurrent context'});
  await chats.begin(actor(),chat.id,{content:'Original objective'});
  const results=await Promise.all(['First clarification','Second clarification'].map(content=>chats.begin(actor(),chat.id,{content})));
  expect(results.map(result=>result.messages.length).sort()).toEqual([2,3]);
  expect(results.every(result=>result.messages[0]!.content==='Original objective')).toBe(true);
  expect((await chats.messages(actor(),chat.id)).map(message=>message.content)).toEqual(results.find(result=>result.messages.length===3)!.messages.map(message=>message.content));
 });
 it('replays the same message and persisted reply without adding duplicate history',async()=>{
  const chat=await chats.create(actor(),{type:'workflow_builder',title:'Retry proof'});
  const first=await chats.begin(actor(),chat.id,{content:'Original objective'},'retry-message');
  const response=await chats.reply(actor(),chat.id,first.userMessage.id,'clarification',{text:'Which day?',questions:['Which day?']});
  const repeat=await chats.begin(actor(),chat.id,{content:'Original objective'},'retry-message');
  expect(repeat.userMessage.id).toBe(first.userMessage.id);expect(repeat.messages).toHaveLength(2);
  expect(await chats.reply(actor(),chat.id,first.userMessage.id,'text','Different retry output')).toEqual(response);
  await expect(chats.begin(actor(),chat.id,{content:'Different objective'},'retry-message')).rejects.toMatchObject({code:'IDEMPOTENCY_KEY_REUSED'});
  expect(await chats.messages(actor(),chat.id)).toHaveLength(2);
 });
 it('keeps one assistant per user and workspace, including concurrent creation and archived reuse',async()=>{
  const values=await Promise.all([chats.create(actor(),{type:'general',title:'Ask'}),chats.create(actor(),{type:'general',title:'Ask again'})]);expect(values[0]!.id).toBe(values[1]!.id);
  await chats.archive(actor(),values[0]!.id);expect(await chats.create(actor(),{type:'general',title:'Ask Alter'})).toMatchObject({id:values[0]!.id,status:'active'});
  const elsewhere=await chats.create(actor({workspace_id:`ws_${otherWorkspace}`}),{type:'general',title:'Ask'});expect(elsewhere.id).not.toBe(values[0]!.id);
  await expect(chats.get(actor({user_id:`usr_${otherUser}`}),values[0]!.id)).rejects.toMatchObject({code:'CHAT_NOT_FOUND'});
 });
 it('stores actual assistant call attribution without creating a workflow run',async()=>{
  const assistant=await chats.create(actor(),{type:'general',title:'Ask'});
  const turn=await chats.begin(actor(),assistant.id,{content:'What failed this week?'});
  await expect(chats.answer(actor(),assistant.id,turn.userMessage.id,{capturedAt:new Date().toISOString(),workflows:[]})).rejects.toThrow('Storage proof must not invoke a model');
  const lookup=new RunWorkspaceLookupService(store),run=`run_${turn.userMessage.id.slice(4)}`,node=`node_${turn.userMessage.id.slice(4)}`;
  expect(await lookup.getRunWorkspace(`ten_${tenant}`,run)).toEqual({workspaceId:workspace,workflowId:''});
  expect(await lookup.getRunWorkspaceResponse(`ten_${tenant}`,run)).toEqual({workspace_id:`ws_${workspace}`,workflow_id:''});
  expect(await lookup.getRecoveryInfo(`ten_${tenant}`,run,node)).toEqual({isRetry:false,isRecovery:false});
  await expect(lookup.getRunWorkspace(`ten_${otherTenant}`,run)).rejects.toThrow('was not found');
  await expect(lookup.getRecoveryInfo(`ten_${tenant}`,run,`node_${uuidV7()}`)).rejects.toThrow('was not found');
  expect((await store.withTenant(tenant,tx=>tx.query('SELECT id FROM runs WHERE tenant_id=$1',[tenant]))).rows).toEqual([]);
  expect((await workflows.listWorkflows(`ten_${tenant}`,`ws_${workspace}`,undefined,20)).data).toEqual([]);
 });
 it('refuses tenant and workspace mismatches and forged message ownership',async()=>{
  const chat=await chats.create(actor(),{type:'workflow_builder',title:'Scope proof'}),assistant=await chats.create(actor(),{type:'general',title:'Ask'});
  await expect(chats.get(actor({workspace_id:`ws_${otherWorkspace}`}),chat.id)).rejects.toMatchObject({code:'CHAT_NOT_FOUND'});
  await expect(chats.get(actor({tenant_id:`ten_${otherTenant}`}),chat.id)).rejects.toMatchObject({code:'CHAT_NOT_FOUND'});
  const msg=await chats.begin(actor(),assistant.id,{content:'Status?'});
  await expect(chats.reply(actor(),chat.id,msg.userMessage.id,'text','Forged reply')).rejects.toMatchObject({code:'CHAT_MESSAGE_NOT_FOUND'});
  const hidden=await store.withTenant(otherTenant,tx=>tx.query('SELECT id FROM conversation_messages'));expect(hidden.rows).toEqual([]);
  await expect(store.withTenant(tenant,tx=>tx.query(`INSERT INTO conversation_messages(id,tenant_id,workspace_id,conversation_id,role,kind,content_json) VALUES($1,$2,$3,$4,'user','text','"wrong scope"')`,[`msg_${uuidV7()}`,tenant,otherWorkspace,chat.id]))).rejects.toMatchObject({code:'23503'});
 });
 it('erases registered chat messages with workspace data and preserves another workspace',async()=>{
  const chat=await chats.create(actor(),{type:'workflow_builder',title:'Erase'}),other=await chats.create(actor({workspace_id:`ws_${otherWorkspace}`}),{type:'workflow_builder',title:'Keep'});
  await chats.begin(actor(),chat.id,{content:'Erase this message'});await chats.begin(actor({workspace_id:`ws_${otherWorkspace}`}),other.id,{content:'Keep this message'});
  const deletion=new OrchestrationDeletionService(store,admin);expect((await deletion.locateSubjectData(`ten_${tenant}`)).find(r=>r.table==='conversation_messages')?.rowCount).toBe(2);
  await deletion.deleteWorkspaceData(`ten_${tenant}`,`ws_${workspace}`,`del_${uuidV7()}`);
  await expect(chats.get(actor(),chat.id)).rejects.toMatchObject({code:'CHAT_NOT_FOUND'});expect((await chats.messages(actor({workspace_id:`ws_${otherWorkspace}`}),other.id)).map(m=>m.content)).toEqual(['Keep this message']);
 });
 it('uses real signed machine/actor tokens and replay protection at the engine HTTP boundary',async()=>{
  const redis=await new RedisContainer('redis:7.4.2-alpine').start();
  const pair=generateKeyPairSync('rsa',{modulusLength:2048});
  const registryToken=randomBytes(24).toString('hex');
  let registerModel:((address:string)=>void)|undefined;
  const jwk={...pair.publicKey.export({format:'jwk'}),kid:'chat-native',alg:'RS256',use:'sig'};
  const issuer=createServer(async(request,response)=>{
    if(request.url==='/native/model-gateway'){
      if(request.method!=='POST'||request.headers.authorization!==`Bearer ${registryToken}`||!registerModel){response.statusCode=401;response.end();return;}
      const chunks=[];for await(const chunk of request)chunks.push(chunk);
      const input=JSON.parse(Buffer.concat(chunks).toString()) as {address:string};
      if(!/^127\.0\.0\.1:\d+$/.test(input.address)){response.statusCode=400;response.end();return;}
      registerModel(input.address);response.end('{}');return;
    }
    response.setHeader('content-type','application/json');response.end(JSON.stringify({keys:[jwk]}));
  });
  await new Promise<void>(done=>issuer.listen(0,'127.0.0.1',done));
  const jwksUrl=`http://127.0.0.1:${(issuer.address() as {port:number}).port}/jwks`;
  const uri=new URL(postgres.getConnectionUri());uri.username=role;uri.password='chat-fixture-only';
  const config={NODE_ENV:'test',AUTH0_DOMAIN:'chat.test',AUTH0_API_AUDIENCE:'alter-engine',AUTH0_JWKS_URL:jwksUrl,
    ACTOR_TOKEN_ISSUER:'alter-platform-api.identity-broker',ACTOR_TOKEN_AUDIENCE:'alter-engine',ACTOR_TOKEN_JWKS_URL:jwksUrl,
    REDIS_ENDPOINT:redis.getConnectionUrl(),AWS_REGION:'ap-south-1',ALTER_ARTIFACTS_BUCKET_PARAM:'/fixture/artifacts',
    ORCHESTRATION_DATABASE_AUTHENTICATION:'static',ORCHESTRATION_DATABASE_URL:uri.href};
  for(const[name,value]of Object.entries(config))vi.stubEnv(name,value);
  let app:NestFastifyApplication|undefined,guardStore:PostgresOrchestrationStoreProvider|undefined;
  try {
    guardStore=orchestrationStore(identityTenantGatewayEnvironment(process.env));
    const lookup=new RunWorkspaceLookupService(store);
    const module=await Test.createTestingModule({imports:[SecurityModule],controllers:[WorkflowChatController,WorkflowReadController,CompilerGrpcController,ConnectionRegistryController,RunsGrpcController,RunsController,NodeExecutionsController,RunObservabilityController],providers:[
      {provide:WorkflowChatService,useValue:chats},{provide:WorkflowReadService,useValue:workflows},
      {provide:RunLauncherService,useValue:new RunLauncherService(store,createMockDurableExecutionProvider())},
      {provide:RunOutcomeService,useValue:new RunOutcomeService(store)},
      {provide:RunEstimateService,useValue:{estimate:async()=>{throw Error('Assistant must not request execution');}}},
      {provide:NodeExecutionLedgerService,useValue:new NodeExecutionLedgerService(store)},
      {provide:RunObservabilityService,useValue:new RunObservabilityService(store)},
      {provide:COMPILER_HANDLER,useValue:new GraphCompilerService(store)},
      {provide:ConnectionRegistryService,useValue:new ConnectionRegistryService(store)},
      {provide:CONNECTION_REGISTRY_TOKEN_HASH,useValue:createHash('sha256').update(registryToken).digest('hex')},
      {provide:CONNECTION_LOOKUP_TOKEN_HASH,useValue:createHash('sha256').update(randomBytes(24)).digest('hex')},
      {provide:RUNS_HANDLER,useValue:{getRunWorkspace:(request:{tenant_id:string;run_id:string})=>lookup.getRunWorkspaceResponse(request.tenant_id,request.run_id),
        getNodeExecutionRecoveryInfo:async(request:{tenant_id:string;run_id:string;node_execution_id:string})=>{const result=await lookup.getRecoveryInfo(request.tenant_id,request.run_id,request.node_execution_id);return {is_retry:result.isRetry,is_recovery:result.isRecovery};}}},
    ]}).compile();
    app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    const port=await new Promise<number>((done,reject)=>{const server=createNetServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string')return reject(Error('No compiler port'));server.close(error=>error?reject(error):done(address.port));});});
    connectCompilerGrpcTransport(app,{bindAddress:`127.0.0.1:${port}`,protoPath:resolve('packages/contracts/proto/alter/compiler/v1/compiler.proto')});
    const runsPort=await new Promise<number>((done,reject)=>{const server=createNetServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string')return reject(Error('No run lookup port'));server.close(error=>error?reject(error):done(address.port));});});
    connectRunsGrpcTransport(app,{bindAddress:`127.0.0.1:${runsPort}`,protoPath:resolve('packages/contracts/proto/alter/runs/v1/runs.proto')});
    await app.listen(0,'127.0.0.1');await app.startAllMicroservices();
    const jwt=(claims:Record<string,unknown>)=>{const value=[{alg:'RS256',kid:jwk.kid},claims].map(part=>Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');return `${value}.${sign('RSA-SHA256',Buffer.from(value),pair.privateKey).toString('base64url')}`;};
    registerModel=address=>{modelGateway=new ModelGatewayClient({address,protoPath:resolve('packages/contracts/proto/alter/modelgw/v1/modelgw.proto'),accessTokenProvider:{getAccessToken:async()=>{const now=Math.floor(Date.now()/1000);return jwt({iss:'https://chat.test/',aud:'alter-engine',iat:now,exp:now+60});}}});};
    const headers=(overrides:Record<string,unknown>={})=>{
      const now=Math.floor(Date.now()/1000);
      return {'content-type':'application/json',authorization:`Bearer ${jwt({iss:'https://chat.test/',aud:'alter-engine',iat:now,exp:now+60})}`,
        'x-alter-actor-token':jwt({user_id:`usr_${user}`,tenant_id:`ten_${tenant}`,workspace_id:`ws_${workspace}`,roles:['admin'],permissions:[],session_id:'chat-native',auth_time:now,jti:uuidV7(),iss:'alter-platform-api.identity-broker',aud:'alter-engine',iat:now,exp:now+60,...overrides})};
    };
    const url=(await app.getUrl())+'/api/v1/conversations';
    expect((await fetch(url)).status).toBe(401);
    const created=await fetch(url,{method:'POST',headers:headers(),body:JSON.stringify({type:'workflow_builder',title:'HTTP chat'})});
    expect(created.status).toBe(201);const chat=await created.json() as {id:string;linkedWorkflowId:string};
    const reused=headers();expect((await fetch(url+'/'+chat.id,{headers:reused})).status).toBe(200);
    expect((await fetch(url+'/'+chat.id,{headers:reused})).status).toBe(401);
    expect((await fetch(url+'/'+chat.id,{headers:headers({workspace_id:`ws_${otherWorkspace}`})})).status).toBe(404);
    expect((await fetch(url+'/'+chat.id,{headers:headers({tenant_id:`ten_${otherTenant}`})})).status).toBe(404);
    const sent=await fetch(url+'/'+chat.id+'/messages',{method:'POST',headers:headers(),body:JSON.stringify({content:'Keep the real objective'})});
    expect(sent.status).toBe(201);expect(await sent.json()).toMatchObject({userMessage:{content:'Keep the real objective'}});
    const messages=await fetch(url+'/'+chat.id+'/messages',{headers:headers()});expect(await messages.json()).toHaveLength(1);
    const directory=await mkdtemp(resolve(tmpdir(),'alter-chat-bridge-')),reportPath=resolve(directory,'report.json');
    const privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'}).toString();
    try {
      await promisify(execFile)(process.execPath,[resolve('node_modules/vitest/vitest.mjs'),'run','apps/platform-api/src/workflow-chat/platform-workflow-chat.integration.spec.ts','--maxWorkers=1','--reporter=json',`--outputFile=${reportPath}`],{
        env:{...process.env,WORKFLOW_CHAT_NATIVE_BRIDGE:JSON.stringify({baseUrl:await app.getUrl(),compilerAddress:`127.0.0.1:${port}`,tenant,workspace,user,privateKey,registryToken})},timeout:120000,maxBuffer:4*1024*1024,
      }).catch(async(error:unknown)=>{
        const output=error as {stdout?:string;stderr?:string};
        const report=JSON.parse(await readFile(reportPath,'utf8').catch(()=>'{}')) as {testResults?:{message?:string;assertionResults?:{failureMessages?:string[]}[]}[]};
        const failures=report.testResults?.flatMap(file=>[file.message??'',...(file.assertionResults??[]).flatMap(test=>test.failureMessages??[])]).join('\n')??'';
        const detail=`${output.stdout??''}\n${output.stderr??''}\n${failures}`.replaceAll(privateKey,'[fixture key]').replaceAll(registryToken,'[fixture token]');
        console.error(detail.replace(/\u001b\[[0-9;]*m/g,'').split('\n').filter(line=>/FAIL|Error:|expected|received|Expected|Received|❯/.test(line)).slice(-20).join('\n'));throw error;
      });
      const report=JSON.parse(await readFile(reportPath,'utf8')) as {success:boolean;numFailedTests:number;numPendingTests:number;testResults:{assertionResults:{title:string;status:string}[]}[]};
      expect(report.success).toBe(true);expect(report.numFailedTests).toBe(0);expect(report.numPendingTests).toBe(0);
      const native=report.testResults.flatMap(file=>file.assertionResults).filter(test=>test.title==='retains chat context through native planner HTTP and compiler gRPC');
      expect(native).toHaveLength(1);expect(native[0]!.status).toBe('passed');
      const observed={workflowId:`wf_${uuidV7()}`,runId:`run_${uuidV7()}`,nodeId:`node_${uuidV7()}`,foreignWorkflowId:`wf_${uuidV7()}`,foreignRunId:`run_${uuidV7()}`,oldRunId:`run_${uuidV7()}`};
      await store.withTenant(tenant,async tx=>{
        await tx.query("INSERT INTO workflows(id,tenant_id,workspace_id,name) VALUES($1,$2,$3,'Recent invoice checks'),($4,$2,$5,'Foreign workspace sentinel')",[observed.workflowId,tenant,workspace,observed.foreignWorkflowId,otherWorkspace]);
        for(const[run,wf,ws,date]of [[observed.runId,observed.workflowId,workspace,new Date(Date.now()-60000).toISOString()],
          [observed.foreignRunId,observed.foreignWorkflowId,otherWorkspace,new Date().toISOString()],
          [observed.oldRunId,observed.workflowId,workspace,new Date(Date.now()-8*86400000).toISOString()]])
          await tx.query("INSERT INTO runs(id,tenant_id,workspace_id,parent_kind,workflow_id,status,created_at) VALUES($1,$2,$3,'workflow',$4,'failed',$5)",[run,tenant,ws,wf,date]);
        await tx.query("INSERT INTO node_executions(id,tenant_id,run_id,dag_node_id,node_type,status,error) VALUES($1,$2,$3,'invoice-check','tool','failed',$4)",[observed.nodeId,tenant,observed.runId,{error_code:'TOOL_CALL_VALIDATION_FAILED',detail:'Invoice fields are missing'}]);
        await tx.query("INSERT INTO verification_results(id,tenant_id,run_id,node_execution_id,gate_type,verdict,details) VALUES($1,$2,$3,$4,'mechanical','fail',$5)",[`ver_${uuidV7()}`,tenant,observed.runId,observed.nodeId,{reason:'Invoice total did not match'}]);
        await tx.query("INSERT INTO recovery_actions(id,tenant_id,run_id,node_execution_id,failure_class,strategy,policy_version,outcome) VALUES($1,$2,$3,$4,'logic_output_failure','terminate','native','failed')",[`rec_${uuidV7()}`,tenant,observed.runId,observed.nodeId]);
        await tx.query("INSERT INTO run_outcomes(id,tenant_id,workspace_id,run_id,mode,eligible,verdict,human_rescue,critical_external_error,decided_at) VALUES($1,$2,$3,$4,'workflow',true,'failed',false,false,now())",[uuidV7(),tenant,workspace,observed.runId]);
      });
      const modelReportPath=resolve(directory,'model-report.json');
      await promisify(execFile)(process.execPath,[resolve('node_modules/vitest/vitest.mjs'),'run','apps/model-gateway/src/gateway/workflow-chat-native.integration.spec.ts','--maxWorkers=1','--reporter=json',`--outputFile=${modelReportPath}`],{
        env:{...process.env,WORKFLOW_CHAT_NATIVE_ASSISTANT:JSON.stringify({baseUrl:await app.getUrl(),controlUrl:`http://127.0.0.1:${(issuer.address() as {port:number}).port}/native/model-gateway`,runsAddress:`127.0.0.1:${runsPort}`,tenant,workspace,user,privateKey,registryToken,directory,observed})},timeout:180000,maxBuffer:4*1024*1024,
      }).catch(async(error:unknown)=>{
        const report=JSON.parse(await readFile(modelReportPath,'utf8').catch(()=>'{}')) as {testResults?:{message?:string;assertionResults?:{failureMessages?:string[]}[]}[]};
        const detail=report.testResults?.flatMap(file=>[file.message??'',...(file.assertionResults??[]).flatMap(test=>test.failureMessages??[])]).join('\n')??'';
        console.error(detail.replaceAll(privateKey,'[fixture key]').replaceAll(registryToken,'[fixture token]').replace(/Bearer [A-Za-z0-9._-]+/g,'Bearer [fixture token]').replace(/\u001b\[[0-9;]*m/g,'').split('\n').slice(-50).join('\n'));throw error;
      });
      const modelReport=JSON.parse(await readFile(modelReportPath,'utf8')) as {success:boolean;numFailedTests:number;numPendingTests:number;testResults:{assertionResults:{title:string;status:string}[]}[]};
      expect(modelReport.success).toBe(true);expect(modelReport.numFailedTests).toBe(0);expect(modelReport.numPendingTests).toBe(0);
      const nativeModel=modelReport.testResults.flatMap(file=>file.assertionResults).filter(test=>test.title==='answers through the authenticated Model Gateway and persists actual workspace cost');
      expect(nativeModel).toHaveLength(1);expect(nativeModel[0]!.status).toBe('passed');
    } finally {await rm(directory,{recursive:true,force:true});}
    expect((await fetch(url+'/'+chat.id+'/archive',{method:'POST',headers:headers(),body:'{}'})).status).toBe(201);
    expect((await workflows.getWorkflow(`ten_${tenant}`,chat.linkedWorkflowId)).status).toBe('draft');
  } finally {modelGateway=undefined;await app?.close();await guardStore?.close();vi.unstubAllEnvs();await new Promise<void>(done=>issuer.close(()=>done()));await redis.stop();}
 },240000);
 it('executes the paired migration rollback and reapplies the native storage schema',async()=>{
  await admin.withTenant(tenant,tx=>tx.query(readFileSync(resolve(migrationsFolder,'rollback/0051_restore_workflow_chat.sql'),'utf8')));
  const absent=await admin.withTenant(tenant,tx=>tx.query<{table_name:string|null}>("SELECT to_regclass('public.conversation_messages')::text AS table_name"));
  expect(absent.rows[0]!.table_name).toBeNull();
  await admin.withTenant(tenant,async tx=>{await tx.query(readFileSync(resolve(migrationsFolder,'0051_workflow_chat.sql'),'utf8'));await tx.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);await tx.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);});
  const restored=await chats.create(actor(),{type:'workflow_builder',title:'Restored migration'});expect((await chats.begin(actor(),restored.id,{content:'Persist after rollback'})).userMessage.content).toBe('Persist after rollback');
 });
});
