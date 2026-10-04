import type { PackageScanProvider, ScanFinding } from "@alterx/shared-clients";
import { z } from "zod";
export type { PackageScanProvider, PackageScanRequest, PackageScanReport, ScanFinding, ScanSeverity, ScanVerdict } from "@alterx/shared-clients";
export const PackageScanReportSchema = z.object({
  verdict: z.enum(["clean", "findings", "blocked", "errored", "unavailable"]),
  findings: z.array(z.object({ rule: z.string().min(1), severity: z.enum(["info", "low", "medium", "high", "critical"]), locator: z.string().min(1), detail: z.string().min(1) }).strict()).max(10000),
  scannerVersion: z.string().min(1).max(512), scannedAt: z.iso.datetime(), durationMs: z.number().int().nonnegative(),
}).strict();
// ENGINE-FIX-P3-10: no real scan provider is wired anywhere in this repo.
// With an empty seed, every artifactRef used to fall through
// `findings.length === 0 ? "blocked" : "findings"` -- an unconditional,
// permanent "blocked" that reads as a real security verdict but is really
// just "this stub has no data". `verdict: "unavailable"` says that
// honestly. A seeded artifactRef (real usage: tests) still reports a real
// clean/findings verdict, distinguished by seed.has(), not by array length,
// so an explicitly-seeded empty findings list still means "clean", not
// "we never scanned this at all".
export function createInMemoryPackageScanProvider(seed: ReadonlyMap<string, readonly ScanFinding[]> = new Map()): PackageScanProvider {
  return {
    async scanPackage(request) {
      const scannedAt = new Date().toISOString();
      if (!seed.has(request.artifactRef)) {
        return { verdict: "unavailable", findings: [], scannerVersion: "mock-unavailable-1", scannedAt, durationMs: 0 };
      }
      const findings = seed.get(request.artifactRef)!;
      return { verdict: findings.length === 0 ? "clean" : "findings", findings, scannerVersion: "mock-unavailable-1", scannedAt, durationMs: 0 };
    },
  };
}
