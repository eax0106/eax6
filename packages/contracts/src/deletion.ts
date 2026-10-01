export interface SubjectDataLocation {
  readonly store: string;
  readonly table: string;
  readonly rowCount: number;
  readonly objectReferences: readonly string[];
}

export interface DeletionResult {
  readonly store: string;
  readonly manifestId: string;
  readonly deletedRows: number;
  readonly deletedObjects: number;
}

export interface VerificationResult {
  readonly store: string;
  readonly manifestId: string;
  readonly deleted: boolean;
  readonly remaining: readonly SubjectDataLocation[];
}

export interface RetentionSweepResult {
  readonly store: string;
  readonly deletedRows: number;
  readonly deletedObjects: number;
  readonly sweptAt: string;
}

export interface ReplayResult {
  readonly store: string;
  readonly ledgerEntriesReplayed: number;
  readonly deletedRows: number;
  readonly deletedObjects: number;
}

export interface DeletionProvider {
  locateSubjectData(tenantId: string): Promise<readonly SubjectDataLocation[]>;
  deleteSubjectData(tenantId: string, manifestId: string): Promise<DeletionResult>;
  verifyDeletion(tenantId: string, manifestId: string): Promise<VerificationResult>;
  applyRetentionPolicy(): Promise<RetentionSweepResult>;
  replayDeletionLedger(sinceTimestamp: string): Promise<ReplayResult>;
}

/**
 * D2 workspace erasure at the end of a deleted workspace's undo window: the
 * same locate, delete, verify path as a tenant's erasure, narrowed to one
 * workspace of a still-active tenant. Ids are prefixed (ten_, ws_).
 */
export interface WorkspaceDeletionProvider {
  locateWorkspaceData(tenantId: string, workspaceId: string): Promise<readonly SubjectDataLocation[]>;
  deleteWorkspaceData(tenantId: string, workspaceId: string, manifestId: string): Promise<DeletionResult>;
  verifyWorkspaceDeletion(tenantId: string, workspaceId: string, manifestId: string): Promise<VerificationResult>;
}
