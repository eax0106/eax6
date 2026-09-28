import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { IntegrationModule } from "./integration.module";
import { IntegrationRepository } from "./integration.repository";
import { IntegrationService } from "./integration.service";
import {
  INTEGRATION_CONNECTOR_RUNTIME_CONFIG,
  INTEGRATION_OAUTH_HTTP_CLIENT,
  INTEGRATION_SECRETS_PROVIDER,
} from "./tokens";
import type { ConnectorRuntimeConfigMap } from "./integration.service";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("IntegrationModule", () => {
  it("wires real providers with no connectors configured by default", async () => {
    process.env.DATABASE_URL = "postgres://localhost/platform";
    process.env.CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN_REF =
      "env:CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN";
    process.env.CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN = "test-connector-health-sweep-token";
    process.env.NOTIFICATION_DIGEST_SERVICE_TOKEN_REF = "env:NOTIFICATION_DIGEST_SERVICE_TOKEN";
    process.env.NOTIFICATION_DIGEST_SERVICE_TOKEN = "test-notification-digest-token";
    delete process.env.GITHUB_OAUTH_CLIENT_ID_SECRET_REF;
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET_REF;
    delete process.env.GOOGLE_OAUTH_CLIENT_ID_SECRET_REF;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET_REF;
    delete process.env.OAUTH_STATE_TTL_SECONDS;

    const moduleRef = await Test.createTestingModule({
      imports: [IntegrationModule],
    }).compile();

    expect(moduleRef.get(IntegrationRepository)).toBeInstanceOf(
      IntegrationRepository,
    );
    expect(moduleRef.get(IntegrationService)).toBeInstanceOf(
      IntegrationService,
    );
    expect(moduleRef.get(INTEGRATION_SECRETS_PROVIDER)).toBeDefined();
    expect(moduleRef.get(INTEGRATION_OAUTH_HTTP_CLIENT)).toBeDefined();

    const connectorConfig = moduleRef.get<ConnectorRuntimeConfigMap>(
      INTEGRATION_CONNECTOR_RUNTIME_CONFIG,
    );
    expect(connectorConfig.github.configured).toBe(false);
    expect(connectorConfig.google.configured).toBe(false);
    expect(connectorConfig.github.clientIdSecretRef).toBe(
      "/alter/integrations/github/client-id",
    );

    await moduleRef.close();
  });

  it("marks a connector configured once both secret refs are set via env", async () => {
    process.env.DATABASE_URL = "postgres://localhost/platform";
    process.env.CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN_REF =
      "env:CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN";
    process.env.CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN = "test-connector-health-sweep-token";
    process.env.NOTIFICATION_DIGEST_SERVICE_TOKEN_REF = "env:NOTIFICATION_DIGEST_SERVICE_TOKEN";
    process.env.NOTIFICATION_DIGEST_SERVICE_TOKEN = "test-notification-digest-token";
    process.env.GITHUB_OAUTH_CLIENT_ID_SECRET_REF =
      "/alter/prod/integrations/github/client-id";
    process.env.GITHUB_OAUTH_CLIENT_SECRET_REF =
      "/alter/prod/integrations/github/client-secret";

    const moduleRef = await Test.createTestingModule({
      imports: [IntegrationModule],
    }).compile();

    const connectorConfig = moduleRef.get<ConnectorRuntimeConfigMap>(
      INTEGRATION_CONNECTOR_RUNTIME_CONFIG,
    );
    expect(connectorConfig.github).toEqual({
      clientIdSecretRef: "/alter/prod/integrations/github/client-id",
      clientSecretSecretRef: "/alter/prod/integrations/github/client-secret",
      configured: true,
    });
    expect(connectorConfig.google.configured).toBe(false);

    await moduleRef.close();
  });
});
