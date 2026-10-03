import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { S3CommandClient } from "../aws/s3-object-storage-provider";
import { MAX_PACKAGE_BYTES, S3PackageArtifactReader } from "./package-artifact";

const tenantId = "ten_00000000-0000-7000-8000-000000000001";
const manifestId = "tlm_00000000-0000-7000-8000-000000000002";
const key = `${tenantId}/registry/${manifestId}/1.0.0/package.tgz`;
const request = { tenantId, manifestId, manifestVersion: "1.0.0", artifactRef: `s3://registry-fixture/${key}?versionId=pinned-1`, ecosystem: "npm" as const };

describe("pinned registry artifact reader", () => {
  it("asks S3 for the exact tenant object and version and reads its bounded stream", async () => {
    const stream = Readable.from([Buffer.from("package"), Buffer.from(" bytes")]);
    const send = vi.fn().mockResolvedValue({ Body: stream, VersionId: "pinned-1", ContentLength: 13 });
    const reader = new S3PackageArtifactReader("registry-fixture", "ap-south-1", { send } as S3CommandClient);
    expect(await reader.read(request)).toEqual({ bytes: Buffer.from("package bytes"), name: "package.tgz" });
    expect(send.mock.calls[0]![0].input).toEqual({ Bucket: "registry-fixture", Key: key, VersionId: "pinned-1" });
    expect(stream.destroyed).toBe(true);
  });

  it("rejects other tenant/bucket/manifest/version, traversal and unpinned references before any object read", async () => {
    const send = vi.fn();
    const reader = new S3PackageArtifactReader("registry-fixture", "ap-south-1", { send } as S3CommandClient);
    for (const artifactRef of [request.artifactRef.replace(tenantId, "ten_00000000-0000-7000-8000-000000000003"), request.artifactRef.replace("registry-fixture", "another-bucket"), request.artifactRef.replace(manifestId, "tlm_00000000-0000-7000-8000-000000000003"), request.artifactRef.replace("1.0.0", "2.0.0"), request.artifactRef.replace("package.tgz", "%2e%2e%2fpackage.tgz"), `s3://registry-fixture/${key}`, request.artifactRef.replace("pinned-1", "null"), request.artifactRef + "&versionId=other", request.artifactRef + "&token=ignored", request.artifactRef.replace("s3:", "https:")]) {
      await expect(reader.read({ ...request, artifactRef })).rejects.toThrow();
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a missing binding, wrong returned version, missing data and both declared/streamed byte overflows", async () => {
    const send = vi.fn();
    const reader = new S3PackageArtifactReader("registry-fixture", "ap-south-1", { send } as S3CommandClient);
    await expect(new S3PackageArtifactReader(undefined, "ap-south-1", { send } as S3CommandClient).read(request)).rejects.toThrow("not configured");
    for (const response of [{ Body: Buffer.from("a"), VersionId: "other" }, { VersionId: "pinned-1" }, { VersionId: "pinned-1", ContentLength: MAX_PACKAGE_BYTES + 1 }, { VersionId: "pinned-1", Body: Buffer.alloc(MAX_PACKAGE_BYTES + 1) }]) {
      send.mockResolvedValueOnce(response);
      await expect(reader.read(request)).rejects.toThrow();
    }
    for (const details of [{ VersionId: "other" }, { VersionId: "pinned-1", ContentLength: MAX_PACKAGE_BYTES + 1 }]) {
      const rejected = Readable.from([Buffer.from("unused")]); send.mockResolvedValueOnce({ ...details, Body: rejected });
      await expect(reader.read(request)).rejects.toThrow(); expect(rejected.destroyed).toBe(true);
    }
    const stream = Readable.from([Buffer.alloc(MAX_PACKAGE_BYTES), Buffer.from("a")]);
    send.mockResolvedValueOnce({ VersionId: "pinned-1", Body: stream });
    await expect(reader.read(request)).rejects.toThrow("byte limit");
    expect(stream.destroyed).toBe(true);
  });
});
