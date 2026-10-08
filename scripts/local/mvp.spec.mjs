import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, statSync, writeFileSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createHttp2Server } from 'node:http2';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { assertNoPnpm, assertPortFree, grpcHealth, grpcServices, health, processStamp, serviceEnvironment, services, stopOwnedProcess } from './mvp-stack.mjs';
import { assertSmokeCeiling, smoke } from './mvp-smoke.mjs';

test('smoke refuses oversized or invalid spend and conflicting execution modes', async () => {
  assertSmokeCeiling(0.25);
  for (const usd of [0.25000001, -1, NaN, Infinity]) assert.throws(() => assertSmokeCeiling(usd), /no model run started/);
  await assert.rejects(smoke({ apply: true, healthOnly: true }), /mutually exclusive/);
});

test('gRPC readiness requires a live HTTP/2 acknowledgement, not an open HTTP port', async () => {
  const server = createHttp2Server(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = `127.0.0.1:${server.address().port}`;
  try { await grpcHealth('verification-service', address); } finally { await new Promise(resolve => server.close(resolve)); }
  await assert.rejects(grpcHealth('verification-service', address), /verification-service: gRPC transport health failed/);
  const wrong = createServer(); wrong.listen(0, '127.0.0.1'); await once(wrong, 'listening');
  try { await assert.rejects(grpcHealth('verification-service', `127.0.0.1:${wrong.address().port}`), /verification-service: gRPC transport health failed/); }
  finally { await new Promise(resolve => wrong.close(resolve)); }
  assert.equal(grpcServices({ MODEL_GATEWAY_GRPC_BIND_ADDRESS: '0.0.0.0:12345' })[0].address, '127.0.0.1:12345');
});

test('health requires the named service, fails after stop, passes after restoration', async () => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: 'ok', service: request.url === '/correct' ? 'audit-service' : 'other' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port, url = `http://127.0.0.1:${port}/correct`;
  try {
    await health('audit-service', url);
    await assert.rejects(health('audit-service', `http://127.0.0.1:${port}/wrong`), /audit-service: health check failed/);
    await assert.rejects(assertPortFree('audit-service', port), /audit-service: port .* already in use/);
  } finally { await new Promise(resolve => server.close(resolve)); }
  await assert.rejects(health('audit-service', url), /audit-service: health check failed/);
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  try { await health('audit-service', url); } finally { await new Promise(resolve => server.close(resolve)); }
  await assertPortFree('audit-service', port);
});

test('shutdown ignores reused PID and stops only the recorded process group', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  await once(child, 'spawn');
  try {
    const stamp = processStamp(child.pid); assert.ok(stamp);
    await stopOwnedProcess({ pid: child.pid, stamp: 'different start time' });
    assert.equal(processStamp(child.pid), stamp);
    await stopOwnedProcess({ pid: child.pid, stamp });
    assert.equal(processStamp(child.pid), '');
    await stopOwnedProcess({ pid: child.pid, stamp });
  } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
});

test('local issuer accepts real signed JWT requests without writing request or token bodies', async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const child = spawn(process.execPath, ['scripts/local-mock-auth0/server.js'], { env: { ...process.env, MOCK_AUTH0_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  try {
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i++) { try { await health('local-mock-auth0', `${url}/.well-known/jwks.json`); break; } catch { await delay(100); } }
    const response = await fetch(`${url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audience: 'https://engine.alter.local', client_secret: 'private-test-sentinel' }) });
    assert.equal(response.status, 200);
    const token = (await response.json()).access_token;
    assert.equal(token.split('.').length, 3);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    assert.equal(payload.iss, 'https://alterx-local-m2m.test/');
    await delay(50);
    assert.ok(!output.includes('private-test-sentinel'));
    assert.ok(!output.includes(token));
  } finally { child.kill('SIGTERM'); await once(child, 'exit'); }
});

test('service inventory uses configured ports and includes every application plus local issuer', () => {
  const rows = services({ AUDIT_PORT: '12345' });
  assert.equal(rows.length, 16);
  assert.equal(rows.find(row => row.name === 'audit-service').url, 'http://127.0.0.1:12345/health');
  assert.equal(new Set(rows.map(row => row.name)).size, rows.length);
});

test('port checks refuse malformed values before opening a socket', async () => {
  for (const port of [undefined, 'socket-path', 0, 65536, '12x']) await assert.rejects(assertPortFree('audit-service', port), /audit-service: invalid port/);
});

test('installation guard detects pnpm arguments even when process executable is node', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '/tmp/pnpm.cjs'], { stdio: 'ignore' });
  await once(child, 'spawn');
  try { assert.throws(assertNoPnpm, /pnpm already running/); }
  finally { child.kill('SIGTERM'); await once(child, 'exit'); }
});

test('installation guard ignores dependency paths containing pnpm', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '/tmp/node_modules/.pnpm/server-pdf/node_modules/server-pdf/index.js'], { stdio: 'ignore' });
  await once(child, 'spawn');
  try { assert.doesNotThrow(assertNoPnpm); }
  finally { child.kill('SIGTERM'); await once(child, 'exit'); }
});

test('restarted services reuse startup mock identity, token references and disarmed model guard', () => {
  const base = {INTERNAL_SERVICE_TOKEN: 'test-only', PLATFORM_API_PORT: '3100', ADS_CORE_PORT: '8100',
    ORCHESTRATION_PORT: '3101', COST_PORT: '5100', AUDIT_PORT: '8101', MEMORY_SERVICE_PORT: '8102',
    INTELLIGENCE_SERVICE_PORT: '8103', AUTH0_M2M_TOKEN_URL: 'http://127.0.0.1:4999/oauth/token',
    AUTH0_M2M_AUDIENCE: 'local-engine', AUTH0_M2M_CLIENT_ID: 'local-client', AWS_ENDPOINT_URL: 'http://127.0.0.1:4566'};
  const env = serviceEnvironment(base);
  assert.equal(env.IDENTITY_PROVIDER, 'mock'); assert.equal(env.EMAIL_PROVIDER, 'mock');
  assert.equal(env.ENGINE_M2M_TOKEN_URL, base.AUTH0_M2M_TOKEN_URL);
  assert.equal(env.ENGINE_M2M_CLIENT_SECRET_REF, 'env:AUTH0_M2M_CLIENT_SECRET');
  assert.equal(env.EVAL_FACADE_TOKEN_REF, 'env:INTERNAL_SERVICE_TOKEN');
  for (const key of ['RETENTION_SWEEP_SERVICE_TOKEN_REF', 'ORCHESTRATION_RETENTION_SWEEP_SERVICE_TOKEN_REF',
    'EVAL_FACADE_SERVICE_TOKEN_REF', 'DRIFT_SWEEP_SERVICE_TOKEN_REF', 'AUDIT_CHAIN_VERIFY_SERVICE_TOKEN_REF']) {
    assert.equal(env[key], 'env:INTERNAL_SERVICE_TOKEN');
  }
  assert.equal(env.AWS_ENDPOINT_URL_SQS, base.AWS_ENDPOINT_URL);
  assert.equal(env.ADS_CORE_BASE_URL, 'http://127.0.0.1:8100');
  assert.equal(env.PLATFORM_API_INTERNAL_BASE_URL, 'http://127.0.0.1:3100');
  assert.equal(env.ORCHESTRATION_SERVICE_INTERNAL_BASE_URL, 'http://127.0.0.1:3101');
  assert.equal(env.AUDIT_SERVICE_INTERNAL_BASE_URL, 'http://127.0.0.1:8101');
  assert.equal(env.MEMORY_SERVICE_INTERNAL_BASE_URL, 'http://127.0.0.1:8102');
  assert.equal(env.INTELLIGENCE_SERVICE_INTERNAL_BASE_URL, 'http://127.0.0.1:8103');
  assert.equal(env.MODEL_GATEWAY_LOCAL_SMOKE, '1'); assert.equal(env.AWS_MAX_ATTEMPTS, '1');
  assert.ok(env.MODEL_GATEWAY_LOCAL_SMOKE_PERMIT_FILE.endsWith('/tmp/local-mvp/spend-permit.json'));
  assert.equal(base.ENGINE_M2M_TOKEN_URL, undefined, 'Input env stays unchanged');
});

test('startup migrates orchestration before seeding and owns the ADS gRPC server', () => {
  const source = readFileSync('scripts/local/mvp-stack.mjs', 'utf8');
  const migration = "await setup('pnpm', ['--filter', '@alterx/orchestration-service', 'db:migrate'], env);";
  const seed = "'postgres:16-alpine', 'sh', 'scripts/seed-local.sh'], env);";
  assert.ok(source.indexOf(migration) > 0 && source.indexOf(migration) < source.indexOf(seed));
  assert.match(source, /await start\(state, 'ads-core-grpc', 'uv', \['run', '--frozen', 'python', '-m', 'src\.query\.grpc_server'\]/);
});

test('owned startup helper records private process state and refuses a failed native restart', async () => {
  const dir = realpathSync(mkdtempSync(resolve(tmpdir(), 'mvp-start-control-')));
  mkdirSync(resolve(dir, 'scripts/local'), {recursive: true}); mkdirSync(resolve(dir, 'tmp/local-mvp'), {recursive: true});
  copyFileSync('scripts/local/mvp-stack.mjs', resolve(dir, 'scripts/local/mvp-stack.mjs'));
  const {start} = await import(pathToFileURL(resolve(dir, 'scripts/local/mvp-stack.mjs')).href);
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise(done => reservation.close(done));
  const state = {processes: []};
  const env = {...process.env, ALTER_SERVICE_NAME: 'foreign-service'};
  const source = `if(process.env.ALTER_SERVICE_NAME!=='audit-service')throw Error('native child service identity missing');const {createServer}=require('node:http');createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',service:'audit-service'}))}).listen(Number(process.argv[1]),'127.0.0.1');`;
  try {
    await start(state, 'audit-service', process.execPath, ['-e', source, String(port)], env, dir, `http://127.0.0.1:${port}/health`);
    assert.equal(env.ALTER_SERVICE_NAME, 'foreign-service', 'Parent environment stays unchanged');
    assert.equal(state.processes.length, 1); const row = state.processes[0];
    assert.equal(processStamp(row.pid), row.stamp);
    assert.deepEqual(JSON.parse(readFileSync(resolve(dir, 'tmp/local-mvp/state.json'), 'utf8')).processes, state.processes);
    assert.equal(statSync(resolve(dir, 'tmp/local-mvp/state.json')).mode & 0o777, 0o600);
    await stopOwnedProcess(row); assert.equal(processStamp(row.pid), '');
    await assert.rejects(start(state, 'audit-service', process.execPath, ['-e', 'process.exit(1)'], process.env, dir, `http://127.0.0.1:${port}/health`), /audit-service: (startup failed|exited during startup)/);
    assert.equal(state.processes.length, 2, 'Failed child retains ownership for cleanup');
  } finally {
    for (const row of state.processes) await stopOwnedProcess(row);
    rmSync(dir, {recursive: true, force: true});
  }
});

test('failed-init role recovery targets only the owned project and preserves existing roles', async () => {
  const dir = realpathSync(mkdtempSync(resolve(tmpdir(), 'mvp-role-control-')));
  mkdirSync(resolve(dir, 'scripts/local'), {recursive: true}); mkdirSync(resolve(dir, 'tmp/local-mvp'), {recursive: true});
  copyFileSync('scripts/local/mvp-stack.mjs', resolve(dir, 'scripts/local/mvp-stack.mjs'));
  const log = resolve(dir, 'calls.jsonl'), repaired = resolve(dir, 'repaired');
  writeFileSync(resolve(dir, 'docker'), String.raw`#!/bin/sh
printf '%s\n' "$@" >> "$MVP_CONTROL_FILE"
printf 'END\n' >> "$MVP_CONTROL_FILE"
case " $* " in
  *" bash "*) : > "$MVP_REPAIR_MARKER" ;;
  *) if [ -f "$MVP_REPAIR_MARKER" ]; then printf true; else printf '%s' "$MVP_ROLE_PROBE"; fi ;;
esac
`, {mode: 0o700});
  const {ensureRetentionRole} = await import(pathToFileURL(resolve(dir, 'scripts/local/mvp-stack.mjs')).href);
  const env = {...process.env, PATH: `${dir}:${process.env.PATH}`, MVP_CONTROL_FILE: log, MVP_REPAIR_MARKER: repaired, MVP_ROLE_PROBE: ''};
  try {
    const nativeProbe = spawnSync(resolve(dir, 'docker'), ['fixture-check'], {env, encoding: 'utf8'});
    assert.equal(nativeProbe.status, 0, `fixture command: ${nativeProbe.error?.code ?? nativeProbe.stderr}`);
    rmSync(log);
    await ensureRetentionRole(env);
    const calls = readFileSync(log, 'utf8').trim().split('\nEND').filter(Boolean).map(line => line.trim().split('\n'));
    assert.equal(calls.length, 3, 'Probe, original initializer, restored login probe');
    const project = `alter-mvp-${createHash('sha256').update(dir + '/').digest('hex').slice(0, 10)}`;
    for (const args of calls) {
      assert.deepEqual(args.slice(0, 8), ['compose', '-p', project, '--env-file', resolve(dir, '.env.mvp.local'), 'exec', '-T', 'platform-db']);
      assert.ok(!args.includes('down') && !args.includes('volume'), 'No DB volume replacement');
    }
    assert.deepEqual(calls[1].slice(8), ['bash', '/docker-entrypoint-initdb.d/10-platform-retention.sh']);
    rmSync(log); await ensureRetentionRole(env);
    assert.equal(readFileSync(log, 'utf8').trim().split('\nEND').filter(Boolean).length, 1, 'Existing login remains untouched');
    rmSync(repaired);
    for (const probe of ['false', 'malformed']) {
      rmSync(log); await assert.rejects(ensureRetentionRole({...env, MVP_ROLE_PROBE: probe}), /platform_retention role cannot log in/);
      assert.equal(readFileSync(log, 'utf8').trim().split('\nEND').filter(Boolean).length, 1, 'Existing role not altered');
    }
  } finally {rmSync(dir, {recursive: true, force: true});}
});
