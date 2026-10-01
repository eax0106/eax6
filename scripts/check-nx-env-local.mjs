import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';

if (process.argv.includes('--child')) {
  assert.equal(process.env.ALTERX_NX_ENV_FIXTURE, 'fixture-default');
  assert.equal(process.env.ALTERX_NX_ENV_NESTED, 'fixture-default');
  assert.equal(process.env.ALTERX_NX_ENV_OVERRIDE, 'from-shell');
  assert.equal(process.env.ALTERX_NX_ENV_REFERENCE, 'from-shell');
  process.exit(0);
}

// Use harmless fixture variables, never a developer's actual env file.
const fixture = '.env.local';
const keep = process.argv.includes('--keep');
writeFileSync(fixture, [
  'ALTERX_NX_ENV_FIXTURE=${ALTERX_NX_ENV_FIXTURE:-fixture-default}',
  'ALTERX_NX_ENV_NESTED=${ALTERX_NX_ENV_NESTED:-${ALTERX_NX_ENV_FIXTURE}}',
  'ALTERX_NX_ENV_OVERRIDE=from-file',
  'ALTERX_NX_ENV_REFERENCE=${ALTERX_NX_ENV_OVERRIDE}',
  '',
].join('\n'), { flag: 'wx', mode: 0o600 });
let passed = false;
try {
  const env = { ...process.env, NX_DAEMON: 'false', NX_LOAD_DOT_ENV_FILES: 'true', ALTERX_NX_ENV_OVERRIDE: 'from-shell' };
  const run = args => {
    const result = spawnSync(process.execPath, ['node_modules/nx/dist/bin/nx.js', ...args], {
      env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
    return result.stdout;
  };
  const projects = JSON.parse(run(['show', 'projects', '--json']));
  assert.ok(projects.length > 0, 'Nx did not load the project graph');
  run(['exec', '--', 'node', fileURLToPath(import.meta.url), '--child']);
  passed = true;
  console.log(`nx-env-local-passed; projects=${projects.length}`);
} finally {
  if (!keep || !passed) unlinkSync(fixture);
}
