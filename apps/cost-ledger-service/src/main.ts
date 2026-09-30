import "reflect-metadata";

import { createHash } from "node:crypto";

import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { NestFactory } from "@nestjs/core";

import {
  AwsSecretsManagerProvider,
  PostgresCostStoreProvider,
  RunsClient,
  startCostGrpcTransport,
} from "@alterx/adapters";

import { AppModule } from "./app.module";
import { loadCostLedgerEnvironment } from "./config/environment";
import { COST_MIGRATIONS_PATH } from "./database/migrations-path";
import { resolveDatabaseConnectionString } from "./database/resolve-database-secret";
import { COST_PROTO_PATH } from "./ingest/grpc.constants";
import { RUNS_CLIENT_PROTO_PATH } from "./ingest/runs-client.constants";

async function bootstrap(): Promise<void> {
  const environment = loadCostLedgerEnvironment(process.env);
  let secretsProvider: AwsSecretsManagerProvider | undefined;
  let store: PostgresCostStoreProvider | undefined;

  try {
    secretsProvider = new AwsSecretsManagerProvider({ region: "ap-south-1" });
    if (environment.databaseAuthentication === "iam") {
      store = new PostgresCostStoreProvider({
        authentication: "iam",
        host: environment.databaseHost,
        port: environment.databasePort,
        database: environment.databaseName,
        user: environment.databaseUser,
        region: environment.region,
        migrationsFolder: COST_MIGRATIONS_PATH,
      });
    } else {
      const connectionString = await resolveDatabaseConnectionString(
        secretsProvider,
        environment.databaseSecretReference,
      );
      store = new PostgresCostStoreProvider({
        authentication: "static",
        connectionString,
        migrationsFolder: COST_MIGRATIONS_PATH,
      });
    }
    await store.migrate();

    const runsClient = new RunsClient({
      address: environment.runsServiceAddress,
      protoPath: RUNS_CLIENT_PROTO_PATH,
    });
    const pseudonymKey = await secretsProvider.getSecret(environment.pseudonymKeyReference);
    const deletionTokenHash = createHash("sha256")
      .update(await secretsProvider.getSecret(environment.deletionServiceTokenReference))
      .digest("hex");

    const app = await NestFactory.create<NestFastifyApplication>(
      AppModule.register(
        store,
        runsClient,
        environment.costMarginRate,
        environment.costUsdToInrRate,
        pseudonymKey,
        deletionTokenHash,
      ),
      new FastifyAdapter(),
    );
    await startCostGrpcTransport(app, {
      bindAddress: environment.grpcBindAddress,
      protoPath: COST_PROTO_PATH,
    });
    app.enableShutdownHooks();
    await app.listen(environment.httpPort, "0.0.0.0");
  } catch (error: unknown) {
    await store?.close();
    throw error;
  } finally {
    secretsProvider?.close();
  }
}

void bootstrap();
