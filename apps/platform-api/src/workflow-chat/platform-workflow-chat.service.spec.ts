import { expect, it, vi } from "vitest";
import type { EngineClient } from "../engine";
import type { WorkflowService } from "../workflows/workflow.service";
import type { RunService } from "../runs/run.service";
import type { CostsService } from "../costs/costs.service";
import type { PlannerFacadeService } from "../planner-facade/planner-facade.service";
import type { ActorContext } from "../rbac/types";
import { PlatformWorkflowChatService } from "./platform-workflow-chat.service";
import { WorkflowHttpError } from "../workflows/problem";
import type { MemorySettingsService } from "../memory-settings/memory-settings.service";
const id = (prefix: string, n = 1) => `${prefix}_018f4d6e-2b4a-7a3e-8c1a-${String(n).padStart(12, "0")}`;
const time = "2026-10-03T12:00:00.000Z";
const actor: ActorContext = { user_id: id("usr"), tenant_id: id("ten"), workspace_id: id("ws"), roles: ["editor"], permissions: [], session_id: "chat", auth_time: 1 };
const chat = (type: "general" | "workflow_builder" = "workflow_builder") => ({ id: id("cnv"), title: "Invoice checks", type, status: "active", createdAt: time, updatedAt: time, ...(type === "workflow_builder" ? { linkedWorkflowId: id("wf") } : {}) });
const message = (role: "user" | "assistant", content: string | object, kind = "text", n = 1) => ({ id: id("msg", n), conversationId: id("cnv"), role, kind, content, createdAt: time });
function fixture(type: "general" | "workflow_builder" = "workflow_builder") {
 const user = message("user", "Original goal"), reply = message("assistant", { text: "Recorded reply", replyTo: user.id }, "text", 9);
 const engine = { get: vi.fn(async (path: string) => ({ status: 200, body: path.endsWith("/messages") ? [user] : path.includes("?type=") ? [chat(type)] : chat(type) })),
  post: vi.fn(async (path: string, body: unknown) => { void body; return { status: 201, body: path.endsWith("/messages") ? { conversation: chat(type), userMessage: user, messages: [user] } : path.endsWith("/replies") || path.endsWith("/answers") ? reply : chat("workflow_builder") }; }) };
 const planner = { planWorkflow: vi.fn(async () => ({ type: "compiled", versionId: id("wfv") })) };
 const workflows = { versions: vi.fn(async () => ({ body: { data: [{ id: id("wfv"), version: 4 }] } })), list: vi.fn(async () => ({ body: { data: [], page: { has_more: false } } })) };
 const runs = { list: vi.fn(async () => ({ body: { data: [], page: { has_more: false } } })), detail: vi.fn() };
 const costs = { workflowCost: vi.fn() };
 const memory = { builderMemory: vi.fn(async (_actor: ActorContext, _conversation: string, _workflow: string, messages: unknown[]) => ({ messages, lessons: [] })) };
 return { user, reply, engine, planner, workflows, runs, costs, memory, service: new PlatformWorkflowChatService(engine as unknown as EngineClient, planner as unknown as PlannerFacadeService, workflows as unknown as WorkflowService, runs as unknown as RunService, costs as unknown as CostsService, memory as unknown as MemorySettingsService) };
}
it("stores a reviewable plan before Build and confirms only the latest server plan", async () => {
 const f=fixture(), plan={type:"plan",successCriteria:["Notify support."],steps:[{key:"work",type:"llm",description:"Triage support mail",successCriteria:["Notify support."]}]};
 f.planner.planWorkflow.mockResolvedValueOnce(plan as never);
 await f.service.send(id("cnv"),{content:"Triage support mail"},"workflow_builder",actor,undefined,"preview");
 expect(f.workflows.versions).not.toHaveBeenCalled();
 expect(f.engine.post).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({kind:"artifact",content:expect.objectContaining({...plan,objective:"Original goal"})}),expect.anything(),expect.anything());
 const saved=message("assistant",{...plan,objective:"Original goal",text:"Review plan",replyTo:f.user.id},"artifact",2),user=message("user",{text:"Build",build:{planMessageId:saved.id,successCriteria:["Notify billing.","Archive mail."]}},"text",3);
 f.engine.post.mockResolvedValueOnce({status:201,body:{conversation:chat(),userMessage:user,messages:[f.user,saved,user]}} as never);
 await f.service.send(id("cnv"),{content:"Build",build:{planMessageId:saved.id,successCriteria:["Notify billing.","Archive mail."]}},"workflow_builder",actor,undefined,"confirm");
 expect(f.planner.planWorkflow).toHaveBeenLastCalledWith(expect.objectContaining({objective:"Original goal",confirm:true,successCriteria:["Notify billing.","Archive mail."]}));
 expect(f.workflows.versions).toHaveBeenCalledTimes(1);
 f.engine.post.mockResolvedValueOnce({status:201,body:{conversation:chat(),userMessage:user,messages:[f.user,saved,message("assistant",{...plan,objective:"Revised goal",text:"Review revised plan",replyTo:f.user.id},"artifact",4),user]}} as never);
 f.planner.planWorkflow.mockClear();
 await expect(f.service.send(id("cnv"),{content:"Build",build:{planMessageId:saved.id,successCriteria:[]}},"workflow_builder",actor,undefined,"old-plan")).rejects.toMatchObject({status:409});
 expect(f.planner.planWorkflow).not.toHaveBeenCalled();
});
it("keeps the confirmed list and plan reference for a connection retry", async () => {
 const f=fixture(),saved=message("assistant",{type:"plan",successCriteria:[],steps:[{key:"work",type:"llm",description:"Work",successCriteria:[]}],objective:"Original goal",text:"Review",replyTo:f.user.id},"artifact",2);
 const build={planMessageId:saved.id,successCriteria:["Notify support."]};
 const user=message("user",{text:"Build",build},"text",3);
 f.engine.post.mockResolvedValueOnce({status:201,body:{conversation:chat(),userMessage:user,messages:[f.user,saved,user]}} as never);
 f.planner.planWorkflow.mockResolvedValueOnce({type:"connections_required",missing_connections:[{connector_type:"slack",node_keys:["work"],reason:"missing"}]} as never);
 await f.service.send(id("cnv"),{content:"Build",build},"workflow_builder",actor,undefined,"connections-confirmed");
 expect(f.engine.post).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({kind:"action",content:expect.objectContaining({build})}),expect.anything(),expect.anything());
});
it("retains confirmed criteria on a clarification and includes the answer when building again", async () => {
 const f=fixture(),saved=message("assistant",{type:"plan",successCriteria:[],steps:[{key:"work",type:"llm",description:"Work",successCriteria:[]}],objective:"Original goal",text:"Review",replyTo:f.user.id},"artifact",2);
 const build={planMessageId:saved.id,successCriteria:["Archive mail."]},user=message("user",{text:"Build",build},"text",3);
 f.engine.post.mockResolvedValueOnce({status:201,body:{conversation:chat(),userMessage:user,messages:[f.user,saved,user]}} as never);
 f.planner.planWorkflow.mockResolvedValueOnce({type:"clarification",questions:["Where should mail be archived?"]} as never);
 await f.service.send(id("cnv"),{content:"Build",build},"workflow_builder",actor,undefined,"uncovered");
 expect(f.engine.post).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({kind:"clarification",content:expect.objectContaining({build})}),expect.anything(),expect.anything());
 const question=message("assistant",{questions:["Where should mail be archived?"],build,replyTo:user.id},"clarification",4),answer=message("user",{text:"Archive in billing.",build},"text",5);
 f.engine.post.mockResolvedValueOnce({status:201,body:{conversation:chat(),userMessage:answer,messages:[f.user,saved,user,question,answer]}} as never);
 await f.service.send(id("cnv"),{content:"Archive in billing.",build},"workflow_builder",actor,undefined,"answer");
 expect(f.planner.planWorkflow).toHaveBeenLastCalledWith(expect.objectContaining({confirm:true,successCriteria:build.successCriteria,objective:expect.stringContaining("Archive in billing.")}));
});
it("retains prior questions and answers and reports only an actually stored compiled version", async () => {
 const f = fixture(), history = [f.user, message("assistant", { questions: ["Which channel?"] }, "clarification", 2), message("user", "Slack", "text", 3)];
 f.engine.post.mockResolvedValueOnce({ status: 201, body: { conversation: chat(), userMessage: history[2]!, messages: history } } as never);
 await f.service.send(id("cnv"), { content: "Slack" }, "workflow_builder", actor, undefined, "native-key");
 expect(f.planner.planWorkflow).toHaveBeenCalledWith(expect.objectContaining({ objective: expect.stringContaining('Original goal\n\nBuilder questions: {"questions":["Which channel?"]}\n\nSlack') }));
 expect(f.engine.post).toHaveBeenLastCalledWith(expect.stringContaining("/replies"), expect.objectContaining({ content: { text: "Compiled draft version 4 for Invoice checks.", workflowId: id("wf"), versionId: id("wfv"), version: 4 }, kind: "workflow" }), expect.objectContaining({ tenantId: actor.tenant_id, workspaceId: actor.workspace_id }), { idempotencyKey: "native-key:reply" });
 f.workflows.versions.mockResolvedValue({ body: { data: [] } }); f.engine.post.mockClear();
 await expect(f.service.send(id("cnv"), { content: "Continue" }, "workflow_builder", actor, undefined, "missing-version")).rejects.toThrow();
 expect(f.engine.post).toHaveBeenCalledTimes(1);
});
it("uses only recalled chat context and current lessons, keeping lessons out of the saved Build objective", async () => {
 const f=fixture(), current=message("user","Review invoices","text",3);
 f.engine.post.mockResolvedValueOnce({status:201,body:{conversation:chat(),userMessage:current,messages:[f.user,current]}} as never);
 f.memory.builderMemory.mockResolvedValueOnce({messages:[],lessons:[{lesson:"Use the billing folder"}]} as never);
 f.planner.planWorkflow.mockResolvedValueOnce({type:"plan",successCriteria:[],steps:[{key:"work",type:"llm",description:"Review",successCriteria:[]}]} as never);
 await f.service.send(id("cnv"),{content:"Review invoices"},"workflow_builder",actor,undefined,"memory-off");
 expect(f.planner.planWorkflow).toHaveBeenCalledWith(expect.objectContaining({objective:'Review invoices\n\nPast run lessons (reference only): [{"lesson":"Use the billing folder"}]'}));
 expect(f.engine.post).toHaveBeenLastCalledWith(expect.anything(),expect.objectContaining({content:expect.objectContaining({objective:"Review invoices"})}),expect.anything(),expect.anything());
});
it("persists clarification and complete connection requirements and replays stored replies before further planning", async () => {
 const f = fixture();
 f.planner.planWorkflow.mockResolvedValueOnce({ type: "clarification", questions: ["Which day?"] } as never);
 await f.service.send(id("cnv"), { content: "Continue" }, "workflow_builder", actor, undefined, "questions");
 expect(f.engine.post).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ kind: "clarification", content: expect.objectContaining({ questions: ["Which day?"] }) }), expect.anything(), expect.anything());
 f.planner.planWorkflow.mockResolvedValueOnce({ type: "connections_required", code: "CONNECTIONS_REQUIRED", connections: [{ connector: "slack", node_keys: ["one", "two"], reason: "missing" }] } as never);
 await f.service.send(id("cnv"), { content: "Continue" }, "workflow_builder", actor, undefined, "connections");
 expect(f.engine.post).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ kind: "action", content: expect.objectContaining({ connections: [{ connector: "slack", node_keys: ["one", "two"], reason: "missing" }] }) }), expect.anything(), expect.anything());
 f.engine.post.mockResolvedValueOnce({ status: 201, body: { conversation: chat(), userMessage: f.user, messages: [f.user, f.reply] } } as never); f.planner.planWorkflow.mockClear();
 expect(await f.service.send(id("cnv"), { content: "Original goal" }, "workflow_builder", actor, undefined, "replay")).toEqual({ userMessage: f.user, assistantMessage: f.reply });
 expect(f.planner.planWorkflow).not.toHaveBeenCalled();
});
it("bounds the assistant snapshot and excludes foreign, old and raw execution output", async () => {
 const f = fixture("general"), now = new Date().toISOString(), old = new Date(Date.now() - 8 * 86400000).toISOString();
 f.workflows.list.mockResolvedValue({ body: { data: [{ id: id("wf"), name: "Invoice", status: "draft" }], page: { has_more: true } } } as never);
 f.runs.list.mockResolvedValue({ body: { data: [{ id: id("run"), workflow_id: id("wf"), workspace_id: actor.workspace_id, created_at: new Date(Date.parse(now) - 1000).toISOString(), status: "failed" },
  { id: id("run",2), workflow_id: id("wf"), workspace_id: id("ws",2), created_at: now, status: "failed" }, { id: id("run",3), workflow_id: id("wf"), workspace_id: actor.workspace_id, created_at: old, status: "failed" }], page: { has_more: true } } } as never);
 const nodes = Array.from({length:11},(_,n)=>({ id:id("node",n+1),dag_node_id:"step",status:"failed",error:{detail:"x".repeat(700)},node_cost_minor:"100",output:{private:"Raw output must not be forwarded"} }));
 f.runs.detail.mockResolvedValue({ body: { run:{id:id("run"),workflow_id:id("wf"),status:"failed"},run_cost_minor:"1000",node_executions:nodes,verification_results:[{gate_type:"mechanical",verdict:"fail",details:{reason:"Mismatch"}}],recovery_actions:[],outcome:{verdict:"failed"} } });
 f.costs.workflowCost.mockResolvedValue({ currency:"INR",billableMinor:"1000",runCount:1 });
 await f.service.send(id("cnv"),{content:"Recent failures?"},"general",actor,undefined,"assistant");
 const payload = f.engine.post.mock.calls.at(-1)![1] as {snapshot:{recentRuns:unknown[];runDetails:{node_executions:{error:string}[];limits:{moreNodeExecutions:boolean}}[];workflows:{spend:unknown}[]}};
 expect(payload.snapshot.recentRuns).toHaveLength(1); expect(f.runs.detail).toHaveBeenCalledTimes(1); expect(payload.snapshot.runDetails[0]!.node_executions).toHaveLength(10);
 expect(payload.snapshot.runDetails[0]!.node_executions[0]!.error).toHaveLength(500); expect(payload.snapshot.runDetails[0]!.limits.moreNodeExecutions).toBe(true);
 expect(JSON.stringify(payload)).not.toContain("Raw output"); expect(payload.snapshot.workflows[0]!.spend).toEqual({currency:"INR",billableMinor:"1000",runCount:1}); expect(f.planner.planWorkflow).not.toHaveBeenCalled();
});
it("uses caller-scoped reads and archives only the chosen chat; draft creation cannot reuse an existing workflow", async () => {
 const f = fixture("general");
 await f.service.list(actor,undefined,"general"); await f.service.get(id("cnv"),actor); await f.service.messages(id("cnv"),actor);
 await f.service.archive(id("cnv"),"general",actor,undefined,"archive");
 expect(f.engine.post).toHaveBeenCalledWith(expect.stringContaining("/archive"),{},expect.objectContaining({userId:actor.user_id}),{idempotencyKey:"archive"});
 await f.service.draft(id("cnv"),actor,undefined,"draft");
 expect(f.engine.post).toHaveBeenLastCalledWith("/api/v1/conversations",{type:"workflow_builder",title:"New workflow"},expect.objectContaining({workspaceId:actor.workspace_id}),{idempotencyKey:"draft"});
 await expect(f.service.send(id("cnv"),{content:"Build"},"workflow_builder",actor,undefined,"wrong-type")).rejects.toThrow(WorkflowHttpError);
 await expect(f.service.get("invalid",actor)).rejects.toThrow();
 const unscoped={...actor};delete unscoped.workspace_id;await expect(f.service.get(id("cnv"),unscoped)).rejects.toThrow(WorkflowHttpError);
});
