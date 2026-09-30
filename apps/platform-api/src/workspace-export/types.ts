/** Workspace data export (D2, C74) shared shapes. */

export const EXPORT_STATUSES = ["requested", "running", "ready", "failed", "expired"] as const;

export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export interface WorkspaceExportView {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: ExportStatus;
  readonly failureReason: string | null;
  readonly requestedAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
}

export interface WorkspaceExportArchive {
  readonly exportedAt: string;
  readonly workspaceId: string;
  readonly workflows: readonly unknown[];
  readonly workflowVersions: readonly unknown[];
  readonly runs: readonly unknown[];
  readonly knowledgeSources: readonly unknown[];
  readonly knowledgeDocuments: readonly unknown[];
  readonly members: readonly WorkspaceExportMember[];
}

export interface WorkspaceExportMember {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: string;
  readonly scope: string;
}
