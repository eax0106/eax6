import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PackageScanRequest } from "@alterx/shared-clients";
import type { S3CommandClient } from "../aws/s3-object-storage-provider";

export const MAX_PACKAGE_BYTES = 10 * 1024 * 1024;
export interface PackageArtifactReader {
  read(request: PackageScanRequest): Promise<{ bytes: Buffer; name: string }>;
}

/** Reads one immutable object version under the authenticated tenant's prefix. */
export class S3PackageArtifactReader implements PackageArtifactReader {
  private readonly client: S3CommandClient;
  constructor(private readonly bucket: string | undefined, region: string, client?: S3CommandClient) {
    this.client = client ?? new S3Client({ region });
  }

  async read(request: PackageScanRequest) {
    if (!this.bucket) throw new Error("Registry package bucket is not configured");
    const ref = new URL(request.artifactRef);
    const key = decodeURIComponent(ref.pathname.slice(1));
    const version = ref.searchParams.get("versionId");
    if (ref.protocol !== "s3:" || ref.hostname !== this.bucket || ref.username || ref.password || ref.hash ||
      !/^ten_[0-9a-f-]{36}$/i.test(request.tenantId) ||
      !/^tlm_[0-9a-f-]{36}$/i.test(request.manifestId) || !/^[A-Za-z0-9.+_-]{1,128}$/.test(request.manifestVersion) ||
      !key.startsWith(`${request.tenantId}/registry/${request.manifestId}/${request.manifestVersion}/`) ||
      key.split("/").some(part => !part || part === "." || part === ".." || /[\\\x00-\x1f]/.test(part)) ||
      !version || version === "null" || version.length > 1024 ||
      [...ref.searchParams.keys()].some(name => name !== "versionId") || ref.searchParams.getAll("versionId").length !== 1) {
      throw new Error("Artifact must be a pinned object in this tenant's registry package prefix");
    }
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, VersionId: version })) as {
      Body?: unknown; ContentLength?: number; VersionId?: string;
    };
    try {
      if (result.VersionId !== version) throw new Error("Object store did not return the pinned artifact version");
      if (result.ContentLength !== undefined && result.ContentLength > MAX_PACKAGE_BYTES) throw new Error("Package exceeds scan byte limit");
      const chunks: Buffer[] = [];
      let length = 0;
      const append = (chunk: Uint8Array) => {
        length += chunk.byteLength;
        if (length > MAX_PACKAGE_BYTES) throw new Error("Package exceeds scan byte limit");
        chunks.push(Buffer.from(chunk));
      };
      if (result.Body instanceof Uint8Array) append(result.Body);
      else if (result.Body !== null && typeof result.Body === "object" && Symbol.asyncIterator in result.Body) {
        const body = result.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
        for await (const chunk of body) {
          if (!(chunk instanceof Uint8Array)) throw new Error("Object store returned an invalid package stream");
          append(chunk);
        }
      } else throw new Error("Object store returned no package bytes");
      return { bytes: Buffer.concat(chunks), name: key.split("/").at(-1)! };
    } finally {
      const body = result.Body as { destroy?: () => void } | undefined;
      body?.destroy?.();
    }
  }
}
