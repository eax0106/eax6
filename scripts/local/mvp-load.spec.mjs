import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { simulationBatch, assertStack, assertOwnedProcess, validateTrace, summarize, mockGatewayEnvironment, durableDag, assertDurableCompletion } from './mvp-load.mjs';

const root = '/owned/checkout/';
const state = { root, ready: true, project: `alter-mvp-${createHash('sha256').update(root).digest('hex').slice(0, 10)}`,
  smokeCeilingUsd: .25, gatewayDigest: 'guarded-build', processes: [
    { name: 'orchestration-service', pid: 123, stamp: 'engine-start' },
    { name: 'model-gateway', pid: 124, stamp: 'gateway-start' },
    { name: 'background-workers', pid: 125, stamp: 'worker-start' } ] };
const stamp = pid => ({123: 'engine-start', 124: 'gateway-start', 125: 'worker-start'})[pid];

test('ownership and zero-spend prerequisites fail closed before lifecycle changes', () => {
  assert.doesNotThrow(() => assertStack(state, root, stamp, 'guarded-build', false));
  for (const broken of [ {...state, root: '/foreign/'}, {...state, project: 'foreign'}, {...state, ready: false},
    {...state, smokeCeilingUsd: 1}, {...state, gatewayDigest: 'old-build'}, {...state, processes: []},
    {...state, processes: [...state.processes, state.processes[0]]} ]) {
    assert.throws(() => assertStack(broken, root, stamp, 'guarded-build', false));
  }
  assert.throws(() => assertStack(state, root, () => 'reused-pid', 'guarded-build', false));
  assert.throws(() => assertStack(state, root, stamp, 'guarded-build', true));
});

test('twenty native HTTP simulations expose a killed service and restored recovery', async () => {
  const input = { loadProbe: 'probe' }, keys = ['start', 'end'];
  const source = `
    const {createServer} = require('node:http'); let active = 0, peak = 0;
    const server = createServer(async (request, response) => {
      active++; peak = Math.max(peak, active);
      await new Promise(done => setTimeout(done, 30));
      response.writeHead(request.method === 'POST' && request.url === '/simulate' ? 200 : 400,
        {'content-type': 'application/json', 'x-peak': String(peak)});
      response.end(JSON.stringify({trace: ['start', 'end'].map(key => ({key, status: 'simulated', input: {loadProbe: 'probe'}}))}));
      active--;
    });
    server.listen(Number(process.argv[1]), '127.0.0.1', () => process.send(server.address().port));`;
  let child, port = 0, peak = 0;
  const stamp = pid => spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {encoding: 'utf8'}).stdout.trim();
  async function start() {
    child = spawn(process.execPath, ['-e', source, String(port)], {detached: true, stdio: ['ignore', 'ignore', 'inherit', 'ipc']});
    const exit = once(child, 'exit').then(() => {throw new Error('Fixture exited before readiness');});
    port = (await Promise.race([once(child, 'message'), exit]))[0];
  }
  const simulate = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/simulate`, {method: 'POST', signal: AbortSignal.timeout(1000)});
    assert.equal(response.status, 200); peak = Number(response.headers.get('x-peak'));
    validateTrace(await response.json(), keys, input);
  };
  try {
    await start();
    const row = {pid: child.pid, stamp: stamp(child.pid)};
    assertOwnedProcess(row, stamp);
    assert.throws(() => assertOwnedProcess({...row, stamp: 'reused-pid'}, stamp));
    assert.throws(() => assertOwnedProcess({pid: 1, stamp: 'foreign'}, stamp));
    process.kill(child.pid, 0); // Both rejected controls left the child alive.
    const baseline = await simulationBatch(simulate);
    assert.equal(baseline.total, 20); assert.equal(baseline.errors, 0); assert.equal(peak, 20);
    assert.ok(baseline.p95Ms >= baseline.p50Ms); assert.ok(baseline.p50Ms > 0);
    const outage = await simulationBatch(simulate, async () => {
      assertOwnedProcess(row, stamp); const exited = once(child, 'exit');
      process.kill(-row.pid, 'SIGKILL'); await exited;
    });
    assert.equal(outage.errors, 20); assert.equal(outage.errorRate, 1); assert.equal(outage.p50Ms, null);
    await start(); assert.equal((await simulationBatch(simulate)).errors, 0);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); process.kill(-child.pid, 'SIGKILL'); await exited;
    }
  }
});

test('invalid trace and missing samples cannot certify recovery', () => {
  const input = {loadProbe: 'probe'};
  const valid = {trace: [{key: 'start', status: 'simulated', input}]};
  validateTrace(valid, ['start'], input);
  for (const bad of [{trace: []}, {trace: [{key: 'other', status: 'simulated', input}]},
    {trace: [{key: 'start', status: 'completed', input}]},
    {trace: [{key: 'start', status: 'simulated', input: {loadProbe: 'wrong'}}]}]) {
    assert.throws(() => validateTrace(bad, ['start'], input));
  }
  assert.deepEqual(summarize([{ok: true, ms: 1}, {ok: true, ms: 2}, {ok: false, ms: 100}]),
    {total: 3, errors: 1, errorRate: 1/3, p50Ms: 1, p95Ms: 2});
  assert.throws(() => summarize([]));
});

test('durable evidence refuses duplicate effects, replaced executions and paid mock settings', () => {
  const env = mockGatewayEnvironment({ALTER_ENV: 'local', AWS_ENDPOINT_URL: 'http://127.0.0.1:4566',
    RUNTIME_MODE: 'real', MODEL_GATEWAY_LOCAL_SMOKE: '1', MODEL_GATEWAY_EMBEDDING_PROVIDER: 'titan', AWS_PROFILE: 'paid',
    AWS_ENDPOINT_URL_BEDROCK_RUNTIME: 'https://bedrock.example'});
  assert.equal(env.RUNTIME_MODE, 'mock'); assert.equal(env.ALTER_CONFIG_SOURCE, 'local-file');
  assert.equal(env.MODEL_GATEWAY_EMBEDDING_PROVIDER, 'mock'); assert.equal(env.MODEL_GATEWAY_LOCAL_SMOKE, undefined);
  assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true'); assert.equal(env.AWS_PROFILE, undefined);
  assert.equal(env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME, undefined);
  assert.throws(() => mockGatewayEnvironment({...env, ALTER_ENV: 'prod'}));
  assert.throws(() => mockGatewayEnvironment({...env, AWS_ENDPOINT_URL: 'https://sqs.amazonaws.com'}));
  const probe = 'durable-native-control', dag = durableDag(probe);
  assert.deepEqual(dag.nodes.map(row => row.type), ['YAMLImport', 'HumanApproval', 'YAMLImport']);
  assert.deepEqual(dag.success_criteria, []); // No model judge or external action in this fixture.
  const before = {workflowExecutionInfo: {execution: {runId: 'temporal-execution', workflowId: 'run_fixture'}, status: 'WORKFLOW_EXECUTION_STATUS_RUNNING'},
    parkedEvents: ['EVENT_TYPE_TIMER_STARTED']};
  const after = structuredClone(before); after.workflowExecutionInfo.status = 'WORKFLOW_EXECUTION_STATUS_COMPLETED';
  const history = {events: ['STARTED', 'SIGNALED', 'COMPLETED'].map(type => ({eventType: `EVENT_TYPE_WORKFLOW_EXECUTION_${type}`}))};
  const snapshot = {run: {id: 'run_fixture', status: 'completed'}, approvals: [{status: 'approved', requested_action: {probe}, node_execution_id: 'node_approval', decided_at: 'fixture-time'}], outcomes: [{run_id: 'run_fixture', verdict: 'completed_verified'}],
    nodes: dag.nodes.map(row => ({id: `node_${row.key}`, dag_node_id: row.key, status: 'succeeded', attempt: 1})),
    checkpoints: dag.nodes.map(row => ({context_key: row.key, revision: row.key === 'approval' ? 2 : 1,
      value_json: row.key === 'approval' ? {approved: true} : {probe, phase: row.key}}))};
  assertDurableCompletion(before, after, history, snapshot, probe);
  for (const mutate of [row => row.approvals.push(row.approvals[0]), row => row.outcomes.push(row.outcomes[0]),
    row => row.nodes.push(row.nodes[0]), row => row.nodes[0].attempt++, row => row.checkpoints[0].revision++,
    row => row.checkpoints[0].value_json.probe = 'wrong', row => row.run.status = 'failed',
    row => row.approvals[0].node_execution_id = 'wrong', row => row.outcomes[0].run_id = 'other']) {
    const broken = structuredClone(snapshot); mutate(broken);
    assert.throws(() => assertDurableCompletion(before, after, history, broken, probe));
  }
  const replaced = structuredClone(after); replaced.workflowExecutionInfo.execution.runId = 'new-execution';
  assert.throws(() => assertDurableCompletion(before, replaced, history, snapshot, probe));
  assert.throws(() => assertDurableCompletion(before, after, {events: [...history.events, history.events[1]]}, snapshot, probe));
  assert.throws(() => assertDurableCompletion({...before, parkedEvents: []}, after, history, snapshot, probe));
});
