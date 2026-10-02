import { join } from "node:path";
import { existsSync } from "node:fs";

export {
  CompilerServiceClient,
  CompilerServiceClientError,
  type CompilerServiceClientConfig,
  type CompilerServiceHandlerClient,
} from "@alterx/adapters";

export function getCompilerProtoPath(): string {
  const workspacePath = join(process.cwd(), "packages/contracts/proto/alter/compiler/v1/compiler.proto");
  return existsSync(workspacePath) ? workspacePath : join(__dirname, "../../../../../packages/contracts/proto/alter/compiler/v1/compiler.proto");
}
