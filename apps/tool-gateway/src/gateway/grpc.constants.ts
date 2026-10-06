import { existsSync } from "node:fs";
import { resolve } from "node:path";

const workspaceProtoPath = resolve(
  process.cwd(),
  "packages/contracts/proto/alter/toolgw/v1/toolgw.proto",
);

export const TOOLGW_PROTO_PATH = existsSync(workspaceProtoPath)
  ? workspaceProtoPath
  : resolve(__dirname, "../proto/toolgw.proto");

const workspaceAuditProtoPath = resolve(
  process.cwd(),
  "packages/contracts/proto/alter/audit/v1/audit.proto",
);

export const AUDIT_CLIENT_PROTO_PATH = existsSync(workspaceAuditProtoPath)
  ? workspaceAuditProtoPath
  : resolve(__dirname, "../proto/audit.proto");

const workspaceAdsqProtoPath = resolve(
  process.cwd(),
  "packages/contracts/proto/alter/adsq/v1/adsq.proto",
);

export const ADSQ_CLIENT_PROTO_PATH = existsSync(workspaceAdsqProtoPath)
  ? workspaceAdsqProtoPath
  : resolve(__dirname, "../proto/adsq.proto");
