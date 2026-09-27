import type { PoolConfig } from "pg";

/**
 * Pool configuration for a static (password) Postgres connection.
 *
 * The IAM path builds its own pool config and sets `ssl` explicitly, because
 * an RDS endpoint is reached inside the VPC with a signed token. A static
 * connection string is the opposite case: managed Postgres outside AWS (Neon,
 * where IAM authentication does not exist) is reached over the public internet
 * and the password travels with the connection. node-postgres sends no TLS
 * unless it is asked to, so a connection string without an sslmode is a silent
 * plaintext connection carrying that password.
 *
 * Every static call site therefore routes through here rather than passing
 * `{ connectionString }` straight to the pool.
 *
 * Certificates are verified even for sslmode=require, which is stricter than
 * libpq (where `require` encrypts without verifying). Neon presents a
 * publicly-trusted certificate, so verification costs nothing; a provider with
 * a private CA needs its CA supplied here rather than verification switched off.
 */
const TLS_REQUIRING_MODES = new Set(["require", "verify-ca", "verify-full"]);

export class StaticConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaticConnectionError";
  }
}

export function staticPoolConfig(connectionString: string): PoolConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new StaticConnectionError(
      "static database connection string is not a valid URL",
    );
  }

  // Local Postgres has no certificate to verify: the docker-compose stack and
  // every testcontainers spec connect to 127.0.0.1, and requiring TLS there
  // would fail the tests rather than protect anything.
  if (isLoopbackOrDevelopmentHost(url.hostname)) {
    return { connectionString };
  }

  const sslMode = url.searchParams.get("sslmode");
  if (sslMode === null || !TLS_REQUIRING_MODES.has(sslMode)) {
    throw new StaticConnectionError(
      `static database connection to ${url.hostname} must set sslmode to one of ${[...TLS_REQUIRING_MODES].join(", ")}`,
    );
  }

  return { connectionString, ssl: { rejectUnauthorized: true } };
}

function isLoopbackOrDevelopmentHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.endsWith(".test")
  );
}
