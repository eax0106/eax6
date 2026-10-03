import {
  ArtifactIdSchema,
  MemoryWriteCompiledConfigSchema,
  RunIdSchema,
  TenantIdSchema,
  WorkspaceIdSchema,
  type NodeType,
} from "@alterx/contracts";
import {
  MemoryServiceClientError,
  type MemoryWritebackHandler,
} from "@alterx/adapters";

import {
  NodeHandlerValidationError,
  type NodeExecutionContext,
  type NodeExecutionResult,
  type NodeHandler,
} from "../handler";

export class MemoryWriteHandler implements NodeHandler {
  readonly nodeType: NodeType = "MemoryWrite";

  constructor(private readonly memoryService: MemoryWritebackHandler) {}

  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    const tenantId = requiredId(TenantIdSchema, context.tenant_id, "tenant_id");
    const runId = requiredId(RunIdSchema, context.run_id, "run_id");
    const config = MemoryWriteCompiledConfigSchema.safeParse(context.config);
    const workspaceId = config.success
      ? requiredId(WorkspaceIdSchema, config.data.workspace_id, "config.workspace_id")
      : invalidConfig();
    const artifactId = config.success
      ? requiredId(ArtifactIdSchema, config.data.verified_output_artifact_id, "config.verified_output_artifact_id")
      : invalidConfig();
    const namespace = config.success && config.data.namespace !== undefined
      ? config.data.namespace
      : invalidConfig();

    try {
      const response = await this.memoryService.proposeWriteback({
        tenant_id: tenantId,
        workspace_id: workspaceId,
        run_id: runId,
        verified_output_artifact_id: artifactId,
        namespace,
      });
      return response.skipped
        ? { output: { skipped: true, reason: "memory_disabled" } }
        : { output: { memory_id: response.memory_id, candidate_json: response.candidate_json } };
    } catch (error: unknown) {
      if (error instanceof MemoryServiceClientError) {
        throw new NodeHandlerValidationError(
          error.code === "deadline_exceeded" || error.code === "upstream"
            ? "Memory Service is temporarily unavailable"
            : "Memory Service rejected writeback",
        );
      }
      throw error;
    }
  }
}

function requiredId<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: unknown,
  field: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success || result.data === undefined) {
    throw new NodeHandlerValidationError(`MemoryWrite requires valid ${field}`);
  }
  return result.data;
}

function invalidConfig(): never {
  throw new NodeHandlerValidationError(
    "MemoryWrite requires config.workspace_id, config.verified_output_artifact_id, and config.namespace",
  );
}
