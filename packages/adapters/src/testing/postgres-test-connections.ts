import { Client, Pool } from "pg";

// Raw connections for integration specs that must act as a specific database
// role (fixture admin, app role, retention role). Engine apps may not import
// pg directly, so specs get them from here.
export type PostgresTestClient = Client;
export type PostgresTestPool = Pool;

export async function connectPostgresTestClient(connectionString: string): Promise<PostgresTestClient> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

export function createPostgresTestPool(connectionString: string): PostgresTestPool {
  return new Pool({ connectionString });
}
