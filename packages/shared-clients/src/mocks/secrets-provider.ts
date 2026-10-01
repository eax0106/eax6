import type { ProviderCapabilities } from "@alterx/contracts";
import { createMockProvider } from "../mock-provider";
import type {
  ErasableSecretsProvider,
  ProviderMetadata,
  SecretsProvider,
} from "../provider-types";
import { mockCapabilities, mockMetadata } from "./shared";

export const MOCK_SECRETS_CAPABILITIES: ProviderCapabilities =
  mockCapabilities(65_536);

export class InvalidSecretReferenceError extends Error {
  public constructor() {
    super("Secret reference ID must be non-empty and contain no whitespace");
    this.name = "InvalidSecretReferenceError";
  }
}

export class SecretNotFoundError extends Error {
  public readonly referenceId: string;

  public constructor(referenceId: string) {
    super(`Secret reference was not found: ${referenceId}`);
    this.name = "SecretNotFoundError";
    this.referenceId = referenceId;
  }
}

export interface MockSecretsProviderOptions {
  readonly providerId?: string;
  readonly metadata?: ProviderMetadata<"SecretsProvider">;
  readonly capabilities?: ProviderCapabilities;
  readonly secrets?: Readonly<Record<string, string>>;
}

const DEFAULT_SECRETS = Object.freeze({
  "contract/secret": "contract-secret-value",
});

function validateReferenceId(referenceId: string): void {
  if (
    referenceId.length === 0 ||
    referenceId.trim() !== referenceId ||
    /\s/.test(referenceId)
  ) {
    throw new InvalidSecretReferenceError();
  }
}

export function createMockSecretsProvider(
  options: MockSecretsProviderOptions = {},
): SecretsProvider {
  const providerId = options.providerId ?? "mock.secrets";
  const secrets = new Map(
    Object.entries(options.secrets ?? DEFAULT_SECRETS),
  );

  return createMockProvider<SecretsProvider>({
    metadata:
      options.metadata ?? mockMetadata(providerId, "SecretsProvider"),
    capabilities: options.capabilities ?? MOCK_SECRETS_CAPABILITIES,
    implementation: {
      getSecret: async (referenceId) => {
        validateReferenceId(referenceId);

        const secret = secrets.get(referenceId);
        if (secret === undefined) {
          throw new SecretNotFoundError(referenceId);
        }

        return secret;
      },
    },
  });
}

/**
 * Real, disclosed mutable mock (put/delete backed by the same in-memory
 * map getSecret reads from) -- for eval-only entrypoints exercising a real
 * write path (e.g. CredentialService.update/delete) that a plain
 * createMockSecretsProvider() cannot satisfy (it only implements the
 * read-only SecretsProvider interface; MutableSecretsProvider callers
 * calling putSecret/deleteSecret on it fail at runtime since those
 * methods are simply absent from the returned object, not stubbed).
 */
export function createMockMutableSecretsProvider(
  options: MockSecretsProviderOptions = {},
): ErasableSecretsProvider {
  const providerId = options.providerId ?? "mock.secrets.mutable";
  const secrets = new Map(
    Object.entries(options.secrets ?? DEFAULT_SECRETS),
  );

  return createMockProvider<ErasableSecretsProvider>({
    metadata:
      options.metadata ?? mockMetadata(providerId, "SecretsProvider"),
    capabilities: options.capabilities ?? MOCK_SECRETS_CAPABILITIES,
    implementation: {
      getSecret: async (referenceId) => {
        validateReferenceId(referenceId);

        const secret = secrets.get(referenceId);
        if (secret === undefined) {
          throw new SecretNotFoundError(referenceId);
        }

        return secret;
      },
      putSecret: async (referenceId, value) => {
        validateReferenceId(referenceId);
        secrets.set(referenceId, value);
      },
      deleteSecret: async (referenceId) => {
        validateReferenceId(referenceId);
        secrets.delete(referenceId);
      },
      listSecretReferences: async (prefix) =>
        [...secrets.keys()].filter((referenceId) => referenceId.startsWith(prefix)).sort(),
    },
  });
}
