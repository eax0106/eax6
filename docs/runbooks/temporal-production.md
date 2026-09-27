# Temporal production rollout

Alter runs two Temporal concerns independently: Engine execution and Platform
Jobs. Local development continues to use the disposable `start-dev` server;
staging and production use durable Temporal Cloud namespaces (or an equivalent
persistent cluster) and versioned workers.

## Namespace contract

Create one Engine namespace and one Platform namespace per environment. Use
environment-qualified names such as `engine-staging` and `platform-staging`;
never share a namespace across staging and production. Configure at least
seven days of Workflow Execution retention. Worker startup describes its
namespace and refuses to poll when the configured retention floor is not met.

Inject these values into both `orchestration-service` and
`background-workers` from the deployment secret/config system:

| Variable | Meaning |
|---|---|
| `TEMPORAL_ADDRESS` | Cloud or cluster gRPC endpoint |
| `TEMPORAL_API_KEY` | Secret API key; its presence enables TLS and production validation |
| `TEMPORAL_NAMESPACE` | Engine namespace |
| `PLATFORM_TEMPORAL_NAMESPACE` | Platform Jobs namespace |
| `EXECUTOR_TASK_QUEUE` | Executor task queue |
| `CONVERSATION_LIFECYCLE_TASK_QUEUE` | Long-lived conversation task queue |
| `PLATFORM_JOBS_TASK_QUEUE` | Platform Jobs task queue |
| `TEMPORAL_MINIMUM_RETENTION_DAYS` | Engine retention floor; defaults to 7 with a Cloud API key |
| `PLATFORM_TEMPORAL_MINIMUM_RETENTION_DAYS` | Platform retention floor; defaults to 7 with a Cloud API key |

The API key is secret. Do not put it in task definitions, logs, shell history,
Terraform state, pull requests, or this runbook.

## Versioned worker rollout

Every worker image supplies the same immutable `TEMPORAL_WORKER_BUILD_ID`
(prefer the image digest or full Git commit). Engine and Platform Jobs use
separate deployment names:

- `TEMPORAL_WORKER_DEPLOYMENT_NAME=alter-engine-workers`
- `PLATFORM_TEMPORAL_WORKER_DEPLOYMENT_NAME=alter-platform-workers`

With a Cloud API key configured, startup fails unless both the applicable
deployment name and build ID are present. Workflows use `PINNED` behavior, so
an execution stays on the build that began it while the previous worker drains.

For the first versioned release:

1. Leave the current unversioned workers running.
2. Start the new versioned workers and wait until all expected task queues have
   active pollers. Engine must show both the executor and conversation queues.
3. Inspect each deployment with `temporal worker deployment describe`.
4. Ramp a small percentage of new workflows to the build:

   ```text
   temporal worker deployment set-ramping-version \
     --deployment-name <deployment> --build-id <build> --percentage 5
   ```

5. Inspect workflow failures, task-queue backlog, and worker availability.
6. Promote the same build:

   ```text
   temporal worker deployment set-current-version \
     --deployment-name <deployment> --build-id <build>
   ```

7. Keep the previous workers alive until the old version reports drained. Do
   not delete deployment versions or branches as part of a routine rollout.

Repeat ramp then promote for each later build. If a bad build is only ramping,
set its ramp percentage to zero. If it is current, set the previous good build
current again; pinned executions on the bad build still need explicit recovery.

The command shapes and migration order follow Temporal's official
[Worker CLI reference](https://docs.temporal.io/cli/worker) and
[unversioned-to-versioned migration guide](https://docs.temporal.io/production-deployment/worker-deployments/unversioned-to-versioned-migration).

## History-size protection

The conversation lifecycle is the intentionally long-lived workflow. It now
continues as new after 500 accepted signals by default, or earlier when the
Temporal server recommends rollover. Continue-As-New carries a bounded recent
query/deduplication snapshot; PostgreSQL `events` remains the complete durable
conversation history. Configure a lower threshold with
`CONVERSATION_HISTORY_ROLLOVER_EVENT_COUNT` only after load testing.

Executor runs are bounded by the compiled DAG contract (1,000 nodes and 4,000
edges) and by their recovery timeout. Platform jobs and trigger dispatches are
one-shot workflows. If load tests show either bounded class approaching the
namespace history warning, partition the work before raising Temporal limits.

## Acceptance check

In staging, prove all of the following before production promotion:

- namespace retention meets the configured floor;
- executor, conversation, and Platform Jobs queues all have versioned pollers;
- a conversation crosses a Continue-As-New boundary and retains recent query
  state and duplicate suppression;
- an executor workflow survives a worker process kill and resumes on the same
  pinned build;
- a new build ramps, promotes, rolls back, and leaves the earlier build to
  drain without nondeterminism failures.
