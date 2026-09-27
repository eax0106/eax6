import type { PoolConfig } from "pg";

/**
 * Pool configuration for a static (password) Postgres connection.
 *
 * The IAM path builds its own pool config and sets `ssl` explicitly, because an
 * RDS endpoint is reached inside the VPC with a signed token and no password.
 * A static connection string is the opposite case: the password travels with
 * the connection, and node-postgres sends no TLS unless it is asked to, so a
 * connection string without an sslmode is a silent plaintext connection
 * carrying that password.
 *
 * TLS is therefore required whenever the database is reached over a network
 * that could carry the password past equipment we do not run -- anything with a
 * publicly-routable host. It is not required for a database reached inside one
 * host or one private network, which is how the MVP runs: services and Postgres
 * in containers on a single EC2 instance, talking over the Docker network by
 * service name, plus every local docker-compose and testcontainers spec.
 *
 * Certificates are verified even for sslmode=require, which is stricter than
 * libpq (where `require` encrypts without verifying). A managed provider with a
 * publicly-trusted certificate satisfies this as-is; one with a private CA needs
 * its CA supplied here rather than verification switched off.
 */
const TLS_REQUIRING_MODES = new Set(["require", "verify-ca", "verify-full"]);

const PRIVATE_IPV4 =
  /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

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

  if (isPrivateHost(url.hostname)) {
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

/**
 * Whether this host is reachable only from inside our own network.
 *
 * A single-label hostname ("engine-db", "platform-db") is treated as private
 * because that is what container DNS gives a service on a Docker network, and
 * such a name cannot resolve on the public internet. The heuristic is the
 * ceiling here: a split-horizon DNS setup could resolve a dotted internal name
 * that this function calls public, which fails closed -- the connection is
 * refused until its string asks for TLS -- and an operator who wants a dotted
 * private name exempted should give it an `.internal` or `.local` suffix.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  if (PRIVATE_IPV4.test(host)) return true;
  if (!host.includes(".")) return true;
  return (
    host.endsWith(".localhost") ||
    host.endsWith(".test") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  );
}
