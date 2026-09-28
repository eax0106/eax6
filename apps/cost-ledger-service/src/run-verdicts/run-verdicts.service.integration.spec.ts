import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { PostgresCostStoreProvider } from "@alterx/adapters";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  RunVerdictConflictError,
  RunVerdictValidationError,
  RunVerdictsService,
} from "./run-verdicts.service";

const migrationsFolder = resolve(process.cwd(), "apps/cost-ledger-service/drizzle");

const TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const BARE_TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890b2";
const DECIDED_AT = "2026-09-28T10:00:00.000Z";

// C5, design log §21 / §22 item 10: the ledger holds each run's verdict.
describe.sequential("RunVerdictsService against a real Postgres cost_db", () => {
  let postgres: StartedPostgreSqlContainer;
  let store: PostgresCostStoreProvider;
  let service: RunVerdictsService;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer("postgres:16.6-alpine")
      .withDatabase("cost_db")
      .withUsername("cost_admin")
      .withPassword(randomBytes(24).toString("hex"))
      .start();
    store = new PostgresCostStoreProvider({
      authentication: "static",
      connectionString: postgres.getConnectionUri(),
      migrationsFolder,
    });
    await store.migrate();
    service = new RunVerdictsService(store);
  }, 90_000);

  afterAll(async () => {
    await store?.close();
    await postgres?.stop();
  }, 60_000);

  it("records a run's verdict once, and a replay of the same verdict is a no-op", async () => {
    const request = { tenant_id: TENANT, run_id: RUN, verdict: "completed_verified", decided_at: DECIDED_AT };

    await expect(service.recordRunVerdict(request)).resolves.toEqual({ recorded: true });
    await expect(service.recordRunVerdict(request)).resolves.toEqual({ recorded: false });

    const rows = await store.withTenant(BARE_TENANT, (tx) =>
      tx.query<{ verdict: string; decided_at: Date }>(
        "SELECT verdict, decided_at FROM run_verdicts WHERE tenant_id = $1",
        [BARE_TENANT],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.verdict).toBe("completed_verified");
    expect(new Date(rows.rows[0]!.decided_at).toISOString()).toBe(DECIDED_AT);
  });

  it("never rewrites a recorded verdict", async () => {
    await expect(
      service.recordRunVerdict({ tenant_id: TENANT, run_id: RUN, verdict: "failed", decided_at: DECIDED_AT }),
    ).rejects.toBeInstanceOf(RunVerdictConflictError);
  });

  it("rejects a verdict that is not a run outcome", async () => {
    await expect(
      service.recordRunVerdict({ tenant_id: TENANT, run_id: RUN, verdict: "pass", decided_at: DECIDED_AT }),
    ).rejects.toBeInstanceOf(RunVerdictValidationError);
  });
});
