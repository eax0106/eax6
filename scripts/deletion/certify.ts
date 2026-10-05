// Task C3. Certifies the Deletion & Retention registry against live schemas
// built from every service's real migrations (materialize-schemas.sh), and
// each provider route against the provider's own table list. Fail-closed: a
// database that cannot be reached, or is missing from DELETION_DATABASES, is a
// failure, never a skip. Prints "deletion-registry-ok".
//
// Usage: DELETION_DATABASES='{"platform_db":"postgres://…",…}' \
//          pnpm exec tsx scripts/deletion/certify.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import {
  MAX_ERASURE_GAPS,
  certifyDatabase,
  compareProviderTables,
  erasureGaps,
  listLiveTables,
  tenantDataDeclarations,
  tenantDataExemptions,
  type DatabaseName,
} from "../../packages/deletion-registry/src";

const repo = join(__dirname, "../..");
const DATABASES: readonly DatabaseName[] = [
  "platform_db", "orchestration_db", "audit_db", "cost_db", "ads_db", "intelligence_db", "policy_db", "eval_db",
];

/** The string literals inside a provider's own table list. */
function providerTables(file: string, pattern: RegExp): string[] {
  const text = readFileSync(join(repo, file), "utf8");
  const block = pattern.exec(text)?.[1];
  if (!block) throw new Error(`could not find the table list in ${file}`);
  return [...block.matchAll(/["']([a-z_]+)["']/g)].map((match) => match[1]!);
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const urls = JSON.parse(process.env.DELETION_DATABASES ?? "{}") as Partial<Record<DatabaseName, string>>;

  for (const database of DATABASES) {
    const url = urls[database];
    if (!url) {
      failures.push(`${database}: not in DELETION_DATABASES -- could not check is a failure, not a pass`);
      continue;
    }
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      const live = await listLiveTables(client);
      for (const { table, problem } of certifyDatabase(database, live, tenantDataDeclarations, tenantDataExemptions)) {
        failures.push(`${database}: ${table} is ${problem}`);
      }
      console.log(`${database}: ${live.length} live tables checked`);
    } catch (error) {
      failures.push(`${database}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  const providers = {
    "audit-service": providerTables(
      "apps/audit-service/src/deletion/deletion-orchestrator.ts",
      /export const AUDIT_ERASURE_TABLES = \[([\s\S]*?)\] as const/,
    ),
    "orchestration-service": providerTables(
      "apps/orchestration-service/src/deletion/deletion.service.ts",
      /export const TABLES = \[([\s\S]*?)\] as const/,
    ),
    "ads-core": providerTables("apps/ads-core/src/deletion/provider.py", /^TABLES = \(([\s\S]*?)\)/m),
    "cost-ledger-service": providerTables(
      "apps/cost-ledger-service/src/deletion/cost-deletion.service.ts",
      /export const COST_TABLES = \[([\s\S]*?)\] as const/,
    ),
    "intelligence-service": providerTables(
      "apps/intelligence-service/src/deletion/provider.py",
      /^TABLES = \(([\s\S]*?)\)/m,
    ),
    "memory-service": providerTables("apps/memory-service/src/deletion/provider.py", /^TABLES = \(([\s\S]*?)\)/m),
    "eval-service": providerTables("apps/eval-service/src/deletion/provider.py", /^TABLES = \(([\s\S]*?)\)/m),
    "platform-api": providerTables(
      "apps/platform-api/src/deletion/platform-deletion.service.ts",
      /export const PLATFORM_TABLES = \[([\s\S]*?)\] as const/,
    ),
  } as const;
  for (const [provider, tables] of Object.entries(providers) as [keyof typeof providers, string[]][]) {
    const { declaredOnly, providerOnly } = compareProviderTables(provider, tenantDataDeclarations, tables);
    for (const table of declaredOnly) failures.push(`${provider}: registry says it erases ${table}; its code does not`);
    for (const table of providerOnly) failures.push(`${provider}: its code erases ${table}; the registry does not route it there`);
  }

  const gaps = erasureGaps(tenantDataDeclarations);
  if (gaps.length > MAX_ERASURE_GAPS) {
    failures.push(`${gaps.length} erasure gaps, above MAX_ERASURE_GAPS (${MAX_ERASURE_GAPS}): new tenant data no erasure reaches`);
  }
  const byDatabase = new Map<string, number>();
  for (const gap of gaps) byDatabase.set(gap.database, (byDatabase.get(gap.database) ?? 0) + 1);
  console.log(`erasure gaps (tenant data no provider reaches): ${gaps.length} -- ${[...byDatabase].map(([db, n]) => `${db} ${n}`).join(", ")}`);

  if (failures.length > 0) {
    for (const failure of failures) console.log(`FAIL ${failure}`);
    process.exit(1);
  }
  console.log("deletion-registry-ok");
}

void main();
