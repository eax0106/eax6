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
import { applyMargin, CostRollupService, type RollupStore } from "./rollup/cost-rollup.service";
import { CostSummaryController } from "./rollup/cost-summary.controller";
import { TenantSpendController } from "./rollup/tenant-spend.controller";
import { TenantSpendService } from "./rollup/tenant-spend.service";
import { EstimationController } from "./estimation/estimation.controller";
import { EstimationService } from "./estimation/estimation.service";
import { RunEstimatesController } from "./estimation/run-estimates.controller";
import { RUN_ESTIMATE_MARGIN, RUN_ESTIMATE_USD_TO_INR, RunEstimatesService } from "./estimation/run-estimates.service";
import { HealthController } from "./health/health.controller";
import { ModelOutcomesController } from "./model-outcomes/model-outcomes.controller";
import { ModelOutcomesService } from "./model-outcomes/model-outcomes.service";
import { RunVerdictsService } from "./run-verdicts/run-verdicts.service";
import { NodeCostsController } from "./node-costs/node-costs.controller";
import { NodeCostsService } from "./node-costs/node-costs.service";
import { RUN_TOTAL_MARGIN, RunTotalService } from "./node-costs/run-total.service";
import { COST_DELETION_TOKEN_HASH, CostDeletionController } from "./deletion/cost-deletion.controller";
import { CostDeletionService, type CostDeletionStore } from "./deletion/cost-deletion.service";

@Module({})
export class AppModule {
  static register(
    store: CostStoreProvider,
    runsClient: RunsHandlerClient,
    marginRate: number,
    usdToInrRate: number,
    pseudonymKey: string,
    deletionTokenHash: string,
  ): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        CostGrpcController,
        HealthController,
        EstimationController,
        RunEstimatesController,
        NodeCostsController,
        CostSummaryController,
        TenantSpendController,
        ModelOutcomesController,
        CostDeletionController,
      ],
      providers: [
        serviceAuthGuardProvider(),
        { provide: COST_STORE_PROVIDER, useValue: store },
        { provide: TenantSpendService, useFactory: () => new TenantSpendService(store as unknown as RollupStore, marginRate) },
        { provide: COST_DELETION_TOKEN_HASH, useValue: deletionTokenHash },
        { provide: CostDeletionService, useValue: new CostDeletionService(store as unknown as CostDeletionStore) },
        EstimationService,
        NodeCostsService,
        { provide: RUN_TOTAL_MARGIN, useValue: (internalCostMinor: string) => applyMargin(internalCostMinor, marginRate) },
        RunTotalService,
        { provide: RUN_ESTIMATE_MARGIN, useValue: (internalCostMinor: string) => applyMargin(internalCostMinor, marginRate) },
        { provide: RUN_ESTIMATE_USD_TO_INR, useValue: String(usdToInrRate) },
        RunEstimatesService,
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
