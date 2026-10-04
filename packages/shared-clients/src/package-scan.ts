export type PackageEcosystem = "npm" | "pip" | "mcp";
export type ScanSeverity = "info" | "low" | "medium" | "high" | "critical";
export type ScanVerdict = "clean" | "findings" | "blocked" | "errored" | "unavailable";

export interface PackageScanRequest {
  readonly tenantId: string;
  readonly manifestId: string;
  readonly manifestVersion: string;
  readonly artifactRef: string;
  readonly ecosystem: PackageEcosystem;
}
export interface ScanFinding {
  readonly rule: string;
  readonly severity: ScanSeverity;
  readonly locator: string;
  readonly detail: string;
}
export interface PackageScanReport {
  readonly verdict: ScanVerdict;
  readonly findings: readonly ScanFinding[];
  readonly scannerVersion: string;
  readonly scannedAt: string;
  readonly durationMs: number;
}
export interface PackageScanProvider {
  scanPackage(request: PackageScanRequest): Promise<PackageScanReport>;
}

export interface RegistryToolVersion {
  readonly id: string;
  readonly manifestId: string;
  readonly version: string;
  readonly artifactRef: string;
  readonly capabilities: readonly string[];
  readonly permissions: readonly string[];
  readonly pinned: boolean;
  readonly status: "draft" | "scanning" | "scan_failed" | "scan_unavailable" | "review_pending" | "published" | "revoked";
  readonly publishedAt: string | null;
  readonly scanReportId?: string | null;
  readonly review?: { readonly scanReportId: string; readonly decision: "approved" | "rejected"; readonly reviewedBy: string; readonly reviewedAt: string; readonly reason: string } | null;
}
export interface RegistryScanReport extends PackageScanReport {
  readonly id: string;
  readonly toolVersionId: string;
}
export interface ToolVersionReviewItem {
  readonly manifestId: string;
  readonly tenantId: string;
  readonly name: string;
  readonly version: RegistryToolVersion;
  readonly scan: RegistryScanReport;
}
