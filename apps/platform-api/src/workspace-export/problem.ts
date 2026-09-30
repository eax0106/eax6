import { HttpException } from "@nestjs/common";

export class WorkspaceExportHttpError extends HttpException {
  constructor(status: number, code: string, detail: string, instance: string) {
    super(
      {
        type: `https://alter.dev/problems/${code.toLowerCase().replaceAll("_", "-")}`,
        title: statusTitle(status),
        status,
        detail,
        instance,
        error_code: code,
      },
      status,
    );
  }
}

function statusTitle(status: number): string {
  if (status === 400) return "Bad Request";
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not Found";
  if (status === 410) return "Gone";
  if (status === 428) return "Precondition Required";
  return "Internal Server Error";
}
