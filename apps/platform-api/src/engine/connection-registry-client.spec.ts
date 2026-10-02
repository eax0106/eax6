import { describe, expect, it, vi } from "vitest";
import type { ConnectionRegistrySnapshot } from "@alterx/contracts";
import { ConnectionRegistryClient, connectionRegistryClientFromEnvironment } from "./connection-registry-client";

const snapshot: ConnectionRegistrySnapshot = {
  tenant_id: "00000000-0000-7000-8000-000000000001", workspace_id: "00000000-0000-7000-8000-000000000002",
  connection_id: "00000000-0000-7000-8000-000000000003", connector_type: "github", status: "connected", source_revision: 2,
  secret_ref: "/alter/integrations/00000000-0000-7000-8000-000000000001/00000000-0000-7000-8000-000000000002/00000000-0000-7000-8000-000000000003",
};

describe("ConnectionRegistryClient", () => {
  it("requires both URL and service token reference at boot", () => {
    expect(() => connectionRegistryClientFromEnvironment({})).toThrow("must be configured");
    expect(() => connectionRegistryClientFromEnvironment({ ENGINE_BASE_URL: "http://engine.test" })).toThrow("must be configured");
    expect(connectionRegistryClientFromEnvironment({ ENGINE_BASE_URL: "http://engine.test", CONNECTION_REGISTRY_SERVICE_TOKEN_REF: "env:TOKEN" })).toBeInstanceOf(ConnectionRegistryClient);
  });
  it("authenticates the bounded snapshot and accepts an already newer engine revision", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ source_revision: 3 }));
    await new ConnectionRegistryClient("http://engine.test/", async () => "fixture", http).upsert(snapshot);
    const [url, request] = http.mock.calls[0]!;
    expect(url).toBe("http://engine.test/internal/connections/upsert");
    expect(request).toMatchObject({ method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" } });
    expect(JSON.parse(String(request?.body))).toEqual(snapshot);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([null, {}, [], { source_revision: "2" }, { source_revision: 1 }])("rejects malformed or stale acknowledgement %j", async result => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result));
    await expect(new ConnectionRegistryClient("http://engine.test", async () => "fixture", http).upsert(snapshot)).rejects.toThrow("invalid revision");
  });

  it("discloses HTTP failure without returning secret material", async () => {
    const http = vi.fn<typeof fetch>().mockResolvedValue(new Response("secret must stay private", { status: 503 }));
    await expect(new ConnectionRegistryClient("http://engine.test", async () => "fixture", http).upsert(snapshot)).rejects.toThrow("synchronization failed (503)");
  });

  it("refuses missing authentication or a foreign reference before HTTP", async () => {
    const http = vi.fn<typeof fetch>();
    await expect(new ConnectionRegistryClient("http://engine.test", async () => "", http).upsert(snapshot)).rejects.toThrow("authentication is not configured");
    await expect(new ConnectionRegistryClient("http://engine.test", async () => "fixture", http).upsert({ ...snapshot, secret_ref: "/other" })).rejects.toThrow();
    expect(http).not.toHaveBeenCalled();
  });
});
