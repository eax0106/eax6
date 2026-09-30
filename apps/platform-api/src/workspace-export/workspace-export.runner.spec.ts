import { describe, expect, it, vi } from "vitest";
import { WorkspaceExportRunner } from "./workspace-export.runner";

const tenant = "00000000-0000-7000-8000-000000000001";
const workspace = "00000000-0000-7000-8000-0000000000a1";
const requester = "00000000-0000-7000-8000-0000000001a1";
const record = { id: "00000000-0000-7000-8000-00000000e001", workspace_id: workspace, requested_by: requester };

function enginePage(data: unknown[], hasMore = false) {
  return { status: 200, body: { data, page: { has_more: hasMore, next_cursor: hasMore ? "cursor-1" : null, limit: 200 } } };
}

function setup(overrides: {
  pending?: unknown[];
  claimed?: boolean;
  engineImpl?: (path: string) => unknown;
  members?: unknown[];
  requesterRole?: string | null;
  adsImpl?: (kind: string) => unknown;
} = {}) {
  const {
    pending = [record],
    claimed = true,
    engineImpl = () => enginePage([{ id: "wf_1", workspace_id: `ws_${workspace}` }]),
    members = [{ userId: requester, email: "a@example.com", name: "A", role: "admin", scope: "workspace" }],
    requesterRole = "admin",
    adsImpl = () => ({ status: 200, body: { data: [{ id: "src_1" }], page: { has_more: false, next_cursor: null } } }),
  } = overrides;
  const queries: string[] = [];
  const db = {
    queryTenant: vi.fn(async (_tenant: string, sql: string, values: unknown[] = []) => {
      queries.push(sql);
      if (sql.includes("FROM workspace_exports") && sql.startsWith("SELECT")) return pending;
      if (sql.includes("SET status = 'running'")) return claimed ? [{ id: record.id }] : [];
      if (sql.includes("SET status = 'ready'") || sql.includes("SET status = 'failed'")) return [{ id: record.id }];
      if (sql.includes("FROM workspace_members") && values.length === 3) {
        return requesterRole === null ? [] : [{ role: requesterRole }];
      }
      if (sql.includes("FROM workspace_members")) return members;
      return [];
    }),
  };
  const engine = { get: vi.fn(async (path: string) => engineImpl(path)) };
  const ads = {
    sources: vi.fn(async () => adsImpl("sources")),
    documents: vi.fn(async () => adsImpl("documents")),
  };
  const audit = { recordEvent: vi.fn(async () => ({})) };
  const tenants = { listActiveTenantIds: vi.fn(async () => [tenant]) };
  const runner = new WorkspaceExportRunner(tenants as never, db as never, engine as never, ads as never, audit as never);
  return { db, engine, ads, audit, tenants, runner, queries };
}

// The runner builds the archive from workspace-scoped reads or fails honestly.
describe("WorkspaceExportRunner", () => {
  it("builds a ready archive from every source and audits it", async () => {
    const { runner, engine, ads, audit, db } = setup();
    const result = await runner.run(new Date("2026-09-30T10:00:00.000Z"));
    expect(result).toEqual({ tenants: 1, tenantsFailed: 0, exportsProcessed: 1, exportsFailed: 0 });
    const paths = engine.get.mock.calls.map((call) => call[0] as string);
    expect(paths.filter((path) => path.includes("collection=workflows"))).toHaveLength(1);
    expect(paths.filter((path) => path.includes("collection=workflow_versions"))).toHaveLength(1);
    expect(paths.filter((path) => path.includes("collection=runs"))).toHaveLength(1);
    for (const path of paths) expect(path).toContain(`workspace_id=ws_${workspace}`);
    expect(ads.sources).toHaveBeenCalledTimes(1);
    expect(ads.documents).toHaveBeenCalledTimes(1);
    const ready = db.queryTenant.mock.calls.find((call) => call[1].includes("SET status = 'ready'"));
    expect(ready).toBeDefined();
    const archive = JSON.parse(String(ready![2]?.[0]));
    expect(archive.workspaceId).toBe(`ws_${workspace}`);
    expect(archive.workflows).toHaveLength(1);
    expect(archive.members).toHaveLength(1);
    expect(archive.knowledgeSources).toHaveLength(1);
    expect(JSON.stringify(archive)).not.toMatch(/password|secret|token|credential|identity_ref/);
    expect(new Date(archive.exportedAt).getTime()).toBe(new Date("2026-09-30T10:00:00.000Z").getTime());
    expect(audit.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "workspace.exports.ready", result: "success" }));
  });

  it("records an engine failure as failed with its reason, never an empty archive", async () => {
    const { runner, db, audit } = setup({ engineImpl: () => { throw new Error("engine 503"); } });
    const result = await runner.run(new Date("2026-09-30T10:00:00.000Z"));
    expect(result).toEqual({ tenants: 1, tenantsFailed: 0, exportsProcessed: 1, exportsFailed: 1 });
    const failed = db.queryTenant.mock.calls.find((call) => call[1].includes("SET status = 'failed'"));
    expect(failed).toBeDefined();
    expect(String(failed![2]?.[0])).toContain("source metadata unavailable");
    expect(audit.recordEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "workspace.exports.failed", result: "error" }));
    expect(db.queryTenant.mock.calls.some((call) => call[1].includes("SET status = 'ready'"))).toBe(false);
  });

  it("refuses when the requester is no longer a workspace admin", async () => {
    const { runner, db, engine } = setup({ requesterRole: "editor" });
    await runner.run(new Date("2026-09-30T10:00:00.000Z"));
    const failed = db.queryTenant.mock.calls.find((call) => call[1].includes("SET status = 'failed'"));
    expect(failed).toBeDefined();
    expect(String(failed![2]?.[0])).toContain("no longer a workspace admin");
    expect(engine.get).not.toHaveBeenCalled();
  });

  it("skips a record lost in a claim race without reading anything", async () => {
    const { runner, engine, ads } = setup({ claimed: false });
    const result = await runner.run(new Date("2026-09-30T10:00:00.000Z"));
    expect(result.exportsProcessed).toBe(0);
    expect(result.exportsFailed).toBe(0);
    expect(engine.get).not.toHaveBeenCalled();
    expect(ads.sources).not.toHaveBeenCalled();
  });

  it("counts a tenant whose pass throws and keeps going", async () => {
    const failing = setup({ pending: [] });
    failing.db.queryTenant.mockRejectedValueOnce(new Error("db down"));
    const mixed = new WorkspaceExportRunner(
      { listActiveTenantIds: async () => [tenant] } as never,
      failing.db as never,
      failing.engine as never,
      failing.ads as never,
      failing.audit as never,
    );
    const result = await mixed.run();
    expect(result).toEqual({ tenants: 1, tenantsFailed: 1, exportsProcessed: 0, exportsFailed: 0 });
  });

  it("fails closed when tenant enumeration is unavailable", async () => {
    const { db, engine, ads, audit } = setup();
    const runner = new WorkspaceExportRunner(
      { listActiveTenantIds: async () => { throw new Error("store unconfigured"); } } as never,
      db as never, engine as never, ads as never, audit as never,
    );
    await expect(runner.run()).rejects.toThrow("store unconfigured");
  });

  it("exports scalar knowledge metadata only, never connector settings or unknown payloads", async () => {
    const { runner, db } = setup({ adsImpl: () => ({
      status: 200,
      body: { data: [{ id: "src_1", kind: "drive", title: "Policies", document_count: 2,
        sync_config: { token: "fixture-value" }, unexpected_payload: { password: "fixture-value" } }],
        page: { has_more: false, next_cursor: null } },
    }) });
    await runner.run();
    const ready = db.queryTenant.mock.calls.find((call) => call[1].includes("SET status = 'ready'"));
    const archive = JSON.parse(String(ready![2]?.[0]));
    expect(archive.knowledgeSources[0]).toEqual({ id: "src_1", kind: "drive", document_count: 2 });
    expect(archive.knowledgeDocuments[0]).toEqual({ id: "src_1", kind: "drive", title: "Policies" });
    expect(JSON.stringify(archive)).not.toContain("fixture-value");
  });

  it.each([
    { data: [], page: {} },
    { data: [], page: { has_more: "false", next_cursor: null } },
    { data: [{ id: { token: "fixture-value" } }], page: { has_more: false, next_cursor: null } },
  ])("records malformed knowledge metadata as failed, never ready: %j", async (body) => {
    const { runner, db } = setup({ adsImpl: () => ({ status: 200, body }) });
    expect((await runner.run()).exportsFailed).toBe(1);
    expect(db.queryTenant.mock.calls.some((call) => call[1].includes("SET status = 'ready'"))).toBe(false);
  });

  it("rechecks staleness atomically when claiming a running export", async () => {
    const { runner, db } = setup();
    const now = new Date("2026-10-01T00:00:00.000Z");
    await runner.run(now);
    const claim = db.queryTenant.mock.calls.find((call) => call[1].includes("SET status = 'running'"))!;
    expect(claim[1]).toContain("updated_at < $4");
    expect(claim[2]).toContainEqual(new Date(now.getTime() - 60 * 60 * 1000));
  });

  it("clears expired archives during the scheduled pass", async () => {
    const { runner, db } = setup({ pending: [] });
    const now = new Date("2026-10-01T00:00:00.000Z");
    await runner.run(now);
    const expiry = db.queryTenant.mock.calls.find((call) => call[1].includes("SET status = 'expired'"))!;
    expect(expiry[1]).toContain("archive = NULL");
    expect(expiry[1]).toContain("tenant_id = $1");
    expect(expiry[1]).toContain("expires_at <= $2");
    expect(expiry[2]).toEqual([tenant, now.toISOString()]);
  });

  it("never stores upstream error contents in an export failure reason", async () => {
    const { runner, db } = setup({ engineImpl: () => { throw new Error("provider token fixture-value"); } });
    expect((await runner.run()).exportsFailed).toBe(1);
    const failed = db.queryTenant.mock.calls.find((call) => call[1].includes("SET status = 'failed'"))!;
    expect(failed[2]?.[0]).toBe("source metadata unavailable");
    expect(JSON.stringify(failed[2])).not.toContain("fixture-value");
  });

  it("clears an archive rather than claiming audited readiness if the ready audit fails", async () => {
    const { runner, db, audit } = setup();
    audit.recordEvent.mockRejectedValueOnce(new Error("audit unavailable"));
    expect((await runner.run()).exportsFailed).toBe(1);
    const failed = db.queryTenant.mock.calls.find((call) => call[1].includes("SET status = 'failed'"))!;
    expect(failed[1]).toContain("archive = NULL");
    expect(audit.recordEvent).toHaveBeenLastCalledWith(expect.objectContaining({ action: "workspace.exports.failed" }));
  });
});
