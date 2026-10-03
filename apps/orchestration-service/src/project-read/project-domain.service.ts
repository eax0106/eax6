import { randomUUID } from "node:crypto";

import type { ConversationHandler, PlannerHandler } from "@alterx/adapters";
import { TenantIdSchema, WorkspaceIdSchema, type CompiledDag } from "@alterx/contracts";

import { ClarificationLoopService } from "../conversation/clarification-loop.service";
import { compileTaskSkeletonToDag, parseTaskSkeleton } from "../compiler/dag-builder";
import { RunLauncherService } from "../runs/run-launcher.service";
import {
  ProjectNotFoundError,
  ProjectValidationError,
  type OrchestrationTransactionLike,
  type OrchestrationTenantStore,
} from "./project-read.service";

export class ProjectStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectStateConflictError";
  }
}

type PlanStatus =
  | "planning"
  | "awaiting_clarification"
  | "pending_review"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "building"
  | "failed";

interface ProjectPlanRow extends Record<string, unknown> {
  readonly project_id: string;
  readonly conversation_id: string;
  readonly brief: string;
  readonly task_skeleton: unknown;
  readonly status: PlanStatus;
  readonly version: number;
}

interface ClarificationRow extends Record<string, unknown> {
  readonly id: string;
  readonly question: string;
  readonly status: "open" | "answered" | "expired";
}

export interface ProjectDomainResource {
  readonly project_id: string;
  readonly workspace_id: string;
  readonly status: PlanStatus;
  readonly brief: string;
  readonly conversation_id: string;
}

function prefixedUuidV7(prefix: string): string {
  const id = randomUUID();
  return `${prefix}_${id.slice(0, 14)}7${id.slice(15)}`;
}

function bareTenantId(tenantId: string): string {
  const parsed = TenantIdSchema.safeParse(tenantId);
  if (!parsed.success) throw new ProjectValidationError("tenantId must be a ten_ prefixed UUIDv7");
  return parsed.data.slice("ten_".length);
}

function bareWorkspaceId(workspaceId: string): string {
  const parsed = WorkspaceIdSchema.safeParse(workspaceId);
  if (!parsed.success) throw new ProjectValidationError("workspaceId must be a ws_ prefixed UUIDv7");
  return parsed.data.slice("ws_".length);
}

function requireBrief(brief: string): string {
  const normalized = brief.trim();
  if (normalized.length === 0) throw new ProjectValidationError("brief is required");
  return normalized;
}

function planSteps(taskSkeleton: unknown): readonly Record<string, unknown>[] {
  if (typeof taskSkeleton !== "object" || taskSkeleton === null || Array.isArray(taskSkeleton)) {
    return [];
  }
  const nodes = (taskSkeleton as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? nodes.filter((node): node is Record<string, unknown> =>
    typeof node === "object" && node !== null && !Array.isArray(node),
  ) : [];
}

/**
 * Public project lifecycle over the real Planner, conversation/clarification
 * state, Provisioning service, and Executor launcher. Project rows are the
 * durable join point; no Platform-side project shadow state exists.
 */
export class ProjectDomainService {
  readonly #clarificationLoop: ClarificationLoopService;

  constructor(
    private readonly store: OrchestrationTenantStore,
    planner: PlannerHandler,
    private readonly conversations: ConversationHandler,
    private readonly launcher: RunLauncherService,
  ) {
    this.#clarificationLoop = new ClarificationLoopService(store, planner);
  }

  async create(
    tenantId: string,
    workspaceId: string,
    briefInput: string,
  ): Promise<ProjectDomainResource> {
    const brief = requireBrief(briefInput);
    const tenant = bareTenantId(tenantId);
    const workspace = bareWorkspaceId(workspaceId);
    const projectId = prefixedUuidV7("prj");
    const conversationId = prefixedUuidV7("cnv");

    await this.store.withTenant(tenant, async (tx) => {
      await tx.query(
        `INSERT INTO projects (id, tenant_id, workspace_id, name, status)
         VALUES ($1, $2, $3, $4, 'draft')`,
        [projectId, tenant, workspace, brief.slice(0, 120)],
      );
      await tx.query(
        `INSERT INTO conversations
           (id, tenant_id, workspace_id, channel, temporal_workflow_id, status)
         VALUES ($1, $2, $3, 'api', $4, 'active')`,
        [conversationId, tenant, workspace, prefixedUuidV7("convwf")],
      );
      await tx.query(
        `INSERT INTO project_plans
           (tenant_id, project_id, conversation_id, brief, status)
         VALUES ($1, $2, $3, $4, 'planning')`,
        [tenant, projectId, conversationId, brief],
      );
    });

    try {
      const result = await this.#clarificationLoop.requestPlan({
        tenantId,
        workspaceId,
        conversationId,
        runId: prefixedUuidV7("run"),
        objective: brief,
        mode: "project",
      });
      await this.#persistPlannerResult(tenant, projectId, result);
      return {
        project_id: projectId,
        workspace_id: workspaceId,
        status: result.status === "ready" ? "pending_review" : "awaiting_clarification",
        brief,
        conversation_id: conversationId,
      };
    } catch (error: unknown) {
      await this.#setPlanStatus(tenant, projectId, "failed");
      throw error;
    }
  }

  async clarifications(tenantId: string, projectId: string, workspaceId?: string) {
    const tenant = bareTenantId(tenantId);
    return this.store.withTenant(tenant, async (tx) => {
      if (workspaceId !== undefined) {
        const owner = await tx.query("SELECT id FROM projects WHERE tenant_id=$1 AND id=$2 AND workspace_id=$3", [tenant, projectId, workspaceId]);
        if (owner.rowCount === 0) throw new ProjectNotFoundError(projectId);
      }
      await this.#requirePlan(tx, tenant, projectId);
      const result = await tx.query<ClarificationRow>(
        `SELECT c.id, c.question, c.status
         FROM clarifications c
         JOIN project_plans p ON p.tenant_id = c.tenant_id AND p.conversation_id = c.conversation_id
         WHERE p.tenant_id = $1 AND p.project_id = $2 AND c.status = 'open'
         ORDER BY c.requested_at ASC, c.id ASC`,
        [tenant, projectId],
      );
      return { data: result.rows.map((row) => ({
        clarification_id: row.id,
        question: row.question,
        options: [],
        required: true,
      })) };
    });
  }

  async answerClarification(
    tenantId: string,
    projectId: string,
    clarificationId: string,
    answer: string,
  ) {
    const tenant = bareTenantId(tenantId);
    const normalized = requireBrief(answer);
    const plan = await this.store.withTenant(tenant, async (tx) => {
      const current = await this.#requirePlan(tx, tenant, projectId);
      const clarification = await tx.query<ClarificationRow>(
        `SELECT c.id, c.question, c.status
         FROM clarifications c
         WHERE c.tenant_id = $1 AND c.conversation_id = $2 AND c.id = $3`,
        [tenant, current.conversation_id, clarificationId],
      );
      if (clarification.rows[0] === undefined) throw new ProjectNotFoundError(clarificationId);
      if (clarification.rows[0].status !== "open") {
        throw new ProjectStateConflictError(`clarification ${clarificationId} is already ${clarification.rows[0].status}`);
      }
      return current;
    });

    await this.conversations.mergeClarification({
      tenant_id: tenantId,
      conversation_id: plan.conversation_id,
      clarification_id: clarificationId,
      answer: normalized,
    });
    const result = await this.#clarificationLoop.resumeAfterClarification({
      tenantId,
      workspaceId: await this.#workspaceId(tenant, projectId),
      conversationId: plan.conversation_id,
      runId: prefixedUuidV7("run"),
      originalObjective: plan.brief,
      mode: "project",
    });
    await this.#persistPlannerResult(tenant, projectId, result);
    return {
      project_id: projectId,
      action: "answer_clarification",
      status: result.status === "ready" ? "pending_review" : "awaiting_clarification",
    };
  }

  async plan(tenantId: string, projectId: string) {
    const tenant = bareTenantId(tenantId);
    return this.store.withTenant(tenant, async (tx) => {
      const row = await this.#requirePlan(tx, tenant, projectId);
      return {
        project_id: projectId,
        version: row.version,
        status: row.status,
        steps: planSteps(row.task_skeleton),
      };
    });
  }

  async reviewPlan(
    tenantId: string,
    projectId: string,
    action: "approve" | "reject" | "request-changes",
  ) {
    const tenant = bareTenantId(tenantId);
    const status: PlanStatus = action === "approve" ? "approved" : action === "reject" ? "rejected" : "changes_requested";
    return this.store.withTenant(tenant, async (tx) => {
      const plan = await this.#requirePlan(tx, tenant, projectId);
      if (plan.status !== "pending_review") {
        throw new ProjectStateConflictError(`project plan is ${plan.status}; only pending_review plans can be reviewed`);
      }
      await tx.query(
        `UPDATE project_plans SET status = $3, updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND project_id = $2`,
        [tenant, projectId, status],
      );
      return { project_id: projectId, action, status };
    });
  }

  async startBuild(tenantId: string, projectId: string): Promise<{ project_id: string; build_id: string; status: string }> {
    const tenant = bareTenantId(tenantId);
    const plan = await this.store.withTenant(tenant, (tx) => this.#requirePlan(tx, tenant, projectId));
    if (plan.status !== "approved") {
      throw new ProjectStateConflictError(`project plan is ${plan.status}; approve it before starting a build`);
    }
    if (plan.task_skeleton === null) throw new ProjectStateConflictError("project plan has no planner task skeleton");
    const compiledDag = this.#compile(plan.task_skeleton);
    const run = await this.launcher.createProjectRun(tenantId, {
      projectId,
      cycle_id: `project_${Date.now().toString(36)}`,
      template_id: "project-default",
      environment_refs: {},
      scaffold: [],
      compiledDag,
    });
    await this.#setPlanStatus(tenant, projectId, "building");
    return { project_id: projectId, build_id: run.id, status: run.status };
  }

  async #workspaceId(tenant: string, projectId: string): Promise<string> {
    return this.store.withTenant(tenant, async (tx) => {
      const row = await tx.query<{ readonly workspace_id: string }>(
        "SELECT workspace_id::text FROM projects WHERE tenant_id = $1 AND id = $2",
        [tenant, projectId],
      );
      if (row.rows[0] === undefined) throw new ProjectNotFoundError(projectId);
      return `ws_${row.rows[0].workspace_id}`;
    });
  }

  #compile(taskSkeleton: unknown): CompiledDag {
    if (typeof taskSkeleton !== "object" || taskSkeleton === null) {
      throw new ProjectStateConflictError("project plan has invalid task skeleton");
    }
    const skeleton = parseTaskSkeleton(JSON.stringify(taskSkeleton));
    return compileTaskSkeletonToDag(skeleton, "1");
  }

  async #persistPlannerResult(
    tenant: string,
    projectId: string,
    result: Awaited<ReturnType<ClarificationLoopService["requestPlan"]>>,
  ): Promise<void> {
    if (result.status === "ready") {
      const taskSkeleton = JSON.parse(result.taskSkeletonJson) as unknown;
      await this.store.withTenant(tenant, (tx) => tx.query(
        `UPDATE project_plans SET task_skeleton = $3, status = 'pending_review', updated_at = clock_timestamp()
         WHERE tenant_id = $1 AND project_id = $2`,
        [tenant, projectId, JSON.stringify(taskSkeleton)],
      ));
      return;
    }
    await this.#setPlanStatus(tenant, projectId, "awaiting_clarification");
  }

  async #setPlanStatus(tenant: string, projectId: string, status: PlanStatus): Promise<void> {
    await this.store.withTenant(tenant, (tx) => tx.query(
      `UPDATE project_plans SET status = $3, updated_at = clock_timestamp()
       WHERE tenant_id = $1 AND project_id = $2`,
      [tenant, projectId, status],
    ));
  }

  async #requirePlan(
    tx: OrchestrationTransactionLike,
    tenant: string,
    projectId: string,
  ): Promise<ProjectPlanRow> {
    const result = await tx.query<ProjectPlanRow>(
      `SELECT project_id, conversation_id, brief, task_skeleton, status, version
       FROM project_plans WHERE tenant_id = $1 AND project_id = $2`,
      [tenant, projectId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new ProjectNotFoundError(projectId);
    return row;
  }
}
