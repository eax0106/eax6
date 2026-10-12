import type { AuditEventHandler } from "@alterx/shared-clients";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { computeEtag } from "../concurrency";
import type { ActorContext } from "../rbac/types";
import { PlatformDb } from "../signup/platform-db";
import { TenantsService } from "./tenants.service";

const actor: ActorContext = {
  user_id: "user",
  tenant_id: "tenant",
  roles: ["owner"],
  permissions: [],
  session_id: "session",
};
const tenant = {
  id: "tenant",
  name: "User's Workspace",
  status: "active",
  region: "ap-south-1",
  role: "owner",
};

function auditClient() {
  return { recordEvent: vi.fn().mockResolvedValue({}), getEvent: vi.fn() };
}

describe("TenantsService", () => {
  it("lists and reads caller tenant", async () => {
    const queryTenant = vi.fn().mockResolvedValue([tenant]);
    const service = new TenantsService({ queryTenant } as unknown as PlatformDb, auditClient());
    await expect(service.list(actor)).resolves.toEqual([tenant]);
    await expect(service.get(actor, "tenant")).resolves.toEqual(tenant);
  });

  it("returns RFC problem for missing tenant", async () => {
    const service = new TenantsService(
      { queryTenant: vi.fn().mockResolvedValue([]) } as unknown as PlatformDb,
      auditClient(),
    );
    await expect(service.get(actor, "missing")).rejects.toMatchObject({ status: 404 });
  });
});

describe("TenantsService data residency", () => {
  const stored = { data_residency: { allowed: ["eu"], legal_basis: "GDPR Art. 44" } };
  const next = { data_residency: { allowed: ["eu", "de"] } };

  function writer() {
    const query = vi.fn(async (sql: string) => (sql.startsWith("SELECT") ? { rows: [stored] } : { rows: [] }));
    const withTenant = vi.fn(async (_tenantId: string, operation: (client: PoolClient) => Promise<unknown>) =>
      operation({ query } as unknown as PoolClient),
    );
    const audit = auditClient();
    const service = new TenantsService(
      { withTenant, queryTenant: vi.fn().mockResolvedValue([stored]) } as unknown as PlatformDb,
      audit as AuditEventHandler,
    );
    return { service, query, withTenant, audit };
  }

  it("reads the stored value for the caller's own tenant only", async () => {
    const { service } = writer();
    await expect(service.getDataResidency(actor, "tenant")).resolves.toEqual(stored);
    await expect(service.getDataResidency(actor, "other")).rejects.toMatchObject({ status: 404 });
  });

  it("writes, audits and returns the new value when If-Match is the current ETag", async () => {
    const { service, query, audit } = writer();

    await expect(service.setDataResidency(actor, "tenant", next, computeEtag(stored))).resolves.toEqual(next);

    expect(query).toHaveBeenCalledWith("SELECT data_residency FROM tenants WHERE id = $1 FOR UPDATE", ["tenant"]);
    expect(query).toHaveBeenCalledWith("UPDATE tenants SET data_residency = $2 WHERE id = $1", [
      "tenant",
      JSON.stringify(next.data_residency),
    ]);
    expect(audit.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "tenant",
        actor_ref: "user",
        action: "tenant.data_residency.update",
        target_ref: "tenant",
        context_json: JSON.stringify({ scope: { before: stored.data_residency, after: next.data_residency } }),
      }),
    );
  });

  it("clears residency with null", async () => {
    const { service, query } = writer();

    await expect(
      service.setDataResidency(actor, "tenant", { data_residency: null }, computeEtag(stored)),
    ).resolves.toEqual({ data_residency: null });
    expect(query).toHaveBeenCalledWith("UPDATE tenants SET data_residency = $2 WHERE id = $1", ["tenant", null]);
  });

  it("fails when the audit event could not be recorded instead of returning success", async () => {
    const { service, audit } = writer();
    audit.recordEvent.mockRejectedValue(new Error("audit unavailable"));

    await expect(service.setDataResidency(actor, "tenant", next, computeEtag(stored))).rejects.toThrow(
      "audit unavailable",
    );
  });

  it.each([
    ["no If-Match", undefined, 428],
    ["a stale If-Match", computeEtag({ data_residency: null }), 412],
  ])("refuses %s without writing", async (_name, ifMatch, status) => {
    const { service, query, audit } = writer();

    await expect(service.setDataResidency(actor, "tenant", next, ifMatch)).rejects.toMatchObject({ status });
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE tenants"), expect.anything());
    expect(audit.recordEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["a bare array", { data_residency: ["eu"] }],
    ["an empty allowed list", { data_residency: { allowed: [] } }],
    ["an unknown key", { data_residency: { allowed: ["eu"], regions: ["eu-west-1"] } }],
    ["a missing data_residency", {}],
  ])("rejects %s with 400 before touching the database", async (_name, body) => {
    const { service, withTenant } = writer();

    await expect(service.setDataResidency(actor, "tenant", body, computeEtag(stored))).rejects.toMatchObject({
      status: 400,
    });
    expect(withTenant).not.toHaveBeenCalled();
  });

  it("never writes another tenant's residency", async () => {
    const { service, withTenant } = writer();

    await expect(service.setDataResidency(actor, "other", next, computeEtag(stored))).rejects.toMatchObject({
      status: 404,
    });
    expect(withTenant).not.toHaveBeenCalled();
  });
});
