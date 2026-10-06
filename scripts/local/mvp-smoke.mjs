import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { health, loadEnvironment, services, grpcHealth, grpcServices, processStamp, gatewayDigest } from './mvp-stack.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const userId = '01930000-0000-7000-8000-000000000003';
const tenantId = 'ten_01930000-0000-7000-8000-000000000001';
export const MAX_SMOKE_USD = 0.25;
export function assertSmokeCeiling(usd) {
  if (!Number.isFinite(usd) || usd < 0 || usd > MAX_SMOKE_USD) {
    throw new Error(`Upper bound USD ${Number(usd).toFixed(4)} exceeds USD ${MAX_SMOKE_USD}; no model run started`);
  }
}

async function policy(env) {
  const { AwsAppConfigConfigProvider, AwsSsmParameterProvider } = await import('@alterx/adapters');
  const { OperationalConfigProvider } = await import('../../dist/apps/model-gateway/operations/operational-config-provider.js');
  const { LOCAL_SMOKE_RATES } = await import('../../dist/apps/model-gateway/gateway/local-smoke-budget.js');
  // Same real policy path as model-gateway; no account or credential entry.
  Object.assign(process.env, env);
  for (const key of ['AWS_ENDPOINT_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) delete process.env[key];
  if (env.ALTER_AWS_PROFILE) process.env.AWS_PROFILE = env.ALTER_AWS_PROFILE;
  const baseline = new AwsAppConfigConfigProvider({ region: env.ALTER_REGION,
    applicationIdentifier: env.MODEL_GATEWAY_APPCONFIG_APPLICATION_ID,
    environmentIdentifier: env.MODEL_GATEWAY_APPCONFIG_ENVIRONMENT_ID,
    configurationProfileIdentifier: env.MODEL_GATEWAY_APPCONFIG_CONFIGURATION_PROFILE_ID });
  const store = new AwsSsmParameterProvider({ region: env.ALTER_REGION });
  try {
    const current = new OperationalConfigProvider(baseline, store, env.MODEL_POLICY_OVERRIDE_PARAMETER_NAME || '/alter/local/model-gateway/model-policy');
    const models = {};
    for (const alias of ['FAST', 'STANDARD', 'ADVANCED']) {
      const binding = await current.resolveModelAlias(alias);
      if (binding.fallback_chain?.length) throw new Error('Smoke requires priced primary models without unpriced fallback providers');
      if (!LOCAL_SMOKE_RATES[binding.model_id]) throw new Error(`Unpriced model for ${alias}; refusing smoke`);
      models[alias] = binding.model_id;
    }
    return { models, rates: LOCAL_SMOKE_RATES, maxTokens: (await current.resolveCostLimit({ tenantId, runId: '' })).maxTokensPerCall };
  } finally { baseline.close(); store.close(); }
}

export async function smoke({ apply = false, healthOnly = false, evidenceFile } = {}) {
  if (apply && healthOnly) throw new Error('--apply and --health-only are mutually exclusive');
  if (process.versions.node.split('.')[0] !== '22') throw new Error('MVP smoke requires Node 22');
  const state = JSON.parse(readFileSync(resolve(root, 'tmp/local-mvp/state.json'), 'utf8'));
  if (state.root !== root || !state.ready) throw new Error('This checkout has no ready MVP stack; run scripts/local/mvp-up.sh');
  const env = loadEnvironment();
  if (env.ALTER_ENV !== 'local') throw new Error('Smoke requires ALTER_ENV=local');
  for (const row of services(env)) await health(row.name, row.url);
  for (const row of grpcServices(env)) await grpcHealth(row.name, row.address);
  console.log('MVP HTTP health identities verified');
  if (healthOnly) return;
  const gateway = state.processes.find(row => row.name === 'model-gateway');
  if (!gateway?.stamp || processStamp(gateway.pid) !== gateway.stamp || state.smokeCeilingUsd !== MAX_SMOKE_USD || state.gatewayDigest !== gatewayDigest()) {
    throw new Error('Guarded model-gateway ownership not verified; refusing smoke');
  }
  const gatewayLog = readFileSync(resolve(root, 'tmp/local-mvp/model-gateway.log'), 'utf8');
  if (!gatewayLog.includes(`Local smoke lifetime ceiling: USD ${MAX_SMOKE_USD}`)) throw new Error('Model pre-call budget missing; refusing smoke');
  const boundUsd = MAX_SMOKE_USD;
  console.log(JSON.stringify({ upperBoundUsd: boundUsd, scope: 'whole model-gateway process lifetime',
    maxOutputTokens: 1024, awsMaxAttempts: 1, fallbackProviders: 0, apply, email: 'mock' }));
  assertSmokeCeiling(boundUsd);
  const base = `http://127.0.0.1:${env.PLATFORM_API_PORT}`;
  const cookies = new Map();
  async function request(path, method = 'GET', body, headers = {}) {
    const response = await fetch(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0], at = pair.indexOf('='); cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    if (!response.ok) throw new Error(`platform-api: ${method} ${path.split('?')[0]} failed HTTP ${response.status}`);
    const data = response.status === 204 ? null : await response.json();
    return { data, etag: response.headers.get('etag') };
  }
  const verifier = randomUUID(), redirectUri = `http://127.0.0.1:${env.PLATFORM_WEB_PORT}/auth/callback`;
  const login = await request('/api/v1/auth/login', 'POST', { redirectUri, state: randomUUID(), codeChallenge: createHash('sha256').update(verifier).digest('base64url') });
  assert.equal(new URL(login.data.url).hostname, 'mock.identity.local', 'local mock identity required');
  const query = new URLSearchParams({ code: `user:${userId}`, redirect_uri: redirectUri, code_verifier: verifier });
  const signedIn = await request(`/api/v1/auth/callback?${query}`);
  assert.equal(signedIn.data.userId, userId); assert.ok(cookies.has('alter_access'));
  const catalogue = (await request('/api/v1/workflow-templates')).data;
  assert.ok(catalogue.some(row => row.template_id === 'meeting-notes-summary'));
  const created = (await request('/api/v1/workflow-templates/meeting-notes-summary/instantiate', 'POST', {})).data;
  assert.equal(created.status, 'compiled');
  const workflow = await request(`/api/v1/workflows/${created.workflowId}`);
  const dag = workflow.data.dag;
  // Provide local trigger input through the existing deterministic YAMLImport
  // node. Every remaining template step and its success criteria stay intact.
  const intake = dag.nodes.find(node => node.key === 'intake');
  assert.equal(intake.type, 'Merge');
  intake.type = 'YAMLImport'; intake.config = { yaml: JSON.stringify({
    title: `Local MVP ${randomUUID()}`, recipient: 'probe@local.invalid', notes: 'Nothing decided. No action items.' }) };
  assert.ok(workflow.etag, 'workflow ETag required');
  await request(`/api/v1/workflows/${created.workflowId}`, 'PATCH', { dag }, { 'if-match': workflow.etag });
  const compiled = (await request(`/api/v1/workflows/${created.workflowId}/actions/compile`, 'POST', {})).data;
  assert.match(compiled.id, /^wfv_/);
  const priced = await policy(env);
  // The local process allowance includes node reviewers, final outcome,
  // recovery attempts and embeddings; exhaustion stops the next paid call.
  console.log(JSON.stringify({ plan: { workflowId: created.workflowId, template: 'meeting-notes-summary', models: priced.models,
    policyMaxTokensPerCall: priced.maxTokens, upperBoundUsd: boundUsd, ceilingUsd: MAX_SMOKE_USD, apply, email: 'mock' } }));
  assertSmokeCeiling(boundUsd);
  const estimate = (await request(`/api/v1/runs/estimate?${new URLSearchParams({ workflow_id: created.workflowId, workflow_version_id: compiled.id })}`)).data;
  assert.equal(estimate.unpriced_calls, 0, 'Cost Ledger has unpriced model calls');
  if (!apply) { console.log('MVP smoke plan verified; no model run started. Use --apply only with owner spend approval.'); return; }
  const permitFile = resolve(root, 'tmp/local-mvp/spend-permit.json');
  writeFileSync(permitFile, JSON.stringify({ gatewayPid: gateway.pid }), { flag: 'wx', mode: 0o600 });
  let run, detail;
  try {
  run = (await request('/api/v1/runs', 'POST', { workflow_id: created.workflowId, workflow_version_id: compiled.id })).data;
  assert.match(run.id, /^run_/);
  writeFileSync(permitFile, JSON.stringify({ gatewayPid: gateway.pid, tenantId, runId: run.id }), { mode: 0o600 });
  for (let i = 0; i < 120; i++) {
    detail = (await request(`/api/v1/runs/${run.id}`)).data;
    if (['completed', 'failed', 'cancelled', 'paused'].includes(detail.run.status)) break;
    await delay(1000);
  }
  assert.equal(detail.run.status, 'completed', `run ${run.id} did not complete`);
  assert.equal(detail.outcome.verdict, 'completed_verified');
  assert.ok(detail.verification_results.length > 0, 'No persisted verification verdicts');
  assert.ok(detail.verification_results.every(row => row.verdict === 'pass'), 'Verification failed');
  // Cost ingestion is asynchronous. A real model smoke must not certify zero
  // just because the cost-events consumer has not caught up yet.
  for (let i = 0; i < 30 && BigInt(detail.run_cost_minor) === 0n; i++) {
    await delay(1000); detail = (await request(`/api/v1/runs/${run.id}`)).data;
  }
  assert.ok(BigInt(detail.run_cost_minor) > 0n, 'No persisted run cost');
  } catch (error) {
    if (run?.id) {
      try { await request(`/api/v1/runs/${run.id}/actions/cancel`, 'POST', {}); }
      catch { console.error(`run ${run.id}: cancellation could not be confirmed; guarded Gateway allowance still applies`); }
    }
    throw error;
  } finally { rmSync(permitFile, { force: true }); }
  const modelCalls = readFileSync(resolve(root, 'tmp/local-mvp/model-gateway.log'), 'utf8').split('\n').flatMap(line => {
    try { const row = JSON.parse(line).localSmokeUsage; return row?.runId === run.id ? [row] : []; }
    catch { return []; }
  });
  assert.ok(modelCalls.some(row => row.modelId === priced.models.STANDARD), 'No real generation call recorded for this run; cache replay cannot certify a paid smoke');
  let observedListPriceUsd = 0;
  for (const row of modelCalls) {
    assert.equal(row.provider, 'aws-bedrock');
    assert.ok(Number.isSafeInteger(row.input_tokens) && row.input_tokens > 0);
    assert.ok(Number.isSafeInteger(row.output_tokens) && row.output_tokens > 0);
    const rates = priced.rates[row.modelId]; assert.ok(rates, 'Unpriced paid model');
    observedListPriceUsd += row.input_tokens * rates[0] + row.output_tokens * rates[1];
  }
  assertSmokeCeiling(observedListPriceUsd);
  const evidence = { recordedAt: new Date().toISOString(), models: priced.models, template: 'meeting-notes-summary', boundUsd,
    gatewayPid: gateway.pid, gatewayStamp: gateway.stamp, gatewayDigest: state.gatewayDigest, smokeDigest: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    workflowId: created.workflowId, runId: run.id, status: detail.run.status, outcome: detail.outcome,
    verification: detail.verification_results, runCostMinor: detail.run_cost_minor, currency: 'INR', email: 'mock',
    modelCalls, observedListPriceUsd, costScope: 'successful generation/review calls; failed attempts and embeddings remain covered by the lifetime bound' };
  if (evidenceFile) writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ runId: run.id, status: detail.run.status, verdict: detail.outcome.verdict, runCostMinor: detail.run_cost_minor, currency: 'INR', email: 'mock' }));
  console.log('MVP REAL SMOKE VERIFIED');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--health-only'].includes(arg) && !arg.startsWith('--evidence-file='))) {
    console.error('Usage: mvp-smoke.mjs [--health-only|--apply] [--evidence-file=PATH]'); process.exitCode = 2;
  } else smoke({ apply: args.includes('--apply'), healthOnly: args.includes('--health-only'), evidenceFile: args.find(arg => arg.startsWith('--evidence-file='))?.slice(16) })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
