import { describe, expect, it, vi } from "vitest";
import type { PlatformDb } from "../signup/platform-db";
import { PlatformDbWorkspaceTenantLookup } from "./resource-tenant.resolver";

// PlatformDb.queryTenant is generic over an arbitrary QueryResultRow; a
// plain vi.fn() mock can't structurally satisfy that generic signature, so
// this cast is the pragmatic boundary -- runtime behavior is what these
// tests exercise, not the generic type itself.
function db(queryTenant: (...args: unknown[]) => Promise<unknown>) {
  return { queryTenant } as unknown as Pick<PlatformDb, "queryTenant">;
}

describe("PlatformDbWorkspaceTenantLookup", () => {
  it("queries the workspaces table scoped to the actor's own tenant", async () => {
    const queryTenant = vi.fn(async () => [{ tenant_id: "ten_a" }]);
    const lookup = new PlatformDbWorkspaceTenantLookup(db(queryTenant));

    const workspace = "018f47a5-7b2c-7d10-8f11-123456789abc";
    await expect(lookup.queryWorkspaceTenant("ten_a", `ws_${workspace}`)).resolves.toBe("ten_a");
    expect(queryTenant).toHaveBeenCalledWith(
      "ten_a",
      "SELECT tenant_id FROM workspaces WHERE id = $1",
      [workspace],
    );
  });

  it("resolves nothing for an id that is not a workspace id, without querying", async () => {
    const queryTenant = vi.fn(async () => [{ tenant_id: "ten_a" }]);
    const lookup = new PlatformDbWorkspaceTenantLookup(db(queryTenant));

    await expect(lookup.queryWorkspaceTenant("ten_a", "ws_1")).resolves.toBeUndefined();
    expect(queryTenant).not.toHaveBeenCalled();
  });

  it("returns undefined when the RLS-scoped query finds no matching row", async () => {
    const queryTenant = vi.fn(async () => []);
    const lookup = new PlatformDbWorkspaceTenantLookup(db(queryTenant));

    await expect(lookup.queryWorkspaceTenant("ten_a", "ws_018f47a5-7b2c-7d10-8f11-000000000000")).resolves.toBeUndefined();
  });
});
