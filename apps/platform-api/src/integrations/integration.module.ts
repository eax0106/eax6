import { createHash } from "node:crypto";
import { Module } from "@nestjs/common";
import { AwsSecretsManagerProvider } from "@alterx/adapters";
import type { MutableSecretsProvider } from "@alterx/shared-clients";
import { Pool } from "pg";
import { resolveRuntimeSecret } from "../identity/identity.module";
import { IdempotencyModule } from "../idempotency";
import { sharedPool } from "../db/shared-pool";
import { poolSizeConfigFromEnvironment } from "../db/pool-config";
import { CONNECTOR_CATALOG } from "./connectors";
import { createFetchOAuthHttpClient, type OAuthHttpClient } from "./adapters/oauth/oauth-http-client";
import {
  ConnectorHealthSweepController,
  CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN_HASH,
} from "./connector-health-sweep.controller";
import { IntegrationController } from "./integration.controller";
import { IntegrationExceptionFilter } from "./integration-exception.filter";
import { NotificationModule } from "../notifications/notification.module";
import { NotificationService } from "../notifications/notification.service";
import { IntegrationRepository } from "./integration.repository";
import {
  IntegrationService,
  type ConnectorRuntimeConfigMap,
} from "./integration.service";
import { SystemIntegrationStore } from "./system-integration-store";
import {
  INTEGRATION_CONNECTOR_RUNTIME_CONFIG,
  INTEGRATION_OAUTH_HTTP_CLIENT,
  INTEGRATION_SECRETS_PROVIDER,
} from "./tokens";

function buildConnectorRuntimeConfig(): ConnectorRuntimeConfigMap {
  const envRefs: Record<string, [string, string]> = {
    github: [
      "GITHUB_OAUTH_CLIENT_ID_SECRET_REF",
      "GITHUB_OAUTH_CLIENT_SECRET_REF",
    ],
    google: [
      "GOOGLE_OAUTH_CLIENT_ID_SECRET_REF",
      "GOOGLE_OAUTH_CLIENT_SECRET_REF",
    ],
    slack: [
      "SLACK_OAUTH_CLIENT_ID_SECRET_REF",
      "SLACK_OAUTH_CLIENT_SECRET_REF",
    ],
    hubspot: [
      "HUBSPOT_OAUTH_CLIENT_ID_SECRET_REF",
      "HUBSPOT_OAUTH_CLIENT_SECRET_REF",
    ],
    linkedin: [
      "LINKEDIN_OAUTH_CLIENT_ID_SECRET_REF",
      "LINKEDIN_OAUTH_CLIENT_SECRET_REF",
    ],
    zendesk: ["ZENDESK_OAUTH_CLIENT_ID_SECRET_REF", "ZENDESK_OAUTH_CLIENT_SECRET_REF"],
    salesforce: ["SALESFORCE_OAUTH_CLIENT_ID_SECRET_REF", "SALESFORCE_OAUTH_CLIENT_SECRET_REF"],
    shopify: ["SHOPIFY_OAUTH_CLIENT_ID_SECRET_REF", "SHOPIFY_OAUTH_CLIENT_SECRET_REF"],
    x: ["X_OAUTH_CLIENT_ID_SECRET_REF", "X_OAUTH_CLIENT_SECRET_REF"],
    m365: ["M365_OAUTH_CLIENT_ID_SECRET_REF", "M365_OAUTH_CLIENT_SECRET_REF"],
  };
  const config: Record<string, unknown> = {};
  for (const connector of CONNECTOR_CATALOG) {
    const [clientIdEnvVar, clientSecretEnvVar] = envRefs[connector.id]!;
    const clientIdEnvValue = process.env[clientIdEnvVar];
    const clientSecretEnvValue = process.env[clientSecretEnvVar];
    config[connector.id] = {
      clientIdSecretRef: clientIdEnvValue ?? connector.defaultClientIdSecretRef,
      clientSecretSecretRef:
        clientSecretEnvValue ?? connector.defaultClientSecretSecretRef,
      configured: Boolean(clientIdEnvValue) && Boolean(clientSecretEnvValue),
    };
  }
  return config as ConnectorRuntimeConfigMap;
}

@Module({
  imports: [IdempotencyModule, NotificationModule],
  controllers: [IntegrationController, ConnectorHealthSweepController],
  providers: [
    {
      provide: IntegrationRepository,
      useFactory: () => new IntegrationRepository(sharedPool(process.env.DATABASE_URL), false),
    },
    {
      // Real, separate bypass-RLS connection for the health sweep's
      // cross-tenant enumeration only -- undefined (fails closed, see
      // SystemIntegrationStore) until the real platform_db system role
      // is provisioned. CONNECTOR_HEALTH_SWEEP_SYSTEM_DATABASE_URL must
      // point at a role with a real BYPASSRLS grant, never the normal
      // per-request role. Deliberately its own dedicated pool, not one of
      // db.module.ts's shared tokens -- this connection string is unique
      // to this one call site, sharing it with anything else would be
      // wrong, not simpler. Still gets the same size/timeout config
      // (ENGINE-FIX-P3-6) as every other pool in this app.
      provide: SystemIntegrationStore,
      useFactory: () => {
        const systemDatabaseUrl = process.env.CONNECTOR_HEALTH_SWEEP_SYSTEM_DATABASE_URL;
        if (!systemDatabaseUrl) return new SystemIntegrationStore(undefined);
        const size = poolSizeConfigFromEnvironment(process.env);
        return new SystemIntegrationStore(new Pool({ connectionString: systemDatabaseUrl, ...size }));
      },
    },
    {
      provide: CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN_HASH,
      useFactory: async () => {
        const reference = process.env.CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN_REF;
        if (!reference) {
          throw new Error("CONNECTOR_HEALTH_SWEEP_SERVICE_TOKEN_REF must be configured");
        }
        const token = await resolveRuntimeSecret(reference);
        return createHash("sha256").update(token).digest("hex");
      },
    },
    {
      provide: INTEGRATION_SECRETS_PROVIDER,
      useFactory: () =>
        new AwsSecretsManagerProvider({
          region: process.env.AWS_REGION ?? "ap-south-1",
        }),
    },
    {
      provide: INTEGRATION_OAUTH_HTTP_CLIENT,
      useFactory: () => createFetchOAuthHttpClient(),
    },
    {
      provide: INTEGRATION_CONNECTOR_RUNTIME_CONFIG,
      useFactory: () => buildConnectorRuntimeConfig(),
    },
    {
      provide: IntegrationService,
      inject: [
        IntegrationRepository,
        INTEGRATION_SECRETS_PROVIDER,
        INTEGRATION_OAUTH_HTTP_CLIENT,
        INTEGRATION_CONNECTOR_RUNTIME_CONFIG,
        SystemIntegrationStore,
        NotificationService,
      ],
      useFactory: (
        repository: IntegrationRepository,
        secrets: MutableSecretsProvider,
        http: OAuthHttpClient,
        connectorConfig: ConnectorRuntimeConfigMap,
        systemStore: SystemIntegrationStore,
        notifications: NotificationService,
      ) =>
        new IntegrationService(
          repository,
          secrets,
          http,
          connectorConfig,
          Number(process.env.OAUTH_STATE_TTL_SECONDS ?? 300),
          systemStore,
          notifications,
        ),
    },
    IntegrationExceptionFilter,
  ],
  exports: [IntegrationService],
})
export class IntegrationModule {}
