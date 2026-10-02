import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const baseline = JSON.parse(readFileSync('scripts/identity-names-baseline.json', 'utf8'));
assert.match(baseline.revision, /^[a-f0-9]{40}$/);
assert.ok(Object.values(baseline.files).every(count => Number.isInteger(count) && count > 0));
assert.equal(Object.keys(baseline.files).length, baseline.file_count);
assert.equal(Object.values(baseline.files).reduce((sum, count) => sum + count, 0), baseline.total_occurrences);

const base = process.env.IDENTITY_NAMES_BASE ?? process.env.NX_BASE ?? 'origin/main';
assert.match(base, /^[a-zA-Z0-9_./-]+$/);
assert.ok(!base.startsWith('-'));
execFileSync('git', ['rev-parse', '--verify', `${base}^{commit}`], { stdio: 'pipe' });
const diff = execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--unified=0', '--no-ext-diff', '--no-color', '--no-renames', base, '--'], { encoding: 'utf8' });
let file = '', line = 0, inHunk = false;
const violations = [];
for (const text of diff.split('\n')) {
  if (text.startsWith('diff --git ')) { inHunk = false; continue; }
  if (!inHunk && text.startsWith('+++ ')) { file = text.slice(4); continue; }
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
  if (hunk) { line = Number(hunk[1]); inHunk = true; continue; }
  if (text.startsWith('+')) {
    if (/session(?:[ \t]+)?gateway/i.test(text.slice(1))) violations.push(`${file}:${line}`);
    line++;
  } else if (text.startsWith(' ')) line++;
}
if (violations.length) {
  console.error('Use Identity & Tenant Gateway in added lines: ' + violations.join(', '));
  process.exit(1);
}
console.log(`identity-name-passed; historical files=${baseline.file_count}; historical occurrences=${baseline.total_occurrences}`);
