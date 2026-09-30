import { randomBytes } from "node:crypto";
import { HttpException } from "@nestjs/common";
import type { ProblemDetails } from "@alterx/contracts";

export class CostsHttpError extends HttpException {
  constructor(
    status: 400 | 401 | 403 | 422 | 502,
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
        trace_id: `trc_${uuidV7()}`,
        request_id: `req_${uuidV7()}`,
        retryable: status >= 500,
        field_errors: fieldErrors,
        documentation_key: errorCode.toLowerCase().replaceAll("_", "."),
      } satisfies ProblemDetails,
      status,
    );
  }
}

function uuidV7(): string {
  const bytes = randomBytes(16);
  const timestamp = Date.now();
  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
