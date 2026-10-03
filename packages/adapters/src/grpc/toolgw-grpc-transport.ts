import { status } from "@grpc/grpc-js";
import { Controller, Inject, type INestApplication } from "@nestjs/common";
import {
  GrpcMethod,
  RpcException,
  Transport,
  type MicroserviceOptions,
} from "@nestjs/microservices";

import type {
  ToolgwFetchUrlRequest,
  ToolgwFetchUrlResponse,
  ToolgwInvokeToolRequest,
  ToolgwInvokeToolResponse,
  ToolgwResolveCredentialRequest,
  ToolgwResolveCredentialResponse,
} from "@alterx/contracts";

import { SsrfBlockedError } from "../http/ssrf-guard";
import { internalError } from "./internal-error";

export const TOOLGW_HANDLER = Symbol("TOOLGW_HANDLER");

export class ToolGatewayCredentialMissingError extends Error {
  constructor() {
    super("CREDENTIAL_MISSING");
    this.name = "ToolGatewayCredentialMissingError";
  }
}

export class ToolGatewayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolGatewayValidationError";
  }
}

export class ToolGatewayPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolGatewayPermissionError";
  }
}

export class ToolGatewayRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolGatewayRateLimitError";
  }
}

export class ToolGatewayNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolGatewayNotImplementedError";
  }
}

export interface ToolgwHandler {
  invokeTool(
    request: ToolgwInvokeToolRequest,
  ): Promise<ToolgwInvokeToolResponse>;
  resolveCredential(
    request: ToolgwResolveCredentialRequest,
  ): Promise<ToolgwResolveCredentialResponse>;
  fetchUrl(request: ToolgwFetchUrlRequest): Promise<ToolgwFetchUrlResponse>;
}

export interface ToolgwGrpcTransportConfig {
  readonly bindAddress: string;
  readonly protoPath: string;
}

@Controller()
export class ToolgwGrpcController {
  constructor(
    @Inject(TOOLGW_HANDLER)
    private readonly handler: ToolgwHandler,
  ) {}

  @GrpcMethod("ToolgwService", "InvokeTool")
  async invokeTool(
    request: ToolgwInvokeToolRequest,
  ): Promise<ToolgwInvokeToolResponse> {
    try {
      return await this.handler.invokeTool(request);
    } catch (error: unknown) {
      throw mapToolGatewayError(
        error,
        "Tool invocation could not be completed",
      );
    }
  }

  @GrpcMethod("ToolgwService", "ResolveCredential")
  async resolveCredential(
    request: ToolgwResolveCredentialRequest,
  ): Promise<ToolgwResolveCredentialResponse> {
    try {
      return await this.handler.resolveCredential(request);
    } catch (error: unknown) {
      throw mapToolGatewayError(
        error,
        "Credential reference could not be resolved",
      );
    }
  }

  @GrpcMethod("ToolgwService", "FetchUrl")
  async fetchUrl(
    request: ToolgwFetchUrlRequest,
  ): Promise<ToolgwFetchUrlResponse> {
    try {
      return await this.handler.fetchUrl(request);
    } catch (error: unknown) {
      throw mapToolGatewayError(error, "URL fetch could not be completed");
    }
  }
}

export async function startToolgwGrpcTransport(
  app: INestApplication,
  config: ToolgwGrpcTransportConfig,
): Promise<void> {
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: "alter.toolgw.v1",
      protoPath: config.protoPath,
      url: config.bindAddress,
      loader: { keepCase: true },
    },
  }, { inheritAppConfig: true });
  await app.startAllMicroservices();
}

function mapToolGatewayError(error: unknown, fallbackMessage: string): RpcException {
  if (error instanceof ToolGatewayCredentialMissingError) {
    return new RpcException({ code: status.FAILED_PRECONDITION, message: error.message });
  }
  if (error instanceof ToolGatewayValidationError) {
    return new RpcException({
      code: status.INVALID_ARGUMENT,
      message: error.message,
    });
  }
  if (error instanceof ToolGatewayPermissionError) {
    return new RpcException({
      code: status.PERMISSION_DENIED,
      message: error.message,
    });
  }
  if (error instanceof ToolGatewayRateLimitError) {
    return new RpcException({
      code: status.RESOURCE_EXHAUSTED,
      message: error.message,
    });
  }
  if (error instanceof ToolGatewayNotImplementedError) {
    return new RpcException({
      code: status.UNIMPLEMENTED,
      message: error.message,
    });
  }
  if (error instanceof SsrfBlockedError) {
    return new RpcException({
      code: status.PERMISSION_DENIED,
      message: error.message,
    });
  }
  return internalError(error, fallbackMessage);
}
