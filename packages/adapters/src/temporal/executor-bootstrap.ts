import { NativeConnection } from "@temporalio/worker";

import {
  createExecutorActivities,
  type ExecutorActivities,
} from "./activities/executor-activities";
import type {
  TriggerDispatchActivities,
} from "./activities/trigger-dispatch-activities";
import type { TemporalConnectionConfig } from "./durable-execution-provider";
import { assertTemporalNamespaceReady } from "./namespace-readiness";
import {
  createConversationLifecycleWorker,
  createExecutorWorker,
} from "./worker";
import { BlackboardClient, type BlackboardClientConfig } from "../grpc/blackboard-client";
import { NodeExecutionClient, type NodeExecutionClientConfig } from "../grpc/nodeexec-client";

export interface ExecutorWorkerBootstrapConfig {
  readonly temporal: TemporalConnectionConfig;
  readonly conversationTaskQueue: string;
  readonly nodeexec: NodeExecutionClientConfig;
  readonly blackboard: BlackboardClientConfig;
}

export interface ExecutorWorkerBootstrapOptions {
  /** INGR-7: cron-trigger dispatch activities registered on the same worker. */
  readonly triggerDispatch?: TriggerDispatchActivities;
}

export interface ExecutorWorkerHandle {
  shutdown(): void;
}

/**
 * Full Executor worker bootstrap: connects to Temporal, builds the
 * NodeExecutionClient + Activities, starts the worker, and returns an
 * opaque handle. This is the ONLY function apps/background-workers calls
 * -- it never touches @temporalio/worker directly (adapter law: vendor
 * SDKs live only in packages/adapters).
 */
export async function startExecutorWorker(
  config: ExecutorWorkerBootstrapConfig,
  options: ExecutorWorkerBootstrapOptions = {},
): Promise<ExecutorWorkerHandle> {
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

  const nodeExecutionClient = new NodeExecutionClient(config.nodeexec);
  const blackboardClient = new BlackboardClient(config.blackboard);
  const activities: ExecutorActivities & Partial<TriggerDispatchActivities> =
    createExecutorActivities(nodeExecutionClient, blackboardClient);
  if (options.triggerDispatch !== undefined) {
    activities.publishTriggerDispatchEvent =
      options.triggerDispatch.publishTriggerDispatchEvent;
  }
  const worker = await createExecutorWorker(config.temporal, connection, activities);
  const conversationWorker = await createConversationLifecycleWorker(
    { ...config.temporal, taskQueue: config.conversationTaskQueue },
    connection,
  );

  void worker.run();
  void conversationWorker.run();

  return {
    shutdown: () => {
      worker.shutdown();
      conversationWorker.shutdown();
    },
  };
}
