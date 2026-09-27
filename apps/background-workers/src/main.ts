import "reflect-metadata";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { NestFactory } from "@nestjs/core";
import {
  CostClient,
  EventBridgeEventPublisher,
  RunDispatchClient,
  SqsQueueProvider,
  TemporalDurableExecutionProvider,
  createEnvironmentValidators,
  createTriggerDispatchActivities,
  startExecutorWorker,
  startPlatformJobsWorker,
} from "@alterx/adapters";
import { lazyAuth0M2mTokenProviderFromEnvironment } from "@alterx/auth";
import { AppModule } from "./app.module";
import { loadExecutorWorkerEnvironment } from "./config/environment";
import { loadCostEventConsumerEnvironment } from "./config/cost-event-consumer-environment";
import { loadCanonicalEventConsumerEnvironment } from "./config/canonical-event-consumer-environment";
import { loadPlatformJobWorkerEnvironment } from "./config/platform-job-worker-environment";
import {
  loadPlatformJobsEnvironment,
  resolveRuntimeSecret,
} from "./config/platform-jobs-environment";
import { BLACKBOARD_PROTO_PATH } from "./executor/blackboard-proto-path";
import { NODEEXEC_PROTO_PATH } from "./executor/nodeexec-proto-path";
import { COST_PROTO_PATH } from "./cost-events/cost-proto-path";
import { CostEventConsumerService } from "./cost-events/cost-event-consumer.service";
import { CostEventConsumerRunner } from "./cost-events/cost-event-consumer-runner";
import { RUNS_PROTO_PATH } from "./canonical-events/canonical-event-proto-path";
import { CanonicalEventConsumerService } from "./canonical-events/canonical-event-consumer.service";
import { CanonicalEventConsumerRunner } from "./canonical-events/canonical-event-consumer-runner";
import { createPlatformJobHandlers } from "./platform-jobs/handlers";
import { NotificationDigestSchedulerRunner } from "./platform-jobs/notification-digest-scheduler-runner";
import { IntervalJobSchedulerRunner } from "./platform-jobs/interval-job-scheduler-runner";
import {
  CONNECTOR_HEALTH_SWEEP_JOB_TYPE,
  RETENTION_SWEEP_JOB_TYPE,
  ORCHESTRATION_RETENTION_SWEEP_JOB_TYPE,
  BENCHMARK_SWEEP_JOB_TYPE,
  DRIFT_SWEEP_JOB_TYPE,
  AUDIT_CHAIN_VERIFY_JOB_TYPE,
  AUDIT_CHAIN_FULL_VERIFY_JOB_TYPE,
} from "./platform-jobs/scheduled-job-types";

const { parsePort, scopedValue } = createEnvironmentValidators(
  (field, reason) => new Error(`${field} ${reason}`),
);

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  // The health check (HTTP) and the Executor's Temporal worker are
  // independent concerns running in the same process -- the worker owns
  // no HTTP surface of its own. All vendor SDK usage (Temporal, gRPC) is
  // hidden inside startExecutorWorker (packages/adapters) -- adapter law.
  const environment = loadExecutorWorkerEnvironment(process.env);
  // ALTER_REGION/ALTER_ENV are canonical-events config; the cron-trigger
  // workflow activity publishes through the same EventBridge bus the
  // orchestration webhook path uses, so the worker reuses those values.
  const canonicalEventsConfig = loadCanonicalEventConsumerEnvironment(process.env);
  const eventBridgePublisher = new EventBridgeEventPublisher({
    region: canonicalEventsConfig.region,
    busName: `alter-${canonicalEventsConfig.alterEnvironment}`,
    ...(process.env.AWS_ENDPOINT_URL
      ? { endpoint: process.env.AWS_ENDPOINT_URL }
      : {}),
  });
  const worker = await startExecutorWorker(
    {
      temporal: {
        address: environment.temporalAddress,
        namespace: environment.temporalNamespace,
        taskQueue: environment.taskQueue,
        ...(environment.temporalApiKey === undefined
          ? {}
          : { apiKey: environment.temporalApiKey }),
        ...(environment.workerDeployment === undefined
          ? {}
          : { workerDeployment: environment.workerDeployment }),
        ...(environment.minimumRetentionDays === undefined
          ? {}
          : { minimumRetentionDays: environment.minimumRetentionDays }),
      },
      conversationTaskQueue: environment.conversationTaskQueue,
      nodeexec: {
        address: environment.nodeexecAddress,
        protoPath: NODEEXEC_PROTO_PATH,
      },
      blackboard: {
        address: environment.blackboardAddress,
        protoPath: BLACKBOARD_PROTO_PATH,
      },
    },
    {
      triggerDispatch: createTriggerDispatchActivities(eventBridgePublisher),
    },
  );

  // Cost-events consumer (OUT-4): an independent background loop in this
  // same process, same reasoning as the Executor worker above -- it owns
  // no HTTP surface of its own.
  const costEventsConfig = loadCostEventConsumerEnvironment(process.env);
  const costEventsQueueName = `alter-${costEventsConfig.alterEnvironment}-cost-events`;
  const costEventSqs = new SqsQueueProvider({
    region: costEventsConfig.region,
    ...(process.env.AWS_ENDPOINT_URL ? { endpoint: process.env.AWS_ENDPOINT_URL, useQueueUrlAsEndpoint: false } : {}),
  });
  const costEventConsumer = new CostEventConsumerService(
    costEventSqs as unknown as import("@alterx/shared-clients").QueueMessageConsumer,
    costEventsQueueName,
    new CostClient({
      address: costEventsConfig.costLedgerServiceAddress,
      protoPath: COST_PROTO_PATH,
      accessTokenProvider: lazyAuth0M2mTokenProviderFromEnvironment(process.env),
    }),
  );
  const costEventRunner = new CostEventConsumerRunner(
    costEventConsumer,
    costEventsConfig.pollIntervalMs,
  );
  costEventRunner.start();

  // Canonical-events consumer (INGR-7): drains the FIFO queue the
  // EventBridge canonical rule feeds, calling the orchestration
  // RunDispatchService.CreateRun RPC per message -- same no-HTTP-surface
  // reasoning as the cost-events loop above. Visibility-timeout based:
  // receive() leaves messages in flight for SQS to redeliver on failure.
  const canonicalEventQueueName = `alter-${canonicalEventsConfig.alterEnvironment}-events.fifo`;
  const canonicalEventSqs = new SqsQueueProvider({
    region: canonicalEventsConfig.region,
    ...(process.env.AWS_ENDPOINT_URL
      ? { endpoint: process.env.AWS_ENDPOINT_URL, useQueueUrlAsEndpoint: false }
      : {}),
  });
  const canonicalEventConsumer = new CanonicalEventConsumerService(
    canonicalEventSqs as unknown as import("@alterx/shared-clients").QueueMessageConsumer,
    canonicalEventQueueName,
    new RunDispatchClient({
      address: canonicalEventsConfig.orchestrationRunsAddress,
      protoPath: RUNS_PROTO_PATH,
    }),
  );
  const canonicalEventRunner = new CanonicalEventConsumerRunner(
    canonicalEventConsumer,
    canonicalEventsConfig.pollIntervalMs,
  );
  canonicalEventRunner.start();

  // Platform Jobs worker (Engagement Phase, doc 12): real `platform`
  // Temporal namespace, independent of the Executor worker's `engine`
  // namespace above -- separate concerns, separate task queues.
  const platformJobsEnvironment = loadPlatformJobWorkerEnvironment(process.env);
  const platformJobsConfig = loadPlatformJobsEnvironment(process.env);
  const notificationDigestServiceToken = await resolveRuntimeSecret(
    platformJobsConfig.notificationDigestServiceTokenRef,
  );
  const connectorHealthSweepServiceToken = await resolveRuntimeSecret(
    platformJobsConfig.connectorHealthSweepServiceTokenRef,
  );
  const retentionSweepServiceToken = await resolveRuntimeSecret(
    platformJobsConfig.retentionSweepServiceTokenRef,
  );
  const orchestrationRetentionSweepServiceToken = await resolveRuntimeSecret(
    platformJobsConfig.orchestrationRetentionSweepServiceTokenRef,
  );
  const evalFacadeServiceToken = await resolveRuntimeSecret(
    platformJobsConfig.evalFacadeServiceTokenRef,
  );
  const driftSweepServiceToken = await resolveRuntimeSecret(
    platformJobsConfig.driftSweepServiceTokenRef,
  );
  const auditChainVerifyServiceToken = await resolveRuntimeSecret(
    platformJobsConfig.auditChainVerifyServiceTokenRef,
  );
  const platformJobsWorker = await startPlatformJobsWorker(
    {
      temporal: {
        address: platformJobsEnvironment.temporalAddress,
        namespace: platformJobsEnvironment.temporalNamespace,
        taskQueue: platformJobsEnvironment.taskQueue,
        ...(platformJobsEnvironment.temporalApiKey === undefined
          ? {}
          : { apiKey: platformJobsEnvironment.temporalApiKey }),
        ...(platformJobsEnvironment.workerDeployment === undefined
          ? {}
          : { workerDeployment: platformJobsEnvironment.workerDeployment }),
        ...(platformJobsEnvironment.minimumRetentionDays === undefined
          ? {}
          : {
              minimumRetentionDays:
                platformJobsEnvironment.minimumRetentionDays,
            }),
      },
    },
    createPlatformJobHandlers({
      platformApiInternalBaseUrl: platformJobsConfig.platformApiInternalBaseUrl,
      notificationDigestServiceToken,
      connectorHealthSweepServiceToken,
      adsCoreInternalBaseUrl: platformJobsConfig.adsCoreInternalBaseUrl,
      retentionSweepServiceToken,
      orchestrationServiceInternalBaseUrl: platformJobsConfig.orchestrationServiceInternalBaseUrl,
      orchestrationRetentionSweepServiceToken,
      evalFacadeServiceToken,
      intelligenceServiceInternalBaseUrl: platformJobsConfig.intelligenceServiceInternalBaseUrl,
      memoryServiceInternalBaseUrl: platformJobsConfig.memoryServiceInternalBaseUrl,
      driftSweepServiceToken,
      driftSweepMinimumObservations: platformJobsConfig.driftSweepMinimumObservations,
      auditServiceInternalBaseUrl: platformJobsConfig.auditServiceInternalBaseUrl,
      auditChainVerifyServiceToken,
    }),
  );

  // Real periodic trigger for the notification digest job -- durability
  // and retry live in the Temporal workflow itself (platformJobWorkflow),
  // this loop only decides when to start a real execution.
  const digestDurableExecution = new TemporalDurableExecutionProvider({
    address: platformJobsEnvironment.temporalAddress,
    namespace: platformJobsEnvironment.temporalNamespace,
    taskQueue: platformJobsEnvironment.taskQueue,
    ...(platformJobsEnvironment.temporalApiKey === undefined
      ? {}
      : { apiKey: platformJobsEnvironment.temporalApiKey }),
  });
  const digestSchedulerRunner = new NotificationDigestSchedulerRunner(
    digestDurableExecution,
    platformJobsConfig.notificationDigestIntervalMs,
  );
  digestSchedulerRunner.start();

  // Real periodic triggers for the connector health sweep and retention
  // sweep job types -- same durable-workflow-owns-retry reasoning as the
  // digest scheduler above, reusing the same Temporal connection.
  const connectorHealthSweepRunner = new IntervalJobSchedulerRunner(
    digestDurableExecution,
    CONNECTOR_HEALTH_SWEEP_JOB_TYPE,
    "connector-health-sweep",
    platformJobsConfig.connectorHealthSweepIntervalMs,
  );
  connectorHealthSweepRunner.start();

  const retentionSweepRunner = new IntervalJobSchedulerRunner(
    digestDurableExecution,
    RETENTION_SWEEP_JOB_TYPE,
    "retention-sweep",
    platformJobsConfig.retentionSweepIntervalMs,
  );
  retentionSweepRunner.start();

  // P5-2: orchestration-service's own retention sweep -- distinct tables,
  // distinct policy, distinct schedule from ads-core's above.
  const orchestrationRetentionSweepRunner = new IntervalJobSchedulerRunner(
    digestDurableExecution,
    ORCHESTRATION_RETENTION_SWEEP_JOB_TYPE,
    "orchestration-retention-sweep",
    platformJobsConfig.orchestrationRetentionSweepIntervalMs,
  );
  orchestrationRetentionSweepRunner.start();

  const benchmarkSweepRunner = new IntervalJobSchedulerRunner(
    digestDurableExecution,
    BENCHMARK_SWEEP_JOB_TYPE,
    "benchmark-sweep",
    platformJobsConfig.benchmarkSweepIntervalMs,
  );
  benchmarkSweepRunner.start();

  const driftSweepRunner = new IntervalJobSchedulerRunner(
    digestDurableExecution,
    DRIFT_SWEEP_JOB_TYPE,
    "drift-sweep",
    platformJobsConfig.driftSweepIntervalMs,
  );
  driftSweepRunner.start();

  const auditChainVerifyRunner = new IntervalJobSchedulerRunner(
    digestDurableExecution,
    AUDIT_CHAIN_VERIFY_JOB_TYPE,
    "audit-chain-verify",
    platformJobsConfig.auditChainVerifyIntervalMs,
  );
  auditChainVerifyRunner.start();

  const auditChainFullVerifyRunner = new IntervalJobSchedulerRunner(
    digestDurableExecution,
    AUDIT_CHAIN_FULL_VERIFY_JOB_TYPE,
    "audit-chain-full-verify",
    platformJobsConfig.auditChainFullVerifyIntervalMs,
  );
  auditChainFullVerifyRunner.start();

  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().addHook("onClose", () => {
    worker.shutdown();
    void costEventRunner.stop();
    void canonicalEventRunner.stop();
    platformJobsWorker.shutdown();
    void digestSchedulerRunner.stop();
    void connectorHealthSweepRunner.stop();
    void retentionSweepRunner.stop();
    void orchestrationRetentionSweepRunner.stop();
    void benchmarkSweepRunner.stop();
    void driftSweepRunner.stop();
    void auditChainVerifyRunner.stop();
    void auditChainFullVerifyRunner.stop();
  });

  await app.listen(
    parsePort(scopedValue(process.env, "BACKGROUND_WORKERS_PORT", "PORT"), "BACKGROUND_WORKERS_PORT", 3011),
    "0.0.0.0",
  );
}

void bootstrap();
