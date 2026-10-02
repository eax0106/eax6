import { expect, it } from "vitest";
import { loadServiceTokenFingerprint } from "./service-token-fingerprint";

it("requires and normalizes each operation's SHA-256 fingerprint", () => {
  for (const field of [
    "CONNECTION_REGISTRY_SERVICE_TOKEN_SHA256",
    "DEPLOYMENT_ADMIN_SERVICE_TOKEN_SHA256",
    "DELETION_SERVICE_TOKEN_SHA256",
  ]) {
    const fingerprint = "aB".repeat(32);
    expect(loadServiceTokenFingerprint({ [field]: ` ${fingerprint} ` }, field))
      .toBe(fingerprint);
    for (const value of [undefined, "", " ", "a".repeat(63), "z".repeat(64)]) {
      expect(() => loadServiceTokenFingerprint({ [field]: value }, field))
        .toThrow(`${field} must be a 64-character SHA-256 fingerprint`);
    }
  }
});
