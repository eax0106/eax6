import { NativeConnection } from "@temporalio/worker";

import {
  createPlatformJobActivities,
  type PlatformJobHandler,
} from "./activities/platform-job-activities";
import type { TemporalConnectionConfig } from "./durable-execution-provider";
import { assertTemporalNamespaceReady } from "./namespace-readiness";
import { createPlatformJobsWorker } from "./worker";

export interface PlatformJobWorkerBootstrapConfig {
  readonly temporal: TemporalConnectionConfig;
}

export interface PlatformJobWorkerHandle {
  shutdown(): void;
}

/**
 * Full Platform Jobs worker bootstrap: connects to Temporal, builds the
 * activity registry, starts the worker, returns an opaque handle. This is
 * the ONLY function apps/background-workers calls -- it never touches
 * @temporalio/worker directly (adapter law: vendor SDKs live only in
 * packages/adapters). Mirrors startExecutorWorker's real shape.
 */
export async function startPlatformJobsWorker(
  config: PlatformJobWorkerBootstrapConfig,
  handlers: ReadonlyMap<string, PlatformJobHandler>,
): Promise<PlatformJobWorkerHandle> {
  const connection = await NativeConnection.connect({
    address: config.temporal.address,
    ...(config.temporal.apiKey === undefined
      ? {}
      : { apiKey: config.temporal.apiKey, tls: true }),
  });
  await assertTemporalNamespaceReady(
    connection,
    config.temporal.namespace,
    config.temporal.minimumRetentionDays,
  );

  const activities = createPlatformJobActivities(handlers);
  const worker = await createPlatformJobsWorker(
    config.temporal,
    connection,
    activities,
  );

  void worker.run();

  return {
    shutdown: () => worker.shutdown(),
  };
}
