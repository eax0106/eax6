import { randomUUID } from "node:crypto";
import type { ProblemDetails } from "@alterx/contracts";
import { HttpException } from "@nestjs/common";

export class BudgetHttpError extends HttpException {
  constructor(
    status: 400 | 401 | 403 | 404 | 428,
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
        retryable: false,
        field_errors: fieldErrors,
        documentation_key: errorCode.toLowerCase().replaceAll("_", "."),
      } satisfies ProblemDetails,
      status,
    );
  }
}

export function budgetNotFound(instance: string): BudgetHttpError {
  return new BudgetHttpError(404, "BUDGET_NOT_FOUND", "Budget not found", instance);
}
