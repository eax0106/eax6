import { describe, expect, it } from "vitest";

import { createPlatformJobHandlers } from "./handlers";
import { SCHEDULED_PLATFORM_JOB_TYPES } from "./scheduled-job-types";

/**
 * Wave 3 item 3 -- the driver test itself. Asserts every job type has BOTH
 * a real handler and a real scheduled caller, not just one of the two:
 *
 * - Every SCHEDULED_PLATFORM_JOB_TYPES entry (main.ts's callers) must
 *   resolve to a real handler when createPlatformJobHandlers() is given
 *   every dependency it can use -- a scheduled job type with no handler
 *   would start a workflow that fails every single tick.
 * - Every handler createPlatformJobHandlers() can register (given full
 *   dependencies) besides platform.health-ping must appear in
 *   SCHEDULED_PLATFORM_JOB_TYPES -- a handler with no scheduled caller is
 *   exactly "Pattern 3": real, tested code nothing ever invokes in
 *   production.
 *
 * This is a structural check, not a behavioral one -- it doesn't run
 * main.ts (an imperative bootstrap script isn't unit-testable), it checks
 * that the two declarative sources of truth (the schedule list, the
 * handler registry) can't silently drift apart.
 */
describe("platform job driver wiring", () => {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => "",
  })) as unknown as typeof fetch;

  const handlers = createPlatformJobHandlers({
    platformApiInternalBaseUrl: "http://platform-api.internal",
    notificationDigestServiceToken: "token",
    connectorHealthSweepServiceToken: "token",
    adsCoreInternalBaseUrl: "http://ads-core.internal",
    retentionSweepServiceToken: "token",
    platformRetentionSweepServiceToken: "token",
    orchestrationServiceInternalBaseUrl: "http://orchestration-service.internal",
    orchestrationRetentionSweepServiceToken: "token",
    evalFacadeServiceToken: "token",
    intelligenceServiceInternalBaseUrl: "http://intelligence-service.internal",
    memoryServiceInternalBaseUrl: "http://memory-service.internal",
    driftSweepServiceToken: "token",
    driftSweepMinimumObservations: 5,
    auditServiceInternalBaseUrl: "http://audit-service.internal",
    auditChainVerifyServiceToken: "token",
    fetchImpl,
  });

  it("registers a real handler for every job type main.ts schedules a caller for", () => {
    for (const jobType of SCHEDULED_PLATFORM_JOB_TYPES) {
      expect(handlers.get(jobType), `no handler registered for ${jobType}`).toBeDefined();
    }
  });

  it("schedules a real caller for every handler except the deliberately caller-less health-ping proof", () => {
    const scheduled = new Set<string>(SCHEDULED_PLATFORM_JOB_TYPES);
    for (const jobType of handlers.keys()) {
      if (jobType === "platform.health-ping") continue;
      expect(scheduled.has(jobType), `handler ${jobType} has no scheduled caller`).toBe(true);
    }
  });
});
