import { randomBytes, randomUUID } from "node:crypto";

/**
 * UUIDv7. Node's randomUUID() emits v4, which does not satisfy the
 * `*_<uuidv7>` id schemas the platform contract validates against, so this
 * module mints v7 directly: 48-bit big-endian Unix-millis timestamp, version
 * nibble 7, variant bits 10, remainder CSPRNG.
 */
export function uuidV7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function bindingId(): string {
  return `tbn_${uuidV7()}`;
}

export function webhookEndpointId(): string {
  return `whe_${uuidV7()}`;
}

export function webhookSecretId(): string {
  return `whs_${uuidV7()}`;
}

/**
 * 256 bits of CSPRNG entropy, base64url. This is the unguessable component of
 * a webhook URL. Brute-forcing it is not a realistic attack, and finding it
 * still does not let a caller forge a delivery -- every delivery must also
 * carry a valid HMAC signature.
 */
export function webhookPathToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * 256-bit signing secret, base64url. Generated here, handed straight to
 * SecretsProvider, and never returned to a caller or written to this
 * service's database.
 */
export function webhookSigningSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Deterministic SecretsProvider reference for an endpoint's Nth secret.
 * Version is part of the reference so a rotation writes a NEW provider entry
 * rather than overwriting the old one in place -- the old entry is deleted
 * explicitly, after the revocation has committed.
 */
export function secretReference(
  tenantId: string,
  endpointId: string,
  version: number,
): string {
  return `${tenantSecretPrefix(tenantId)}${endpointId}/v${version}`;
}

/** Prefix of every webhook signing secret a tenant owns, for its erasure. */
export function tenantSecretPrefix(tenantId: string): string {
  return `alter/webhook-endpoints/${tenantId}/`;
}

/** Kept so callers that only need an opaque correlation id have one. */
export function correlationId(): string {
  return randomUUID();
}
