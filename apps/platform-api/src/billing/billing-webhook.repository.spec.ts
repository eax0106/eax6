import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BillingWebhookRepository } from "./billing-webhook.repository";

const tenantId = "018f47a5-7b2c-7d10-8f11-123456789abc";

describe("BillingWebhookRepository", () => {
  let query: ReturnType<typeof vi.fn>;
  let release: ReturnType<typeof vi.fn>;
  let end: ReturnType<typeof vi.fn>;
  let repository: BillingWebhookRepository;

  beforeEach(() => {
    query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO billing_events")) return result([], 1);
      if (sql.includes("billing_dunning_states") && sql.includes("SELECT")) {
        return result([
          {
            state: "grace",
            current_plan: "plan_basic",
            first_failed_at: new Date("2026-07-28T00:00:00.000Z"),
          },
        ]);
      }
      return result([]);
    });
    release = vi.fn();
    end = vi.fn(async () => undefined);
    const client = { query, release } as unknown as PoolClient;
    repository = new BillingWebhookRepository(
      {
        connect: vi.fn(async () => client),
        end,
      } as unknown as Pool,
      true,
    );
  });

  it("writes event, state, audit, and processed marker in one tenant transaction", async () => {
    await repository.transaction(tenantId, async (client) => {
      await expect(
        repository.insertEvent(client, {
          tenantId,
          providerId: "razorpay",
          providerEventId: "event-1",
          type: "payment.failed",
          payload: { safe: true },
        }),
      ).resolves.toBe(true);
      await expect(
        repository.getDunningState(client, tenantId),
      ).resolves.toMatchObject({
        state: "grace",
        currentPlan: "plan_basic",
      });
      await repository.saveDunningState(client, tenantId, {
        state: "limited",
        currentPlan: "plan_basic",
        firstFailedAt: new Date("2026-07-28T00:00:00.000Z"),
      });
      await repository.auditTransition(client, {
        tenantId,
        providerEventId: "event-1",
        fromState: "grace",
        toState: "limited",
        reason: "payment_failed",
      });
      await repository.markEventProcessed(client, tenantId, "event-1");
    });

    expect(query).toHaveBeenCalledWith(
      "SELECT set_config('app.current_tenant_id', $1, true)",
      [tenantId],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (provider_event_id) DO NOTHING"),
      [
        tenantId,
        "razorpay",
        "event-1",
        "payment.failed",
        '{"safe":true}',
      ],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO billing_dunning_audits"),
      [
        tenantId,
        expect.any(String),
        "event-1",
        "grace",
        "limited",
        "payment_failed",
      ],
    );
    expect(query).toHaveBeenLastCalledWith("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses actual current entitlement when no dunning row exists", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM entitlements")) {
        return result([{ plan: "plan_pro", access_state: "active" }]);
      }
      return result([]);
    });
    const client = { query } as unknown as PoolClient;
    await expect(
      repository.getDunningState(client, tenantId),
    ).resolves.toEqual({
      state: "active",
      currentPlan: "plan_pro",
      firstFailedAt: null,
    });
    query.mockResolvedValue(result([]));
    await expect(
      repository.getDunningState(client, tenantId),
    ).resolves.toEqual({
      state: "active",
      currentPlan: null,
      firstFailedAt: null,
    });
  });

  it("returns false for duplicate events and rolls back failures", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO billing_events")) return result([], 0);
      if (sql.includes("explode")) throw new Error("db failed");
      return result([]);
    });
    const duplicate = await repository.transaction(tenantId, (client) =>
      repository.insertEvent(client, {
        tenantId,
        providerId: "razorpay",
        providerEventId: "event-1",
        type: "payment.failed",
        payload: {},
      }),
    );
    expect(duplicate).toBe(false);

    await expect(
      repository.transaction(tenantId, async (client) => {
        await client.query("explode");
      }),
    ).rejects.toThrow("db failed");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("closes only owned pools", async () => {
    await repository.onModuleDestroy();
    expect(end).toHaveBeenCalledOnce();
    const injected = new BillingWebhookRepository({
      end,
    } as unknown as Pool);
    await injected.onModuleDestroy();
    expect(end).toHaveBeenCalledOnce();
  });
});

function result<T extends QueryResultRow>(
  rows: T[],
  rowCount = rows.length,
): QueryResult<T> {
  return {
    rows,
    rowCount,
    command: "",
    oid: 0,
    fields: [],
  };
}
