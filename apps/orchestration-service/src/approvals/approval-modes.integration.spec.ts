import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  createExecutorActivities,
  PostgresOrchestrationStoreProvider,
  type BlackboardHandlerClient,
} from "@alterx/adapters";
import { createExecutorTestHarness, type ExecutorTestHarness } from "@alterx/adapters/testing";
import { createMockAuditEventHandler, type MockAuditEventHandler } from "@alterx/shared-clients";
import { CompiledDagSchema, applyNodeOverride, type CompiledDag, type NodeType } from "@alterx/contracts";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { compileArchitectureToDag } from "../compiler/architecture-dag-builder";
import type { NodeExecutionResult, NodeHandler } from "../registry/handler";
import { HumanApprovalHandler } from "../registry/handlers/human-approval.handler";
import { GateHandler } from "../registry/handlers/gate.handler";
import { MergeHandler } from "../registry/handlers/merge.handler";
import { NodeHandlerRegistry } from "../registry/node-handler-registry";
import { NodeexecService } from "../registry/nodeexec.service";
import { NodeExecutionLedgerService } from "../runs/node-execution-ledger.service";
import { RunStreamEventService } from "../runs/run-stream-event.service";
import { ApprovalPolicyConfirmationRequiredError, ApprovalPolicyService, ApprovalPolicyStaleError, type SetApprovalStepPolicyInput, PROMOTION_SUGGESTION_THRESHOLD } from "./approval-policy.service";
import { ApprovalsService } from "./approvals.service";

/**
 * D5 approval modes on a real Temporal executor and real Postgres: "Always go
 * ahead" approves by policy without waiting, side-effect steps need the named
 * consequence confirmed, skip-on-timeout continues and flags the run, and ten
 * approvals in a row suggest a promotion that is never applied by itself.
 *
 * (Shared fixture notes from the approval-route spec follow.)
 *
 * A compiled plan with an approval gate before an external action runs on a
 * real Temporal executor and pauses. The decision then arrives the way it does
 * in production: an HTTP POST carrying an M2M token and a platform-api actor
 * token through the real SessionGatewayGuard, into ApprovalsService, which
 * signals the waiting workflow through the production Temporal provider.
 * Only the external action itself is a stand-in, so the test can see whether
 * it ran.
 */

const migrationsFolder = resolve(process.cwd(), "apps/orchestration-service/drizzle");
const TENANT_A = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const WORKSPACE = "018f4d6e-2b4a-7a3e-8c1a-1234567890a2";
const APPROVER = "018f4d6e-2b4a-7a3e-8c1a-1234567890a5";
const TASK_QUEUE = "approval-modes";
const WORKFLOW = "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890a6";
const EMAIL_WORKFLOW = "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890a7";

const sent = new Set<string>();

class SendStandIn implements NodeHandler {
  readonly nodeType: NodeType = "ToolCall";
  async execute(context: { readonly run_id?: string }): Promise<NodeExecutionResult> {
    sent.add(context.run_id ?? "");
    return { output: { sent: true, messageId: `fixture-${context.run_id}` } };
  }
}

function blackboard(): BlackboardHandlerClient {
  const values = new Map<string, string>();
  return {
    async readValue(input) {
      const value = values.get(input.key);
      return value === undefined ? { found: false, value_json: "" } : { found: true, value_json: value };
    },
    async writeValue(input) { values.set(input.key, input.value_json); return {}; },
  };
}

// The synthesizer's output for "send an email" under approve_external_actions:
// an approval boundary before the one external action.
const compiledDag = compileArchitectureToDag({
  tenant_id: `ten_${TENANT_A}`,
  workspace_id: `ws_${WORKSPACE}`,
  workflow_id: "wf_018f4d6e-2b4a-7a3e-8c1a-1234567890a6",
  dag_schema_version: "v1",
  architecture: {
    status: "ready",
    version: "1",
    topology: "sequential",
    boundaries: [{ kind: "human_approval", before_node_key: "send", reason: "approve before external actions" }],
    nodes: [
      { source_node_key: "send", role: "deterministic", execution_kind: "deterministic", source_node_type: "tool", depends_on: [], config: {} },
    ],
    execution_waves: [{ order: 0, node_keys: ["send"], depends_on_wave_orders: [] }],
  },
  binding_decision: { status: "ready", bindings: [] },
});

// The same plan, with its external action named as an email send.
const emailDag = {
  ...compiledDag,
  nodes: compiledDag.nodes.map((node) => node.key === "send" ? { ...node, config: { ...node.config, tool_name: "email.send" } } : node),
};
const approvalKey = compiledDag.nodes.find((node) => node.type === "HumanApproval")!.key;

describe.sequential("approval modes (D5), end to end", () => {
  let postgres: StartedPostgreSqlContainer;
  let admin: PostgresOrchestrationStoreProvider;
  let store: PostgresOrchestrationStoreProvider;
  let harness: ExecutorTestHarness;
  let approvals: ApprovalsService;
  let policies: ApprovalPolicyService;
  let audit: MockAuditEventHandler;
  const role = `approval_modes_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(24).toString("hex");

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine").withDatabase("orchestration_db").withUsername("admin").withPassword(randomBytes(24).toString("hex")).start();
    admin = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: postgres.getConnectionUri(), migrationsFolder });
    await admin.migrate();
    await admin.withTenant(TENANT_A, async (tx) => {
      await tx.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await tx.query(`GRANT CONNECT ON DATABASE orchestration_db TO ${role}`);
      await tx.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
      for (const [workflow, dag] of [[WORKFLOW, compiledDag], [EMAIL_WORKFLOW, emailDag]] as const) {
        await tx.query("INSERT INTO workflows (id, tenant_id, workspace_id, name) VALUES ($1, $2, $3, 'fixture')", [workflow, TENANT_A, WORKSPACE]);
        await tx.query(
          "INSERT INTO workflow_versions (id, tenant_id, workflow_id, version, compiled_dag, dag_schema_version) VALUES ($1, $2, $3, 1, $4, 'v1')",
          [`wfv_${workflow.slice(3)}`, TENANT_A, workflow, JSON.stringify(dag)],
        );
      }
    });
    store = new PostgresOrchestrationStoreProvider({ authentication: "static", connectionString: `postgresql://${role}:${password}@${postgres.getHost()}:${postgres.getPort()}/${postgres.getDatabase()}`, migrationsFolder });

    const handlers = new NodeHandlerRegistry([
      new SendStandIn(),
      new MergeHandler(),
      new GateHandler({ findForSourceNode: async () => [
        { gateType: "quality", verdict: "pass", score: .95, threshold: .7, details: {} },
        { gateType: "safety", verdict: "pass", score: null, threshold: null, details: { severity: "low" } },
      ] }),
      new HumanApprovalHandler({
        requestApproval: async (request) => {
          const created = await approvals.createPending(request);
          return { approvalId: created.id, expiryAt: created.expiryAt, mode: created.mode, policySetBy: created.policySetBy, skipOnTimeout: created.skipOnTimeout };
        },
      }),
    ]);
    const nodeexec = new NodeexecService(
      handlers, new NodeExecutionLedgerService(store), new RunStreamEventService(store),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { markSkipped: (tenant, run, node) => approvals.markSkipped(tenant, run, node) },
    );
    harness = await createExecutorTestHarness(TASK_QUEUE, createExecutorActivities(nodeexec, blackboard()));
    approvals = new ApprovalsService(store, harness.durable);
    audit = createMockAuditEventHandler();
    policies = new ApprovalPolicyService(store, audit);
  }, 180_000);

  afterAll(async () => {
    await harness?.teardown();
    await store?.close();
    await admin?.withTenant(TENANT_A, async (tx) => { await tx.query(`DROP OWNED BY ${role}`); await tx.query(`DROP ROLE IF EXISTS ${role}`); });
    await admin?.close();
    await postgres?.stop();
  }, 60_000);

  beforeEach(async () => {
    sent.clear();
    await admin.withTenant(TENANT_A, (tx) => tx.query("DELETE FROM approval_step_policies WHERE tenant_id = $1", [TENANT_A]));
  });

  async function setPolicy(workflow: string, nodeKey: string, input: SetApprovalStepPolicyInput) {
    const step = (await policies.list(TENANT_A, WORKSPACE, workflow)).find((row) => row.nodeKey === nodeKey)!;
    return policies.set(TENANT_A, WORKSPACE, workflow, nodeKey, input, step.etag);
  }

  async function startRun(workflow = WORKFLOW, manualDag?: CompiledDag) {
    const runId = `run_${uuidV7()}`;
    await admin.withTenant(TENANT_A, (tx) =>
      tx.query(
        "INSERT INTO runs (id, tenant_id, workspace_id, parent_kind, workflow_id, workflow_version_id, status) VALUES ($1, $2, $3, 'workflow', $4, $5, 'running')",
        [runId, TENANT_A, WORKSPACE, workflow, `wfv_${workflow.slice(3)}`],
      ),
    );
    const dag = manualDag ?? (workflow === WORKFLOW ? compiledDag : emailDag);
    const result = harness.run(runId, { tenantId: `ten_${TENANT_A}`, runId, compiledDagJson: JSON.stringify(dag) });
    result.catch(() => undefined);
    return { runId, result };
  }

  async function approvalOf(runId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const page = await approvals.list(`ten_${TENANT_A}`);
      const approval = page.data.find((row) => row.run_id === runId);
      if (approval !== undefined) return approval;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`run ${runId} never reached its approval`);
  }

  it("lists the step as Ask me first by default, with no consequence for a non-side-effect step", async () => {
    await expect(policies.list(TENANT_A, WORKSPACE, WORKFLOW)).resolves.toEqual([
      expect.objectContaining({ nodeKey: approvalKey, mode: "ask", sideEffectConsequence: null, promotionSuggested: false, setBy: null }),
    ]);
  });

  it("serializes competing first writes and rejects stale updates without recording an audit", async () => {
    const [initial] = await policies.list(TENANT_A, WORKSPACE, WORKFLOW);
    const input = { mode: "ask" as const, skipOnTimeout: false, timeoutSeconds: 120, setBy: "usr_setter" };
    const beforeEvents = audit.getRecordedEvents().length;
    const attempts = await Promise.allSettled([
      policies.set(TENANT_A, WORKSPACE, WORKFLOW, approvalKey, input, initial!.etag),
      policies.set(TENANT_A, WORKSPACE, WORKFLOW, approvalKey, { ...input, timeoutSeconds: 180 }, initial!.etag),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = attempts.find((result) => result.status === "rejected");
    expect(failed?.status === "rejected" && failed.reason).toBeInstanceOf(ApprovalPolicyStaleError);
    expect(audit.getRecordedEvents().slice(beforeEvents)).toEqual([expect.objectContaining({
      tenant_id: TENANT_A, actor_ref: "usr_setter", action: "approval.policy.update", target_ref: `${WORKFLOW}/${approvalKey}`,
      context_json: JSON.stringify({ scope: "approval_policy" }),
    })]);
    const [current] = await policies.list(TENANT_A, WORKSPACE, WORKFLOW);
    expect(current!.etag).not.toBe(initial!.etag);
    await expect(policies.set(TENANT_A, WORKSPACE, WORKFLOW, approvalKey, input, initial!.etag)).rejects.toBeInstanceOf(ApprovalPolicyStaleError);
    expect(audit.getRecordedEvents()).toHaveLength(beforeEvents + 1);
  });

  it("rolls back both first and existing policy writes when audit recording fails", async () => {
    const failing = new ApprovalPolicyService(store, createMockAuditEventHandler({ recordEvent: async () => { throw new Error("audit unavailable"); } }));
    const input = { mode: "auto" as const, skipOnTimeout: false, timeoutSeconds: null, setBy: "usr_setter" };
    const [initial] = await policies.list(TENANT_A, WORKSPACE, WORKFLOW);
    await expect(failing.set(TENANT_A, WORKSPACE, WORKFLOW, approvalKey, input, initial!.etag)).rejects.toThrow("audit unavailable");
    expect(await policies.list(TENANT_A, WORKSPACE, WORKFLOW)).toEqual([initial]);
    const saved = await setPolicy(WORKFLOW, approvalKey, { ...input, mode: "ask" });
    await expect(failing.set(TENANT_A, WORKSPACE, WORKFLOW, approvalKey, input, saved.etag)).rejects.toThrow("audit unavailable");
    expect(await policies.list(TENANT_A, WORKSPACE, WORKFLOW)).toEqual([saved]);
  });

  it("Always go ahead approves by policy without waiting, recording the mode and who set it", async () => {
    await setPolicy( WORKFLOW, approvalKey, { mode: "auto", skipOnTimeout: false, timeoutSeconds: null, setBy: "usr_setter" });
    const { runId, result } = await startRun();
    await expect(result).resolves.toBeDefined();
    expect(sent.has(runId)).toBe(true);
    const approval = await approvalOf(runId);
    expect(approval).toMatchObject({ status: "approved", mode: "auto", policy_set_by: "usr_setter", decision_note: "approved by policy", decided_by: null });
  }, 120_000);

  it("Ask me first still waits for a person", async () => {
    const { runId, result } = await startRun();
    const approval = await approvalOf(runId);
    expect(approval).toMatchObject({ status: "pending", mode: "ask", policy_set_by: null });
    expect(sent.has(runId)).toBe(false);
    await approvals.decide(`ten_${TENANT_A}`, approval.id, "approved", APPROVER, undefined);
    await expect(result).resolves.toBeDefined();
    expect(sent.has(runId)).toBe(true);
  }, 120_000);

  it("a manual outside tool choice retains its real Temporal approval wait", async () => {
    const verified = compileArchitectureToDag({
      tenant_id: `ten_${TENANT_A}`, workspace_id: `ws_${WORKSPACE}`, workflow_id: EMAIL_WORKFLOW, dag_schema_version: "v1",
      architecture: { status: "ready", version: "1", topology: "sequential",
        boundaries: [{ kind: "human_approval", before_node_key: "send", reason: "approve outside action" }, { kind: "verification", before_node_key: "send", reason: "verify prepared output" }],
        nodes: [{ source_node_key: "prepare", role: "deterministic", execution_kind: "control", source_node_type: "join", depends_on: [], config: {} }, { source_node_key: "send", role: "deterministic", execution_kind: "deterministic", source_node_type: "tool", depends_on: ["prepare"], config: { tool_name: "search.web" } }],
        execution_waves: [{ order: 0, node_keys: ["prepare"], depends_on_wave_orders: [] }, { order: 1, node_keys: ["send"], depends_on_wave_orders: [0] }],
      }, binding_decision: { status: "ready", bindings: [] },
    });
    const dag = CompiledDagSchema.parse({ ...verified, nodes: verified.nodes.map(node => node.key === "send" ? { ...node, config: applyNodeOverride(node.config, { kind: "tool", value: "email.send" }) } : node) });
    const { runId, result } = await startRun(EMAIL_WORKFLOW, dag);
    const approval = await approvalOf(runId);
    expect(approval).toMatchObject({ status: "pending", mode: "ask" });
    expect(sent.has(runId)).toBe(false);
    await approvals.decide(`ten_${TENANT_A}`, approval.id, "approved", APPROVER, undefined);
    await expect(result).resolves.toBeDefined();
    expect(sent.has(runId)).toBe(true);
  }, 120_000);

  it("on a side-effect step, Always go ahead needs the named consequence confirmed and records who and when", async () => {
    const [step] = await policies.list(TENANT_A, WORKSPACE, EMAIL_WORKFLOW);
    expect(step!.sideEffectConsequence).toBe("this will send emails without asking");
    for (const confirmConsequence of [undefined, "yes"]) {
      await expect(setPolicy( EMAIL_WORKFLOW, approvalKey, {
        mode: "auto", skipOnTimeout: false, timeoutSeconds: null, setBy: "usr_setter",
        ...(confirmConsequence === undefined ? {} : { confirmConsequence }),
      })).rejects.toBeInstanceOf(ApprovalPolicyConfirmationRequiredError);
    }
    await expect(policies.list(TENANT_A, WORKSPACE, EMAIL_WORKFLOW)).resolves.toEqual([expect.objectContaining({ mode: "ask" })]);
    const confirmed = await setPolicy( EMAIL_WORKFLOW, approvalKey, {
      mode: "auto", skipOnTimeout: false, timeoutSeconds: null, setBy: "usr_setter", confirmConsequence: "this will send emails without asking",
    });
    expect(confirmed).toMatchObject({ mode: "auto", autoConfirmedBy: "usr_setter", autoConfirmedAt: expect.any(String) });
    expect(audit.getRecordedEvents().at(-1)).toMatchObject({ actor_ref: "usr_setter", reason_code: "consequence_confirmed" });
    // The database refuses an unconfirmed auto side-effect row outright.
    await expect(admin.withTenant(TENANT_A, (tx) =>
      tx.query("UPDATE approval_step_policies SET auto_confirmed_by = NULL WHERE tenant_id = $1 AND workflow_id = $2", [TENANT_A, EMAIL_WORKFLOW]),
    )).rejects.toThrow(/approval_step_policies_side_effect_confirmed/);
  });

  it(`suggests promotion after ${PROMOTION_SUGGESTION_THRESHOLD} approvals in a row, resets on a rejection, and never applies it`, async () => {
    async function decidedRun(decision: "approved" | "rejected") {
      const { runId, result } = await startRun();
      const approval = await approvalOf(runId);
      await approvals.decide(`ten_${TENANT_A}`, approval.id, decision, APPROVER, undefined);
      await result.catch(() => undefined);
    }
    for (let index = 0; index < PROMOTION_SUGGESTION_THRESHOLD - 1; index += 1) await decidedRun("approved");
    await expect(policies.list(TENANT_A, WORKSPACE, WORKFLOW)).resolves.toEqual([expect.objectContaining({ consecutiveApprovals: 9, promotionSuggested: false })]);
    await decidedRun("rejected");
    await expect(policies.list(TENANT_A, WORKSPACE, WORKFLOW)).resolves.toEqual([expect.objectContaining({ consecutiveApprovals: 0 })]);
    for (let index = 0; index < PROMOTION_SUGGESTION_THRESHOLD; index += 1) await decidedRun("approved");
    await expect(policies.list(TENANT_A, WORKSPACE, WORKFLOW)).resolves.toEqual([
      expect.objectContaining({ mode: "ask", consecutiveApprovals: 10, promotionSuggested: true }),
    ]);
    const promoted = await setPolicy( WORKFLOW, approvalKey, { mode: "auto", skipOnTimeout: false, timeoutSeconds: null, setBy: "usr_setter" });
    expect(promoted).toMatchObject({ mode: "auto", consecutiveApprovals: 0, promotionSuggested: false });
  }, 600_000);

  it("skip-on-timeout continues past an unanswered approval and flags the run", async () => {
    await setPolicy( WORKFLOW, approvalKey, { mode: "ask", skipOnTimeout: true, timeoutSeconds: 60, setBy: "usr_setter" });
    const { runId, result } = await startRun();
    const approval = await approvalOf(runId);
    expect(approval.status).toBe("pending");
    await expect(result).resolves.toBeDefined();
    expect(sent.has(runId)).toBe(true);
    const after = await approvals.getById(`ten_${TENANT_A}`, approval.id);
    expect(after.status).toBe("skipped");
    const flags = await admin.withTenant(TENANT_A, (tx) => tx.query<{ flags: string[] }>("SELECT flags FROM runs WHERE tenant_id = $1 AND id = $2", [TENANT_A, runId]));
    expect(flags.rows[0]?.flags).toEqual(["approval_skipped"]);
  }, 180_000);
});

function uuidV7(): string {
  const bytes = randomBytes(16);
  const timestamp = Date.now();
  bytes.writeUIntBE(timestamp, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
