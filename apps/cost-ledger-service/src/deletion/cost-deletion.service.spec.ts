import { describe, expect, it, vi } from "vitest";
import { COST_TABLES, CostDeletionService, type CostDeletionStore } from "./cost-deletion.service";

const TENANT = "ten_018f4d6e-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const BARE = TENANT.slice(4);
const MANIFEST = "del_018f4d6e-bbbb-7bbb-8bbb-bbbbbbbbbbbb";

function setup(counts: Record<string, number> = {}) {
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    const text = sql.replace(/\s+/g, " ").trim();
    const count = /FROM "(\w+)" WHERE tenant_id/.exec(text);
    if (text.startsWith("SELECT count(*)")) return { rowCount: 1, rows: [{ count: counts[count![1]!] ?? 0 }] };
    if (text.startsWith("DELETE") || text.startsWith("UPDATE")) return { rowCount: 2, rows: [] };
    if (text.startsWith("SELECT DISTINCT")) return { rowCount: 1, rows: [{ tenant_id: BARE }] };
    throw new Error(`unexpected ${text} ${JSON.stringify(values)}`);
  });
  const withProvisioner = vi.fn(async (op: (tx: { query: typeof query }) => Promise<unknown>) => op({ query }));
  return { query, service: new CostDeletionService({ withProvisioner } as unknown as CostDeletionStore) };
}

describe("CostDeletionService", () => {
  it("names the four cost_db tables the registry routes to it", () => {
    expect([...COST_TABLES]).toEqual(["billing_rollups", "cost_events", "model_outcomes", "run_verdicts"]);
  });

  it("deletes costs, outcomes and verdicts, and only strips billing rollups of tenant and breakdown", async () => {
    const { query, service } = setup();
    await expect(service.deleteSubjectData(TENANT, MANIFEST)).resolves.toEqual({
      store: "cost-ledger-service", manifestId: MANIFEST, deletedRows: 8, deletedObjects: 0,
    });
    const statements = query.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, " "));
    expect(statements).toEqual([
      'DELETE FROM "cost_events" WHERE tenant_id = $1',
      'DELETE FROM "model_outcomes" WHERE tenant_id = $1',
      'DELETE FROM "run_verdicts" WHERE tenant_id = $1',
      "UPDATE billing_rollups SET tenant_id = NULL, detail = '{}'::jsonb, finalized = true WHERE tenant_id = $1",
    ]);
    for (const [, values] of query.mock.calls) expect(values).toEqual([BARE]);
    expect(statements.join(" ")).not.toMatch(/DELETE FROM "?billing_rollups/);
  });

  it("reports what remains, and verification agrees only when nothing does", async () => {
    const remaining = setup({ cost_events: 3 });
    await expect(remaining.service.verifyDeletion(TENANT, MANIFEST)).resolves.toMatchObject({
      deleted: false,
      remaining: [{ table: "cost_events", rowCount: 3 }],
    });
    await expect(setup().service.verifyDeletion(TENANT, MANIFEST)).resolves.toMatchObject({ deleted: true, remaining: [] });
  });

  it("refuses a malformed tenant or manifest before touching the database", async () => {
    const { query, service } = setup();
    await expect(service.deleteSubjectData("not-a-tenant", MANIFEST)).rejects.toThrow("ten_");
    await expect(service.deleteSubjectData(TENANT, "nope")).rejects.toThrow("del_");
    expect(query).not.toHaveBeenCalled();
  });

  it("lists tenants with prefixed ids", async () => {
    await expect(setup().service.listSubjectIds()).resolves.toEqual([TENANT]);
  });
});
