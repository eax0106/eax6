import { createHash, createHmac } from "node:crypto";

import {
  ProblemDetailsSchema,
  type DeletionResult,
  type ReplayResult,
  type RetentionSweepResult,
  type SubjectDataLocation,
  type VerificationResult,
} from "@alterx/contracts";
import {
  createMockAuditStoreProvider,
  createMockObjectStorageProvider,
} from "@alterx/shared-clients";
import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  DELETION_SERVICE_TOKEN_HASH,
  DeletionController,
} from "./deletion.controller";
import { AuditService } from "../audit/audit.service";
import { DeletionOrchestrator } from "./deletion-orchestrator";
import type { InternalDeletionStoreClient, InternalWorkspaceDeletionStoreClient } from "./http-deletion-provider";

const TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890a1";
const OTHER_TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890b1";
const OBJECT_REFERENCE = "s3://ads-private/redacted/content";
const HMAC_KEY = "test-only-key-material-with-at-least-32-characters";

class MemoryDeletionClient implements InternalDeletionStoreClient {
  readonly rows = new Map([[TENANT, 2], [OTHER_TENANT, 1]]);
  readonly references = new Map([[TENANT, [OBJECT_REFERENCE] as readonly string[]]]);
  failVerification = false;

  constructor(readonly store: string) {}

  async locateSubjectData(tenantId: string): Promise<readonly SubjectDataLocation[]> {
    return [{
      store: this.store,
      table: "fixture",
      rowCount: this.rows.get(tenantId) ?? 0,
      objectReferences: this.references.get(tenantId) ?? [],
    }];
  }

  async deleteSubjectData(tenantId: string, manifestId: string): Promise<DeletionResult> {
    const deletedRows = this.rows.get(tenantId) ?? 0;
    const deletedObjects = this.references.get(tenantId)?.length ?? 0;
    this.rows.set(tenantId, 0);
    this.references.set(tenantId, []);
    return { store: this.store, manifestId, deletedRows, deletedObjects };
  }

  async verifyDeletion(tenantId: string, manifestId: string): Promise<VerificationResult> {
    const rowCount = this.failVerification ? 1 : (this.rows.get(tenantId) ?? 0);
    const remaining = rowCount === 0 ? [] : [{
      store: this.store,
      table: "fixture",
      rowCount,
      objectReferences: [],
    }];
    return { store: this.store, manifestId, deleted: remaining.length === 0, remaining };
  }

  async applyRetentionPolicy(): Promise<RetentionSweepResult> {
    return { store: this.store, deletedRows: 0, deletedObjects: 0, sweptAt: new Date(0).toISOString() };
  }

  async replayDeletionLedger(): Promise<ReplayResult> {
    throw new Error("audit service coordinates replay");
  }

  async listSubjectIds(): Promise<readonly string[]> {
    return [...this.rows.keys()];
  }
}

describe("DeletionOrchestrator", () => {
  it("rejects weak pseudonym keys and invalid replay timestamps", async () => {
    const audit = createMockAuditStoreProvider();
    const objects = createMockObjectStorageProvider();
    expect(() => new DeletionOrchestrator(audit, [], objects, "weak")).toThrow(
      "at least 32 characters",
    );
    const orchestrator = new DeletionOrchestrator(audit, [], objects, HMAC_KEY, () => new AuditService(audit, HMAC_KEY).sealChain());
    await expect(orchestrator.replayDeletionLedger("not-a-timestamp")).rejects.toThrow("ISO 8601");
  });

  it("purges, verifies, and persists only an irreversible pseudonym", async () => {
    const audit = createMockAuditStoreProvider();
    const objects = createMockObjectStorageProvider([OBJECT_REFERENCE]);
    const providers = [new MemoryDeletionClient("ads-core"), new MemoryDeletionClient("orchestration-service")];
    const orchestrator = new DeletionOrchestrator(audit, providers, objects, HMAC_KEY, () => new AuditService(audit, HMAC_KEY).sealChain());

    const execution = await orchestrator.execute(TENANT);
    expect(execution).toMatchObject({ completed: true });
    expect(execution.manifestId).toMatch(/^del_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(objects.deletedReferences).toEqual([OBJECT_REFERENCE]);
    await expect(objects.objectExists(OBJECT_REFERENCE)).resolves.toBe(false);
    expect(audit.deletionCertificates()).toHaveLength(1);
    expect(audit.deletionLedger()).toHaveLength(1);
    const expectedPseudonym = `tnp_${createHmac("sha256", HMAC_KEY).update(TENANT).digest("hex")}`;
    expect(audit.deletionCertificates()[0]?.tenantPseudonym).toBe(expectedPseudonym);
    expect(audit.deletionLedger()[0]?.subjectPseudonym).toBe(expectedPseudonym);

    const persisted = JSON.stringify({
      certificates: audit.deletionCertificates(),
      ledger: audit.deletionLedger(),
    });
    expect(persisted).not.toContain(TENANT);
    expect(persisted).not.toContain(OTHER_TENANT);
    expect(persisted).not.toContain(OBJECT_REFERENCE);
    expect(persisted).not.toContain(HMAC_KEY);
  });

  it("records an incomplete certificate and no replay ledger on verification failure", async () => {
    const audit = createMockAuditStoreProvider();
    const objects = createMockObjectStorageProvider([OBJECT_REFERENCE]);
    const provider = new MemoryDeletionClient("ads-core");
    provider.failVerification = true;
    const orchestrator = new DeletionOrchestrator(audit, [provider], objects, HMAC_KEY, () => new AuditService(audit, HMAC_KEY).sealChain());

    await expect(orchestrator.execute(TENANT)).rejects.toThrow("verification failed");
    expect(audit.deletionLedger()).toEqual([]);
    expect(audit.deletionCertificates()).toEqual([
      expect.objectContaining({
        completedAt: null,
        manifest: expect.objectContaining({
          status: "incomplete",
          failed_stage: "verify",
          deletion_results: [expect.objectContaining({ store: "ads-core", deletedRows: 2 })],
          verification_results: [expect.objectContaining({ store: "ads-core", deleted: false })],
        }),
      }),
    ]);
    const persisted = JSON.stringify(audit.deletionCertificates());
    expect(persisted).not.toContain(TENANT);
    expect(persisted).not.toContain(OBJECT_REFERENCE);
    expect(persisted).not.toContain(HMAC_KEY);
  });

  it("fails verification when a located object survives its delete request", async () => {
    const audit = createMockAuditStoreProvider();
    const baseObjects = createMockObjectStorageProvider([OBJECT_REFERENCE]);
    const objects = { ...baseObjects, deleteObject: async () => undefined };
    const orchestrator = new DeletionOrchestrator(
      audit,
      [new MemoryDeletionClient("ads-core")],
      objects,
      HMAC_KEY,
      () => new AuditService(audit, HMAC_KEY).sealChain(),
    );
    await expect(orchestrator.execute(TENANT)).rejects.toThrow("Object deletion verification failed");
    expect(audit.deletionLedger()).toEqual([]);
  });

  it("replays restored rows and objects by transient HMAC matching only", async () => {
    const audit = createMockAuditStoreProvider();
    const objects = createMockObjectStorageProvider([OBJECT_REFERENCE]);
    const provider = new MemoryDeletionClient("ads-core");
    await audit.appendDeletionLedger({
      id: "018f4d6e-2b4a-7a3e-8c1a-123456789090",
      subjectPseudonym: `tnp_${createHmac("sha256", HMAC_KEY).update(TENANT).digest("hex")}`,
      subjectSelectors: { scheme: "hmac-sha256-v1" },
      deletedAt: new Date("2026-07-30T00:00:00.000Z"),
    });
    const orchestrator = new DeletionOrchestrator(audit, [provider], objects, HMAC_KEY, () => new AuditService(audit, HMAC_KEY).sealChain());

    await expect(orchestrator.replayDeletionLedger("2026-07-29T00:00:00.000Z")).resolves.toEqual({
      store: "audit-service",
      ledgerEntriesReplayed: 1,
      deletedRows: 2,
      deletedObjects: 1,
    });
    expect(provider.rows.get(TENANT)).toBe(0);
    expect(provider.rows.get(OTHER_TENANT)).toBe(1);
    await expect(objects.objectExists(OBJECT_REFERENCE)).resolves.toBe(false);
  });

  it("keeps internal endpoints fail-closed and never logs request IDs", async () => {
    const token = "internal-test-token";
    const audit = createMockAuditStoreProvider();
    const orchestrator = new DeletionOrchestrator(
      audit,
      [new MemoryDeletionClient("ads-core")],
      createMockObjectStorageProvider([OBJECT_REFERENCE]),
      HMAC_KEY,
      () => new AuditService(audit, HMAC_KEY).sealChain(),
    );
    const controller = new DeletionController(
      orchestrator,
      createHash("sha256").update(token).digest("hex"),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    for (const authorization of [undefined, "Bearer wrong"]) {
      try {
        await controller.execute({ tenantId: TENANT }, authorization);
        throw new Error("expected authentication failure");
      } catch (failure: unknown) {
        expect(failure).toBeInstanceOf(HttpException);
        const response = ProblemDetailsSchema.parse((failure as HttpException).getResponse());
        expect(response).toMatchObject({ status: 401, error_code: "DELETION_AUTHENTICATION_FAILED" });
        expect(JSON.stringify(response)).not.toContain(TENANT);
      }
    }
    await expect(controller.execute({ tenantId: TENANT }, `Bearer ${token}`)).resolves.toMatchObject({
      completed: true,
    });
    await expect(
      controller.replay({ sinceTimestamp: "2026-07-30T00:00:00.000Z" }, `Bearer ${token}`),
    ).resolves.toMatchObject({ store: "audit-service" });
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    expect(DELETION_SERVICE_TOKEN_HASH.description).toBe("DELETION_SERVICE_TOKEN_HASH");
  });
});

describe("DeletionOrchestrator workspace erasure (D2)", () => {
  const WORKSPACE = "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890c1";
  const WORKSPACE_REF = "s3://ads-private/redacted/workspace";

  function workspaceStore(store: string, options: { failVerification?: boolean } = {}) {
    const rows = new Map([[WORKSPACE, 3]]);
    const refs = new Map([[WORKSPACE, [WORKSPACE_REF] as readonly string[]]]);
    const calls: string[] = [];
    return {
      calls,
      client: {
        store,
        locateWorkspaceData: vi.fn(async (_tenant: string, workspace: string) => {
          calls.push(`locate ${store}`);
          return [{ store, table: "fixture", rowCount: rows.get(workspace) ?? 0, objectReferences: store === "ads-core" ? refs.get(workspace) ?? [] : [] }];
        }),
        deleteWorkspaceData: vi.fn(async (_tenant: string, workspace: string, manifestId: string) => {
          calls.push(`delete ${store}`);
          const deletedRows = rows.get(workspace) ?? 0;
          rows.set(workspace, 0);
          return { store, manifestId, deletedRows, deletedObjects: 0 };
        }),
        verifyWorkspaceDeletion: vi.fn(async (_tenant: string, workspace: string, manifestId: string) => {
          const rowCount = options.failVerification ? 1 : rows.get(workspace) ?? 0;
          return { store, manifestId, deleted: rowCount === 0, remaining: rowCount === 0 ? [] : [{ store, table: "fixture", rowCount, objectReferences: [] }] };
        }),
      } as unknown as InternalWorkspaceDeletionStoreClient,
    };
  }

  it("purges objects, then rows, then verifies, across the workspace stores only, and certifies without minimising", async () => {
    const minimise = vi.fn();
    const certificate = vi.fn(async () => undefined);
    const auditStore = { ...createMockAuditStoreProvider(), minimiseTenantEvents: minimise, storeDeletionCertificate: certificate };
    const objects = createMockObjectStorageProvider();
    await objects.putObject(WORKSPACE_REF, Buffer.from("x"), "text/plain");
    const tenantOnly = new MemoryDeletionClient("cost-ledger-service");
    const ads = workspaceStore("ads-core");
    const engine = workspaceStore("orchestration-service");
    const seal = vi.fn();
    const orchestrator = new DeletionOrchestrator(auditStore, [tenantOnly], objects, HMAC_KEY, seal, [ads.client, engine.client]);

    await expect(orchestrator.executeWorkspace(TENANT, WORKSPACE)).resolves.toMatchObject({ completed: true });
    expect(ads.calls).toEqual(["locate ads-core", "delete ads-core"]);
    expect(engine.calls).toEqual(["locate orchestration-service", "delete orchestration-service"]);
    await expect(objects.objectExists(WORKSPACE_REF)).resolves.toBe(false);
    expect(tenantOnly.rows.get(TENANT)).toBe(2);
    expect(minimise).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    expect(certificate).toHaveBeenCalledWith(expect.objectContaining({
      completedAt: expect.any(Date),
      manifest: expect.objectContaining({ status: "completed", scope: "workspace", workspace_id: WORKSPACE }),
    }));
  });

  it("fails and records an incomplete certificate when a store still holds workspace rows", async () => {
    const certificate = vi.fn(async () => undefined);
    const auditStore = { ...createMockAuditStoreProvider(), storeDeletionCertificate: certificate };
    const orchestrator = new DeletionOrchestrator(
      auditStore, [], createMockObjectStorageProvider(), HMAC_KEY, vi.fn(),
      [workspaceStore("platform-api", { failVerification: true }).client],
    );
    await expect(orchestrator.executeWorkspace(TENANT, WORKSPACE)).rejects.toThrow("Provider deletion verification failed");
    expect(certificate).toHaveBeenCalledWith(expect.objectContaining({
      completedAt: null,
      manifest: expect.objectContaining({ status: "incomplete", failed_stage: "verify", scope: "workspace" }),
    }));
  });
});
