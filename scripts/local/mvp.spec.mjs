import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createHttp2Server } from 'node:http2';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { assertNoPnpm, assertPortFree, grpcHealth, grpcServices, health, processStamp, services, stopOwnedProcess } from './mvp-stack.mjs';
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
