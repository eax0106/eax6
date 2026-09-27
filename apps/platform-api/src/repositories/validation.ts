import { z } from "zod";
import { RepositoryHttpError } from "./problem";
import type { BindRepositoryInput } from "./types";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const repositoryIdPattern =
  /^rep_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** GitHub's own limits: owner up to 39 of [A-Za-z0-9-], name up to 100 of [A-Za-z0-9._-]. */
export const fullNamePattern = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

function invalid(instance: string, field: string, message: string): RepositoryHttpError {
  return new RepositoryHttpError(400, "VALIDATION_FAILED", message, instance, [{ field, message }]);
}

export function parseRepositoryId(value: string, instance: string): string {
  if (!repositoryIdPattern.test(value)) throw invalid(instance, "repositoryId", "Invalid repositoryId");
  return value;
}

export function parseConnectionQuery(value: string | undefined, instance: string): string {
  if (value === undefined || !uuidPattern.test(value)) {
    throw invalid(instance, "connection_id", "connection_id must be a connection id");
  }
  return value;
}

const bindSchema = z
  .object({
    connection_id: z.string().regex(uuidPattern),
    full_name: z.string().regex(fullNamePattern),
  })
  .strict();

export function parseBindRepository(value: unknown, instance: string): BindRepositoryInput {
  const parsed = bindSchema.safeParse(value);
  if (!parsed.success) {
    throw new RepositoryHttpError(
      400,
      "VALIDATION_FAILED",
      "Invalid repository binding",
      instance,
      parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "body",
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}
