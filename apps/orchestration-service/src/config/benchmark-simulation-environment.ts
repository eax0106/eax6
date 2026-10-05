import { loadConversationManagerEnvironment } from "./environment";
import { loadNodeexecEnvironment } from "./nodeexec-environment";
import { loadServiceTokenFingerprint } from "./service-token-fingerprint";

export const BENCHMARK_SIMULATION_ENVIRONMENT = Symbol("BENCHMARK_SIMULATION_ENVIRONMENT");

export interface BenchmarkSimulationEnvironment {
  /** SHA-256 of the internal service token eval-service presents. */
  readonly tokenHash: string;
  readonly modelGatewayAddress: string;
  readonly verifyServiceAddress: string;
  /** Sent verbatim to verification-service, as the node executor does. */
  readonly verifyAuthorization: string;
}

export function loadBenchmarkSimulationEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): BenchmarkSimulationEnvironment {
  return {
    tokenHash: loadServiceTokenFingerprint(environment, "INTERNAL_SERVICE_TOKEN_SHA256"),
    modelGatewayAddress: loadConversationManagerEnvironment(environment).modelGatewayAddress,
    verifyServiceAddress: loadNodeexecEnvironment(environment).verifyServiceAddress,
    verifyAuthorization: `Bearer ${environment["INTERNAL_SERVICE_TOKEN"] ?? ""}`,
  };
}
