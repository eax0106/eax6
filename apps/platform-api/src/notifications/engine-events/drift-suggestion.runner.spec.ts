import { describe, expect, it, vi } from "vitest";
import type { EngineClient } from "../../engine";
import type { NotificationService } from "../notification.service";
import { DriftSuggestionRunner } from "./drift-suggestion.runner";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890e1";
const AGENT = "agt_018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const WS_A = "018f4d6e-2b4a-7a3e-8c1a-1234567890f1";
const WS_B = "018f4d6e-2b4a-7a3e-8c1a-1234567890f2";

function setup(data: unknown[]) {
  const get = vi.fn().mockResolvedValue({ body: { data } });
  const notifyWorkspaceRolesOnce = vi.fn().mockResolvedValue(2);
  const runner = new DriftSuggestionRunner(
    { get } as unknown as EngineClient,
    { notifyWorkspaceRolesOnce } as unknown as NotificationService,
  );
  return { get, notifyWorkspaceRolesOnce, runner };
}

const suggestion = { tenantId: `ten_${TENANT}`, agentId: AGENT, taskClass: "summarisation", action: "flagged" as const };

describe("DriftSuggestionRunner (section 17)", () => {
  it("reads the agent's recent workflows as the system caller of that tenant", async () => {
    const { get, runner } = setup([]);
    await runner.run(suggestion, NOW);
    expect(get).toHaveBeenCalledWith(`/api/v1/agents/${AGENT}/workflows`, expect.objectContaining({ tenantId: TENANT }));
  });

  it("tells each workflow's admins and editors once a month, linking to the workflow, changing nothing", async () => {
    const { notifyWorkspaceRolesOnce, runner } = setup([
      { workflow_id: "wf_a", workspace_id: `ws_${WS_A}`, name: "A" },
      { workflow_id: "wf_b", workspace_id: `ws_${WS_B}`, name: "B" },
      { workflow_id: null, workspace_id: `ws_${WS_B}` },
    ]);

    await expect(runner.run(suggestion, NOW)).resolves.toBe(4);

    expect(notifyWorkspaceRolesOnce).toHaveBeenCalledTimes(2);
    expect(notifyWorkspaceRolesOnce).toHaveBeenCalledWith(
      ["admin", "editor"],
      `drift:${AGENT}:summarisation:wf_a:2026-09`,
      expect.objectContaining({ tenantId: TENANT, workspaceId: WS_A, eventClass: "workflow", severity: "info", deepLink: "/app/workflows/wf_a" }),
    );
    expect(notifyWorkspaceRolesOnce.mock.calls[0]![2].body).toContain("Nothing in your workflow was changed");
  });

  it("one failed notification does not stop the others", async () => {
    const { notifyWorkspaceRolesOnce, runner } = setup([
      { workflow_id: "wf_a", workspace_id: `ws_${WS_A}` },
      { workflow_id: "wf_b", workspace_id: `ws_${WS_B}` },
    ]);
    notifyWorkspaceRolesOnce.mockRejectedValueOnce(new Error("db down"));
    await expect(runner.run(suggestion, NOW)).resolves.toBe(2);
  });
});
