import { createMockSecretsProvider } from "@alterx/shared-clients";
import type { SecretsProvider } from "@alterx/shared-clients";
import { describe, expect, it } from "vitest";

import { resolveDeletionSecrets } from "./resolve-deletion-secrets";

describe("resolveDeletionSecrets", () => {
  it("resolves both values exclusively through reference IDs", async () => {
    const serviceTokenReference = "/alter/prod/audit-service/system/deletion-service-token";
    const pseudonymKeyReference = "/alter/prod/audit-service/system/deletion-pseudonym-key";
    const chainSigningKeyReference = "/alter/prod/audit-service/system/chain-signing-key";
    const base = createMockSecretsProvider({
      secrets: {
        [serviceTokenReference]: "resolved-service-token",
        [pseudonymKeyReference]: "resolved-pseudonym-key-material-over-thirty-two-characters",
        [chainSigningKeyReference]: "resolved-chain-signing-key-over-32-chars",
      },
    });
    const calls: string[] = [];
    const secrets: SecretsProvider = {
      ...base,
      async getSecret(referenceId) {
        calls.push(referenceId);
        return base.getSecret(referenceId);
      },
    };

    await expect(resolveDeletionSecrets(secrets, {
      serviceTokenReference,
      pseudonymKeyReference,
      chainSigningKeyReference,
    })).resolves.toEqual({
      serviceToken: "resolved-service-token",
      pseudonymKey: "resolved-pseudonym-key-material-over-thirty-two-characters",
      chainSigningKey: "resolved-chain-signing-key-over-32-chars",
    });
    expect(calls).toEqual([serviceTokenReference, pseudonymKeyReference, chainSigningKeyReference]);
  });

  it("fails startup when either referenced value cannot be resolved safely", async () => {
    const secrets = createMockSecretsProvider({
      secrets: { token: "service-token", weak: "too-short", strong: "signing-key-material-that-is-long-enough" },
    });
    await expect(resolveDeletionSecrets(secrets, {
      serviceTokenReference: "token",
      pseudonymKeyReference: "weak",
      chainSigningKeyReference: "strong",
    })).rejects.toThrow("too short");

    const emptyToken = createMockSecretsProvider({
      secrets: { empty: "", strong: "pseudonym-key-material-that-is-long-enough", signing: "signing-key-material-that-is-long-enough", weak: "too-short" },
    });
    await expect(resolveDeletionSecrets(emptyToken, {
      serviceTokenReference: "empty",
      pseudonymKeyReference: "strong",
      chainSigningKeyReference: "signing",
    })).rejects.toThrow("service token resolved empty");

    await expect(resolveDeletionSecrets(emptyToken, {
      serviceTokenReference: "strong",
      pseudonymKeyReference: "strong",
      chainSigningKeyReference: "weak",
    })).rejects.toThrow("signing key resolved too short");
  });
});
