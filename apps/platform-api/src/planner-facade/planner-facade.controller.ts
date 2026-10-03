import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
} from "@nestjs/common";
import { Idempotent } from "../idempotency";
import {
  ActorContext,
  RequireWorkspaceRole,
  type ActorContextType,
} from "../rbac";
import { PlatformHttpError } from "../signup/problem";
import { PlannerFacadeService } from "./planner-facade.service";
import { z } from "zod";
import { ConfirmWorkflowBuildSchema, WorkflowIdSchema } from "@alterx/contracts";

const writeRoles = ["admin", "editor"] as const;

// Strict: safeguards are not taken per request. Flags sent with one plan were
// kept nowhere, so planning again quietly dropped them. They are read from the
// workspace and the workflow (GET/PUT .../safeguards), and residency from the
// tenant, on every plan; a body that still sends `constraints` is a 400.
export const PlanWorkflowBodySchema = z
  .object({
    goal: z.string().min(1),
    answers: z.record(z.string(), z.string()).optional(),
  })
  .merge(z.object({ confirm: z.literal(true).optional(), successCriteria: ConfirmWorkflowBuildSchema.shape.successCriteria.optional() }))
  .strict().refine(value => (value.confirm === true) === (value.successCriteria !== undefined), "Build confirmation and successCriteria must be supplied together");

@Controller("/api/v1/workflows/:workflowId/actions")
export class PlannerFacadeController {
  constructor(private readonly plannerFacade: PlannerFacadeService) {}

  @Post("plan")
  @HttpCode(200)
  @RequireWorkspaceRole(...writeRoles)
  @Idempotent()
  async plan(
    @Param("workflowId") workflowId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType,
  ) {
    const result = PlanWorkflowBodySchema.safeParse(body);
    if (!result.success) {
      throw new PlatformHttpError(
        400,
        "INVALID_PLAN_REQUEST",
        "Body must be { goal: string, answers?: Record<string, string> }",
        `/api/v1/workflows/${workflowId}/actions/plan`,
        result.error.issues.map((issue) => ({
          field: issue.path.join(".") || "body",
          message: issue.message,
        })),
      );
    }
    const parsed = result.data;
    if (!WorkflowIdSchema.safeParse(workflowId).success || !actor.workspace_id) throw new PlatformHttpError(400, "INVALID_PLAN_REQUEST", "A workflow and current workspace are required", `/api/v1/workflows/${workflowId}/actions/plan`);

    // Reconstruct the objective including answers
    let objective = parsed.goal;
    if (parsed.answers && Object.keys(parsed.answers).length > 0) {
      const parts = [objective];
      for (const [question, answer] of Object.entries(parsed.answers)) {
        parts.push(`Clarification: ${question} Answer: ${answer}`);
      }
      objective = parts.join("\n\n");
    }

    // Call the facade service
    return await this.plannerFacade.planWorkflow({
      tenantId: actor.tenant_id,
      workspaceId: actor.workspace_id ?? "",
      workflowId,
      objective,
      ...(parsed.confirm ? { confirm: parsed.confirm, successCriteria: parsed.successCriteria! } : {}),
    });
  }
}
