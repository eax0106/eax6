import type { AuditEventHandler } from "@alterx/shared-clients";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { computeEtag } from "../concurrency";
import type { ActorContext } from "../rbac/types";
import { PlatformDb } from "../signup/platform-db";
import { WorkspaceSafeguardsService } from "./workspace-safeguards.service";

const actor: ActorContext = {
  user_id: "user",
  tenant_id: "tenant",
  roles: ["owner"],
  permissions: [],
  session_id: "session",
};
const workspaceId = "0190f5a0-0000-7000-8000-000000000001";
const stored = { safeguards: { contains_pii: true, approve_external_actions: true } };
const next = { safeguards: { contains_pii: false, approve_external_actions: true } };

function writer(row: unknown = stored) {
  const query = vi.fn(async (sql: string) => (sql.startsWith("SELECT") ? { rows: row ? [row] : [] } : { rows: [] }));
  const withTenant = vi.fn(async (_tenantId: string, operation: (client: PoolClient) => Promise<unknown>) =>
    operation({ query } as unknown as PoolClient),
  );
  const queryTenant = vi.fn().mockResolvedValue(row ? [row] : []);
  const audit = { recordEvent: vi.fn().mockResolvedValue({}), getEvent: vi.fn() };
  const service = new WorkspaceSafeguardsService(
    { withTenant, queryTenant } as unknown as PlatformDb,
    audit as unknown as AuditEventHandler,
  );
  return { service, query, withTenant, queryTenant, audit };
}

describe("WorkspaceSafeguardsService", () => {
  it("reads the workspace's safeguards within the caller's tenant", async () => {
    const { service, queryTenant } = writer();
    await expect(service.get(actor, workspaceId)).resolves.toEqual(stored);
    expect(queryTenant).toHaveBeenCalledWith("tenant", expect.stringContaining("tenant_id = $2"), [
      workspaceId,
      "tenant",
    ]);
  });

  it("answers 404 for a workspace the tenant cannot see or a malformed id", async () => {
    await expect(writer(null).service.get(actor, workspaceId)).rejects.toMatchObject({ status: 404 });
    const { service, queryTenant } = writer();
    await expect(service.get(actor, "not-a-uuid")).rejects.toMatchObject({ status: 404 });
    expect(queryTenant).not.toHaveBeenCalled();
  });

  it("fails closed on a stored value the schema rejects", async () => {
    const { service } = writer({ safeguards: { contains_pii: "yes" } });
    await expect(service.get(actor, workspaceId)).rejects.toMatchObject({ status: 500 });
  });

  it("writes, audits before and after, and returns the new value", async () => {
    const { service, query, audit } = writer();
    await expect(service.set(actor, workspaceId, next, computeEtag(stored))).resolves.toEqual(next);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE"), [workspaceId, "tenant"]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE workspaces"), [
      workspaceId,
      "tenant",
      JSON.stringify(next.safeguards),
    ]);
    expect(audit.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.safeguards.update",
        target_type: "workspace",
        target_ref: workspaceId,
        context_json: JSON.stringify({ scope: { before: stored.safeguards, after: next.safeguards } }),
      }),
    );
  });

  it.each([
    [{ safeguards: { contains_pii: false } }],
    [{ safeguards: { ...next.safeguards, verification_required: true } }],
    [{ safeguards: { contains_pii: "false", approve_external_actions: true } }],
    [{}],
  ])("rejects a body that is not both safeguards exactly: %j", async (body) => {
    const { service, withTenant } = writer();
    await expect(service.set(actor, workspaceId, body, computeEtag(stored))).rejects.toMatchObject({ status: 400 });
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("requires If-Match and rejects a stale one without writing", async () => {
    const missing = writer();
    await expect(missing.service.set(actor, workspaceId, next, undefined)).rejects.toMatchObject({ status: 428 });
    expect(missing.withTenant).not.toHaveBeenCalled();

    const stale = writer();
    await expect(stale.service.set(actor, workspaceId, next, '"stale"')).rejects.toMatchObject({ status: 412 });
    expect(stale.query).toHaveBeenCalledTimes(1);
    expect(stale.audit.recordEvent).not.toHaveBeenCalled();
  });

  it("propagates an audit failure so the transaction rolls back", async () => {
    const { service, audit } = writer();
    audit.recordEvent.mockRejectedValue(new Error("audit unavailable"));
    await expect(service.set(actor, workspaceId, next, computeEtag(stored))).rejects.toThrow("audit unavailable");
  });
});
