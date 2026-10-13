import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatewayDigest, processStamp, smokeCeilingUsd } from './mvp-stack.mjs';
import { LOCAL_TENANT_ID } from './mvp-smoke.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const permitFile = resolve(root, 'tmp/local-mvp/spend-permit.json');
// The gateway refuses a session permit longer than this, whatever the file says.
export const MAX_UI_SESSION_MINUTES = 120;

/**
 * Lets runs a signed-in user starts from the web app make paid model calls for
 * a limited time. The smoke and template scripts arm a permit for one run they
 * create; a run started by clicking in the UI has no script to do that, so the
 * guarded gateway would refuse its first model call. This permit names the
 * owned gateway process and the local tenant, expires on its own, and spends
 * from the same process-lifetime allowance as every other local run. It is
 * removed by --disarm or by stopping the stack.
 */
export async function uiSession({ minutes = 60, apply = false, disarm = false, now = Date.now() } = {}) {
  if (apply && disarm) throw new Error('--apply and --disarm are mutually exclusive');
  if (disarm) { rmSync(permitFile, { force: true }); console.log('UI spend session disarmed'); return; }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_UI_SESSION_MINUTES) {
    throw new Error(`--minutes must be a whole number from 1 to ${MAX_UI_SESSION_MINUTES}`);
  }
  const state = JSON.parse(readFileSync(resolve(root, 'tmp/local-mvp/state.json'), 'utf8'));
  if (state.root !== root || !state.ready) throw new Error('This checkout has no ready MVP stack; run scripts/local/mvp-up.sh');
  const ceilingUsd = await smokeCeilingUsd();
  const gateway = state.processes.find(row => row.name === 'model-gateway');
  if (!gateway?.stamp || processStamp(gateway.pid, gateway.stamp) !== gateway.stamp || state.smokeCeilingUsd !== ceilingUsd || state.gatewayDigest !== gatewayDigest()) {
    throw new Error('Guarded model-gateway ownership not verified; no session armed');
  }
  const gatewayLog = readFileSync(resolve(root, 'tmp/local-mvp/model-gateway.log'), 'utf8');
  if (!gatewayLog.includes(`Local smoke lifetime ceiling: USD ${ceilingUsd}`)) throw new Error('Model pre-call budget missing; no session armed');
  const sessionUntil = now + minutes * 60_000;
  console.log(JSON.stringify({ plan: { tenantId: LOCAL_TENANT_ID, minutes, until: new Date(sessionUntil).toISOString(),
    upperBoundUsd: ceilingUsd, scope: 'whole model-gateway process lifetime', apply } }));
  if (!apply) { console.log('Plan only; add --apply with owner spend approval.'); return; }
  if (existsSync(permitFile)) throw new Error('A spend permit is already armed (a script run or another session); no session armed');
  writeFileSync(permitFile, JSON.stringify({ gatewayPid: gateway.pid, tenantId: LOCAL_TENANT_ID, sessionUntil }), { flag: 'wx', mode: 0o600 });
  console.log(`UI spend session armed until ${new Date(sessionUntil).toISOString()}; run node scripts/local/mvp-ui-session.mjs --disarm when done`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const minutes = args.find(arg => arg.startsWith('--minutes='));
  if (args.some(arg => !['--apply', '--disarm'].includes(arg) && arg !== minutes)) {
    console.error('Usage: mvp-ui-session.mjs [--minutes=60] [--apply] | --disarm'); process.exitCode = 2;
  } else uiSession({ apply: args.includes('--apply'), disarm: args.includes('--disarm'),
    ...(minutes ? { minutes: Number(minutes.slice(10)) } : {}) })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
