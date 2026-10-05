import { v7 as uuidv7 } from "uuid";
import type { ProblemDetails } from "@alterx/contracts";
import { HttpException } from "@nestjs/common";

export class BillingHttpError extends HttpException {
  constructor(
    status: 400 | 401 | 403 | 404 | 409 | 412 | 428 | 502 | 503 | 504,
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
        trace_id: `trc_${uuidv7()}`,
        request_id: `req_${uuidv7()}`,
        retryable: status >= 500,
        field_errors: fieldErrors,
        documentation_key: errorCode.toLowerCase().replaceAll("_", "."),
      } satisfies ProblemDetails,
      status,
    );
  }
}
