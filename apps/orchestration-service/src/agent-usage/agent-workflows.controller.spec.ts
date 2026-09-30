import { describe, expect, it, vi } from "vitest";

import { AgentWorkflowsController } from "./agent-workflows.controller";
import { AgentWorkflowsValidationError, type AgentWorkflowsService } from "./agent-workflows.service";

const TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const AGENT = "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const request = (actorType: string) =>
  ({ url: `/api/v1/agents/${AGENT}/workflows`, actorContext: { actor_type: actorType, tenant_id: TENANT, workspace_id: null } }) as never;

describe("AgentWorkflowsController (section 17)", () => {
  it("answers the system principal with the workflows and their prefixed workspaces", async () => {
    const recentWorkflows = vi.fn(async () => [{ workflow_id: "wf_a", workspace_id: "018f4d6e-2b4a-7a3e-8c1a-1234567890f1", name: "A" }]);
    const response = await new AgentWorkflowsController({ recentWorkflows } as unknown as AgentWorkflowsService).list(request("system"), AGENT);
    expect(response.data).toEqual([{ workflow_id: "wf_a", workspace_id: "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890f1", name: "A" }]);
    expect(recentWorkflows).toHaveBeenCalledWith(TENANT, AGENT);
  });

  it.each(["user", "service"])("refuses a %s actor: the feed crosses workspaces", async (actorType) => {
    const recentWorkflows = vi.fn();
    await expect(
      new AgentWorkflowsController({ recentWorkflows } as unknown as AgentWorkflowsService).list(request(actorType), AGENT),
    ).rejects.toMatchObject({ status: 403 });
    expect(recentWorkflows).not.toHaveBeenCalled();
  });

  it("answers 400 for a malformed agent id", async () => {
    const recentWorkflows = vi.fn(async () => { throw new AgentWorkflowsValidationError("agent_id must be an agt_ id"); });
    await expect(
      new AgentWorkflowsController({ recentWorkflows } as unknown as AgentWorkflowsService).list(request("system"), "bad"),
    ).rejects.toMatchObject({ status: 400 });
  });
});
