import { HttpException } from "@nestjs/common";
import {v7 as uuidv7} from "uuid";

export class AdminDeploymentHttpError extends HttpException {
  constructor(status: number, code: string, detail: string, instance: string) {
    super({
      type: `https://alter.dev/problems/${code.toLowerCase().replaceAll("_", "-")}`,
      title: code,
      status,
      detail,
      instance,
      error_code: code,
      trace_id: generatedId("trc"),
      request_id: generatedId("req"),
      retryable: false,
      field_errors: [],
      documentation_key: "deployment.admin",
    }, status);
  }
}

function generatedId(prefix: "trc" | "req"): string {
  return `${prefix}_${uuidv7()}`;
}
