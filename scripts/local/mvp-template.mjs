import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { putLocalStackSecret } from './mvp-stack.mjs';
import { runTemplate } from './mvp-smoke.mjs';

// Runs one catalogue template on the local MVP stack with its own first test
// case as the trigger input, one paid run per invocation (same spend guard as
// the smoke). Usage and prerequisites: docs/local-dev.md.

const root = fileURLToPath(new URL('../../', import.meta.url));
const templateDir = resolve(root, 'apps/intelligence-service/src/capability_registry/templates/v2');

export const UNSUPPORTED_TEMPLATES = {
  'whatsapp-faq-responder': 'it needs an approved WhatsApp Business account',
  // knowledge.search sends no scope ids, which ADS Q refuses, and the local
  // stack has no uploads bucket to ingest a document through.
  'knowledge-qa': 'knowledge search and upload do not work on the local stack yet',
};

export function loadTemplate(templateId) {
  for (const file of readdirSync(templateDir).filter(name => name.endsWith('.json')).sort()) {
    const template = JSON.parse(readFileSync(resolve(templateDir, file), 'utf8'));
    if (template.template_id === templateId) return template;
  }
  throw new Error(`Unknown template ${templateId}`);
}

export function needsPostgres(template) {
  return template.skeleton.nodes.some(node => node.config?.required_connector === 'postgres');
}

// The tables the two database templates write, shaped by their statements.
export const SCRATCH_TABLES = [
  `CREATE TABLE IF NOT EXISTS leads (name text NOT NULL, email text PRIMARY KEY, company text,
     created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS invoices (invoice_number text NOT NULL, vendor text NOT NULL, invoice_date date,
     currency text NOT NULL, net numeric NOT NULL, tax numeric NOT NULL, total numeric NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (vendor, invoice_number))`,
];

/** One stable connection id per workspace, so re-runs update the same registry row. */
export function scratchConnectionId(workspaceUuid) {
  const hex = createHash('sha256').update(`alter-local-scratch-postgres:${workspaceUuid}`).digest('hex');
  const variant = (8 + (parseInt(hex[16], 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function connectionSnapshot({ tenantUuid, workspaceUuid, revision }) {
  const connectionId = scratchConnectionId(workspaceUuid);
  return { tenant_id: tenantUuid, workspace_id: workspaceUuid, connection_id: connectionId, connector_type: 'postgres',
    status: 'connected', secret_ref: `/alter/integrations/${tenantUuid}/${workspaceUuid}/${connectionId}`, source_revision: revision };
}

function databaseUrl(env) {
  const url = process.env.MVP_SCRATCH_DATABASE_URL || env.MVP_SCRATCH_DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) throw new Error('Database templates need MVP_SCRATCH_DATABASE_URL (a postgres:// URL for the scratch database)');
  return url;
}

async function withScratch(url, work) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

/**
 * Local stand-in for a "connect a database" product path, which does not
 * exist yet: the engine's connection registry gets a postgres row for the
 * signed-in workspace, and LocalStack the secret it names, as platform-api's
 * integrations sync would write for an OAuth connector.
 */
async function preparePostgres({ request, env, tenantId }) {
  const url = databaseUrl(env);
  await withScratch(url, async client => { for (const sql of SCRATCH_TABLES) await client.query(sql); });
  const listed = (await request('/api/v1/workspaces')).data;
  const workspaces = Array.isArray(listed) ? listed : listed?.data;
  const workspaceUuid = String(workspaces?.[0]?.id ?? '').replace(/^ws_/, '');
  if (!workspaceUuid) throw new Error('Signed-in user has no workspace');
  const snapshot = connectionSnapshot({ tenantUuid: tenantId.replace(/^ten_/, ''), workspaceUuid,
    revision: Math.floor(Date.now() / 1000) });
  putLocalStackSecret(env, snapshot.secret_ref, url, 'Scratch database secret: LocalStack write failed');
  const response = await fetch(`http://127.0.0.1:${env.ORCHESTRATION_PORT}/internal/connections/upsert`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.CONNECTION_REGISTRY_SERVICE_TOKEN}` },
    body: JSON.stringify(snapshot) });
  if (!response.ok) throw new Error(`Connection registry upsert failed HTTP ${response.status}`);
  console.log(JSON.stringify({ scratchConnection: { workspaceId: workspaceUuid, connectionId: snapshot.connection_id } }));
  return { url };
}

// What each database template must have written, read back from the scratch database.
const rowChecks = {
  'lead-capture-crm-welcome': input => ['SELECT name, email, company FROM leads WHERE email = lower($1)', [input.email]],
  'invoice-email-to-sheet': () => ["SELECT invoice_number, vendor, currency, net, tax, total FROM invoices WHERE invoice_number = 'SP-1042'", []],
};

export async function runCatalogueTemplate({ templateId, apply = false, recipient, evidenceFile }) {
  if (UNSUPPORTED_TEMPLATES[templateId]) throw new Error(`${templateId} cannot run locally: ${UNSUPPORTED_TEMPLATES[templateId]}`);
  const template = loadTemplate(templateId);
  const input = template.test_cases?.[0]?.input;
  if (!input) throw new Error(`${templateId} has no test case input`);
  const postgres = needsPostgres(template);
  return runTemplate({ templateId, input, apply, recipient, evidenceFile,
    prepare: postgres ? preparePostgres : undefined,
    check: postgres ? async ({ prepared }) => {
      const [sql, values] = rowChecks[templateId](input);
      const rows = await withScratch(prepared.url, async client => (await client.query(sql, values)).rows);
      if (rows.length !== 1) throw new Error(`${templateId}: expected one row in the scratch database, found ${rows.length}`);
      return { table: templateId === 'lead-capture-crm-welcome' ? 'leads' : 'invoices', row: rows[0] };
    } : undefined });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const templateId = value('template');
  if (!templateId || args.some(arg => arg !== '--apply' && !/^--(template|recipient|evidence-file)=/.test(arg))) {
    console.error('Usage: mvp-template.mjs --template=ID [--recipient=VERIFIED_EMAIL] [--apply] [--evidence-file=PATH]');
    process.exitCode = 2;
  } else runCatalogueTemplate({ templateId, apply: args.includes('--apply'), recipient: value('recipient'), evidenceFile: value('evidence-file') })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
