import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { describe, expect, it, vi } from "vitest";

import {
  AwsSecretsManagerProvider,
  type SecretsManagerCommandClient,
} from "./secrets-manager-provider";

describe("AwsSecretsManagerProvider", () => {
  it("resolves secret string by reference without logging value", async () => {
    const send = vi.fn(async (command: GetSecretValueCommand) => {
      expect(command.input.SecretId).toBe("/alter/prod/audit/database");
      return { SecretString: "postgresql://resolved-at-runtime" };
    });
    const destroy = vi.fn();
    const provider = new AwsSecretsManagerProvider(
      { region: "ap-south-1" },
      { send, destroy } as SecretsManagerCommandClient,
    );

    await expect(
      provider.getSecret("/alter/prod/audit/database"),
    ).resolves.toBe("postgresql://resolved-at-runtime");
    await expect(provider.healthCheck()).resolves.toMatchObject({
      status: "healthy",
    });
    provider.close();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("supports binary values and rejects invalid or empty resolution", async () => {
    const binaryClient: SecretsManagerCommandClient = {
      send: vi.fn(async () => ({
        SecretBinary: Buffer.from("postgresql://binary-runtime"),
      })),
    };
    const binaryProvider = new AwsSecretsManagerProvider(
      { region: "ap-south-1" },
      binaryClient,
    );
    await expect(binaryProvider.getSecret("audit/database")).resolves.toBe(
      "postgresql://binary-runtime",
    );
    await expect(binaryProvider.getSecret(" bad ")).rejects.toThrow(
      /reference ID/,
    );

    const emptyProvider = new AwsSecretsManagerProvider(
      { region: "ap-south-1" },
      { send: vi.fn(async () => ({})) },
    );
    await expect(emptyProvider.getSecret("audit/database")).rejects.toThrow(
      "Secret reference was not found",
    );
    expect(() => new AwsSecretsManagerProvider({ region: "" })).toThrow(
      /region is required/,
    );
  });

  it("creates, rotates, and deletes secrets without logging their value", async () => {
    const secret = "never-print-me";
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("exists"), {
          name: "ResourceExistsException",
        }),
      )
      .mockResolvedValue({});
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const provider = new AwsSecretsManagerProvider(
      { region: "ap-south-1" },
      { send } as SecretsManagerCommandClient,
    );

    await provider.putSecret("credential/ref", secret);
    await provider.deleteSecret("credential/ref");

    expect(send.mock.calls[0]![0]).toBeInstanceOf(CreateSecretCommand);
    expect(send.mock.calls[1]![0]).toBeInstanceOf(PutSecretValueCommand);
    expect(send.mock.calls[2]![0]).toBeInstanceOf(DeleteSecretCommand);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    log.mockRestore();
  });

  it("does not retry unexpected create failures", async () => {
    const send = vi.fn().mockRejectedValue(new Error("denied"));
    const provider = new AwsSecretsManagerProvider(
      { region: "ap-south-1" },
      { send } as SecretsManagerCommandClient,
    );
    await expect(provider.putSecret("credential/ref", "value")).rejects.toThrow(
      "denied",
    );
    await expect(provider.putSecret("credential/ref", "")).rejects.toThrow(
      "non-empty",
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("deletes idempotently: a missing secret counts as deleted, other failures surface", async () => {
    const notFound = Object.assign(new Error("gone"), { name: "ResourceNotFoundException" });
    const denied = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
    const send = vi.fn().mockRejectedValueOnce(notFound).mockRejectedValueOnce(denied);
    const provider = new AwsSecretsManagerProvider({ region: "ap-south-1" }, { send } as unknown as SecretsManagerCommandClient);

    await expect(provider.deleteSecret("alter/webhook-endpoints/ten_x/whe_1/v1")).resolves.toBeUndefined();
    await expect(provider.deleteSecret("alter/webhook-endpoints/ten_x/whe_1/v2")).rejects.toThrow("denied");
    expect(send.mock.calls[0]![0]).toBeInstanceOf(DeleteSecretCommand);
  });

  it("lists every page of names under a prefix and drops loose name-filter matches", async () => {
    const send = vi.fn(async (command: ListSecretsCommand) => {
      expect(command.input.Filters).toEqual([{ Key: "name", Values: ["alter/webhook-endpoints/ten_a/"] }]);
      return command.input.NextToken === undefined
        ? { SecretList: [{ Name: "alter/webhook-endpoints/ten_a/whe_2/v1" }, { Name: "other/alter/webhook-endpoints/ten_a/x" }], NextToken: "page-2" }
        : { SecretList: [{ Name: "alter/webhook-endpoints/ten_a/whe_1/v1" }, {}] };
    });
    const provider = new AwsSecretsManagerProvider({ region: "ap-south-1" }, { send } as unknown as SecretsManagerCommandClient);

    await expect(provider.listSecretReferences("alter/webhook-endpoints/ten_a/")).resolves.toEqual([
      "alter/webhook-endpoints/ten_a/whe_1/v1",
      "alter/webhook-endpoints/ten_a/whe_2/v1",
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
