import "reflect-metadata";

import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { NestFactory } from "@nestjs/core";

import {
  AwsSecretsManagerProvider,
  AwsSsmParameterProvider,
  PostgresAuditStoreProvider,
  S3ObjectStorageProvider,
  startAuditGrpcTransport,
} from "@alterx/adapters";

import { AppModule } from "./app.module";
import { AUDIT_PROTO_PATH } from "./audit/grpc.constants";
import { loadAuditEnvironment } from "./config/environment";
import { AUDIT_MIGRATIONS_PATH } from "./database/migrations-path";
import { resolveDatabaseConnectionString } from "./database/resolve-database-secret";
import { resolveDeletionSecrets } from "./deletion/resolve-deletion-secrets";

async function bootstrap(): Promise<void> {
  const environment = loadAuditEnvironment(process.env);
  const parameterStore = new AwsSsmParameterProvider({ region: environment.region });
  let secretsProvider: AwsSecretsManagerProvider | undefined;
  let store: PostgresAuditStoreProvider | undefined;

  try {
    // Resolve the configured bucket parameter during startup; deletion paths
    // currently receive object references from the ledger rather than build keys.
    await parameterStore.getParameter(environment.auditArchiveBucketParameter);
    secretsProvider = new AwsSecretsManagerProvider({ region: environment.region });
    const retentionConnectionString = await resolveDatabaseConnectionString(
      secretsProvider, environment.retentionDatabaseSecretReference,
    );
    if (environment.databaseAuthentication === "iam") {
      store = new PostgresAuditStoreProvider({
        authentication: "iam",
        host: environment.databaseHost,
        port: environment.databasePort,
        database: environment.databaseName,
        user: environment.databaseUser,
        region: environment.region,
        migrationsFolder: AUDIT_MIGRATIONS_PATH,
        retentionConnectionString,
      });
    } else {
      const connectionString = await resolveDatabaseConnectionString(
        secretsProvider,
        environment.databaseSecretReference,
      );
      store = new PostgresAuditStoreProvider({
        authentication: "static",
        connectionString,
        retentionConnectionString,
        migrationsFolder: AUDIT_MIGRATIONS_PATH,
      });
    }
    await store.migrate();
    const { serviceToken, pseudonymKey, chainSigningKey } = await resolveDeletionSecrets(secretsProvider, {
      serviceTokenReference: environment.deletionServiceTokenReference,
      pseudonymKeyReference: environment.deletionPseudonymKeyReference,
      chainSigningKeyReference: environment.chainSigningKeyReference,
    });
    const serviceTokenHash = (await import("node:crypto")).createHash("sha256").update(serviceToken).digest("hex");
    const app = await NestFactory.create<NestFastifyApplication>(
      AppModule.register(store, {
        adsBaseUrl: environment.adsDeletionBaseUrl,
        orchestrationBaseUrl: environment.orchestrationDeletionBaseUrl,
        platformApiBaseUrl: environment.platformApiDeletionBaseUrl,
        costBaseUrl: environment.costDeletionBaseUrl,
        intelligenceBaseUrl: environment.intelligenceDeletionBaseUrl,
        memoryBaseUrl: environment.memoryDeletionBaseUrl,
        evalBaseUrl: environment.evalDeletionBaseUrl,
        serviceToken,
        serviceTokenHash,
        pseudonymKey,
        chainSigningKey,
        objectStorage: new S3ObjectStorageProvider({ region: environment.region }),
      }),
      new FastifyAdapter(),
    );
    await startAuditGrpcTransport(app, {
      bindAddress: environment.grpcBindAddress,
      protoPath: AUDIT_PROTO_PATH,
    });
    app.enableShutdownHooks();
    await app.listen(environment.httpPort, "0.0.0.0");
  } catch (error: unknown) {
    await store?.close();
    throw error;
  } finally {
    secretsProvider?.close();
    parameterStore.close();
  }
}

void bootstrap();
