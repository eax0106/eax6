import { Module } from "@nestjs/common";
import {
  ARTIFACT_CONTENT_HANDLER,
  ArtifactContentGrpcController,
  AwsSsmParameterProvider,
  S3ObjectStorageProvider,
} from "@alterx/adapters";

import { ArtifactsController } from "./artifacts/artifacts.controller";
import { ArtifactsService } from "./artifacts/artifacts.service";
import { ArtifactContentGrpcService } from "./artifacts/artifact-content-grpc.service";
import {
  OrchestrationInfrastructureModule,
  orchestrationStore,
  identityTenantGatewayEnvironment,
} from "./orchestration-infrastructure.module";

@Module({
  imports: [OrchestrationInfrastructureModule],
  controllers: [ArtifactContentGrpcController, ArtifactsController],
  providers: [
    {
      provide: ArtifactsService,
      useFactory: async () => {
        const dbConfig = identityTenantGatewayEnvironment(process.env);
        const store = orchestrationStore(dbConfig);
        const parameterStore = new AwsSsmParameterProvider({ region: dbConfig.awsRegion });
        try {
          const bucketName = await parameterStore.getParameter(dbConfig.artifactsBucketParameter);
          return new ArtifactsService(store, new S3ObjectStorageProvider({ region: dbConfig.awsRegion }), bucketName);
        } finally {
          parameterStore.close();
        }
      },
    },
    {
      provide: ARTIFACT_CONTENT_HANDLER,
      useFactory: (artifacts: ArtifactsService) => new ArtifactContentGrpcService(artifacts),
      inject: [ArtifactsService],
    },
  ],
  exports: [ArtifactsService],
})
export class ArtifactModule {}
