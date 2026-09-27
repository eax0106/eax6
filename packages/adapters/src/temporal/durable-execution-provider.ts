import {
  Client,
  Connection,
  ScheduleAlreadyRunning,
  type ScheduleOptions,
} from "@temporalio/client";

import type { ProviderCapabilities } from "@alterx/contracts";
import type {
  CronScheduleUpsertRequest,
  DurableExecutionProvider,
  DurableWorkflowHandle,
  ProviderHealth,
  ProviderMetadata,
  SignalWorkflowRequest,
  StartWorkflowRequest,
  TerminateWorkflowRequest,
  WorkflowQueryRequest,
  WorkflowQueryResult,
} from "@alterx/shared-clients";

export const TEMPORAL_HEALTH_TIMEOUT_MS = 2_000;

export interface TemporalConnectionConfig {
  readonly address: string;
  readonly namespace: string;
  readonly apiKey?: string;
  readonly taskQueue: string;
  readonly workerDeployment?: TemporalWorkerDeploymentConfig;
  readonly minimumRetentionDays?: number;
}

export interface TemporalWorkerDeploymentConfig {
  readonly deploymentName: string;
  readonly buildId: string;
}

export class TemporalConfigurationError extends Error {
  constructor(field: keyof TemporalConnectionConfig) {
    super(`Temporal connection config field "${field}" must be non-empty`);
    this.name = "TemporalConfigurationError";
  }
}

const TEMPORAL_CAPABILITIES: ProviderCapabilities = {
  streaming: false,
  tool_calling: false,
  vision: false,
  structured_output: true,
  long_context: false,
  regional_availability: [],
  data_residency: [],
  batch_support: false,
  maximum_payload: 2_000_000,
  supported_languages: [],
  cost_model: { rates: [] },
};

const TEMPORAL_METADATA: ProviderMetadata<"DurableExecutionProvider"> = {
  providerId: "temporal",
  interfaceName: "DurableExecutionProvider",
  displayName: "Temporal Durable Execution",
  version: "1.20.3",
  telemetryNamespace: "alterx.adapters.temporal",
  featureFlag: "temporal-durable-execution",
  supportsTenantOverrides: false,
  migration: {
    strategyVersion: "temporal-replay-v1",
    rollbackSupported: true,
  },
};

function assertNonEmpty(
  field: keyof TemporalConnectionConfig,
  value: string | undefined,
): void {
  if (value === undefined || value.trim().length === 0) {
    throw new TemporalConfigurationError(field);
  }
}

function elapsedMilliseconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

export class TemporalDurableExecutionProvider
  implements DurableExecutionProvider
{
  readonly metadata = TEMPORAL_METADATA;
  readonly capabilities = TEMPORAL_CAPABILITIES;

  readonly #config: TemporalConnectionConfig;
  readonly #injectedConnection: Connection | undefined;
  #connectionPromise: Promise<Connection> | undefined;
  #clientPromise: Promise<Client> | undefined;

  constructor(config: TemporalConnectionConfig, connection?: Connection) {
    assertNonEmpty("address", config.address);
    assertNonEmpty("namespace", config.namespace);
    assertNonEmpty("taskQueue", config.taskQueue);
    if (config.apiKey !== undefined) {
      assertNonEmpty("apiKey", config.apiKey);
    }

    this.#config = Object.freeze({ ...config });
    this.#injectedConnection = connection;
  }

  async startWorkflow(
    request: StartWorkflowRequest,
  ): Promise<DurableWorkflowHandle> {
    const client = await this.#getClient();
    const handle = await client.workflow.start(request.workflowType, {
      taskQueue: this.#config.taskQueue,
      workflowId: request.workflowId,
      args: [request.input],
      ...(request.executionTimeout === undefined
        ? {}
        : { workflowExecutionTimeout: request.executionTimeout }),
    });

    return {
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
    };
  }

  async signalWorkflow(request: SignalWorkflowRequest): Promise<void> {
    const client = await this.#getClient();
    await client.workflow
      .getHandle(request.workflowId)
      .signal(request.signalName, request.payload);
  }

  async queryWorkflow(
    request: WorkflowQueryRequest,
  ): Promise<WorkflowQueryResult> {
    const client = await this.#getClient();
    const value = (await client.workflow
      .getHandle(request.workflowId)
      .query(request.queryName)) as WorkflowQueryResult["value"];

    return {
      workflowId: request.workflowId,
      queryName: request.queryName,
      value,
    };
  }

  async terminateWorkflow(request: TerminateWorkflowRequest): Promise<void> {
    const client = await this.#getClient();
    await client.workflow.getHandle(request.workflowId).terminate(request.reason);
  }

  /**
   * INGR-7: create-or-update a cron Schedule. Same schedule id means the
   * same trigger; Temporal enforces schedule ids are unique, so a schedule
   * that already exists is updated in place (never duplicated). The action
   * always starts the caller's workflowType without a fixed workflowId, so
   * consecutive fires produce independent workflow executions.
   */
  async upsertCronSchedule(request: CronScheduleUpsertRequest): Promise<void> {
    const client = await this.#getClient();
    const options: ScheduleOptions = {
      scheduleId: request.scheduleId,
      spec: { cronExpressions: [request.cronExpression] },
      action: {
        type: "startWorkflow",
        workflowType: request.workflowType,
        taskQueue: this.#config.taskQueue,
        args: [request.input],
      },
    };
    try {
      await client.schedule.create(options);
    } catch (error: unknown) {
      if (!(error instanceof ScheduleAlreadyRunning)) {
        throw error;
      }
      await client.schedule.getHandle(request.scheduleId).update((previous) => ({
        ...previous,
        spec: options.spec,
        action: options.action,
      }));
    }
  }

  async deleteCronSchedule(scheduleId: string): Promise<void> {
    const client = await this.#getClient();
    try {
      await client.schedule.getHandle(scheduleId).delete();
    } catch (error: unknown) {
      // Deleting a schedule that no longer exists is the idempotent
      // no-op, not a failure: a trigger disabled twice, or a schedule
      // removed out-of-band, must not make the registry's committed
      // transition look like it did not land.
      if (
        error instanceof Error &&
        (error.message.includes("already completed") ||
          error.name === "ScheduleNotFoundError")
      ) {
        return;
      }
      throw error;
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startedAt = process.hrtime.bigint();
    const deadline = Date.now() + TEMPORAL_HEALTH_TIMEOUT_MS;
    try {
      const connection = await this.#getConnection();
      await connection.withDeadline(
        deadline,
        async () =>
          connection.workflowService.describeNamespace({
            namespace: this.#config.namespace,
          }),
      );

      return {
        status: "healthy",
        checkedAt: new Date().toISOString(),
        latencyMs: elapsedMilliseconds(startedAt),
        details: { namespaceReachable: true },
      };
    } catch (error: unknown) {
      return {
        status: "unhealthy",
        checkedAt: new Date().toISOString(),
        latencyMs: elapsedMilliseconds(startedAt),
        details: {
          namespaceReachable: false,
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
      };
    }
  }

  async close(): Promise<void> {
    if (this.#injectedConnection !== undefined) {
      return;
    }

    const connection = await this.#connectionPromise?.catch(() => undefined);
    await connection?.close();
  }

  #getConnection(): Promise<Connection> {
    if (this.#injectedConnection !== undefined) {
      return Promise.resolve(this.#injectedConnection);
    }

    this.#connectionPromise ??= Connection.connect({
      address: this.#config.address,
      connectTimeout: TEMPORAL_HEALTH_TIMEOUT_MS,
      ...(this.#config.apiKey === undefined
        ? {}
        : { apiKey: this.#config.apiKey, tls: true }),
    });
    return this.#connectionPromise;
  }

  #getClient(): Promise<Client> {
    this.#clientPromise ??= this.#getConnection().then(
      (connection) =>
        new Client({
          connection,
          namespace: this.#config.namespace,
        }),
    );
    return this.#clientPromise;
  }
}
