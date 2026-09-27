import { randomUUID } from "node:crypto";
import type { ProblemDetails } from "@alterx/contracts";
import { HttpException } from "@nestjs/common";

export class RepositoryHttpError extends HttpException {
  constructor(
    status: 400 | 401 | 403 | 404 | 409 | 502,
    errorCode: string,
    detail: string,
    instance: string,
    fieldErrors: ProblemDetails["field_errors"] = [],
  ) {
    super(
      {
        type: `https://errors.alter.ai/${errorCode.toLowerCase().replaceAll("_", "-")}`,
        title: errorCode,
        status,
        detail,
        instance,
        error_code: errorCode,
        trace_id: `trc_${randomUUID()}`,
        request_id: `req_${randomUUID()}`,
        retryable: status >= 500,
        field_errors: fieldErrors,
        documentation_key: errorCode.toLowerCase().replaceAll("_", "."),
      } satisfies ProblemDetails,
      status,
    );
  }
}

export function repositoryNotFound(instance: string): RepositoryHttpError {
  return new RepositoryHttpError(404, "REPOSITORY_NOT_FOUND", "Repository binding not found", instance);
}
