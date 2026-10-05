import { Module } from "@nestjs/common";
import { ModelGatewayClient, VerifyServiceClient } from "@alterx/adapters";

import { BenchmarkCaseSimulator } from "./benchmark-simulation/benchmark-case-simulator";
import {
  BENCHMARK_SIMULATION_TOKEN_HASH,
  BenchmarkSimulationController,
} from "./benchmark-simulation/benchmark-simulation.controller";
import {
  BENCHMARK_SIMULATION_ENVIRONMENT,
  loadBenchmarkSimulationEnvironment,
  type BenchmarkSimulationEnvironment,
} from "./config/benchmark-simulation-environment";
import { MODELGW_CLIENT_PROTO_PATH } from "./conversation/grpc.constants";
import { GateHandler } from "./registry/handlers/gate.handler";
import { GroupChatHandler } from "./registry/handlers/groupchat.handler";
import { LlmTaskHandler } from "./registry/handlers/llmtask.handler";
import { MergeHandler } from "./registry/handlers/merge.handler";
import { SynthesisHandler } from "./registry/handlers/synthesis.handler";
import { YamlImportHandler } from "./registry/handlers/yaml-import.handler";
import { NodeHandlerRegistry } from "./registry/node-handler-registry";
import { VERIFY_CLIENT_PROTO_PATH } from "./registry/nodeexec-grpc.constants";
import { VerifyGateService } from "./registry/verify-gate.service";
import { RunLauncherModule } from "./run-launcher.module";
import { RunLauncherService } from "./runs/run-launcher.service";
import { internalM2mTokenProvider } from "./orchestration-infrastructure.module";

/**
 * D25: benchmark cases run through Simulate. Only compute handlers are
 * composed here; nodes that act outside Alter are recorded by the simulator
 * and never reach a handler.
 */
@Module({
  imports: [RunLauncherModule],
  controllers: [BenchmarkSimulationController],
  providers: [
    { provide: BENCHMARK_SIMULATION_ENVIRONMENT, useFactory: () => loadBenchmarkSimulationEnvironment() },
    {
      provide: BENCHMARK_SIMULATION_TOKEN_HASH,
      inject: [BENCHMARK_SIMULATION_ENVIRONMENT],
      useFactory: (environment: BenchmarkSimulationEnvironment) => environment.tokenHash,
    },
    {
      provide: BenchmarkCaseSimulator,
      inject: [RunLauncherService, BENCHMARK_SIMULATION_ENVIRONMENT],
      useFactory: (launcher: RunLauncherService, environment: BenchmarkSimulationEnvironment) => {
        const modelGateway = new ModelGatewayClient({
          address: environment.modelGatewayAddress,
          protoPath: MODELGW_CLIENT_PROTO_PATH,
          accessTokenProvider: internalM2mTokenProvider(),
        });
        const verifyGate = new VerifyGateService(new VerifyServiceClient({
          address: environment.verifyServiceAddress,
          protoPath: VERIFY_CLIENT_PROTO_PATH,
          authorization: environment.verifyAuthorization,
        }));
        return new BenchmarkCaseSimulator(
          launcher,
          (verification) => new NodeHandlerRegistry([
            new GateHandler(verification),
            new MergeHandler(),
            new GroupChatHandler(),
            new YamlImportHandler(),
            new LlmTaskHandler(modelGateway),
            new SynthesisHandler(modelGateway, verification),
          ]),
          verifyGate,
        );
      },
    },
  ],
})
export class BenchmarkSimulationModule {}
