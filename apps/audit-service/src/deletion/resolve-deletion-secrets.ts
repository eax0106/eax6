import type { SecretsProvider } from "@alterx/shared-clients";

export interface ResolvedDeletionSecrets {
  readonly serviceToken: string;
  readonly pseudonymKey: string;
  readonly chainSigningKey: string;
}

export async function resolveDeletionSecrets(
  secrets: SecretsProvider,
  references: {
    readonly serviceTokenReference: string;
    readonly pseudonymKeyReference: string;
    readonly chainSigningKeyReference: string;
  },
): Promise<ResolvedDeletionSecrets> {
  const [serviceToken, pseudonymKey, chainSigningKey] = await Promise.all([
    secrets.getSecret(references.serviceTokenReference),
    secrets.getSecret(references.pseudonymKeyReference),
    secrets.getSecret(references.chainSigningKeyReference),
  ]);
  if (serviceToken.length === 0) throw new Error("Deletion service token resolved empty");
  if (pseudonymKey.length < 32) throw new Error("Deletion pseudonym key resolved too short");
  if (chainSigningKey.length < 32) throw new Error("Audit chain signing key resolved too short");
  return { serviceToken, pseudonymKey, chainSigningKey };
}
