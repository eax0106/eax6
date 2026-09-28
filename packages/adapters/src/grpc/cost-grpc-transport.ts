import { status } from "@grpc/grpc-js";
import { Controller, Inject, type INestApplication } from "@nestjs/common";
import {
  GrpcMethod,
  RpcException,
  Transport,
  type MicroserviceOptions,
} from "@nestjs/microservices";

import type {
  CostIngestCostEventRequest,
  CostIngestCostEventResponse,
  CostQueryRollupsRequest,
  CostQueryRollupsResponse,
  CostResolveUnitPriceRequest,
  CostResolveUnitPriceResponse,
  CostRecordModelOutcomeRequest,
  CostRecordModelOutcomeResponse,
  CostRecordRunVerdictRequest,
  CostRecordRunVerdictResponse,
} from "@alterx/contracts";
import { internalError } from "./internal-error";

export const COST_HANDLER = Symbol("COST_HANDLER");

export interface CostHandler {
  ingestCostEvent(
    request: CostIngestCostEventRequest,
  ): Promise<CostIngestCostEventResponse>;
  queryRollups(request: CostQueryRollupsRequest): Promise<CostQueryRollupsResponse>;
  resolveUnitPrice(request: CostResolveUnitPriceRequest): Promise<CostResolveUnitPriceResponse>;
  recordModelOutcome(
    request: CostRecordModelOutcomeRequest,
  ): Promise<CostRecordModelOutcomeResponse>;
  recordRunVerdict(
    request: CostRecordRunVerdictRequest,
  ): Promise<CostRecordRunVerdictResponse>;
}

export interface CostGrpcTransportConfig {
  readonly bindAddress: string;
  readonly protoPath: string;
}

@Controller()
export class CostGrpcController {
  constructor(@Inject(COST_HANDLER) private readonly handler: CostHandler) {}

  @GrpcMethod("CostService", "IngestCostEvent")
  async ingestCostEvent(
    request: CostIngestCostEventRequest,
  ): Promise<CostIngestCostEventResponse> {
    try {
      return await this.handler.ingestCostEvent(request);
    } catch (error: unknown) {
      throw mapCostError(error);
    }
  }

  @GrpcMethod("CostService", "QueryRollups")
  async queryRollups(
    request: CostQueryRollupsRequest,
  ): Promise<CostQueryRollupsResponse> {
    try {
      return await this.handler.queryRollups(request);
    } catch (error: unknown) {
      throw mapCostError(error);
    }
  }

  @GrpcMethod("CostService", "ResolveUnitPrice")
  async resolveUnitPrice(
    request: CostResolveUnitPriceRequest,
  ): Promise<CostResolveUnitPriceResponse> {
    try {
      return await this.handler.resolveUnitPrice(request);
    } catch (error: unknown) {
      throw mapCostError(error);
    }
  }

  @GrpcMethod("CostService", "RecordModelOutcome")
  async recordModelOutcome(
    request: CostRecordModelOutcomeRequest,
  ): Promise<CostRecordModelOutcomeResponse> {
    try {
      return await this.handler.recordModelOutcome(request);
    } catch (error: unknown) {
      throw mapCostError(error);
    }
  }

  @GrpcMethod("CostService", "RecordRunVerdict")
  async recordRunVerdict(
    request: CostRecordRunVerdictRequest,
  ): Promise<CostRecordRunVerdictResponse> {
    try {
      return await this.handler.recordRunVerdict(request);
    } catch (error: unknown) {
      throw mapCostError(error);
    }
  }
}

/** Cost Ledger is single-transport, so this starts the microservice itself
 * (matches ModelGw's startModelgwGrpcTransport, not orchestration-service's
 * multi-transport connect-then-start-once pattern). */
export async function startCostGrpcTransport(
  app: INestApplication,
  config: CostGrpcTransportConfig,
): Promise<void> {
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: "alter.cost.v1",
      protoPath: config.protoPath,
      url: config.bindAddress,
      loader: { keepCase: true },
    },
  }, { inheritAppConfig: true });
  await app.startAllMicroservices();
}

function mapCostError(error: unknown): RpcException {
  if (
    isNamedError(error, "CostValidationError") ||
    isNamedError(error, "RollupValidationError") ||
    isNamedError(error, "ModelOutcomesValidationError") ||
    isNamedError(error, "RunVerdictValidationError")
  ) {
    return new RpcException({
      code: status.INVALID_ARGUMENT,
      message: error.message,
    });
  }
  if (isNamedError(error, "RunVerdictConflictError")) {
    return new RpcException({
      code: status.FAILED_PRECONDITION,
      message: error.message,
    });
  }
  if (isNamedError(error, "CostUnrecognizedSourceError")) {
    return new RpcException({
      code: status.INVALID_ARGUMENT,
      message: error.message,
    });
  }
  return internalError(error, "Cost Ledger request could not be completed");
}

function isNamedError(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name;
}
