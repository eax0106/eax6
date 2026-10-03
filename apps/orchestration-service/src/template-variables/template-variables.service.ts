import { TenantIdSchema } from "@alterx/contracts";
import { randomUUID } from "node:crypto";

interface OrchestrationTransactionLike {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }>;
}

export interface OrchestrationTenantStore {
  withTenant<T>(
    tenantId: string,
    operation: (tx: OrchestrationTransactionLike) => Promise<T>,
  ): Promise<T>;
}

export type TemplateVariableType = "text" | "number" | "secret" | "list";

export interface TemplateVariableDefinition {
  readonly name: string;
  readonly value_type: TemplateVariableType;
  readonly required: boolean;
}

export interface TemplateVariableRead extends TemplateVariableDefinition {
  readonly workflow_version_id: string;
  readonly workflow_version: number;
  readonly is_set: boolean;
  readonly masked?: true;
  readonly value?: unknown;
}

export class TemplateVariableValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateVariableValidationError";
  }
}

export class TemplateVariableNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateVariableNotFoundError";
  }
}

export class TemplateVariableConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateVariableConflictError";
  }
}

interface DefinitionRow extends Record<string, unknown> {
  readonly name: string;
  readonly value_type: TemplateVariableType;
  readonly required: boolean;
  readonly workflow_version_id: string;
  readonly workflow_version: number;
  readonly is_set: boolean;
  readonly value_json: unknown | null;
}

interface WorkflowVersionRow extends Record<string, unknown> {
  readonly id: string;
  readonly version: number;
}

const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const VARIABLE_TYPES: readonly TemplateVariableType[] = ["text", "number", "secret", "list"];

function bareTenantUuid(tenantId: string): string {
  const parsed = TenantIdSchema.safeParse(tenantId);
  if (!parsed.success) {
    throw new TemplateVariableValidationError("tenantId must be a ten_ prefixed UUIDv7");
  }
  return parsed.data.slice("ten_".length);
}

function requireWorkflowId(workflowId: string): void {
  if (!/^wf_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workflowId)) {
    throw new TemplateVariableValidationError("workflowId must be a wf_ prefixed UUIDv7");
  }
}

function normalizedDefinitions(input: readonly TemplateVariableDefinition[]): TemplateVariableDefinition[] {
  const names = new Set<string>();
  const definitions = input.map((definition) => {
    const name = definition.name?.trim();
    if (!name || !VARIABLE_NAME.test(name)) {
      throw new TemplateVariableValidationError("variable name must match [A-Za-z][A-Za-z0-9_]{0,63}");
    }
    if (names.has(name)) {
      throw new TemplateVariableValidationError(`duplicate variable name "${name}"`);
    }
    names.add(name);
    if (!VARIABLE_TYPES.includes(definition.value_type)) {
      throw new TemplateVariableValidationError("value_type must be text, number, secret, or list");
    }
    if (typeof definition.required !== "boolean") {
      throw new TemplateVariableValidationError("required must be a boolean");
    }
    return { name, value_type: definition.value_type, required: definition.required };
  });
  return definitions.sort((left, right) => left.name.localeCompare(right.name));
}

function sameDefinitions(
  current: readonly TemplateVariableDefinition[],
  next: readonly TemplateVariableDefinition[],
): boolean {
  return current.length === next.length && current.every((definition, index) =>
    definition.name === next[index]?.name
    && definition.value_type === next[index]?.value_type
    && definition.required === next[index]?.required,
  );
}

function validateValue(valueType: TemplateVariableType, value: unknown): void {
  if ((valueType === "text" || valueType === "secret") && typeof value !== "string") {
    throw new TemplateVariableValidationError(`${valueType} variable value must be a string`);
  }
  if (valueType === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new TemplateVariableValidationError("number variable value must be a finite number");
  }
  if (valueType === "list" && !Array.isArray(value)) {
    throw new TemplateVariableValidationError("list variable value must be an array");
  }
}

function versionId(): string {
  const uuid = randomUUID();
  return `wfv_${uuid.slice(0, 14)}7${uuid.slice(15)}`;
}

function definitionId(): string {
  const uuid = randomUUID();
  return `wtv_${uuid.slice(0, 14)}7${uuid.slice(15)}`;
}

function toRead(row: DefinitionRow): TemplateVariableRead {
  const base = {
    name: row.name,
    value_type: row.value_type,
    required: row.required,
    workflow_version_id: row.workflow_version_id,
    workflow_version: row.workflow_version,
    is_set: row.is_set,
  };
  if (row.value_type === "secret") {
    return row.is_set ? { ...base, masked: true } : base;
  }
  return row.is_set ? { ...base, value: row.value_json } : base;
}

const SELECT_DEFINITIONS = `SELECT definition.name, definition.value_type, definition.required,
       definition.workflow_version_id, version.version AS workflow_version,
       value.name IS NOT NULL AS is_set, value.value_json
  FROM workflow_template_variable_definitions definition
  JOIN workflow_versions version
    ON version.tenant_id = definition.tenant_id
   AND version.id = definition.workflow_version_id
  LEFT JOIN workflow_template_variable_values value
    ON value.tenant_id = definition.tenant_id
   AND value.workflow_id = definition.workflow_id
   AND value.name = definition.name`;

export class TemplateVariablesService {
  constructor(private readonly store: OrchestrationTenantStore) {}

  async list(tenantIdInput: string, workflowId: string, workspaceId?: string): Promise<readonly TemplateVariableRead[]> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireWorkflowId(workflowId);
    return this.store.withTenant(tenantId, async (tx) => {
      if (workspaceId !== undefined) {
        const owner = await tx.query("SELECT id FROM workflows WHERE tenant_id=$1 AND id=$2 AND workspace_id=$3", [tenantId, workflowId, workspaceId]);
        if (owner.rowCount === 0) throw new TemplateVariableNotFoundError("Workflow was not found");
      }
      return (await this.#definitions(tx, tenantId, workflowId)).map(toRead);
    });
  }

  async replaceDefinitions(
    tenantIdInput: string,
    workflowId: string,
    input: readonly TemplateVariableDefinition[],
  ): Promise<readonly TemplateVariableRead[]> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireWorkflowId(workflowId);
    const definitions = normalizedDefinitions(input);

    return this.store.withTenant(tenantId, async (tx) => {
      const current = await this.#definitions(tx, tenantId, workflowId);
      const currentDefinitions = current.map(({ name, value_type, required }) => ({
        name,
        value_type,
        required,
      }));
      if (sameDefinitions(currentDefinitions, definitions)) {
        return current.map(toRead);
      }

      const latest = await this.#latestVersion(tx, tenantId, workflowId);
      if (latest === undefined) {
        throw new TemplateVariableValidationError(
          "workflow must have a compiled version before template definitions can change",
        );
      }
      const nextVersionId = versionId();
      try {
        await tx.query(
          // task_skeleton is copied with the rest of the compiled shape. This
          // version is the source version's DAG under new variable
          // definitions, and it carries the source's compile_metadata --
          // source_skeleton_hash included -- so dropping the skeleton here
          // would leave a row claiming a skeleton it no longer has, and
          // Recovery would decline to replan a workflow that was in fact
          // skeleton-compiled.
          `INSERT INTO workflow_versions
             (id, tenant_id, workflow_id, version, compiled_dag, task_skeleton,
              dag_schema_version, compile_metadata, status)
           SELECT $1, tenant_id, workflow_id, version + 1, compiled_dag, task_skeleton,
                  dag_schema_version,
                  COALESCE(compile_metadata, '{}'::jsonb)
                    || jsonb_build_object('template_variables_versioned_at', clock_timestamp()::text),
                  'compiled'
           FROM workflow_versions
           WHERE tenant_id = $2 AND id = $3`,
          [nextVersionId, tenantId, latest.id],
        );
      } catch (error: unknown) {
        if ((error as { code?: string }).code === "23505") {
          throw new TemplateVariableConflictError(
            `template definition version raced for workflow ${workflowId}; retry`,
          );
        }
        throw error;
      }

      for (const definition of definitions) {
        await tx.query(
          `INSERT INTO workflow_template_variable_definitions
             (id, tenant_id, workflow_id, workflow_version_id, name, value_type, required)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            definitionId(),
            tenantId,
            workflowId,
            nextVersionId,
            definition.name,
            definition.value_type,
            definition.required,
          ],
        );
      }
      if (definitions.length === 0) {
        await tx.query(
          "DELETE FROM workflow_template_variable_values WHERE tenant_id = $1 AND workflow_id = $2",
          [tenantId, workflowId],
        );
      } else {
        await tx.query(
          `DELETE FROM workflow_template_variable_values
           WHERE tenant_id = $1 AND workflow_id = $2 AND NOT (name = ANY($3::text[]))`,
          [tenantId, workflowId, definitions.map((definition) => definition.name)],
        );
      }
      return (await this.#definitions(tx, tenantId, workflowId)).map(toRead);
    });
  }

  async setValue(
    tenantIdInput: string,
    workflowId: string,
    nameInput: string,
    value: unknown,
  ): Promise<TemplateVariableRead> {
    const tenantId = bareTenantUuid(tenantIdInput);
    requireWorkflowId(workflowId);
    const name = nameInput.trim();
    if (!VARIABLE_NAME.test(name)) {
      throw new TemplateVariableValidationError("variable name must match [A-Za-z][A-Za-z0-9_]{0,63}");
    }
    return this.store.withTenant(tenantId, async (tx) => {
      const definitions = await this.#definitions(tx, tenantId, workflowId);
      const definition = definitions.find((item) => item.name === name);
      if (definition === undefined) {
        throw new TemplateVariableNotFoundError(`template variable ${name} was not found`);
      }
      validateValue(definition.value_type, value);
      await tx.query(
        `INSERT INTO workflow_template_variable_values (tenant_id, workflow_id, name, value_json)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (tenant_id, workflow_id, name)
         DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = clock_timestamp()`,
        [tenantId, workflowId, name, JSON.stringify(value)],
      );
      const updated = (await this.#definitions(tx, tenantId, workflowId)).find(
        (item) => item.name === name,
      );
      if (updated === undefined) {
        throw new TemplateVariableNotFoundError(`template variable ${name} was not found`);
      }
      return toRead(updated);
    });
  }

  async #latestVersion(
    tx: OrchestrationTransactionLike,
    tenantId: string,
    workflowId: string,
  ): Promise<WorkflowVersionRow | undefined> {
    const result = await tx.query<WorkflowVersionRow>(
      `SELECT id, version FROM workflow_versions
       WHERE tenant_id = $1 AND workflow_id = $2
       ORDER BY version DESC LIMIT 1`,
      [tenantId, workflowId],
    );
    return result.rows[0];
  }

  async #definitions(
    tx: OrchestrationTransactionLike,
    tenantId: string,
    workflowId: string,
  ): Promise<readonly DefinitionRow[]> {
    const result = await tx.query<DefinitionRow>(
      `${SELECT_DEFINITIONS}
       WHERE definition.tenant_id = $1
         AND definition.workflow_id = $2
         AND version.version = (
           -- A later DAG-only compile creates a newer workflow version but
           -- does not change the template contract. Read the last definition
           -- snapshot, rather than requiring it to be that exact latest DAG.
           SELECT MAX(snapshot_version.version)
           FROM workflow_template_variable_definitions snapshot_definition
           JOIN workflow_versions snapshot_version
             ON snapshot_version.tenant_id = snapshot_definition.tenant_id
            AND snapshot_version.id = snapshot_definition.workflow_version_id
           WHERE snapshot_definition.tenant_id = $1
             AND snapshot_definition.workflow_id = $2
         )
       ORDER BY definition.name ASC`,
      [tenantId, workflowId],
    );
    return result.rows;
  }
}
