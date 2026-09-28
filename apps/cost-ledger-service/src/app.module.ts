import { Module, type DynamicModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import {
  COST_HANDLER,
  type CostHandler,
  CostGrpcController,
  type RunsHandlerClient,
} from "@alterx/adapters";
import { M2mValidator, ServiceAuthGuard } from "@alterx/auth";

import { COST_STORE_PROVIDER, type CostStoreProvider } from "./database/cost-store.token";
import { CostStoreLifecycle } from "./database/store.lifecycle";
import { CostIngestService, type CostEventStore } from "./ingest/cost-ingest.service";
import { CostRollupService, type RollupStore } from "./rollup/cost-rollup.service";
import { CostSummaryController } from "./rollup/cost-summary.controller";
import { EstimationController } from "./estimation/estimation.controller";
import { EstimationService } from "./estimation/estimation.service";
import { HealthController } from "./health/health.controller";
import { ModelOutcomesController } from "./model-outcomes/model-outcomes.controller";
import { ModelOutcomesService } from "./model-outcomes/model-outcomes.service";
import { RunVerdictsService } from "./run-verdicts/run-verdicts.service";
import { NodeCostsController } from "./node-costs/node-costs.controller";
import { NodeCostsService } from "./node-costs/node-costs.service";

@Module({})
export class AppModule {
  static register(
    store: CostStoreProvider,
    runsClient: RunsHandlerClient,
    marginRate: number,
    usdToInrRate: number,
    pseudonymKey: string,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        CostGrpcController,
        HealthController,
        EstimationController,
        NodeCostsController,
        CostSummaryController,
        ModelOutcomesController,
      ],
      providers: [
        serviceAuthGuardProvider(),
        { provide: COST_STORE_PROVIDER, useValue: store },
        EstimationService,
        NodeCostsService,
        ModelOutcomesService,
        RunVerdictsService,
        {
          provide: CostRollupService,
          useFactory: () =>
            new CostRollupService(
              store as unknown as RollupStore,
              marginRate,
              pseudonymKey,
            ),
        },
        CostStoreLifecycle,
        {
          provide: COST_HANDLER,
          inject: [CostRollupService, EstimationService, ModelOutcomesService, RunVerdictsService],
          useFactory: (
            rollup: CostRollupService,
            estimation: EstimationService,
            modelOutcomes: ModelOutcomesService,
            runVerdicts: RunVerdictsService,
          ): CostHandler => {
            const ingest = new CostIngestService(
              store as unknown as CostEventStore,
              runsClient,
              usdToInrRate,
            );
            return {
              ingestCostEvent: (request) => ingest.ingestCostEvent(request),
              queryRollups: (request) => rollup.queryRollups(request),
              resolveUnitPrice: (request) => estimation.resolveUnitPrice(request),
              recordModelOutcome: (request) => modelOutcomes.recordOutcome(request),
              recordRunVerdict: (request) => runVerdicts.recordRunVerdict(request),
            };
          },
        },
      ],
    };
  }
}

function serviceAuthGuardProvider() {
  return {
    provide: APP_GUARD,
    useFactory: () =>
      new ServiceAuthGuard(
        new M2mValidator({
          auth0Domain: process.env["AUTH0_DOMAIN"] ?? "",
          apiAudience: process.env["API_AUDIENCE"] ?? "",
          ...(process.env["AUTH0_JWKS_URL"] === undefined
            ? {}
            : { jwksUrl: process.env["AUTH0_JWKS_URL"] }),
        }),
      ),
  };
}
