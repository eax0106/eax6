import { finding, isTestFile, sourceFiles } from './lib.mjs';
import { lineOf, parse, ts, walk } from './ast.mjs';

/**
 * Gate: everything holding tenant data registers with Deletion & Retention.
 *
 * Rule 20. Erasure that misses one table is not erasure, and the miss stays
 * invisible until someone exercises a legal right and the answer is wrong.
 *
 * Rebuilt after the Adversary evaded the first version, which keyed on class
 * names ending Store, Repository, Repo, Dao or Table. This passed cleanly:
 *
 *   export const workflowCatalog = {
 *     async save(tenantId: TenantId, workflow: Workflow): Promise<void> {
 *       await db.query(
 *         'insert into workflows (tenant_id, body) values ($1, $2)',
 *         [tenantId, workflow],
 *       );
 *     },
 *   };
 *
 * It holds tenant rows under none of those names. The persistence call is the
 * signal, not the identifier.
 *
 * The second bug is also fixed: registration anywhere in a file no longer
 * satisfies every table in it. Each written table is checked by name.
 *
 * Reconciled after Builder A was correctly blocked. This gate originally
 * demanded a `registerForDeletion()` call, which contradicted the decision
 * recorded in PHASE-1-SCOPE: the declaration lives in code as reviewable data,
 * because a database row does not appear in a pull request diff. Builder B
 * built the declarative form; the gate was the thing that was wrong, and
 * Builder A refused to add a fake call to satisfy it, which is exactly right.
 *
 * STAGED. This is the source-level layer. The Integrator owns the
 * schema-derived gate for component 44, which reads live tables from
 * information_schema and is the load-bearing one. Contract 44 forbids a
 * heuristic as the sole check, and this is explicitly not the sole check —
 * it is the early-warning layer that works before any migration exists.
 */

export const name = 'deletion-registration';
export const closes = 'Rule 20 — erasure must reach every store';

const NO_TENANT_DATA_TAG = /@no-tenant-data\b/;
const TENANT_COLUMN = /\btenant_id\b/i;
// Requires a clause that only real DML has. Without this, the error message
// 'audit_events is append-only: UPDATE blocked' matched, and "blocked" was
// read as a table name -- a false positive against Builder C's component 38.
const WRITE =
  /\b(?:insert\s+into\s+([a-z_][a-z0-9_."]*)[\s(]|update\s+([a-z_][a-z0-9_."]*)\s+set\b|upsert\s+into\s+([a-z_][a-z0-9_."]*)|merge\s+into\s+([a-z_][a-z0-9_."]*))/i;

/** SQL string literals that write, with the table they write to. */
function tenantWrites(source) {
  const writes = [];

  walk(source, (node) => {
    const text =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : ts.isTemplateExpression(node)
          ? node.getText(source)
          : undefined;

    if (!text) return;

    const write = WRITE.exec(text);
    if (!write) return;
    if (!TENANT_COLUMN.test(text)) return;

    const table = write[1] ?? write[2] ?? write[3] ?? write[4];
    if (!table) return;

    writes.push({ table: table.replace(/"/g, ''), node });
  });

  return writes;
}

const DECLARATION_FILE = 'packages/deletion-registry/src/declaration.ts';

/**
 * Tables named in the declaration file — both declared and exempt.
 *
 * Read by AST from source rather than imported from dist, so the gate works
 * before anything is built and cannot be fooled by a stale compiled artefact.
 * Returns null when the file does not exist yet.
 */
async function declaredTables(files) {
  if (!files.includes(DECLARATION_FILE)) return null;

  const { source } = await parse(DECLARATION_FILE);
  const tables = new Set();

  walk(source, (node) => {
    if (!ts.isPropertyAssignment(node)) return;
    if (node.name.getText(source).replace(/['"]/g, '') !== 'table') return;
    if (ts.isStringLiteral(node.initializer)) {
      tables.add(node.initializer.text.toLowerCase());
    }
  });

  return tables;
}

export async function run() {
  const findings = [];
  const files = await sourceFiles({ includeTests: false });
  const declared = await declaredTables(files);

  for (const file of files) {
    if (isTestFile(file)) continue;
    if (file === DECLARATION_FILE) continue;

    const { text, source } = await parse(file);
    if (NO_TENANT_DATA_TAG.test(text)) continue;

    for (const { table, node } of tenantWrites(source)) {
      if (declared?.has(table.toLowerCase())) continue;

      const where =
        declared === null
          ? `${DECLARATION_FILE} does not exist yet`
          : `it is absent from ${DECLARATION_FILE}`;

      findings.push(
        finding({
          file,
          line: lineOf(source, node),
          message:
            `Writes tenant rows to "${table}" and ${where}. Erasure would ` +
            'silently miss it. Add it to tenantDataDeclarations, or to ' +
            'tenantDataExemptions with a reason and an owner.',
        }),
      );
    }
  }

  return findings;
}
