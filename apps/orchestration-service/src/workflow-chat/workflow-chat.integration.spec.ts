import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { PostgresOrchestrationStoreProvider } from "@alterx/adapters";
import type { ActorContext } from "@alterx/auth";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowReadService } from "../workflow-read/workflow-read.service";
import { OrchestrationDeletionService } from "../deletion/deletion.service";
import { uuidV7 } from "../trigger-bindings/ids";
import { WorkflowChatService } from "./workflow-chat.service";
import { WorkflowChatController } from "./workflow-chat.controller";
import { SecurityModule } from "../security.module";
import { identityTenantGatewayEnvironment, orchestrationStore } from "../orchestration-infrastructure.module";

const tenant=uuidV7(),otherTenant=uuidV7(),workspace=uuidV7(),otherWorkspace=uuidV7(),user=uuidV7(),otherUser=uuidV7();
const actor=(overrides:Partial<ActorContext>={}):ActorContext=>({actor_type:'user',tenant_id:`ten_${tenant}`,workspace_id:`ws_${workspace}`,user_id:`usr_${user}`,roles:['admin'],permissions:[],session_id:'session-fixture',jti:'chat-fixture',...overrides});
const migrationsFolder=resolve('apps/orchestration-service/drizzle');

describe.sequential('Workflow chats on restricted PostgreSQL',()=>{
 let postgres:StartedPostgreSqlContainer,admin:PostgresOrchestrationStoreProvider,store:PostgresOrchestrationStoreProvider,chats:WorkflowChatService,workflows:WorkflowReadService;
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
  chats=new WorkflowChatService(store,{invoke:async()=>{throw Error('Storage proof must not invoke a model');}});workflows=new WorkflowReadService(store);
 },120000);
 beforeEach(async()=>{
  for(const id of [tenant,otherTenant])await admin.withTenant(id,async tx=>{await tx.query('DELETE FROM conversation_messages WHERE tenant_id=$1',[id]);await tx.query('DELETE FROM conversations WHERE tenant_id=$1',[id]);await tx.query('DELETE FROM workflows WHERE tenant_id=$1',[id]);});
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
 it('keeps one assistant per user and workspace, including concurrent creation and archived reuse',async()=>{
  const values=await Promise.all([chats.create(actor(),{type:'general',title:'Ask'}),chats.create(actor(),{type:'general',title:'Ask again'})]);expect(values[0]!.id).toBe(values[1]!.id);
  await chats.archive(actor(),values[0]!.id);expect(await chats.create(actor(),{type:'general',title:'Ask Alter'})).toMatchObject({id:values[0]!.id,status:'active'});
  const elsewhere=await chats.create(actor({workspace_id:`ws_${otherWorkspace}`}),{type:'general',title:'Ask'});expect(elsewhere.id).not.toBe(values[0]!.id);
  await expect(chats.get(actor({user_id:`usr_${otherUser}`}),values[0]!.id)).rejects.toMatchObject({code:'CHAT_NOT_FOUND'});
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
  const jwk={...pair.publicKey.export({format:'jwk'}),kid:'chat-native',alg:'RS256',use:'sig'};
  const issuer=createServer((_request,response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({keys:[jwk]}));});
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
    const module=await Test.createTestingModule({imports:[SecurityModule],controllers:[WorkflowChatController],providers:[{provide:WorkflowChatService,useValue:chats}]}).compile();
    app=module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());await app.listen(0,'127.0.0.1');
    const jwt=(claims:Record<string,unknown>)=>{const value=[{alg:'RS256',kid:jwk.kid},claims].map(part=>Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');return `${value}.${sign('RSA-SHA256',Buffer.from(value),pair.privateKey).toString('base64url')}`;};
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
    expect((await fetch(url+'/'+chat.id+'/archive',{method:'POST',headers:headers(),body:'{}'})).status).toBe(201);
    expect((await workflows.getWorkflow(`ten_${tenant}`,chat.linkedWorkflowId)).status).toBe('draft');
  } finally {await app?.close();await guardStore?.close();vi.unstubAllEnvs();await new Promise<void>(done=>issuer.close(()=>done()));await redis.stop();}
 },120000);
 it('executes the paired migration rollback and reapplies the native storage schema',async()=>{
  await admin.withTenant(tenant,tx=>tx.query(readFileSync(resolve(migrationsFolder,'rollback/0051_restore_workflow_chat.sql'),'utf8')));
  const absent=await admin.withTenant(tenant,tx=>tx.query<{table_name:string|null}>("SELECT to_regclass('public.conversation_messages')::text AS table_name"));
  expect(absent.rows[0]!.table_name).toBeNull();
  await admin.withTenant(tenant,async tx=>{await tx.query(readFileSync(resolve(migrationsFolder,'0051_workflow_chat.sql'),'utf8'));await tx.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);await tx.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);});
  const restored=await chats.create(actor(),{type:'workflow_builder',title:'Restored migration'});expect((await chats.begin(actor(),restored.id,{content:'Persist after rollback'})).userMessage.content).toBe('Persist after rollback');
 });
});
