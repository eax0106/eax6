import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export function assertStack(state, root, stamp, digest, permitExists) {
  assert.equal(state.root, root, 'Foreign MVP checkout');
  assert.equal(state.project, `alter-mvp-${createHash('sha256').update(root).digest('hex').slice(0, 10)}`, 'Foreign MVP project');
  assert.equal(state.ready, true, 'MVP stack is not ready');
  assert.equal(state.smokeCeilingUsd, .25, 'Guarded Gateway required');
  assert.equal(state.gatewayDigest, digest, 'Gateway source/build changed');
  assert.equal(permitExists, false, 'Spend permit exists; load refused');
  for (const name of ['orchestration-service', 'model-gateway', 'background-workers']) {
    const rows = state.processes.filter(row => row.name === name);
    assert.equal(rows.length, 1, `${name}: unique ownership required`);
    const row = rows[0];
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 1 && row.stamp, `${name}: invalid ownership`);
    assert.equal(stamp(row.pid), row.stamp, `${name}: stale PID ownership`);
  }
}

export function assertOwnedProcess(row, stamp) {
  assert.ok(row?.stamp && Number.isSafeInteger(row.pid) && row.pid > 1 && stamp(row.pid) === row.stamp,
    'Stale PID ownership; no signal sent');
  const group = spawnSync('ps', ['-p', String(row.pid), '-o', 'pgid='], {encoding: 'utf8'});
  assert.equal(group.status, 0); assert.equal(Number(group.stdout.trim()), row.pid, 'Not an owned process group');
  return row;
}

export function validateTrace(body, keys, input) {
  assert.deepEqual(body.trace?.map(row => row.key), keys, 'Simulation node order differs');
  assert.ok(keys.length > 0, 'Empty workflow cannot prove simulation');
  for (const row of body.trace) {
    assert.equal(row.status, 'simulated', 'Not a structural simulation');
    assert.deepEqual(row.input, input, 'Simulation input differs');
  }
}

export function summarize(samples) {
  assert.ok(samples.length > 0, 'No load samples');
  const successful = samples.filter(row => row.ok).map(row => row.ms).sort((a, b) => a - b);
  const errors = samples.length - successful.length;
  const percentile = p => successful.length ? successful[Math.ceil(successful.length * p) - 1] : null;
  return {total: samples.length, errors, errorRate: errors / samples.length, p50Ms: percentile(.5), p95Ms: percentile(.95)};
}

export async function simulationBatch(simulate, whilePending = async () => {}) {
  const pending = Array.from({length: 20}, async () => {
    const started = performance.now();
    try { await simulate(); return {ok: true, ms: performance.now() - started}; }
    catch (error) { return {ok: false, ms: performance.now() - started, error}; }
  });
  // All twenty requests are launched before the failure hook. This observes
  // request-batch recovery; structural Simulate creates no durable run IDs.
  let samples;
  try { await whilePending(); } finally { samples = await Promise.all(pending); }
  const failed = samples.find(row => !row.ok);
  return {...summarize(samples), ...(failed ? {firstError: String(failed.error?.message ?? failed.error)} : {})};
}

export function mockGatewayEnvironment(env) {
  assert.equal(env.ALTER_ENV, 'local', 'Mock Gateway requires local environment');
  const mock = {...env, NODE_ENV: 'development', ALTER_SERVICE_NAME: 'model-gateway',
    RUNTIME_MODE: 'mock', ALTER_CONFIG_SOURCE: 'local-file', MODEL_GATEWAY_EMBEDDING_PROVIDER: 'mock',
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_CONFIG_FILE: '/dev/null'};
  // Existing mock providers do not construct Bedrock/AppConfig/SSM clients.
  // Keep only the local bootstrap credentials for optional LocalStack calls.
  assert.equal(new URL(mock.AWS_ENDPOINT_URL).hostname, '127.0.0.1', 'LocalStack endpoint required');
  for (const key of ['AWS_PROFILE', 'ALTER_AWS_PROFILE', 'AWS_SESSION_TOKEN', 'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
    'MODEL_GATEWAY_LOCAL_SMOKE', 'MODEL_GATEWAY_LOCAL_SMOKE_PERMIT_FILE']) delete mock[key];
  return mock;
}

export function durableDag(probe) {
  const nodes = [
    {key: 'before', type: 'YAMLImport', config: {yaml: JSON.stringify({probe, phase: 'before'})}},
    {key: 'approval', type: 'HumanApproval', config: {requested_action: {probe, action: 'local recovery fixture'}, expiry_seconds: 600}},
    {key: 'after', type: 'YAMLImport', config: {yaml: JSON.stringify({probe, phase: 'after'})}},
  ].map(node => ({...node, metadata: {ui: {}}}));
  return {schema_version: 'v1', entry_node_keys: ['before'], nodes,
    edges: ['before', 'approval'].map((key, i) => ({key: `${key}-next`, from: key, to: nodes[i + 1].key, kind: 'sequential'})),
    waves: nodes.map((node, order) => ({key: `wave_${order}`, order, node_keys: [node.key], depends_on: order ? [`wave_${order - 1}`] : []}))};
}

export function assertDurableCompletion(before, after, history, snapshot, probe) {
  const initial = before.workflowExecutionInfo, final = after.workflowExecutionInfo;
  assert.ok(initial?.execution?.runId, 'Temporal execution missing');
  assert.equal(final?.execution?.runId, initial.execution.runId, 'Temporal execution replaced');
  assert.equal(initial.status, 'WORKFLOW_EXECUTION_STATUS_RUNNING');
  assert.equal(final.status, 'WORKFLOW_EXECUTION_STATUS_COMPLETED');
  assert.equal(final.execution.workflowId, initial.execution.workflowId);
  assert.equal(snapshot.run.id, final.execution.workflowId);
  assert.ok(before.parkedEvents.includes('EVENT_TYPE_TIMER_STARTED'), 'Approval wait was not durable before crash');
  const events = history.events;
  assert.ok(Array.isArray(events));
  for (const type of ['WORKFLOW_EXECUTION_STARTED', 'WORKFLOW_EXECUTION_COMPLETED']) {
    assert.equal(events.filter(row => row.eventType === `EVENT_TYPE_${type}`).length, 1, `Duplicate/missing ${type}`);
  }
  assert.equal(snapshot.run.status, 'completed');
  assert.equal(snapshot.approvals.length, 1, 'Duplicate/missing approval side effect');
  assert.equal(snapshot.approvals[0].status, 'approved');
  assert.equal(snapshot.approvals[0].requested_action.probe, probe);
  assert.ok(snapshot.approvals[0].decided_at, 'Approval decision missing');
  assert.equal(snapshot.outcomes.length, 1, 'Duplicate/missing run outcome');
  assert.equal(snapshot.outcomes[0].run_id, snapshot.run.id);
  assert.equal(events.filter(row => row.eventType === 'EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED').length, 1, 'Duplicate/missing approval signal');
  for (const key of ['before', 'approval', 'after']) {
    const nodes = snapshot.nodes.filter(row => row.dag_node_id === key);
    assert.equal(nodes.length, 1, `Duplicate/missing ${key} execution`);
    assert.equal(nodes[0].status, 'succeeded'); assert.equal(nodes[0].attempt, 1);
    if (key === 'approval') assert.equal(snapshot.approvals[0].node_execution_id, nodes[0].id);
    const checkpoints = snapshot.checkpoints.filter(row => row.context_key === key);
    assert.equal(checkpoints.length, 1, `Duplicate/missing ${key} checkpoint`);
    // Approval legitimately writes pending output, then its decision.
    assert.equal(checkpoints[0].revision, key === 'approval' ? 2 : 1, `${key} checkpoint writes differ`);
    if (key !== 'approval') assert.deepEqual(checkpoints[0].value_json, {probe, phase: key});
    else assert.equal(checkpoints[0].value_json.approved, true);
  }
  assert.equal(snapshot.nodes.length, 3); assert.equal(snapshot.checkpoints.length, 3);
}

export async function load(stackRoot = fileURLToPath(new URL('../../', import.meta.url))) {
  assert.equal(process.versions.node.split('.')[0], '22', 'MVP load requires Node 22');
  const root = realpathSync(stackRoot) + '/';
  const helpers = await import(pathToFileURL(resolve(root, 'scripts/local/mvp-stack.mjs')).href);
  const dir = resolve(root, 'tmp/local-mvp'), stateFile = resolve(dir, 'state.json');
  const lock = resolve(dir, 'lock'), permit = resolve(dir, 'spend-permit.json');
  let state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assertStack(state, root, helpers.processStamp, helpers.gatewayDigest(), existsSync(permit));
  const env = helpers.loadEnvironment(resolve(root, '.env.mvp.local'));
  assert.equal(env.ALTER_ENV, 'local', 'Only local MVP allowed');
  const all = helpers.services(env), grpc = helpers.grpcServices(env);
  for (const row of all) await helpers.health(row.name, row.url);
  for (const row of grpc) await helpers.grpcHealth(row.name, row.address);
  try { mkdirSync(lock); } catch { throw new Error('MVP operation already running; no resources changed'); }
  const cancelled = new AbortController();
  const interrupt = () => cancelled.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const stopped = new Set(), restarted = new Set();
  let changed = false, mockRunning = false, store, request;
  const durableRuns = [];
  const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', {mode: 0o600});
  const owned = name => assertOwnedProcess(state.processes.find(item => item.name === name), helpers.processStamp);
  async function stop(name, crash = false) {
    const row = crash ? owned(name) : state.processes.find(item => item.name === name);
    assert.ok(row?.stamp, `${name}: missing ownership`);
    stopped.add(name);
    restarted.delete(name);
    if (crash) process.kill(-row.pid, 'SIGKILL'); else await helpers.stopOwnedProcess(row);
    for (let i = 0; helpers.processStamp(row.pid) === row.stamp; i++) {
      assert.ok(i < 100, `${name}: did not stop`); await delay(50);
    }
    const service = all.find(item => item.name === name);
    await helpers.assertPortFree(name, service.port);
    for (const item of grpc.filter(item => item.name.startsWith(name))) {
      await helpers.assertPortFree(item.name, item.address.split(':').at(-1));
    }
  }
  async function restart(name, mock = false) {
    if (!stopped.has(name) || restarted.has(name)) return;
    restarted.add(name); // One attempt; retain ownership state if startup fails.
    assert.notEqual(helpers.processStamp(state.processes.find(row => row.name === name).pid),
      state.processes.find(row => row.name === name).stamp, `${name}: still running; restart refused`);
    const service = all.find(row => row.name === name);
    await helpers.assertPortFree(name, service.port);
    if (name === 'model-gateway') assert.equal(existsSync(permit), false, 'Spend permit appeared; Gateway remains stopped');
    const processEnv = mock ? mockGatewayEnvironment(helpers.serviceEnvironment(env)) : helpers.serviceEnvironment(env);
    state.processes = state.processes.filter(row => row.name !== name);
    const realGateway = name === 'model-gateway' && !mock;
    await helpers.start(state, name, realGateway ? 'bash' : process.execPath,
      realGateway ? ['scripts/run-service-aws.sh', name] : [`dist/apps/${name}/main.js`],
      processEnv, root, service.url);
    for (const row of grpc.filter(row => row.name.startsWith(name))) await helpers.grpcHealth(row.name, row.address);
    stopped.delete(name);
  }
  let evidence;
  try {
    // Recheck inside the lifecycle lock, then keep smoke disarmed throughout.
    state = JSON.parse(readFileSync(stateFile, 'utf8'));
    assertStack(state, root, helpers.processStamp, helpers.gatewayDigest(), existsSync(permit));
    state.ready = false; save(); changed = true;
    await stop('model-gateway');
    const base = `http://127.0.0.1:${env.PLATFORM_API_PORT}`, cookies = new Map();
    request = async (path, method = 'GET', body, headers = {}, metadata = false) => {
      const response = await fetch(base + path, {method, redirect: 'error',
        signal: path.endsWith('/actions/cancel') ? AbortSignal.timeout(5000) : AbortSignal.any([cancelled.signal, AbortSignal.timeout(30000)]),
        headers: {'content-type': 'application/json', cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
          ...(method === 'GET' ? {} : {'idempotency-key': randomUUID()}), ...headers},
        ...(body === undefined ? {} : {body: JSON.stringify(body)})});
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0], at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
      assert.ok(response.ok, `platform-api: ${method} ${path.split('?')[0]} HTTP ${response.status}`);
      const data = response.status === 204 ? null : await response.json();
      return metadata ? {data, etag: response.headers.get('etag')} : data;
    };
    const verifier = randomUUID(), redirectUri = `http://127.0.0.1:${env.PLATFORM_WEB_PORT}/auth/callback`;
    const login = await request('/api/v1/auth/login', 'POST', {redirectUri, state: randomUUID(),
      codeChallenge: createHash('sha256').update(verifier).digest('base64url')});
    assert.equal(new URL(login.url).hostname, 'mock.identity.local');
    const userId = '01930000-0000-7000-8000-000000000003';
    const signedIn = await request(`/api/v1/auth/callback?${new URLSearchParams({code: `user:${userId}`, redirect_uri: redirectUri, code_verifier: verifier})}`);
    assert.equal(signedIn.userId, userId); assert.ok(cookies.has('alter_access'));
    const created = await request('/api/v1/workflow-templates/meeting-notes-summary/instantiate', 'POST', {});
    assert.match(created.workflowId, /^wf_[0-9a-f-]+$/); assert.equal(created.status, 'compiled');
    const read = await request(`/api/v1/workflows/${created.workflowId}`, 'GET', undefined, {}, true);
    assert.ok(read.etag);
    // Simulate validates the saved builder canvas, which instantiate does not
    // write; save the compiled template DAG as the canvas, as the durable phase does.
    await request(`/api/v1/workflows/${created.workflowId}`, 'PATCH', {dag: read.data.dag}, {'if-match': read.etag});
    const workflow = read.data;
    const keys = [...workflow.dag.waves].sort((a, b) => a.order - b.order).flatMap(wave => wave.node_keys);
    const input = {loadProbe: randomUUID()};
    const simulate = async () => validateTrace(await request(`/api/v1/workflows/${created.workflowId}/actions/simulate`, 'POST', {input}), keys, input);
    const baseline = await simulationBatch(simulate); assert.equal(baseline.errors, 0, `Baseline simulations failed: ${baseline.firstError}`);
    const killedAt = performance.now();
    const outage = await simulationBatch(simulate, () => stop('orchestration-service', true));
    assert.ok(outage.errors > 0, 'Failure was not observed; no recovery certified');
    await restart('orchestration-service');
    cancelled.signal.throwIfAborted();
    const recovered = await simulationBatch(simulate); assert.equal(recovered.errors, 0, `Restored simulations failed: ${recovered.firstError}`);
    assert.equal(existsSync(permit), false); await helpers.assertPortFree('model-gateway', all.find(row => row.name === 'model-gateway').port);
    evidence = {recordedAt: new Date().toISOString(), scope: 'local structural Simulate HTTP batches; no durable Temporal runs',
      concurrency: 20, spendCapUsd: 0, modelCalls: 0, modelCallsProof: 'Owned guarded model-gateway stopped for all structural workload phases; no spend permit',
      killedService: 'orchestration-service', signal: 'SIGKILL', baseline, outage, recovered,
      recoveryMs: performance.now() - killedAt, latencyScope: 'successful responses only; errors counted separately', workflowId: created.workflowId,
      runnerDigest: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')};
    // Separate real-run proof. HumanApproval is the durable barrier and the
    // observable DB side effect; fixture nodes have no external actions or LLMs.
    assert.match(env.TEMPORAL_ADDRESS, /^127\.0\.0\.1:\d+$/, 'Only local Temporal allowed');
    assert.equal(env.TEMPORAL_ADDRESS.split(':')[1], env.TEMPORAL_PORT || '7233');
    assert.ok(!env.TEMPORAL_API_KEY, 'Cloud Temporal credential not permitted');
    assert.equal(new URL(env.ORCHESTRATION_DATABASE_URL).hostname, '127.0.0.1', 'Local Engine DB required');
    const gatewayLog = resolve(dir, 'model-gateway.log');
    const logStart = readFileSync(gatewayLog, 'utf8').length;
    mockRunning = true;
    await restart('model-gateway', true);
    assert.match(readFileSync(gatewayLog, 'utf8').slice(logStart), /Embedding provider: mock/, 'Mock Gateway boot was not observed');
    const {PostgresOrchestrationStoreProvider} = await import(pathToFileURL(resolve(root, 'packages/adapters/dist/index.js')).href);
    store = new PostgresOrchestrationStoreProvider({authentication: 'static', connectionString: env.ORCHESTRATION_DATABASE_URL,
      migrationsFolder: resolve(root, 'apps/orchestration-service/drizzle')});
    const tenant = '01930000-0000-7000-8000-000000000001';
    async function snapshot(runId) {
      try {return await store.withTenant(tenant, async tx => {
        const read = async (table, columns) => (await tx.query(`SELECT ${columns} FROM ${table} WHERE tenant_id=$1 AND ${table === 'runs' ? 'id' : 'run_id'}=$2`, [tenant, runId])).rows;
        return {run: (await read('runs', 'id,status'))[0], approvals: await read('approvals', 'id,status,requested_action,node_execution_id,decided_at'),
          nodes: await read('node_executions', 'id,dag_node_id,status,attempt'), outcomes: await read('run_outcomes', 'run_id,verdict'),
          checkpoints: await read('blackboard_checkpoints', 'context_key,revision,value_json')};
      });} catch {throw new Error(`run ${runId}: local RLS snapshot failed`);}
    }
    function temporal(action, runId) {
      assert.match(runId, /^run_[0-9a-f-]+$/);
      const result = spawnSync('docker', ['compose', '-p', state.project, '--env-file', resolve(root, '.env.mvp.local'), 'exec', '-T', 'temporal',
        'temporal', 'workflow', action, '--workflow-id', runId, '--namespace', env.TEMPORAL_NAMESPACE,
        '--address', '127.0.0.1:7233', '--output', 'json', '--command-timeout', '10s', '--disable-config-env', '--disable-config-file', ...(action === 'describe' ? ['--raw'] : [])],
      {cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024});
      assert.equal(result.status, 0, `run ${runId}: local Temporal ${action} failed`);
      return JSON.parse(result.stdout);
    }
    const probe = randomUUID(), fixture = await request('/api/v1/workflow-templates/meeting-notes-summary/instantiate', 'POST', {});
    const fixtureRead = await request(`/api/v1/workflows/${fixture.workflowId}`, 'GET', undefined, {}, true);
    assert.ok(fixtureRead.etag);
    await request(`/api/v1/workflows/${fixture.workflowId}`, 'PATCH', {dag: durableDag(probe)}, {'if-match': fixtureRead.etag});
    const version = await request(`/api/v1/workflows/${fixture.workflowId}/actions/compile`, 'POST', {});
    for (let i = 0; i < 5; i++) {
      const run = await request('/api/v1/runs', 'POST', {workflow_id: fixture.workflowId, workflow_version_id: version.id});
      assert.match(run.id, /^run_[0-9a-f-]+$/); durableRuns.push(run.id);
      assert.ok(['pending', 'running'].includes(run.status), `run ${run.id}: mock mode could not start a real workflow`);
    }
    const parked = [];
    for (const runId of durableRuns) {
      let row;
      for (let i = 0; i < 120; i++) {
        cancelled.signal.throwIfAborted(); row = await snapshot(runId);
        if (row.approvals.length) break;
        assert.ok(['pending', 'running'].includes(row.run.status), `run ${runId}: mock-mode run failed before approval`);
        await delay(500);
      }
      assert.equal(row.run.status, 'running'); assert.equal(row.approvals.length, 1);
      assert.equal(row.approvals[0].status, 'pending');
      assert.equal(row.nodes.find(node => node.dag_node_id === 'before')?.status, 'succeeded');
      assert.ok(!row.nodes.some(node => node.dag_node_id === 'after'), 'Run passed barrier before crash');
      let parkedHistory;
      for (let i = 0; i < 20; i++) {
        parkedHistory = temporal('show', runId);
        if (parkedHistory.events.some(event => event.eventType === 'EVENT_TYPE_TIMER_STARTED')) break;
        cancelled.signal.throwIfAborted(); await delay(250);
      }
      assert.ok(parkedHistory.events.some(event => event.eventType === 'EVENT_TYPE_TIMER_STARTED'), 'Approval wait not persisted; no worker killed');
      parked.push({runId, approvalId: row.approvals[0].id, before: {...temporal('describe', runId),
        parkedEvents: parkedHistory.events.map(event => event.eventType)}});
    }
    const durableKilledAt = performance.now();
    await stop('background-workers', true);
    // Signals are durable while no worker exists. They must be consumed by
    // the fresh worker, with no second approval request or workflow start.
    for (const row of parked) await request(`/api/v1/approvals/${row.approvalId}/actions/approve`, 'POST', {note: 'Local durable recovery fixture'});
    for (const row of parked) assert.equal(temporal('describe', row.runId).workflowExecutionInfo.status, 'WORKFLOW_EXECUTION_STATUS_RUNNING');
    await restart('background-workers');
    const finished = [];
    for (const row of parked) {
      let persisted;
      for (let i = 0; i < 120; i++) {
        cancelled.signal.throwIfAborted(); persisted = await snapshot(row.runId);
        if (persisted.run.status === 'completed' && persisted.outcomes.length) break;
        assert.ok(['pending', 'running', 'completed'].includes(persisted.run.status), `run ${row.runId}: recovery failed`);
        await delay(500);
      }
      let after;
      for (let i = 0; i < 20; i++) {
        after = temporal('describe', row.runId);
        if (after.workflowExecutionInfo.status === 'WORKFLOW_EXECUTION_STATUS_COMPLETED') break;
        assert.equal(after.workflowExecutionInfo.status, 'WORKFLOW_EXECUTION_STATUS_RUNNING'); await delay(250);
      }
      const history = temporal('show', row.runId);
      assertDurableCompletion(row.before, after, history, persisted, probe);
      finished.push({runId: row.runId, temporalRunId: after.workflowExecutionInfo.execution.runId,
        before: {workflowExecutionInfo: row.before.workflowExecutionInfo, parkedEvents: row.before.parkedEvents}, after: {workflowExecutionInfo: after.workflowExecutionInfo},
        history: {events: history.events.map(event => ({eventType: event.eventType}))}, snapshot: persisted, probe});
    }
    evidence.durable = {scope: 'five real local Temporal runs; deterministic approval barrier and persisted DB effects',
      runs: finished, concurrency: 5, spendCapUsd: 0, bedrockCalls: 0, gatewayMode: 'mock', embeddingProvider: 'mock',
      killedService: 'background-workers', signal: 'SIGKILL', recoveryMs: performance.now() - durableKilledAt,
      effectsScope: 'approval requests/decisions, node checkpoints and run outcomes; no external actions or model-quality claim'};
  } catch (error) {
    for (const runId of durableRuns) {
      // Cancel only this invocation's created runs before restoring real Gateway.
      try {
        await request(`/api/v1/runs/${runId}/actions/cancel`, 'POST', {});
      } catch {console.error(`run ${runId}: local cancellation unconfirmed; real Gateway remains disarmed`);}
    }
    throw error;
  } finally {
    try {
      if (changed) {
        const errors = [];
        if (mockRunning) {try {await stop('model-gateway');} catch (error) {errors.push(error);}}
        for (const name of ['orchestration-service', 'background-workers', 'model-gateway']) {
          try {await restart(name);} catch (error) {errors.push(error);}
        }
        if (errors.length) throw new AggregateError(errors, 'MVP restoration incomplete; ownership retained for mvp-down.sh');
        for (const row of all) await helpers.health(row.name, row.url);
        for (const row of grpc) await helpers.grpcHealth(row.name, row.address);
        state.ready = true; save();
      }
    } finally {
      try {await store?.close();} finally {
        process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
        rmSync(lock, {recursive: true, force: true});
      }
    }
  }
  writeFileSync(resolve(dir, 'load-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', {mode: 0o600});
  console.log(JSON.stringify(evidence)); console.log('MVP LOCAL LOAD VERIFIED');
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !args[0].startsWith('--stack-root='))) {
    console.error('Usage: mvp-load.mjs [--stack-root=PATH]'); process.exitCode = 2;
  } else load(args[0]?.slice(13)).catch(error => {console.error(error.message); process.exitCode = 1;});
}
