import { Logger } from "@nestjs/common";
import type { JsonValue } from "@alterx/shared-clients";
import type { PlatformJobHandler } from "@alterx/adapters";

// Real, minimal handler proving the Platform Jobs worker's end-to-end wire
// (Temporal -> workflow -> activity -> registered handler) before any real
// job type (ingestion coordination, exports, notification fan-out, etc.)
// is registered here. Each real job type is its own future ticket; none
// are stubbed here as a substitute for that real work.
const healthPingHandler: PlatformJobHandler = async (
  payload: JsonValue,
): Promise<JsonValue> => {
  return { pong: true, receivedPayload: payload };
};

export interface NotificationDigestPayload {
  readonly period_start: string;
  readonly period_end: string;
}

/**
 * Real digest-cycle trigger: calls platform-api's real internal, shared-
 * secret-authenticated route, which does the real work (real cross-tenant
 * enumeration + real per-user buildDigest). This handler is a thin real
 * HTTP relay, not a second implementation of digest logic.
 */
function createNotificationDigestHandler(
  baseUrl: string,
  serviceToken: string,
  fetchImpl: typeof fetch,
): PlatformJobHandler {
  return async (payload: JsonValue): Promise<JsonValue> => {
    const body = payload as unknown as NotificationDigestPayload;
    const response = await fetchImpl(`${baseUrl}/internal/notifications/run-due-digests`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({
        period_start: body.period_start,
        period_end: body.period_end,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `notification digest run failed: HTTP ${response.status} ${await response.text()}`,
      );
    }
    return (await response.json()) as JsonValue;
  };
}

/**
 * Real connector health sweep trigger: calls platform-api's real internal,
 * shared-secret-authenticated route, which does the real work (real
 * cross-tenant connection enumeration + real per-connection health()
 * calls). Thin real HTTP relay, no payload -- the sweep covers every
 * currently-connected connector, not a caller-supplied window.
 */
function createConnectorHealthSweepHandler(
  baseUrl: string,
  serviceToken: string,
  fetchImpl: typeof fetch,
): PlatformJobHandler {
  return async (): Promise<JsonValue> => {
    const response = await fetchImpl(`${baseUrl}/internal/integrations/run-health-sweep`, {
      method: "POST",
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    if (!response.ok) {
      throw new Error(
        `connector health sweep failed: HTTP ${response.status} ${await response.text()}`,
      );
    }
    return (await response.json()) as JsonValue;
  };
}

/**
 * Real retention sweep trigger: calls a service's own real, pre-existing
 * internal, shared-secret-authenticated retention route directly (each
 * caller of this factory is not behind platform-api). Thin real HTTP
 * relay -- the retention logic itself already exists in the target
 * service (ads-core's AdsDeletionProvider.apply_retention_policy,
 * orchestration-service's DeletionService.applyRetentionPolicy); this
 * handler only supplies the missing schedule. Reused once per service
 * that owns its own tenant-scoped retention sweep -- ads-core's data and
 * orchestration-service's data are different tables under different
 * policies, so one schedule cannot stand in for the other.
 */
function createRetentionSweepHandler(
  baseUrl: string,
  serviceToken: string,
  fetchImpl: typeof fetch,
): PlatformJobHandler {
  return async (): Promise<JsonValue> => {
    const response = await fetchImpl(`${baseUrl}/internal/deletion/retention`, {
      method: "POST",
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    if (!response.ok) {
      throw new Error(
        `retention sweep failed: HTTP ${response.status} ${await response.text()}`,
      );
    }
    return (await response.json()) as JsonValue;
  };
}

/**
 * Real, scoped to the 4 confirmed "launch-floor" golden sets
 * (apps/eval-service/src/db/launch_golden_sets.py) -- the redteam/chaos/
 * recovery sets serve a different real purpose (security/resilience
 * testing, not regular regression sweeps) and are deliberately out of
 * scope here, disclosed rather than silently swept too.
 */
const LAUNCH_FLOOR_GOLDEN_SETS = ["planner", "intent", "retrieval", "verification"] as const;

/**
 * ENGINE-FIX-P3-27 (Wave 4 item 3): the real PRD quality floor for
 * retrieval, mirrored from apps/eval-service/src/promotion_gate.py's own
 * _THRESHOLDS["retrieval_recall"] (0.90) and docs/specs/06-task-
 * breakdown.md's "Retrieval recall@10 >=90%" exit check. Kept here as a
 * disclosed duplicate, not a cross-language import (promotion_gate.py is
 * Python, this is TS) -- if that value ever changes, this one needs
 * updating too. Scoped to retrieval only: it's the only launch-floor
 * golden set with a real, PRD-sourced number to check against here (the
 * other 3 don't have an equivalent published target).
 */
const RETRIEVAL_RECALL_MINIMUM = 0.9;

function isBelowRetrievalRecallThreshold(runEvaluationResponseBody: unknown): boolean {
  if (
    typeof runEvaluationResponseBody !== "object" ||
    runEvaluationResponseBody === null ||
    !("results_json" in runEvaluationResponseBody)
  ) {
    return false;
  }
  const resultsJson = (runEvaluationResponseBody as { results_json: unknown }).results_json;
  if (typeof resultsJson !== "string") {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultsJson);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || !("pass_rate" in parsed)) {
    return false;
  }
  const passRate = (parsed as { pass_rate: unknown }).pass_rate;
  return typeof passRate === "number" && passRate < RETRIEVAL_RECALL_MINIMUM;
}

/**
 * Real scheduled benchmark sweep: calls orchestration-service's real,
 * pre-existing internal eval-facade route once per real launch-floor
 * golden set, with trigger="scheduled" so the resulting EvalRun rows are
 * real, honestly distinguishable from staff-triggered manual runs (the
 * same route BenchmarksService already relays staff-initiated runs
 * through). Per-golden-set error isolation, same real pattern as the
 * other sweep handlers.
 *
 * Before this fix, the sweep only tracked whether the RunEvaluation HTTP
 * call itself succeeded -- a real recall regression (a low but real
 * pass_rate) still counted as "processed", so the number just sat in the
 * eval_runs table, unexamined, unless a human went and queried it by
 * hand. retrievalRecallBelowThreshold makes that regression a real,
 * visible part of the sweep's own recorded result.
 */
function createBenchmarkSweepHandler(
  baseUrl: string,
  serviceToken: string,
  fetchImpl: typeof fetch,
): PlatformJobHandler {
  return async (): Promise<JsonValue> => {
    let goldenSetsProcessed = 0;
    let goldenSetsFailed = 0;
    let retrievalRecallBelowThreshold = false;
    for (const goldenSetName of LAUNCH_FLOOR_GOLDEN_SETS) {
      try {
        const response = await fetchImpl(`${baseUrl}/internal/eval/run-evaluation`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${serviceToken}`,
          },
          body: JSON.stringify({ golden_set_name: goldenSetName, trigger: "scheduled" }),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${await response.text()}`);
        }
        goldenSetsProcessed += 1;
        if (goldenSetName === "retrieval") {
          retrievalRecallBelowThreshold = isBelowRetrievalRecallThreshold(await response.json());
        }
      } catch {
        goldenSetsFailed += 1;
      }
    }
    return { goldenSetsProcessed, goldenSetsFailed, retrievalRecallBelowThreshold };
  };
}

interface DriftCandidate {
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly task_class: string;
}

function createDriftSweepHandler(
  intelligenceBaseUrl: string,
  memoryBaseUrl: string,
  serviceToken: string,
  minimumObservations: number,
  fetchImpl: typeof fetch,
  logger: Logger = new Logger("DriftSweepHandler"),
): PlatformJobHandler {
  return async (): Promise<JsonValue> => {
    const candidatesResponse = await fetchImpl(
      `${intelligenceBaseUrl}/internal/performance/drift-candidates?minimum_observations=${minimumObservations}`,
      { headers: { authorization: `Bearer ${serviceToken}` } },
    );
    if (!candidatesResponse.ok) {
      throw new Error(
        `drift candidate discovery failed: HTTP ${candidatesResponse.status} ${await candidatesResponse.text()}`,
      );
    }
    const payload = await candidatesResponse.json() as { candidates?: DriftCandidate[] };
    let scored = 0;
    let failed = 0;
    for (const candidate of payload.candidates ?? []) {
      try {
        const response = await fetchImpl(`${memoryBaseUrl}/drift/agents/score`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${serviceToken}`,
          },
          body: JSON.stringify(candidate),
        });
        if (response.ok) {
          scored += 1;
        } else {
          failed += 1;
        }
      } catch (error: unknown) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        logger.error(
          `drift candidate score failed tenant_id=${candidate.tenant_id} agent_id=${candidate.agent_id} task_class=${candidate.task_class}: ${message}`,
          stack,
        );
      }
    }
    return { candidates: payload.candidates?.length ?? 0, scored, failed };
  };
}

/**
 * ENGINE-FIX-P3-13: real trigger for the audit chain's incremental verifier
 * (AuditQueryController's POST /internal/audit-events/verify-chain) --
 * same thin-relay shape as every other sweep handler here. valid: false
 * in a 200 response is a real finding (the chain broke), not a failed
 * request -- surfaced as a thrown error so it lands as a visible job
 * failure rather than a silently "successful" sweep.
 */
function createAuditChainVerifySweepHandler(
  baseUrl: string,
  serviceToken: string,
  fetchImpl: typeof fetch,
  full: boolean,
): PlatformJobHandler {
  return async (): Promise<JsonValue> => {
    const route = full
      ? "/internal/audit-events/verify-chain/full"
      : "/internal/audit-events/verify-chain";
    const label = full ? "full audit chain verify" : "audit chain verify sweep";
    const response = await fetchImpl(`${baseUrl}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    if (!response.ok) {
      throw new Error(`${label} failed: HTTP ${response.status} ${await response.text()}`);
    }
    const result = (await response.json()) as {
      valid: boolean;
      checkedEvents: number;
      issue?: string;
      eventId?: string;
    };
    if (!result.valid) {
      throw new Error(
        `audit chain verification failed: issue=${result.issue ?? "unknown"} eventId=${result.eventId ?? "unknown"}`,
      );
    }
    return result as unknown as JsonValue;
  };
}

export interface PlatformJobHandlerDependencies {
  readonly platformApiInternalBaseUrl?: string;
  readonly notificationDigestServiceToken?: string;
  readonly connectorHealthSweepServiceToken?: string;
  readonly adsCoreInternalBaseUrl?: string;
  readonly retentionSweepServiceToken?: string;
  readonly orchestrationServiceInternalBaseUrl?: string;
  readonly orchestrationRetentionSweepServiceToken?: string;
  readonly evalFacadeServiceToken?: string;
  readonly intelligenceServiceInternalBaseUrl?: string;
  readonly memoryServiceInternalBaseUrl?: string;
  readonly driftSweepServiceToken?: string;
  readonly driftSweepMinimumObservations?: number;
  readonly auditServiceInternalBaseUrl?: string;
  readonly auditChainVerifyServiceToken?: string;
  readonly fetchImpl?: typeof fetch;
  readonly driftSweepLogger?: Logger;
}

export function createPlatformJobHandlers(
  dependencies?: PlatformJobHandlerDependencies,
): ReadonlyMap<string, PlatformJobHandler> {
  const handlers = new Map<string, PlatformJobHandler>([
    ["platform.health-ping", healthPingHandler],
  ]);
  const fetchImpl = dependencies?.fetchImpl ?? fetch;
  if (dependencies?.platformApiInternalBaseUrl && dependencies.notificationDigestServiceToken) {
    handlers.set(
      "platform.notification-digest",
      createNotificationDigestHandler(
        dependencies.platformApiInternalBaseUrl,
        dependencies.notificationDigestServiceToken,
        fetchImpl,
      ),
    );
  }
  if (dependencies?.platformApiInternalBaseUrl && dependencies.connectorHealthSweepServiceToken) {
    handlers.set(
      "platform.connector-health-sweep",
      createConnectorHealthSweepHandler(
        dependencies.platformApiInternalBaseUrl,
        dependencies.connectorHealthSweepServiceToken,
        fetchImpl,
      ),
    );
  }
  if (dependencies?.adsCoreInternalBaseUrl && dependencies.retentionSweepServiceToken) {
    handlers.set(
      "platform.retention-sweep",
      createRetentionSweepHandler(
        dependencies.adsCoreInternalBaseUrl,
        dependencies.retentionSweepServiceToken,
        fetchImpl,
      ),
    );
  }
  if (
    dependencies?.orchestrationServiceInternalBaseUrl &&
    dependencies.orchestrationRetentionSweepServiceToken
  ) {
    handlers.set(
      "platform.orchestration-retention-sweep",
      createRetentionSweepHandler(
        dependencies.orchestrationServiceInternalBaseUrl,
        dependencies.orchestrationRetentionSweepServiceToken,
        fetchImpl,
      ),
    );
  }
  if (dependencies?.orchestrationServiceInternalBaseUrl && dependencies.evalFacadeServiceToken) {
    handlers.set(
      "platform.benchmark-sweep",
      createBenchmarkSweepHandler(
        dependencies.orchestrationServiceInternalBaseUrl,
        dependencies.evalFacadeServiceToken,
        fetchImpl,
      ),
    );
  }
  if (
    dependencies?.intelligenceServiceInternalBaseUrl &&
    dependencies.memoryServiceInternalBaseUrl &&
    dependencies.driftSweepServiceToken &&
    dependencies.driftSweepMinimumObservations !== undefined
  ) {
    handlers.set(
      "platform.drift-sweep",
      createDriftSweepHandler(
        dependencies.intelligenceServiceInternalBaseUrl,
        dependencies.memoryServiceInternalBaseUrl,
        dependencies.driftSweepServiceToken,
        dependencies.driftSweepMinimumObservations,
        fetchImpl,
        dependencies.driftSweepLogger ?? new Logger("DriftSweepHandler"),
      ),
    );
  }
  if (dependencies?.auditServiceInternalBaseUrl && dependencies.auditChainVerifyServiceToken) {
    handlers.set(
      "platform.audit-chain-verify",
      createAuditChainVerifySweepHandler(
        dependencies.auditServiceInternalBaseUrl,
        dependencies.auditChainVerifyServiceToken,
        fetchImpl,
        false,
      ),
    );
    handlers.set(
      "platform.audit-chain-full-verify",
      createAuditChainVerifySweepHandler(
        dependencies.auditServiceInternalBaseUrl,
        dependencies.auditChainVerifyServiceToken,
        fetchImpl,
        true,
      ),
    );
  }
  return handlers;
}
