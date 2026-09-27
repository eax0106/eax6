import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgSessionStore } from "./session-store";
import { PgSsoConfigStore } from "./sso-config-store";

const databaseUrl = (() => {
  const value = process.env.DATABASE_URL;
  if (!value) {
    throw new Error(
      "DATABASE_URL is required for the platform-api DB integration test target",
    );
  }
  return value;
})();

describe("PostgreSQL identity tenant isolation", () => {
  let adminClient: pg.Client;
  let restrictedPool: pg.Pool;
  let roleName: string;
  let rolePassword: string;
  let tenantA: string;
  let tenantB: string;
  let userId: string;
  let sessionA: string;
  let sessionB: string;

  beforeEach(async () => {
    tenantA = randomUUID();
    tenantB = randomUUID();
    userId = randomUUID();
    sessionA = randomUUID();
    sessionB = randomUUID();
    roleName = `identity_rls_${randomUUID().replaceAll("-", "_")}`;
    rolePassword = randomUUID();

    adminClient = new pg.Client({ connectionString: databaseUrl });
    await adminClient.connect();
    await adminClient.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${rolePassword}'`);
    await adminClient.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
    await adminClient.query(
      // users: session lookups only accept active users (task B1.2).
      `GRANT SELECT, UPDATE ON tenants, user_sessions TO "${roleName}"; GRANT SELECT ON users TO "${roleName}"`,
    );
    await adminClient.query(
      `INSERT INTO tenants (id, name, status)
       VALUES ($1, 'Tenant A', 'active'), ($2, 'Tenant B', 'active')`,
      [tenantA, tenantB],
    );
    await adminClient.query(
      `INSERT INTO users (id, identity_ref, email, status)
       VALUES ($1, $2, $3, 'active')`,
      [userId, `auth0|${userId}`, `${userId}@example.com`],
    );
    await adminClient.query(
      `INSERT INTO user_sessions
        (id, user_id, tenant_id, refresh_token_hash, access_token_hash)
       VALUES ($1, $2, $3, 'refresh-a', 'access-a'),
              ($4, $2, $5, 'refresh-b', 'access-b')`,
      [sessionA, userId, tenantA, sessionB, tenantB],
    );

    const restrictedUrl = new URL(databaseUrl);
    restrictedUrl.username = roleName;
    restrictedUrl.password = rolePassword;
    restrictedPool = new pg.Pool({ connectionString: restrictedUrl.toString() });
  });

  afterEach(async () => {
    await restrictedPool.end();
    await adminClient.query(`DELETE FROM user_sessions WHERE user_id = $1`, [userId]);
    await adminClient.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await adminClient.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [tenantA, tenantB]);
    await adminClient.query(`DROP OWNED BY "${roleName}"`);
    await adminClient.query(`DROP ROLE IF EXISTS "${roleName}"`);
    await adminClient.end();
  });

  it("cannot list, resolve, rotate, or revoke another tenant's session", async () => {
    const store = new PgSessionStore(restrictedPool);

    await expect(store.listActive(tenantA, userId)).resolves.toEqual([
      expect.objectContaining({ id: sessionA, tenantId: tenantA }),
    ]);
    await expect(store.findByAccessTokenHash(tenantA, "access-b")).resolves.toBeUndefined();
    await expect(
      store.findByRefreshTokenHash(tenantA, "refresh-b"),
    ).resolves.toBeUndefined();
    await expect(
      store.rotateRefreshToken(
        tenantA,
        sessionB,
        "refresh-b",
        "refresh-b-next",
        "access-b-next",
      ),
    ).resolves.toBe(false);

    await store.revoke(tenantA, userId, sessionB);
    await expect(store.listActive(tenantB, userId)).resolves.toEqual([
      expect.objectContaining({ id: sessionB, tenantId: tenantB }),
    ]);
  });

  it("stops accepting a suspended user's tokens, and accepts them again once reinstated", async () => {
    const store = new PgSessionStore(restrictedPool);
    await expect(store.findByAccessTokenHash(tenantA, "access-a")).resolves.toEqual(
      expect.objectContaining({ id: sessionA }),
    );

    await adminClient.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [userId]);
    await expect(store.findByAccessTokenHash(tenantA, "access-a")).resolves.toBeUndefined();
    await expect(store.findByRefreshTokenHash(tenantA, "refresh-a")).resolves.toBeUndefined();

    await adminClient.query(`UPDATE users SET status = 'active' WHERE id = $1`, [userId]);
    await expect(store.findByAccessTokenHash(tenantA, "access-a")).resolves.toEqual(
      expect.objectContaining({ id: sessionA }),
    );
  });

  it("rejects a status outside active/suspended", async () => {
    await expect(
      adminClient.query(`UPDATE users SET status = 'banned' WHERE id = $1`, [userId]),
    ).rejects.toThrow(/users_status_known/);
  });

  it("persists full reference-only SSO config for the selected tenant", async () => {
    const store = new PgSsoConfigStore(restrictedPool);
    const config = {
      type: "oidc" as const,
      issuer: "https://idp.example.com",
      clientId: "tenant-client",
      clientSecretRef: "secrets/tenant-a/oidc-client",
    };

    await store.save(tenantA, config);

    const { rows } = await adminClient.query<{ id: string; sso_config: unknown }>(
      `SELECT id, sso_config FROM tenants WHERE id IN ($1, $2) ORDER BY id`,
      [tenantA, tenantB],
    );
    const persisted = rows.find((row) => row.id === tenantA);
    const untouched = rows.find((row) => row.id === tenantB);
    expect(persisted?.sso_config).toEqual(config);
    expect(untouched?.sso_config).toBeNull();
  });
});
