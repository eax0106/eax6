import { Module } from "@nestjs/common";
import { sharedPool } from "../db/shared-pool";
import { IdempotencyModule } from "../idempotency";
import { IntegrationModule } from "../integrations";
import { GitHubRepositoryClient } from "./github-repository-client";
import { RepositoryBindingRepository } from "./repository-binding.repository";
import { RepositoryController } from "./repository.controller";
import { RepositoryService } from "./repository.service";

@Module({
  imports: [IdempotencyModule, IntegrationModule],
  controllers: [RepositoryController],
  providers: [
    {
      provide: RepositoryBindingRepository,
      useFactory: () => new RepositoryBindingRepository(sharedPool(process.env.DATABASE_URL), false),
    },
    { provide: GitHubRepositoryClient, useFactory: () => new GitHubRepositoryClient() },
    RepositoryService,
  ],
})
export class RepositoryModule {}
