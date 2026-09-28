import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT, finding } from './lib.mjs';

// Imported from alterengine--5 (task C1). This repository has no Deletion &
// Retention registry yet; building one is task C3. Until it exists the gate
// reports that single absence -- held in the baseline -- rather than crashing
// or passing: "the subject is missing" must never read as "nothing to find".
const REGISTRY_DIST = '../../packages/deletion-registry/dist/index.js';

/**
 * Gate: every table that actually exists is either declared for deletion or
 * explicitly exempt.
 *
 * This is the driver for `certifySchemaCoverage`, which until now was called
 * only from its own test — the third instance of pattern 3 in this build, and
 * the one the Adversary caught. A test that creates the very probe it expects
 * to fail proves the function works; it proves nothing about the real schema.
 *
 * Designed by the Integrator. The truth source is the LIVE schema, never a
 * hand-maintained list: the previous build died on a hardcoded 19-entry list
 * against a 29-table schema, correct the day it was written and stale after
 * the next migration.
 *
 * Staleness is checked in both directions. An undeclared table means erasure
 * would miss data. A declaration naming a table that no longer exists means
 * the registry is drifting the other way, and a reader cannot tell which
 * entries still mean anything.
 *
 * FAIL-CLOSED. An unreachable database is a violation, not a skip. "We could
 * not check" must never read the same as "there was nothing to find" — that
 * equivalence is how a coverage check quietly stops covering anything.
 */

export const name = 'deletion-schema';
export const closes = 'Rule 20 — erasure verified against the live schema';

export async function run() {
  try {
    await access(join(REPO_ROOT, 'packages/deletion-registry/src/declaration.ts'));
  } catch {
    return [
      finding({
        file: 'packages/deletion-registry/src/declaration.ts',
        line: 1,
        message:
          'The Deletion & Retention registry does not exist yet (task C3), so ' +
          'no live table can be certified as covered by erasure.',
      }),
    ];
  }
  const {
    certifySchemaCoverage,
    listLiveTables,
    tenantDataDeclarations,
    tenantDataExemptions,
  } = await import(REGISTRY_DIST);
  const connectionString = process.env['DATABASE_URL'];

  if (!connectionString) {
    return [
      finding({
        file: 'packages/deletion-registry/src/declaration.ts',
        line: 1,
        message:
          'DATABASE_URL is not set, so live-schema coverage could not be ' +
          'checked. Fail-closed: not being able to check is a violation, not ' +
          'a pass. Run pnpm stack:up and set DATABASE_URL.',
      }),
    ];
  }

  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString });

  try {
    await client.connect();
  } catch (error) {
    return [
      finding({
        file: 'packages/deletion-registry/src/declaration.ts',
        line: 1,
        message:
          `Could not reach the database to verify deletion coverage: ${String(error)}. ` +
          'Fail-closed.',
      }),
    ];
  }

  try {
    const live = await listLiveTables(client);
    const certification = certifySchemaCoverage(
      live,
      tenantDataDeclarations,
      tenantDataExemptions,
    );

    if (certification.status === 'complete') return [];

    const findings = [];

    // A database with no application tables has not been provisioned yet --
    // there is no migration runner in the repository, so CI starts from an
    // empty schema. Declaring a table before it is created is not drift, it is
    // the normal order of work. The forward check below still runs, because a
    // table that DOES exist and is undeclared is a real problem whatever the
    // state of the rest of the schema.
    const schemaIsProvisioned = live.length > 0;

    for (const table of certification.unregistered ?? []) {
      findings.push(
        finding({
          file: 'packages/deletion-registry/src/declaration.ts',
          line: 1,
          message:
            `"${table}" exists in the live schema and is neither declared nor ` +
            'exempt. Erasure would silently miss it.',
        }),
      );
    }

    for (const table of schemaIsProvisioned ? (certification.stale ?? []) : []) {
      findings.push(
        finding({
          file: 'packages/deletion-registry/src/declaration.ts',
          line: 1,
          message:
            `"${table}" is declared but does not exist in the live schema. ` +
            'A registry that drifts in this direction cannot be read as ' +
            'meaning anything.',
        }),
      );
    }

    return findings;
  } finally {
    await client.end();
  }
}
