/**
 * Wave 3 item 3. This is the audit's own root-cause fix for "Pattern 3"
 * (real, tested code sitting behind a caller that doesn't actually exist,
 * or a caller wired to a handler that doesn't actually exist) -- this
 * session hit that shape four separate times going through Phase 3
 * (promotion gate, audit-chain verifier, injection classifier,
 * sandbox-service's browser render verifier).
 *
 * Named job-type constants that must have BOTH a real handler
 * (createPlatformJobHandlers, ./handlers.ts) and a real periodic caller
 * (main.ts). main.ts imports these by name (not by array position, which
 * would silently reorder-break) to construct its schedulers, and
 * SCHEDULED_PLATFORM_JOB_TYPES.spec.ts cross-checks the same names against
 * handlers.ts's registered keys -- a job type can drift out of sync in
 * only one of the two places before that driver test fails, instead of
 * the gap only surfacing when someone traces the wiring by hand.
 *
 * platform.notification-digest is deliberately excluded from this file:
 * NotificationDigestSchedulerRunner hardcodes it internally rather than
 * taking it as a constructor argument (unlike IntervalJobSchedulerRunner,
 * which is shared by every other entry here), so there's no main.ts call
 * site for this module to supply it to -- it's still covered by the
 * cross-check test directly.
 *
 * platform.health-ping is deliberately excluded entirely: it exists to
 * prove the Temporal -> workflow -> activity -> handler wire end to end,
 * not to run on a schedule, so it has no caller by design.
 */
export const CONNECTOR_HEALTH_SWEEP_JOB_TYPE = "platform.connector-health-sweep";
export const RETENTION_SWEEP_JOB_TYPE = "platform.retention-sweep";
// P5-2: orchestration-service's own DeletionService.applyRetentionPolicy()
// has always had a real, authenticated endpoint (/internal/deletion/retention)
// and zero scheduled caller -- the same Pattern 3 shape this file's own
// framework exists to catch, just never plugged into it. ads-core's
// retention sweep (RETENTION_SWEEP_JOB_TYPE above) covers ads-core only;
// orchestration-service's tenant-scoped tables need their own periodic
// trigger, not a reuse of ads-core's.
export const ORCHESTRATION_RETENTION_SWEEP_JOB_TYPE = "platform.orchestration-retention-sweep";
export const BENCHMARK_SWEEP_JOB_TYPE = "platform.benchmark-sweep";
export const DRIFT_SWEEP_JOB_TYPE = "platform.drift-sweep";
export const AUDIT_CHAIN_VERIFY_JOB_TYPE = "platform.audit-chain-verify";
export const AUDIT_CHAIN_FULL_VERIFY_JOB_TYPE = "platform.audit-chain-full-verify";

export const SCHEDULED_PLATFORM_JOB_TYPES = [
  "platform.notification-digest",
  CONNECTOR_HEALTH_SWEEP_JOB_TYPE,
  RETENTION_SWEEP_JOB_TYPE,
  ORCHESTRATION_RETENTION_SWEEP_JOB_TYPE,
  BENCHMARK_SWEEP_JOB_TYPE,
  DRIFT_SWEEP_JOB_TYPE,
  AUDIT_CHAIN_VERIFY_JOB_TYPE,
  AUDIT_CHAIN_FULL_VERIFY_JOB_TYPE,
] as const;

export type ScheduledPlatformJobType =
  (typeof SCHEDULED_PLATFORM_JOB_TYPES)[number];
