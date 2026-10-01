import { createHmac } from "node:crypto";
import type {
  DeletionResult,
  ReplayResult,
  SubjectDataLocation,
  VerificationResult,
} from "@alterx/contracts";
import type {
  AuditStoreProvider,
  AuditChainCheckpoint,
  JsonValue,
  ObjectStorageProvider,
} from "@alterx/shared-clients";
import type { InternalDeletionStoreClient, InternalWorkspaceDeletionStoreClient } from "./http-deletion-provider";
import { createUuidV7 } from "../audit/audit-id";

export interface DeletionExecutionResult {
  readonly manifestId: string;
  readonly completed: boolean;
}

export const AUDIT_ERASURE_TABLES = ["audit_events"] as const;

/**
 * The stores that hold per-workspace data (D2 workspace erasure). The cost
 * ledger is left out on purpose: its records are billing records, kept with
 * the tenant under the legal hold. Memory policies and audit events are
 * tenant-level.
 */
export const WORKSPACE_ERASURE_STORES = ["ads-core", "orchestration-service", "platform-api", "intelligence-service"] as const;

interface DeletionProgress {
  readonly manifestId: string;
  stage: "locate" | "object_purge" | "provider_purge" | "verify" | "audit_minimise" | "complete";
  readonly located: { store: string; locations: readonly SubjectDataLocation[] }[];
  readonly deleted: DeletionResult[];
  readonly verified: VerificationResult[];
  deletedObjectReferences: number;
  verifiedAbsentObjectReferences: number;
}

export class DeletionOrchestrator {
  constructor(
    private readonly auditStore: AuditStoreProvider,
    private readonly providers: readonly InternalDeletionStoreClient[],
    private readonly objects: ObjectStorageProvider,
    private readonly pseudonymKey: string,
    private readonly sealAuditChain?: () => Promise<AuditChainCheckpoint | undefined>,
    private readonly workspaceProviders: readonly InternalWorkspaceDeletionStoreClient[] = [],
  ) {
    if (pseudonymKey.length < 32) throw new Error("Deletion pseudonym key must contain at least 32 characters");
  }

  async execute(tenantId: string): Promise<DeletionExecutionResult> {
    const manifestId = `del_${createUuidV7()}`;
    const requestedAt = new Date();
    const progress = newProgress(manifestId);
    try {
      const outcome = await this.purgeAndVerify(tenantId, progress);
      const pseudonym = this.pseudonym(tenantId);
      const completedAt = new Date();
      const ledgerEntry = {
        id: createUuidV7(), subjectPseudonym: pseudonym,
        subjectSelectors: { scheme: "hmac-sha256-v1" }, deletedAt: completedAt,
      } as const;
      const certificate = {
        id: createUuidV7(), tenantPseudonym: pseudonym,
        manifest: progressManifest(outcome, true),
        requestedAt, completedAt, verifiedBy: "audit-service/deletion-orchestrator",
      } as const;
      await this.auditStore.storeDeletionCompletion(certificate, ledgerEntry);
      return { manifestId, completed: true };
    } catch (error: unknown) {
      await this.auditStore.storeDeletionCertificate({
        id: createUuidV7(), tenantPseudonym: this.pseudonym(tenantId),
        manifest: progressManifest(progress, false),
        requestedAt, completedAt: null, verifiedBy: "audit-service/deletion-orchestrator",
      });
      throw error;
    }
  }

  /**
   * D2: erase one workspace of a tenant that stays, at the end of the
   * workspace's undo window. The same locate, object purge, provider purge
   * and verify sequence as a tenant's erasure, narrowed to the workspace; the
   * tenant's audit trail stays whole (no minimisation, no ledger entry), and
   * the certificate records the outcome either way.
   */
  async executeWorkspace(tenantId: string, workspaceId: string): Promise<DeletionExecutionResult> {
    const manifestId = `del_${createUuidV7()}`;
    const requestedAt = new Date();
    const progress = newProgress(manifestId);
    let completed = false;
    try {
      await this.purgeAndVerifyStores(
        progress,
        this.workspaceProviders.map((provider) => ({
          store: provider.store,
          locate: () => provider.locateWorkspaceData(tenantId, workspaceId),
          purge: (manifest: string) => provider.deleteWorkspaceData(tenantId, workspaceId, manifest),
          verify: (manifest: string) => provider.verifyWorkspaceDeletion(tenantId, workspaceId, manifest),
        })),
      );
      progress.stage = "complete";
      completed = true;
      return { manifestId, completed: true };
    } finally {
      await this.auditStore.storeDeletionCertificate({
        id: createUuidV7(), tenantPseudonym: this.pseudonym(tenantId),
        manifest: { ...progressManifest(progress, completed), scope: "workspace", workspace_id: workspaceId },
        requestedAt, completedAt: completed ? new Date() : null, verifiedBy: "audit-service/deletion-orchestrator",
      });
    }
  }

  async replayDeletionLedger(sinceTimestamp: string): Promise<ReplayResult> {
    const since = new Date(sinceTimestamp);
    if (Number.isNaN(since.getTime())) throw new Error("sinceTimestamp must be ISO 8601");
    const entries = await this.auditStore.listDeletionLedgerSince(since);
    const deletedPseudonyms = new Set(entries.map((entry) => entry.subjectPseudonym));
    const subjects = new Set<string>();
    for (const provider of this.providers) {
      for (const subject of await provider.listSubjectIds()) subjects.add(subject);
    }
    let replayed = 0;
    let deletedRows = 0;
    let deletedObjects = 0;
    for (const subject of subjects) {
      if (!deletedPseudonyms.has(this.pseudonym(subject))) continue;
      const result = await this.purgeAndVerify(subject, newProgress(`del_${createUuidV7()}`));
      replayed += 1;
      deletedRows += result.deleted.reduce((sum, item) => sum + item.deletedRows, 0);
      deletedObjects += result.deleted.reduce((sum, item) => sum + item.deletedObjects, 0);
    }
    return { store: "audit-service", ledgerEntriesReplayed: replayed, deletedRows, deletedObjects };
  }

  pseudonym(tenantId: string): string {
    return `tnp_${createHmac("sha256", this.pseudonymKey).update(tenantId).digest("hex")}`;
  }

  /** Locate, purge objects, purge rows, verify rows and objects: shared by tenant and workspace erasure. */
  private async purgeAndVerifyStores(progress: DeletionProgress, stores: readonly ScopedStore[]): Promise<void> {
    for (const store of stores) {
      progress.located.push({ store: store.store, locations: await store.locate() });
    }
    progress.stage = "object_purge";
    const objectReferences = uniqueObjectReferences(progress.located.flatMap((item) => item.locations));
    for (const reference of objectReferences) {
      await this.objects.deleteObject(reference);
      progress.deletedObjectReferences += 1;
    }
    progress.stage = "provider_purge";
    for (const store of stores) {
      progress.deleted.push(await store.purge(progress.manifestId));
    }
    progress.stage = "verify";
    for (const store of stores) {
      progress.verified.push(await store.verify(progress.manifestId));
    }
    for (const reference of objectReferences) {
      if (await this.objects.objectExists(reference)) {
        throw new Error("Object deletion verification failed");
      }
      progress.verifiedAbsentObjectReferences += 1;
    }
    if (progress.verified.some((result) => !result.deleted)) {
      throw new Error("Provider deletion verification failed");
    }
  }

  private async purgeAndVerify(tenantId: string, progress: DeletionProgress) {
    await this.purgeAndVerifyStores(
      progress,
      this.providers.map((provider) => ({
        store: provider.store,
        locate: () => provider.locateSubjectData(tenantId),
        purge: (manifest: string) => provider.deleteSubjectData(tenantId, manifest),
        verify: (manifest: string) => provider.verifyDeletion(tenantId, manifest),
      })),
    );
    // D2: with every provider verified, this tenant's own audit events
    // shrink to skeletons (pseudonym kept, content gone) stamped now. The
    // 90-day sweep destroys them; the ledger certificate below names only
    // the pseudonym either way.
    progress.stage = "audit_minimise";
    if (this.sealAuditChain === undefined) throw new Error("Audit chain sealing is required before minimisation");
    const seal = await this.sealAuditChain();
    const erasedAt = new Date();
    // An empty global chain has no checkpoint and no tenant rows to minimise.
    if (seal !== undefined) {
      await this.auditStore.minimiseTenantEvents(tenantId, this.pseudonym(tenantId), erasedAt, seal);
    }
    progress.stage = "complete";
    return progress;
  }
}

interface ScopedStore {
  readonly store: string;
  locate(): Promise<readonly SubjectDataLocation[]>;
  purge(manifestId: string): Promise<DeletionResult>;
  verify(manifestId: string): Promise<VerificationResult>;
}

function uniqueObjectReferences(locations: readonly SubjectDataLocation[]): readonly string[] {
  return [...new Set(locations.flatMap((item) => item.objectReferences))];
}

function newProgress(manifestId: string): DeletionProgress {
  return {
    manifestId,
    stage: "locate",
    located: [],
    deleted: [],
    verified: [],
    deletedObjectReferences: 0,
    verifiedAbsentObjectReferences: 0,
  };
}

function progressManifest(
  progress: DeletionProgress,
  completed: boolean,
): Readonly<Record<string, JsonValue>> {
  return {
    manifest_id: progress.manifestId,
    status: completed ? "completed" : "incomplete",
    failed_stage: completed ? null : progress.stage,
    providers: progress.located.map((provider) => ({
      store: provider.store,
      locations: provider.locations.map((item) => ({ table: item.table, row_count: item.rowCount, object_count: item.objectReferences.length })),
    })),
    object_purge: {
      deleted_count: progress.deletedObjectReferences,
      verified_absent_count: progress.verifiedAbsentObjectReferences,
    },
    deletion_results: progress.deleted as unknown as JsonValue,
    verification_results: progress.verified.map((item) => ({
      store: item.store,
      deleted: item.deleted,
      remaining: item.remaining.map((location) => ({
        table: location.table,
        row_count: location.rowCount,
        object_count: location.objectReferences.length,
      })),
    })),
  };
}
