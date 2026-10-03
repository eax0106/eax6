import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

import type { ProviderCapabilities } from "@alterx/contracts";
import { SecretNotFoundError } from "@alterx/shared-clients";
import type {
  ProviderHealth,
  ProviderMetadata,
  ErasableSecretsProvider,
} from "@alterx/shared-clients";

export interface AwsSecretsManagerConfig {
  readonly region: string;
}

export interface SecretsManagerCommandClient {
  send(command: GetSecretValueCommand): Promise<{
    readonly SecretString?: string;
    readonly SecretBinary?: Uint8Array;
  }>;
  send(command: CreateSecretCommand | PutSecretValueCommand | DeleteSecretCommand | ListSecretsCommand): Promise<unknown>;
  destroy?(): void;
}

const AWS_SECRETS_CAPABILITIES: ProviderCapabilities = {
  streaming: false,
  tool_calling: false,
  vision: false,
  structured_output: false,
  long_context: false,
  regional_availability: ["ap-south-1"],
  data_residency: ["IN"],
  batch_support: false,
  maximum_payload: 65_536,
  supported_languages: [],
  cost_model: { rates: [] },
};

const AWS_SECRETS_METADATA: ProviderMetadata<"SecretsProvider"> = {
  providerId: "aws-secrets-manager",
  interfaceName: "SecretsProvider",
  displayName: "AWS Secrets Manager",
  version: "foundation-v1",
  telemetryNamespace: "alterx.adapters.aws.secrets-manager",
  supportsTenantOverrides: false,
  migration: {
    strategyVersion: "aws-secrets-manager-v1",
    rollbackSupported: true,
  },
};

export class AwsSecretsManagerProvider implements ErasableSecretsProvider {
  readonly metadata = AWS_SECRETS_METADATA;
  readonly capabilities = AWS_SECRETS_CAPABILITIES;

  readonly #client: SecretsManagerCommandClient;

  constructor(config: AwsSecretsManagerConfig, client?: SecretsManagerCommandClient) {
    if (config.region.trim().length === 0) {
      throw new Error("AWS Secrets Manager region is required");
    }
    this.#client = client ?? new SecretsManagerClient({ region: config.region });
  }

  async getSecret(referenceId: string): Promise<string> {
    validateReference(referenceId);
    const response = await this.#client.send(
      new GetSecretValueCommand({ SecretId: referenceId }),
    );
    const value =
      response.SecretString ??
      (response.SecretBinary === undefined
        ? undefined
        : Buffer.from(response.SecretBinary).toString("utf8"));
    if (value === undefined || value.length === 0) {
      throw new SecretNotFoundError(referenceId);
    }
    return value;
  }

  async putSecret(referenceId: string, value: string): Promise<void> {
    validateReference(referenceId);
    if (value.length === 0) {
      throw new Error("Secret value must be non-empty");
    }
    try {
      await this.#client.send(
        new CreateSecretCommand({ Name: referenceId, SecretString: value }),
      );
    } catch (error) {
      if (!isResourceExists(error)) {
        throw error;
      }
      await this.#client.send(
        new PutSecretValueCommand({ SecretId: referenceId, SecretString: value }),
      );
    }
  }

  /** Idempotent: a reference that no longer exists counts as deleted. */
  async deleteSecret(referenceId: string): Promise<void> {
    validateReference(referenceId);
    try {
      await this.#client.send(
        new DeleteSecretCommand({
          SecretId: referenceId,
          ForceDeleteWithoutRecovery: true,
        }),
      );
    } catch (error) {
      if (!isErrorNamed(error, "ResourceNotFoundException")) {
        throw error;
      }
    }
  }

  /**
   * Every secret name starting with `prefix`. The name filter matches more
   * loosely than a prefix, so results are filtered again here.
   */
  async listSecretReferences(prefix: string): Promise<readonly string[]> {
    validateReference(prefix);
    const names: string[] = [];
    let nextToken: string | undefined;
    do {
      const page = (await this.#client.send(
        new ListSecretsCommand({
          Filters: [{ Key: "name", Values: [prefix] }],
          MaxResults: 100,
          ...(nextToken === undefined ? {} : { NextToken: nextToken }),
        }),
      )) as { readonly SecretList?: readonly { readonly Name?: string }[]; readonly NextToken?: string };
      for (const secret of page.SecretList ?? []) {
        if (secret.Name !== undefined && secret.Name.startsWith(prefix)) names.push(secret.Name);
      }
      nextToken = page.NextToken;
    } while (nextToken !== undefined);
    return names.sort();
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      status: "healthy",
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
      details: { configured: true },
    };
  }

  close(): void {
    this.#client.destroy?.();
  }
}

function validateReference(referenceId: string): void {
  if (referenceId.length === 0 || referenceId.trim() !== referenceId) {
    throw new Error("Secret reference ID must be non-empty and trimmed");
  }
}

function isResourceExists(error: unknown): boolean {
  return isErrorNamed(error, "ResourceExistsException");
}

function isErrorNamed(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && Reflect.get(error, "name") === name;
}
