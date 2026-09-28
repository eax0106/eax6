/**
 * Architecture gate runner (task C1; the gates are imported from
 * alterengine--5, where they were hardened against the Adversary).
 *
 * This repository did not grow up under these gates, so it starts with
 * violations. Each gate's current findings are recorded in baseline.json and
 * the runner fails only on:
 *   - a NEW finding (not in the baseline) -- nothing new lands ungoverned;
 *   - a STALE baseline entry (a recorded finding that no longer occurs) -- a
 *     fix must shrink the baseline in the same change, so the count only
 *     ratchets down and the file stays a true list of what is left.
 * Nobody stops for a cleanup sprint; every later fix lands governed.
 *
 * alterengine--5's deletion-schema gate is not here: it read one database,
 * and this system has eight. scripts/deletion/certify.ts (task C3) does that
 * job against every database, built from real migrations, in its own CI step.
 *
 *   node scripts/gates/run-all.mjs            check against the baseline
 *   node scripts/gates/run-all.mjs --update   rewrite the baseline to now
 *
 * A finding is identified by gate, file and message -- not line, which moves
 * with every edit above it. Identical findings in one file are counted.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT } from './lib.mjs';

import * as capabilityCoverage from './capability-coverage.mjs';
import * as deletionRegistration from './deletion-registration.mjs';
import * as costNoFloat from './cost-no-float.mjs';
import * as driverExistence from './driver-existence.mjs';
import * as duplicatePrimitive from './duplicate-primitive.mjs';
import * as mockReachability from './mock-reachability.mjs';
import * as safetyDuplicate from './safety-duplicate.mjs';
import * as testEnvFile from './test-env-file.mjs';
import * as unsafeDefault from './unsafe-default.mjs';
import * as verifierDriver from './verifier-driver.mjs';

export const GATES = [
  mockReachability,
  unsafeDefault,
  driverExistence,
  duplicatePrimitive,
  safetyDuplicate,
  costNoFloat,
  deletionRegistration,
  capabilityCoverage,
  verifierDriver,
  testEnvFile,
];

const BASELINE = join(REPO_ROOT, 'scripts/gates/baseline.json');

/** gate -> "file :: message" -> count */
export function tally(results) {
  const counts = {};
  for (const { gate, findings } of results) {
    counts[gate] ??= {};
    for (const { file, message } of findings) {
      const key = `${file} :: ${message}`;
      counts[gate][key] = (counts[gate][key] ?? 0) + 1;
    }
  }
  return counts;
}

/** New and stale findings of `current` against `baseline`, both tallies. */
export function compare(current, baseline) {
  const added = [];
  const stale = [];
  const gates = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  for (const gate of gates) {
    const now = current[gate] ?? {};
    const before = baseline[gate] ?? {};
    for (const key of new Set([...Object.keys(now), ...Object.keys(before)])) {
      const difference = (now[key] ?? 0) - (before[key] ?? 0);
      if (difference > 0) added.push({ gate, key, count: difference });
      if (difference < 0) stale.push({ gate, key, count: -difference });
    }
  }
  return { added, stale };
}

async function main() {
  const update = process.argv.includes('--update');
  const results = [];
  for (const gate of GATES) {
    results.push({ gate: gate.name, closes: gate.closes, findings: await gate.run() });
  }
  const current = tally(results);

  if (update) {
    const sorted = Object.fromEntries(
      Object.keys(current).sort().map((gate) => [
        gate,
        Object.fromEntries(Object.entries(current[gate]).sort(([a], [b]) => a.localeCompare(b))),
      ]),
    );
    await writeFile(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
    const total = results.reduce((sum, { findings }) => sum + findings.length, 0);
    console.log(`Baseline written: ${total} finding(s) across ${GATES.length} gates.`);
    return;
  }

  const baseline = JSON.parse(await readFile(BASELINE, 'utf8'));
  const { added, stale } = compare(current, baseline);

  for (const { gate, closes, findings } of results) {
    const recorded = Object.values(baseline[gate] ?? {}).reduce((a, b) => a + b, 0);
    console.log(`${gate} — ${findings.length} finding(s), ${recorded} in baseline  (${closes})`);
  }

  if (added.length > 0) {
    console.log('\nNEW findings (not in scripts/gates/baseline.json):');
    for (const { gate, key, count } of added) {
      const [file] = key.split(' :: ');
      const lines = results
        .find((result) => result.gate === gate)
        .findings.filter((f) => `${f.file} :: ${f.message}` === key)
        .map((f) => f.line);
      console.log(`  [${gate}] ${file}:${lines.join(',')} (+${count})  ${key.split(' :: ')[1]}`);
    }
  }
  if (stale.length > 0) {
    console.log('\nFIXED but still in the baseline -- shrink it in this change');
    console.log('(node scripts/gates/run-all.mjs --update):');
    for (const { gate, key, count } of stale) console.log(`  [${gate}] (-${count})  ${key}`);
  }
  if (added.length > 0 || stale.length > 0) process.exit(1);
  console.log('\narchitecture-gates-ok');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
