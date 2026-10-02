import { status } from "@grpc/grpc-js";
import { Controller, Inject, type INestApplication } from "@nestjs/common";
import {
  GrpcMethod,
  RpcException,
  Transport,
  type MicroserviceOptions,
} from "@nestjs/microservices";

import type {
  CompilerCompileWorkflowRequest,
  CompilerCompileArchitectureWorkflowRequest,
  CompilerCompileWorkflowResponse,
  CompilerValidateWorkflowDagRequest,
  CompilerValidateWorkflowDagResponse,
} from "@alterx/contracts";
import { ConnectionsRequiredSchema } from "@alterx/contracts";
import { internalError } from "./internal-error";

export const COMPILER_HANDLER = Symbol("COMPILER_HANDLER");

export interface CompilerHandler {
  compileWorkflow(
    request: CompilerCompileWorkflowRequest,
  ): Promise<CompilerCompileWorkflowResponse>;
  compileArchitectureWorkflow(request: CompilerCompileArchitectureWorkflowRequest): Promise<CompilerCompileWorkflowResponse>;
  validateWorkflowDag(
    request: CompilerValidateWorkflowDagRequest,
  ): Promise<CompilerValidateWorkflowDagResponse>;
}

export interface CompilerGrpcTransportConfig {
  readonly bindAddress: string;
  readonly protoPath: string;
}

@Controller()
export class CompilerGrpcController {
  constructor(
    @Inject(COMPILER_HANDLER)
    private readonly handler: CompilerHandler,
  ) {}

  @GrpcMethod("CompilerService", "CompileWorkflow")
  async compileWorkflow(
    request: CompilerCompileWorkflowRequest,
  ): Promise<CompilerCompileWorkflowResponse> {
    try {
      return await this.handler.compileWorkflow(request);
    } catch (error: unknown) {
      throw mapCompilerError(error, "Workflow could not be compiled");
    }
  }

  @GrpcMethod("CompilerService", "CompileArchitectureWorkflow")
  async compileArchitectureWorkflow(request: CompilerCompileArchitectureWorkflowRequest): Promise<CompilerCompileWorkflowResponse> {
    try { return await this.handler.compileArchitectureWorkflow(request); }
    catch (error: unknown) { throw mapCompilerError(error, "Architecture could not be compiled"); }
  }

  @GrpcMethod("CompilerService", "ValidateWorkflowDag")
  async validateWorkflowDag(
    request: CompilerValidateWorkflowDagRequest,
  ): Promise<CompilerValidateWorkflowDagResponse> {
    try {
      return await this.handler.validateWorkflowDag(request);
    } catch (error: unknown) {
      throw mapCompilerError(error, "Workflow DAG could not be validated");
    }
  }
}

/**
 * Connects (but does not start) the Compiler gRPC microservice.
 *
 * Unlike startConversationGrpcTransport, this does not call
 * app.startAllMicroservices() itself: NestJS's startAllMicroservices()
 * re-invokes .listen() on every microservice ever connected on this app
 * instance, not just the one just connected, and gRPC servers cannot be
 * listen()'d twice. When a bootstrap connects more than one gRPC
 * transport on the same app, only the last transport in the sequence may
 * call startAllMicroservices() -- see orchestration-service/src/main.ts.
 */
export function connectCompilerGrpcTransport(
  app: INestApplication,
  config: CompilerGrpcTransportConfig,
): void {
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: "alter.compiler.v1",
      protoPath: config.protoPath,
      url: config.bindAddress,
      loader: { keepCase: true },
    },
  });
}

function mapCompilerError(error: unknown, fallbackMessage: string): RpcException {
  if (isNamedError(error, "CompilerConnectionsRequiredError")) {
    let body: unknown;
    try { body = JSON.parse(error.message); } catch { return internalError(error, fallbackMessage); }
    const parsed = ConnectionsRequiredSchema.safeParse(body);
    if (parsed.success) return new RpcException({ code: status.FAILED_PRECONDITION, message: JSON.stringify(parsed.data) });
  }
  if (isNamedError(error, "CompilerValidationError")) {
    return new RpcException({
      code: status.INVALID_ARGUMENT,
      message: error.message,
    });
  }
  if (isNamedError(error, "CompilerConcurrencyError")) {
    return new RpcException({
      code: status.ABORTED,
      message: error.message,
    });
  }
  return internalError(error, fallbackMessage);
}

function isNamedError(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name;
}
