import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const gate = resolve('scripts/check-identity-names.sh');
const directory = mkdtempSync(join(tmpdir(), 'identity-names-'));
const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' });
const retired = ['Session', 'Gateway'];
try {
  git('init', '-q');
  git('config', 'user.name', 'Native fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const legacy = retired.join(' ') + '\n' + retired.join('') + '\n';
  writeFileSync(join(directory, 'legacy.md'), legacy);
  git('add', '--', 'legacy.md');
  git('commit', '-qm', 'Create historical fixture');
  const base = git('rev-parse', 'HEAD').trim();
  mkdirSync(join(directory, 'scripts'));
  writeFileSync(join(directory, 'scripts/identity-names-baseline.json'), JSON.stringify({ revision: base, files: { 'legacy.md': 2 }, file_count: 1, total_occurrences: 2 }));
  const check = () => spawnSync('bash', [gate], { cwd: directory, env: { ...process.env, IDENTITY_NAMES_BASE: base }, encoding: 'utf8' });
  const expect = (success, label) => {
    const result = check();
    assert.equal(result.error, undefined);
    assert.equal(result.status, success ? 0 : 1, label + '\n' + result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, success ? /identity-name-passed/ : /Use Identity & Tenant Gateway/);
  };
  expect(true, 'Historical occurrences are allowed');
  writeFileSync(join(directory, 'legacy.md'), legacy + 'Identity & Tenant Gateway\n');
  expect(true, 'Current name is allowed beside unchanged history');
  for (const [label, value] of [['phrase', retired.join(' ')], ['identifier', retired.join('') + 'Guard'], ['case', retired.join(' ').toLowerCase()], ['pluses', '++ ' + retired.join(' ')]]) {
    writeFileSync(join(directory, 'legacy.md'), legacy + value + '\n');
    expect(false, 'Working added ' + label + ' must fail');
    git('add', '--', 'legacy.md');
    expect(false, 'Staged added ' + label + ' must fail');
    git('commit', '-qm', 'Add fixture occurrence');
    expect(false, 'Committed added ' + label + ' must fail');
    writeFileSync(join(directory, 'legacy.md'), legacy);
    git('add', '--', 'legacy.md');
    git('commit', '-qm', 'Restore fixture');
    expect(true, 'Restored source passes');
  }
  const added = 'new page.md';
  writeFileSync(join(directory, added), retired.join(' ') + '\n');
  git('add', '--', added);
  expect(false, 'New staged file must fail');
  writeFileSync(join(directory, added), 'Identity & Tenant Gateway\n');
  expect(true, 'Updated new file with current name passes');
  // Inventory edits never authorize new occurrences.
  const path = join(directory, 'scripts/identity-names-baseline.json');
  const baseline = JSON.parse(readFileSync(path, 'utf8'));
  baseline.files['legacy.md']++; baseline.total_occurrences++;
  writeFileSync(path, JSON.stringify(baseline));
  writeFileSync(join(directory, 'legacy.md'), legacy + retired.join('') + '\n');
  expect(false, 'A larger inventory cannot excuse an added occurrence');
  console.log('identity-name-native-passed');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
