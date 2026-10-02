import { createHash, randomUUID } from "node:crypto";

import type {
  CompilerCompileWorkflowRequest,
  CompilerCompileArchitectureWorkflowRequest,
  CompilerCompileWorkflowResponse,
  CompilerValidateWorkflowDagRequest,
  CompilerValidateWorkflowDagResponse,
} from "@alterx/contracts";
import { CompiledDagSchema } from "@alterx/contracts";

import {
  CompilerValidationError,
  compileTaskSkeletonToDag,
  parseTaskSkeleton,
} from "./dag-builder";
import { preflightConnections } from "../connections/connection-preflight";
import { compileArchitectureToDag, type ArchitectureCompileInput } from "./architecture-dag-builder";
import type { OrchestrationTenantStore } from "../project-read/project-read.service";

export type { OrchestrationTenantStore } from "../project-read/project-read.service";

export { CompilerValidationError } from "./dag-builder";

export class CompilerConcurrencyError extends Error {
  constructor(workflowId: string) {
    super(`workflow_versions insert raced for workflow_id=${workflowId}; retry the compile`);
    this.name = "CompilerConcurrencyError";
  }
}

const COMPILER_VERSION = "compiler-core-v1";
const TENANT_ID_PATTERN =
  /^ten_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKFLOW_ID_PATTERN =
  /^wf_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

function bareTenantUuid(tenantId: string): string {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new CompilerValidationError("tenant_id must be a ten_ prefixed UUIDv7");
  }
  return tenantId.slice("ten_".length);
}

function requireValidWorkflowId(workflowId: string): void {
  if (!WORKFLOW_ID_PATTERN.test(workflowId)) {
    throw new CompilerValidationError("workflow_id must be a wf_ prefixed UUIDv7");
  }
}

function prefixedUuidV7(prefix: string): string {
  const uuid = randomUUID();
  return `${prefix}_${uuid.slice(0, 14)}7${uuid.slice(15)}`;
}

export class GraphCompilerService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async compileWorkflow(
    request: CompilerCompileWorkflowRequest,
  ): Promise<CompilerCompileWorkflowResponse> {
    if (request.task_skeleton_json.trim().length === 0) {
      throw new CompilerValidationError("task_skeleton_json is required");
    }
    if (request.dag_schema_version.trim().length === 0) {
      throw new CompilerValidationError("dag_schema_version is required");
    }
    requireValidWorkflowId(request.workflow_id);
    const bareTenant = bareTenantUuid(request.tenant_id);

    const skeleton = parseTaskSkeleton(request.task_skeleton_json);
    const compiledDag = compileTaskSkeletonToDag(skeleton, request.dag_schema_version);

    const compileMetadata = {
      compiler_version: COMPILER_VERSION,
      source_skeleton_hash: createHash("sha256")
        .update(request.task_skeleton_json)
        .digest("hex"),
      compiled_at: new Date().toISOString(),
    };
    const workflowVersionId = prefixedUuidV7("wfv");

    await this.store.withTenant(bareTenant, async (tx) => {
      await preflightConnections(tx, bareTenant, request.workflow_id, compiledDag);
      const nextVersionResult = await tx.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM workflow_versions
         WHERE tenant_id = $1 AND workflow_id = $2`,
        [bareTenant, request.workflow_id],
      );
      const nextVersion = nextVersionResult.rows[0]?.next_version ?? 1;

      try {
        await tx.query(
          `INSERT INTO workflow_versions
             (id, tenant_id, workflow_id, version, compiled_dag, task_skeleton,
              dag_schema_version, compile_metadata, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'compiled')`,
          [
            workflowVersionId,
            bareTenant,
            request.workflow_id,
            nextVersion,
            JSON.stringify(compiledDag),
            // The parsed skeleton rather than request.task_skeleton_json: the
            // raw string is what compile_metadata hashes, and keeping both the
            // hash's input and a re-serialisation of the parse would let the
            // two disagree. Recovery replans from the shape the DAG was
            // actually built from, which is this one.
            JSON.stringify(skeleton),
            request.dag_schema_version,
            JSON.stringify(compileMetadata),
          ],
        );
      } catch (error: unknown) {
        const code = (error as { code?: string }).code;
        if (code === UNIQUE_VIOLATION) {
          throw new CompilerConcurrencyError(request.workflow_id);
        }
        if (code === FOREIGN_KEY_VIOLATION) {
          throw new CompilerValidationError(
            `workflow_id "${request.workflow_id}" does not reference an existing workflow`,
          );
        }
        throw error;
      }

      return nextVersion;
    });

    return {
      workflow_version_id: workflowVersionId,
      compiled_dag_json: JSON.stringify(compiledDag),
      // Retired with the columns in 0037. Both fields are deprecated in
      // alter.compiler.v1 and kept on the wire only because `buf breaking`'s
      // FIELD_NO_DELETE is enforced on this repo's contracts.
      node_requirements_json: "{}",
      policy_bindings_json: "{}",
    };
  }

  /** Strict ENGINE-12 path. It consumes approved architecture and pinned bindings only. */
  async compileArchitectureWorkflow(request: CompilerCompileArchitectureWorkflowRequest): Promise<CompilerCompileWorkflowResponse> {
    let architecture: unknown;
    let binding_decision: unknown;
    try {
      architecture = JSON.parse(request.architecture_json);
      binding_decision = JSON.parse(request.binding_decision_json);
    } catch {
      throw new CompilerValidationError("architecture_json and binding_decision_json must be valid JSON");
    }
    return this.#compileArchitectureInput({
      tenant_id: request.tenant_id,
      workspace_id: request.workspace_id,
      workflow_id: request.workflow_id,
      dag_schema_version: request.dag_schema_version,
      architecture,
      binding_decision,
    } as ArchitectureCompileInput);
  }

  async #compileArchitectureInput(input: ArchitectureCompileInput): Promise<CompilerCompileWorkflowResponse> {
    requireValidWorkflowId(input.workflow_id);
    const bareTenant = bareTenantUuid(input.tenant_id);
    const compiledDag = compileArchitectureToDag(input);
    const workflowVersionId = prefixedUuidV7("wfv");
    await this.store.withTenant(bareTenant, async (tx) => {
      const workflow = await tx.query(
        "SELECT 1 FROM workflows WHERE tenant_id = $1 AND id = $2 AND workspace_id = $3",
        [bareTenant, input.workflow_id, input.workspace_id.slice("ws_".length)],
      );
      if (workflow.rowCount !== 1) {
        throw new CompilerValidationError("workflow is not visible in the supplied tenant/workspace");
      }
      await preflightConnections(tx, bareTenant, input.workflow_id, compiledDag, input.workspace_id.slice("ws_".length));
      const version = await tx.query<{ next_version: number }>("SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM workflow_versions WHERE tenant_id = $1 AND workflow_id = $2", [bareTenant, input.workflow_id]);
      // task_skeleton is deliberately absent from this insert. This path
      // compiles an architecture, not a TaskSkeleton, so there is no skeleton
      // to record and NULL is the truthful value -- the same thing
      // source_skeleton_hash: "architecture-bound" already says. Recovery
      // reads the NULL and declines to replan rather than inventing one.
      await tx.query(
        "INSERT INTO workflow_versions (id, tenant_id, workflow_id, version, compiled_dag, dag_schema_version, compile_metadata, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'compiled')",
        [workflowVersionId, bareTenant, input.workflow_id, version.rows[0]?.next_version ?? 1, JSON.stringify(compiledDag), input.dag_schema_version, JSON.stringify({ compiler_version: COMPILER_VERSION, source_skeleton_hash: "architecture-bound", compiled_at: new Date().toISOString() })],
      );
    });
    return { workflow_version_id: workflowVersionId, compiled_dag_json: JSON.stringify(compiledDag), node_requirements_json: "{}", policy_bindings_json: "{}" };
  }

  async validateWorkflowDag(
    request: CompilerValidateWorkflowDagRequest,
  ): Promise<CompilerValidateWorkflowDagResponse> {
    let raw: unknown;
    try {
      raw = JSON.parse(request.workflow_dag_json);
    } catch (error: unknown) {
      return { valid: false, issues_json: [JSON.stringify({ message: (error as Error).message })] };
    }

    const result = CompiledDagSchema.safeParse(raw);
    if (result.success) {
      return { valid: true, issues_json: [] };
    }
    return {
      valid: false,
      issues_json: result.error.issues.map((issue) =>
        JSON.stringify({ path: issue.path, message: issue.message, code: issue.code }),
      ),
    };
  }
}
