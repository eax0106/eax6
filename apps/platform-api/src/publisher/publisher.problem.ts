import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import type { ProblemDetails } from "@alterx/contracts";

export class PublisherHttpError extends HttpException {
  constructor(status: 400 | 403 | 404 | 409 | 502 | 503, errorCode: string, detail: string, instance: string) {
    super({
      type: `https://errors.alter.ai/${errorCode.toLowerCase().replaceAll("_", "-")}`,
      title: errorCode,
      status,
      detail,
      instance,
      error_code: errorCode,
      trace_id: `trc_${randomUUID()}`,
      request_id: `req_${randomUUID()}`,
      retryable: status >= 500,
      field_errors: [],
      documentation_key: errorCode.toLowerCase().replaceAll("_", "."),
    } satisfies ProblemDetails, status);
  }
}
