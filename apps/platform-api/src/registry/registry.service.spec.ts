import { describe, expect, it, vi } from "vitest";
import { RegistryService } from "./registry.service";
import { RegistryScanStateError } from "./registry.repository";
import type { PackageScanReport } from "./package-scan";

const tenantId = "ten_1";
const manifest = { id: "tlm_00000000-0000-7000-8000-000000000001", tenantId, name: "Tool", ecosystem: "npm" as const, description: null, trustLevel: "community_reviewed" as const, status: "draft" as const, publisherId: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
const version = { id: "tlv_00000000-0000-7000-8000-000000000001", manifestId: manifest.id, version: "1.0.0", artifactRef: "s3://bucket/tool.tgz?versionId=1", capabilities: [], permissions: [], pinned: true, status: "scanning" as const, publishedAt: null };
const clean: PackageScanReport = { verdict:"clean",findings:[],scannerVersion:"test",scannedAt:"2026-01-01T00:00:00.000Z",durationMs:1 };

function harness(report: unknown = clean) {
  const repository = { get:vi.fn().mockResolvedValue(manifest), beginScan:vi.fn().mockResolvedValue(version), completeScan:vi.fn().mockResolvedValue({...version,status:"review_pending"}), createManifest:vi.fn() };
  const publishers = { getPublisher:vi.fn().mockResolvedValue(undefined) };
  const scanner = { scanPackage:vi.fn().mockResolvedValue(report) };
  return { service:new RegistryService(repository as never,publishers as never,scanner), repository,publishers,scanner };
}

describe("RegistryService", () => {
  it("scans the locked immutable artifact and forwards its report to atomic completion", async () => {
    const h=harness();
    await expect(h.service.scan(tenantId,manifest.id,version.id)).resolves.toMatchObject({status:"review_pending"});
    expect(h.repository.beginScan).toHaveBeenCalledWith(tenantId,manifest.id,version.id);
    expect(h.scanner.scanPackage).toHaveBeenCalledWith({tenantId,manifestId:manifest.id,manifestVersion:version.version,artifactRef:version.artifactRef,ecosystem:"npm"});
    expect(h.repository.completeScan).toHaveBeenCalledWith(tenantId,manifest.id,version.id,expect.stringMatching(/^scn_/),clean);
  });
  it.each(["info","low","medium","high","critical"] as const)("forwards %s findings without calling them clean", async severity => {
    const report={...clean,verdict:"findings",findings:[{severity,rule:"OSV-fixture",locator:"package@1",detail:"Affected fixture"}]};
    const h=harness(report); await h.service.scan(tenantId,manifest.id,version.id);
    expect(h.repository.completeScan.mock.calls[0]![4]).toEqual(report);
  });
  it("records scanner exceptions and malformed reports as errors", async () => {
    for (const malformed of [{...clean,verdict:"unknown"},{...clean,durationMs:-1},{...clean,findings:[{severity:"new-level"}]}]) {
      const h=harness(malformed); await h.service.scan(tenantId,manifest.id,version.id);
      expect(h.repository.completeScan.mock.calls[0]![4]).toMatchObject({verdict:"errored",findings:[]});
    }
    const h=harness(); h.scanner.scanPackage.mockRejectedValue(new Error("scanner unavailable"));
    await h.service.scan(tenantId,manifest.id,version.id);
    expect(h.repository.completeScan.mock.calls[0]![4]).toMatchObject({verdict:"errored",findings:[]});
  });
  it("does not start another scanner after a concurrent state change or hidden manifest", async () => {
    const h=harness(); h.repository.beginScan.mockRejectedValue(new RegistryScanStateError(409,"Scan already in progress"));
    await expect(h.service.scan(tenantId,manifest.id,version.id)).rejects.toMatchObject({response:expect.objectContaining({status:409})});
    expect(h.scanner.scanPackage).not.toHaveBeenCalled();
    const hidden=harness(); hidden.repository.get.mockResolvedValue(undefined);
    await expect(hidden.service.scan(tenantId,manifest.id,version.id)).rejects.toMatchObject({response:expect.objectContaining({status:404})});
    expect(hidden.repository.beginScan).not.toHaveBeenCalled();
  });
  it("retains publisher and first-party trust requirements", async () => {
    const h=harness();
    await expect(h.service.create(tenantId,{name:"Tool",ecosystem:"npm",trust_level:"verified_publisher"})).rejects.toMatchObject({response:expect.objectContaining({error_code:"REGISTRY_PUBLISHER_VERIFICATION_REQUIRED"})});
    await expect(h.service.create(tenantId,{name:"Tool",ecosystem:"npm",trust_level:"alter_verified"})).rejects.toMatchObject({response:expect.objectContaining({error_code:"REGISTRY_ALTER_VERIFIED_FIRST_PARTY_ONLY"})});
  });
});
