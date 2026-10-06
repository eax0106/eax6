import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { connect as connectHttp2 } from 'node:http2';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
const stateDir = resolve(root, 'tmp/local-mvp');
const stateFile = resolve(stateDir, 'state.json');
const envFile = resolve(root, '.env.mvp.local');
const project = `alter-mvp-${createHash('sha256').update(root).digest('hex').slice(0, 10)}`;
const pythonServices = ['ads-core', 'memory-service', 'intelligence-service', 'verification-service', 'eval-service'];
const nodeServices = ['audit-service', 'cost-ledger-service', 'model-gateway', 'tool-gateway', 'sandbox-service', 'provisioning-service', 'orchestration-service', 'platform-api', 'background-workers'];

export function gatewayDigest() {
  const digest = createHash('sha256');
  for (const path of ['main', 'app.module', 'config/environment', 'gateway/model-gateway.service', 'gateway/local-smoke-budget']) {
    digest.update(readFileSync(resolve(root, `dist/apps/model-gateway/${path}.js`)));
    digest.update(readFileSync(resolve(root, `apps/model-gateway/src/${path}.ts`)));
  }
  digest.update(readFileSync(resolve(root, 'scripts/run-service-aws.sh')));
  return digest.digest('hex');
}

export function command(program, args, env, cwd = root) {
  const result = spawnSync(program, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error(`${program} ${args[0] ?? ''} failed; see ${stateDir}/setup.log`);
  return result.stdout;
}

export function loadEnvironment(file = envFile) {
  // Reuse the bootstrap's shell expansion; capture values privately, never print them.
  const output = command('bash', ['-c', 'set -a; source "$1"; env -0', 'mvp-env', file], process.env);
  return Object.fromEntries(output.split('\0').filter(Boolean).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
}

export async function assertPortFree(name, port) {
  if (!/^[0-9]+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error(`${name}: invalid port`);
  const server = createServer();
  await new Promise((resolvePort, reject) => {
    server.once('error', () => reject(new Error(`${name}: port ${port} already in use; no process stopped`)));
    server.listen(Number(port), '127.0.0.1', resolvePort);
  });
  await new Promise(resolveClose => server.close(resolveClose));
}

export async function health(name, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('HTTP failure');
    if (!['platform-web', 'local-mock-auth0'].includes(name)) {
      const body = await response.json();
      if (body.status !== 'ok' || body.service !== name) throw new Error('wrong service identity');
    } else if (name === 'local-mock-auth0') {
      const body = await response.json();
      if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error('missing issuer keys');
    }
  } catch { throw new Error(`${name}: health check failed at ${url}`); }
}

export async function grpcHealth(name, address) {
  const session = connectHttp2(`http://${address}`);
  try {
    await new Promise((done, reject) => {
      const timeout = setTimeout(() => reject(new Error('HTTP/2 timeout')), 3000);
      session.once('error', reject);
      session.once('connect', () => session.ping(error => {
        clearTimeout(timeout); error ? reject(error) : done();
      }));
      session.once('close', () => { clearTimeout(timeout); reject(new Error('HTTP/2 connection closed')); });
    });
  } catch { throw new Error(`${name}: gRPC transport health failed at ${address}`); }
  finally { session.destroy(); }
}

export function grpcServices(env) {
  const defaults = {
    MODEL_GATEWAY: [50051, 'model-gateway'], TOOL_GATEWAY: [50053, 'tool-gateway'],
    SANDBOX: [50057, 'sandbox-service'], PROVISIONING: [50055, 'provisioning-service'],
    AUDIT: [50068, 'audit-service'], COST: [50069, 'cost-ledger-service'],
    CONVERSATION: [50052, 'orchestration-service conversation'], COMPILER: [50056, 'orchestration-service compiler'],
    RECOVERY: [50058, 'orchestration-service recovery'], RUNS: [50059, 'orchestration-service runs'],
    REGISTRY: [50063, 'orchestration-service registry'], NODEEXEC: [50064, 'orchestration-service nodeexec'],
    BLACKBOARD: [50065, 'orchestration-service blackboard'], DEPLOYCTL: [50066, 'orchestration-service deployctl'],
    ARTIFACT_CONTENT: [50067, 'orchestration-service artifact-content'], ADS_Q: [50050, 'ads-core query'],
  };
  return [...Object.entries(defaults).map(([key, [port, name]]) => ({ name,
    address: (env[`${key}_GRPC_BIND_ADDRESS`] || `127.0.0.1:${port}`).replace(/^0\.0\.0\.0:/, '127.0.0.1:') })),
  { name: 'verification-service', address: '127.0.0.1:50054' },
  { name: 'memory-service', address: '127.0.0.1:50060' },
  { name: 'intelligence-service capability', address: '127.0.0.1:50061' },
  { name: 'eval-service', address: '127.0.0.1:50062' }];
}

export function processStamp(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

export function assertNoPnpm() {
  // Match process arguments privately: pnpm's executable often appears as
  // "node" in comm. Never print other processes' argument strings.
  const result = spawnSync('pgrep', ['-f', '[p]npm'], { encoding: 'utf8' });
  if (result.error || ![0, 1].includes(result.status)) throw new Error('Cannot check concurrent pnpm; installation refused');
  for (const pid of result.stdout.trim().split(/\s+/).filter(Boolean)) {
    const args = spawnSync('ps', ['-p', pid, '-o', 'args='], { encoding: 'utf8' });
    if (args.error) throw new Error('Cannot inspect concurrent pnpm; installation refused');
    if (/(?:^|\s)(?:\S*\/)?pnpm(?:\.(?:c?js|mjs))?(?:\s|$)/.test(args.stdout)) {
      throw new Error('pnpm already running; installation refused');
    }
  }
}

export async function stopOwnedProcess(row) {
  if (!row.stamp || processStamp(row.pid) !== row.stamp) return;
  try { process.kill(-row.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (let i = 0; i < 100; i++) {
    if (processStamp(row.pid) !== row.stamp) return;
    await delay(100);
  }
  if (processStamp(row.pid) === row.stamp) process.kill(-row.pid, 'SIGKILL');
}

export function services(env) {
  const ports = {
    'audit-service': 'AUDIT_PORT', 'cost-ledger-service': 'COST_PORT', 'model-gateway': 'MODEL_GATEWAY_PORT',
    'tool-gateway': 'TOOL_GATEWAY_PORT', 'sandbox-service': 'SANDBOX_SERVICE_PORT', 'provisioning-service': 'PROVISIONING_SERVICE_PORT',
    'orchestration-service': 'ORCHESTRATION_PORT', 'platform-api': 'PLATFORM_API_PORT', 'background-workers': 'BACKGROUND_WORKERS_PORT',
    'ads-core': 'ADS_CORE_PORT', 'memory-service': 'MEMORY_SERVICE_PORT', 'intelligence-service': 'INTELLIGENCE_SERVICE_PORT',
    'verification-service': 'VERIFICATION_SERVICE_PORT', 'eval-service': 'EVAL_SERVICE_PORT', 'platform-web': 'PLATFORM_WEB_PORT',
    'local-mock-auth0': 'MOCK_AUTH0_PORT',
  };
  return Object.entries(ports).map(([name, key]) => ({ name, port: env[key],
    url: `http://127.0.0.1:${env[key]}${name === 'platform-web' ? '/' : name === 'local-mock-auth0' ? '/.well-known/jwks.json' : '/health'}` }));
}

async function setup(program, args, env, cwd = root) {
  const log = openSync(resolve(stateDir, 'setup.log'), 'a', 0o600);
  try {
    await new Promise((done, reject) => {
      const child = spawn(program, args, { cwd, env, stdio: ['ignore', log, log] });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? done() : reject(new Error(`${program} ${args.join(' ')} failed; see ${stateDir}/setup.log`)));
    });
  } finally { closeSync(log); }
}

function save(state) { writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); }
export async function start(state, name, program, args, env, cwd = root, url) {
  console.log(`Starting ${name}`);
  const log = openSync(resolve(stateDir, `${name}.log`), 'a', 0o600);
  const child = spawn(program, args, { cwd, env, detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
  child.unref();
  const row = { name, pid: child.pid, stamp: processStamp(child.pid) };
  state.processes.push(row); save(state);
  if (!row.stamp) throw new Error(`${name}: exited during startup; see ${stateDir}/${name}.log`);
  if (!url) return;
  for (let i = 0; i < 90; i++) {
    if (processStamp(row.pid) !== row.stamp) break;
    try { await health(name, url); console.log(`${name} healthy`); return; } catch { await delay(1000); }
  }
  throw new Error(`${name}: startup failed; see ${stateDir}/${name}.log`);
}

async function down(state) {
  rmSync(resolve(stateDir, 'spend-permit.json'), { force: true });
  for (const row of [...state.processes].reverse()) await stopOwnedProcess(row);
  if (state.composeStarted) await setup('docker', ['compose', '-p', project, '--env-file', envFile, 'down'], loadEnvironment());
  rmSync(stateFile, { force: true });
  console.log('MVP stopped; local data and credentials preserved');
}

export function serviceEnvironment(base = loadEnvironment()) {
  const env = { ...base, NODE_ENV: 'development', NX_DAEMON: 'false', NX_INTERACTIVE: 'false',
    IDENTITY_PROVIDER: 'mock', EMAIL_PROVIDER: 'mock', VITE_API_MODE: 'live',
    PLATFORM_API_PROXY_TARGET: 'http://127.0.0.1:3020', ALTER_LOCAL_ENV_FILE: envFile, COMPOSE_PROJECT_NAME: project };
  env.ADS_CORE_BASE_URL = `http://127.0.0.1:${env.ADS_CORE_PORT}`;
  env.COST_LEDGER_BASE_URL = `http://127.0.0.1:${env.COST_PORT}`;
  env.AUDIT_SERVICE_BASE_URL = `http://127.0.0.1:${env.AUDIT_PORT}`;
  env.PLATFORM_API_PROXY_TARGET = `http://127.0.0.1:${env.PLATFORM_API_PORT}`;
  for (const key of ['EVAL_FACADE_TOKEN_REF', 'DEPLOYMENT_ADMIN_SERVICE_TOKEN_REF', 'AUDIT_QUERY_SERVICE_TOKEN_REF',
    'CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN_REF', 'NOTIFICATION_DIGEST_SERVICE_TOKEN_REF']) env[key] = 'env:INTERNAL_SERVICE_TOKEN';
  env.ENGINE_M2M_TOKEN_URL = env.AUTH0_M2M_TOKEN_URL;
  env.ENGINE_M2M_AUDIENCE = env.AUTH0_M2M_AUDIENCE;
  env.ENGINE_M2M_CLIENT_ID = env.AUTH0_M2M_CLIENT_ID;
  env.ENGINE_M2M_CLIENT_SECRET_REF = 'env:AUTH0_M2M_CLIENT_SECRET';
  env.AWS_ENDPOINT_URL_SQS = env.AWS_ENDPOINT_URL;
  env.MODEL_GATEWAY_LOCAL_SMOKE = '1';
  env.MODEL_GATEWAY_LOCAL_SMOKE_PERMIT_FILE = resolve(stateDir, 'spend-permit.json');
  env.AWS_MAX_ATTEMPTS = '1';
  return env;
}

async function up() {
  if (existsSync(stateFile)) throw new Error('MVP state exists; run scripts/local/mvp-down.sh before starting again');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (!existsSync(envFile)) await setup('bash', ['scripts/bootstrap-env-local.sh', '--out', envFile], { ...process.env, COMPOSE_PROJECT_NAME: project });
  const env = serviceEnvironment();
  rmSync(env.MODEL_GATEWAY_LOCAL_SMOKE_PERMIT_FILE, { force: true });
  const all = services(env);
  // Refuse every collision before creating a container or starting a process.
  const ports = new Map();
  const addPort = (port, name) => {
    const number = Number(port);
    if (ports.has(number)) throw new Error(`${name}: port ${port} also configured for ${ports.get(number)}`);
    ports.set(number, name);
  };
  for (const row of all) addPort(row.port, row.name);
  const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
  for (const [, key, fallback] of compose.matchAll(/\$\{([A-Z_]+_PORT):-([0-9]+)\}/g)) addPort(env[key] || fallback, key);
  for (const row of grpcServices(env)) addPort(row.address.split(':').at(-1), `${row.name} gRPC`);
  for (const [port, name] of ports) await assertPortFree(name, port);
  if (!existsSync(resolve(root, 'node_modules'))) {
    assertNoPnpm();
    await setup('pnpm', ['install', '--frozen-lockfile'], env);
  }
  await setup('pnpm', ['exec', 'nx', 'run-many', '-t', 'build', '--all', '--parallel=2'], env);
  const state = { root, project, processes: [], composeStarted: true, smokeCeilingUsd: 0.25, gatewayDigest: gatewayDigest() };
  save(state);
  try {
    await setup('docker', ['compose', '-p', project, '--env-file', envFile, 'up', '-d', '--wait'], env);
    const byName = new Map(all.map(row => [row.name, row]));
    await start(state, 'local-mock-auth0', process.execPath, ['scripts/local-mock-auth0/server.js'], env, root, byName.get('local-mock-auth0').url);
    await setup('pnpm', ['--filter', '@alterx/platform-api', 'db:migrate'], env);
    for (const name of pythonServices.filter(name => name !== 'verification-service')) await setup('uv', ['run', '--frozen', 'alembic', 'upgrade', 'head'], env, resolve(root, 'apps', name));
    for (const name of nodeServices.filter(name => !['platform-api', 'background-workers'].includes(name))) {
      const args = name === 'model-gateway' ? ['scripts/run-service-aws.sh', name] : [`dist/apps/${name}/main.js`];
      await start(state, name, name === 'model-gateway' ? 'bash' : process.execPath, args, env, root, byName.get(name).url);
    }
    await setup('docker', ['run', '--rm', '--network', `${project}_default`, '-v', `${root}:/repo:ro`, '-w', '/repo',
      '-e', 'AUDIT_DB_PASSWORD', '-e', 'PLATFORM_DB_PASSWORD', '-e', 'INTELLIGENCE_DB_PASSWORD', '-e', 'ORCHESTRATION_DB_PASSWORD',
      '-e', 'PLATFORM_DB_HOST=platform-db', '-e', 'PLATFORM_DB_PORT=5432', '-e', 'ENGINE_DB_HOST=engine-db', '-e', 'ENGINE_DB_PORT=5432',
      'postgres:16-alpine', 'sh', 'scripts/seed-local.sh'], env);
    for (const name of pythonServices) {
      await start(state, name, 'uv', ['run', '--frozen', 'uvicorn', 'src.main:app', '--host', '127.0.0.1', '--port', byName.get(name).port], env, resolve(root, 'apps', name), byName.get(name).url);
    }
    for (const name of ['verification-service', 'memory-service', 'eval-service']) await start(state, `${name}-grpc`, 'uv', ['run', '--frozen', 'python', '-m', 'src.grpc_server'], env, resolve(root, 'apps', name));
    for (const row of grpcServices(env)) {
      for (let i = 0; ; i++) {
        try { await grpcHealth(row.name, row.address); break; }
        catch (error) { if (i >= 20) throw error; await delay(1000); }
      }
    }
    for (const name of ['platform-api', 'background-workers']) await start(state, name, process.execPath, [`dist/apps/${name}/main.js`], env, root, byName.get(name).url);
    await start(state, 'platform-web', 'pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', env.PLATFORM_WEB_PORT, '--strictPort'], env, resolve(root, 'apps/platform-web'), byName.get('platform-web').url);
    for (const row of all) await health(row.name, row.url);
    state.ready = true; save(state);
    console.log(`MVP ready: http://127.0.0.1:${env.PLATFORM_WEB_PORT}; model-gateway=real Bedrock; email=mock`);
  } catch (error) {
    try { await down(state); } catch { console.error('MVP cleanup incomplete; retained ownership state for mvp-down.sh'); }
    throw error;
  }
}

export async function main(action) {
  if (process.versions.node.split('.')[0] !== '22') throw new Error('MVP requires Node 22; select the version from .nvmrc');
  if (!['up', 'down'].includes(action)) throw new Error('Usage: mvp-stack.mjs up|down');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = resolve(stateDir, 'lock');
  try { mkdirSync(lock); } catch { throw new Error('MVP operation already running; no resources changed'); }
  try {
    if (action === 'up') await up();
    else if (existsSync(stateFile)) {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (state.root !== root || state.project !== project) throw new Error('MVP ownership does not match this checkout');
      await down(state);
    } else console.log('MVP already stopped; no resources changed');
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
