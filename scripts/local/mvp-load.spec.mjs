import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { simulationBatch, assertStack, assertOwnedProcess, validateTrace, summarize } from './mvp-load.mjs';

const root = '/owned/checkout/';
const state = { root, ready: true, project: `alter-mvp-${createHash('sha256').update(root).digest('hex').slice(0, 10)}`,
  smokeCeilingUsd: .25, gatewayDigest: 'guarded-build', processes: [
    { name: 'orchestration-service', pid: 123, stamp: 'engine-start' },
    { name: 'model-gateway', pid: 124, stamp: 'gateway-start' } ] };
const stamp = pid => ({123: 'engine-start', 124: 'gateway-start'})[pid];

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
