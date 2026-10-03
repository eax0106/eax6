import { RunIdSchema, TenantIdSchema, WorkspaceIdSchema } from "@alterx/contracts";
import { randomUUID } from "node:crypto";
import type { ObjectStorageProvider } from "@alterx/shared-clients";

export class ArtifactNotFoundError extends Error {
  constructor(artifactId: string) {
    super(`Artifact ${artifactId} was not found`);
    this.name = "ArtifactNotFoundError";
  }
}

export class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactValidationError";
  }
}

interface TransactionLike {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }>;
}

export interface ArtifactTenantStore {
  withTenant<T>(tenantId: string, operation: (tx: TransactionLike) => Promise<T>): Promise<T>;
}

type ArtifactRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly run_id: string;
  readonly storage_reference: string;
  readonly content_type: string;
  readonly size_bytes: string | number;
  readonly created_at: string;
  // ENGINE-FIX-B5-1: additive, joined from runs.workspace_id -- consumed
  // by platform-api's workspace-bound RBAC resolver so artifact reads can
  // be checked against the workspace that owns them (see runs_controller's
  // identical workspace_id passthrough for the run resource itself).
  readonly workspace_id: string;
};

export interface Artifact {
  readonly id: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
}

export interface ArtifactPage {
  readonly data: readonly Artifact[];
  readonly page: { readonly next_cursor: string | null; readonly has_more: boolean };
}

export interface CreateArtifactInput {
  readonly runId: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

function bareTenantUuid(tenantId: string): string {
  const parsed = TenantIdSchema.safeParse(tenantId);
  if (!parsed.success) throw new ArtifactValidationError("tenantId must be a ten_ prefixed UUIDv7");
  return parsed.data.slice("ten_".length);
}

function bareWorkspaceUuid(workspaceId: string): string {
  const parsed = WorkspaceIdSchema.safeParse(workspaceId);
  if (!parsed.success) throw new ArtifactValidationError("workspaceId must be a ws_ prefixed UUIDv7");
  return parsed.data.slice("ws_".length);
}

function requireLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new ArtifactValidationError("limit must be an integer from 1 to 200");
  }
  return limit;
}

function requireValue(name: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) throw new ArtifactValidationError(`${name} is required`);
  return value;
}

function newArtifactId(): string {
  const id = randomUUID();
  return `art_${id.slice(0, 14)}7${id.slice(15)}`;
}

function fromRow(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
  };
}

export class ArtifactsService {
  constructor(
    private readonly store: ArtifactTenantStore,
    private readonly objects: ObjectStorageProvider,
    private readonly bucketName: string,
  ) {}

  async create(tenantId: string, input: CreateArtifactInput): Promise<Artifact> {
    const tenant = bareTenantUuid(requireValue("tenantId", tenantId));
    if (!RunIdSchema.safeParse(input.runId).success) {
      throw new ArtifactValidationError("runId must be a run_ prefixed UUIDv7");
    }
    if (input.contentType.trim().length === 0) throw new ArtifactValidationError("contentType is required");
    if (this.bucketName.trim().length === 0) throw new ArtifactValidationError("artifact bucket is required");

    const artifactId = newArtifactId();
    const storageReference = `s3://${this.bucketName}/tenants/${tenant}/runs/${input.runId}/artifacts/${artifactId}`;
    await this.objects.putObject(
      storageReference,
      Buffer.from(input.bytes),
      input.contentType,
    );
    try {
      return await this.store.withTenant(tenant, async (tx) => {
        const result = await tx.query<ArtifactRow>(
          `INSERT INTO artifacts (id, tenant_id, run_id, storage_reference, content_type, size_bytes)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, tenant_id, run_id, storage_reference, content_type, size_bytes, created_at::text,
             (SELECT workspace_id::text FROM runs WHERE runs.tenant_id = artifacts.tenant_id AND runs.id = artifacts.run_id) AS workspace_id`,
          [artifactId, tenant, input.runId, storageReference, input.contentType, input.bytes.byteLength],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error("artifact insert returned no row");
        return fromRow(row);
      });
    } catch (error: unknown) {
      try { await this.objects.deleteObject(storageReference); } catch { /* Preserve the database failure. */ }
      throw error;
    }
  }

  async list(tenantId: string, runId: string, workspaceId?: string): Promise<readonly Artifact[]> {
    const tenant = bareTenantUuid(requireValue("tenantId", tenantId));
    const run = requireValue("runId", runId);
    return this.store.withTenant(tenant, async (tx) => {
      const result = await tx.query<ArtifactRow>(
        `SELECT a.id, a.tenant_id, a.run_id, a.storage_reference, a.content_type, a.size_bytes, a.created_at,
           r.workspace_id::text AS workspace_id
         FROM artifacts a
         JOIN runs r ON r.tenant_id = a.tenant_id AND r.id = a.run_id
         WHERE a.tenant_id = $1 AND a.run_id = $2 AND ($3::uuid IS NULL OR r.workspace_id = $3) ORDER BY a.created_at DESC, a.id DESC`,
        [tenant, run, workspaceId ?? null],
      );
      return result.rows.map(fromRow);
    });
  }

  /**
   * Every artifact produced by runs in one workspace, newest first, paged by
   * artifact id. Workspace comes from the run that produced the artifact, so
   * a caller sees only artifacts of runs in the workspace they are acting in.
   */
  async listForWorkspace(
    tenantId: string,
    workspaceId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<ArtifactPage> {
    const tenant = bareTenantUuid(requireValue("tenantId", tenantId));
    const workspace = bareWorkspaceUuid(requireValue("workspaceId", workspaceId));
    const pageSize = requireLimit(limit);
    return this.store.withTenant(tenant, async (tx) => {
      const conditions = ["a.tenant_id = $1", "r.workspace_id = $2"];
      const values: unknown[] = [tenant, workspace];
      if (cursor !== undefined) {
        const cursorRow = await tx.query<{ readonly created_at: string }>(
          `SELECT a.created_at::text FROM artifacts a
           JOIN runs r ON r.tenant_id = a.tenant_id AND r.id = a.run_id
           WHERE a.tenant_id = $1 AND r.workspace_id = $2 AND a.id = $3`,
          [tenant, workspace, cursor],
        );
        const createdAt = cursorRow.rows[0]?.created_at;
        if (createdAt === undefined) throw new ArtifactValidationError("cursor does not belong to this workspace");
        values.push(createdAt, cursor);
        conditions.push(`(a.created_at, a.id) < ($${values.length - 1}::timestamptz, $${values.length})`);
      }
      values.push(pageSize + 1);
      const result = await tx.query<ArtifactRow>(
        `SELECT a.id, a.tenant_id, a.run_id, a.storage_reference, a.content_type, a.size_bytes, a.created_at,
           r.workspace_id::text AS workspace_id
         FROM artifacts a
         JOIN runs r ON r.tenant_id = a.tenant_id AND r.id = a.run_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT $${values.length}`,
        values,
      );
      const rows = result.rows.slice(0, pageSize);
      const hasMore = result.rows.length > pageSize;
      return {
        data: rows.map(fromRow),
        page: { next_cursor: hasMore ? rows[rows.length - 1]!.id : null, has_more: hasMore },
      };
    });
  }

  async get(tenantId: string, artifactId: string): Promise<Artifact> {
    const { row } = await this.find(tenantId, artifactId);
    return fromRow(row);
  }

  async download(tenantId: string, artifactId: string): Promise<{ readonly signed_url: string; readonly expires_at: string }> {
    const { row } = await this.find(tenantId, artifactId);
    const expiresInSeconds = 900;
    const signedUrl = await this.objects.createPresignedDownloadUrl(row.storage_reference, expiresInSeconds);
    return {
      signed_url: signedUrl,
      expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    };
  }

  async read(tenantId: string, artifactId: string): Promise<Uint8Array> {
    const { row } = await this.find(tenantId, artifactId);
    return new Uint8Array(await this.objects.getObject(row.storage_reference));
  }

  private async find(tenantId: string, artifactId: string): Promise<{ readonly row: ArtifactRow }> {
    const tenant = bareTenantUuid(requireValue("tenantId", tenantId));
    const id = requireValue("artifactId", artifactId);
    return this.store.withTenant(tenant, async (tx) => {
      const result = await tx.query<ArtifactRow>(
        `SELECT a.id, a.tenant_id, a.run_id, a.storage_reference, a.content_type, a.size_bytes, a.created_at,
           r.workspace_id::text AS workspace_id
         FROM artifacts a
         JOIN runs r ON r.tenant_id = a.tenant_id AND r.id = a.run_id
         WHERE a.tenant_id = $1 AND a.id = $2`,
        [tenant, id],
      );
      const row = result.rows[0];
      if (row === undefined) throw new ArtifactNotFoundError(id);
      return { row };
    });
  }
}
