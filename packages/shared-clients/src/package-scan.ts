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
