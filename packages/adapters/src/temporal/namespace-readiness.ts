import type { NativeConnection } from "@temporalio/worker";

const SECONDS_PER_DAY = 86_400;

export class TemporalNamespaceConfigurationError extends Error {
  constructor(namespace: string, reason: string) {
    super(`Temporal namespace "${namespace}" is not production-ready: ${reason}`);
    this.name = "TemporalNamespaceConfigurationError";
  }
}

/**
 * Describe the namespace before a worker starts polling. Temporal Cloud
 * accepts a connection to an account even when a configured namespace is
 * misspelled; this converts that late polling failure into a startup failure
 * and enforces the retention floor chosen by the deployment.
 */
export async function assertTemporalNamespaceReady(
  connection: Pick<NativeConnection, "workflowService">,
  namespace: string,
  minimumRetentionDays: number | undefined,
): Promise<void> {
  const description = await connection.workflowService.describeNamespace({
    namespace,
  });
  if (minimumRetentionDays === undefined) {
    return;
  }

  const rawSeconds = description.config?.workflowExecutionRetentionTtl?.seconds;
  const retentionSeconds = rawSeconds === undefined ? Number.NaN : Number(rawSeconds);
  if (!Number.isFinite(retentionSeconds)) {
    throw new TemporalNamespaceConfigurationError(
      namespace,
      "workflow retention was not reported",
    );
  }

  const requiredSeconds = minimumRetentionDays * SECONDS_PER_DAY;
  if (retentionSeconds < requiredSeconds) {
    throw new TemporalNamespaceConfigurationError(
      namespace,
      `workflow retention is below ${minimumRetentionDays} days`,
    );
  }
}
