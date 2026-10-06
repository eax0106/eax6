import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const name of ['orchestration-service', 'model-gateway']) {
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
    catch { return {ok: false, ms: performance.now() - started}; }
  });
  // All twenty requests are launched before the failure hook. This observes
  // request-batch recovery; structural Simulate creates no durable run IDs.
  let samples;
  try { await whilePending(); } finally { samples = await Promise.all(pending); }
  return summarize(samples);
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
  let changed = false;
  const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', {mode: 0o600});
  const owned = name => assertOwnedProcess(state.processes.find(item => item.name === name), helpers.processStamp);
  async function stop(name, crash = false) {
    const row = owned(name);
    stopped.add(name);
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
  async function restart(name) {
    if (!stopped.has(name) || restarted.has(name)) return;
    restarted.add(name); // One attempt; retain ownership state if startup fails.
    assert.notEqual(helpers.processStamp(state.processes.find(row => row.name === name).pid),
      state.processes.find(row => row.name === name).stamp, `${name}: still running; restart refused`);
    const service = all.find(row => row.name === name);
    await helpers.assertPortFree(name, service.port);
    if (name === 'model-gateway') assert.equal(existsSync(permit), false, 'Spend permit appeared; Gateway remains stopped');
    const processEnv = helpers.serviceEnvironment(env);
    const log = openSync(resolve(dir, `${name}.log`), 'a', 0o600);
    let child;
    try {
      child = spawn(name === 'model-gateway' ? 'bash' : process.execPath,
        name === 'model-gateway' ? ['scripts/run-service-aws.sh', name] : [`dist/apps/${name}/main.js`],
        {cwd: root, env: processEnv, detached: true, stdio: ['ignore', log, log]});
      await new Promise((done, reject) => {child.once('spawn', done); child.once('error', reject);});
    } finally {closeSync(log);}
    child.unref();
    const replacement = {name, pid: child.pid, stamp: helpers.processStamp(child.pid)};
    state.processes = state.processes.map(row => row.name === name ? replacement : row); save();
    assert.ok(replacement.stamp, `${name}: exited during restart`);
    for (let i = 0; ; i++) {
      assert.equal(helpers.processStamp(child.pid), replacement.stamp, `${name}: exited during restart`);
      try {await helpers.health(name, service.url); break;}
      catch {assert.ok(i < 90, `${name}: restart timed out; inspect private log`); await delay(1000);}
    }
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
    async function request(path, method = 'GET', body) {
      const response = await fetch(base + path, {method, redirect: 'error',
        signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(30000)]),
        headers: {'content-type': 'application/json', cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
          ...(method === 'GET' ? {} : {'idempotency-key': randomUUID()})},
        ...(body === undefined ? {} : {body: JSON.stringify(body)})});
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0], at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
      assert.ok(response.ok, `platform-api: ${method} ${path.split('?')[0]} HTTP ${response.status}`);
      return response.json();
    }
    const verifier = randomUUID(), redirectUri = `http://127.0.0.1:${env.PLATFORM_WEB_PORT}/auth/callback`;
    const login = await request('/api/v1/auth/login', 'POST', {redirectUri, state: randomUUID(),
      codeChallenge: createHash('sha256').update(verifier).digest('base64url')});
    assert.equal(new URL(login.url).hostname, 'mock.identity.local');
    const userId = '01930000-0000-7000-8000-000000000003';
    const signedIn = await request(`/api/v1/auth/callback?${new URLSearchParams({code: `user:${userId}`, redirect_uri: redirectUri, code_verifier: verifier})}`);
    assert.equal(signedIn.userId, userId); assert.ok(cookies.has('alter_access'));
    const created = await request('/api/v1/workflow-templates/meeting-notes-summary/instantiate', 'POST', {});
    assert.match(created.workflowId, /^wf_[0-9a-f-]+$/); assert.equal(created.status, 'compiled');
    const workflow = await request(`/api/v1/workflows/${created.workflowId}`);
    const keys = [...workflow.dag.waves].sort((a, b) => a.order - b.order).flatMap(wave => wave.node_keys);
    const input = {loadProbe: randomUUID()};
    const simulate = async () => validateTrace(await request(`/api/v1/workflows/${created.workflowId}/actions/simulate`, 'POST', {input}), keys, input);
    const baseline = await simulationBatch(simulate); assert.equal(baseline.errors, 0, 'Baseline simulations failed');
    const killedAt = performance.now();
    const outage = await simulationBatch(simulate, () => stop('orchestration-service', true));
    assert.ok(outage.errors > 0, 'Failure was not observed; no recovery certified');
    await restart('orchestration-service');
    cancelled.signal.throwIfAborted();
    const recovered = await simulationBatch(simulate); assert.equal(recovered.errors, 0, 'Restored simulations failed');
    assert.equal(existsSync(permit), false); await helpers.assertPortFree('model-gateway', all.find(row => row.name === 'model-gateway').port);
    evidence = {recordedAt: new Date().toISOString(), scope: 'local structural Simulate HTTP batches; no durable Temporal runs',
      concurrency: 20, spendCapUsd: 0, modelCalls: 0, modelCallsProof: 'Owned guarded model-gateway stopped for all workload phases; no spend permit',
      killedService: 'orchestration-service', signal: 'SIGKILL', baseline, outage, recovered,
      recoveryMs: performance.now() - killedAt, latencyScope: 'successful responses only; errors counted separately', workflowId: created.workflowId,
      runnerDigest: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')};
  } finally {
    try {
      if (changed) {
        const errors = [];
        for (const name of ['orchestration-service', 'model-gateway']) {
          try {await restart(name);} catch (error) {errors.push(error);}
        }
        if (errors.length) throw new AggregateError(errors, 'MVP restoration incomplete; ownership retained for mvp-down.sh');
        for (const row of all) await helpers.health(row.name, row.url);
        for (const row of grpc) await helpers.grpcHealth(row.name, row.address);
        state.ready = true; save();
      }
    } finally {
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      rmSync(lock, {recursive: true, force: true});
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
