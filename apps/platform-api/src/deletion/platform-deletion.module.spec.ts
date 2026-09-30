import "reflect-metadata";
import { createHash } from "node:crypto";
import { createMockMutableSecretsProvider } from "@alterx/shared-clients";
import { describe, expect, it } from "vitest";
import type { EngineConfig } from "../engine";
import { PlatformDeletionModule } from "./platform-deletion.module";
import { PLATFORM_DELETION_TOKEN_HASH } from "./platform-deletion.controller";

describe("platform deletion production credential wiring", () => {
  it("resolves cloud references via the injected secrets provider and caches the hash", async () => {
    const providers = Reflect.getMetadata("providers", PlatformDeletionModule) as { provide: unknown; useFactory: (config: EngineConfig, secrets: unknown) => () => Promise<string> }[];
    const factory = providers.find((provider) => provider.provide === PLATFORM_DELETION_TOKEN_HASH)!;
    const reference = "alter/dev/audit-service/deletion-service-token";
    const secrets = createMockMutableSecretsProvider({ secrets: { [reference]: "test-token" } });
    const hash = factory.useFactory({ auditQueryServiceTokenRef: reference } as EngineConfig, secrets);
    expect(await hash()).toBe(createHash("sha256").update("test-token").digest("hex"));
    await secrets.deleteSecret(reference);
    expect(await hash()).toBe(createHash("sha256").update("test-token").digest("hex"));
    const unavailable = factory.useFactory({ auditQueryServiceTokenRef: reference } as EngineConfig, secrets);
    await expect(unavailable()).rejects.toThrow();
  });
});
