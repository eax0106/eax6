import { createServer } from "node:net";
import { resolve } from "node:path";

import {
  NODEEXEC_HANDLER,
  PROVISIONING_HANDLER,
  SANDBOX_HANDLER,
  NodeExecutionClient,
  NodeexecGrpcController,
  ProvisioningClient,
  ProvisioningGrpcController,
  SandboxGrpcController,
  SandboxServiceClient,
  connectNodeexecGrpcTransport,
  startProvisioningGrpcTransport,
  startSandboxGrpcTransport,
  type ArtifactContentClientHandler,
  type NodeexecHandler,
  type ProvisioningGrpcHandler,
  type SandboxGrpcHandler,
} from "@alterx/adapters";
import {
  createMockSandboxProvider,
  createMockSecretsProvider,
  type MockSandboxProvider,
} from "@alterx/shared-clients";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProvisioningServiceGrpcHandler } from "../../../provisioning-service/src/provisioning/provisioning.grpc-handler";
import { ProvisioningService } from "../../../provisioning-service/src/provisioning/provisioning.service";
import { SandboxServiceGrpcHandler } from "../../../sandbox-service/src/sandbox/sandbox.grpc-handler";
import { SandboxService } from "../../../sandbox-service/src/sandbox/sandbox.service";
import { GeneratedFileMaterializer, type GeneratedFileArtifactWriter } from "../registry/generated-file-materializer";
import type { NodeHandler } from "../registry/handler";
import { NodeHandlerRegistry } from "../registry/node-handler-registry";
import { NodeexecService } from "../registry/nodeexec.service";
import type { NodeExecutionLedgerService } from "./node-execution-ledger.service";
import {
  ProjectRunProvisioningService,
  type ProjectRunProvisioningTransaction,
  type ProjectRunProvisioningStore,
} from "./project-run-provisioning.service";

const TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const PROJECT = "prj_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";
const NODE = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890ab";

const provisioningProto = resolve(
  process.cwd(),
  "packages/contracts/proto/alter/provisioning/v1/provisioning.proto",
);
const sandboxProto = resolve(
  process.cwd(),
  "packages/contracts/proto/alter/sandbox/v1/sandbox.proto",
);
const nodeexecProto = resolve(
  process.cwd(),
  "packages/contracts/proto/alter/nodeexec/v1/nodeexec.proto",
);

let provisioningHandler: ProvisioningGrpcHandler;
let sandboxHandler: SandboxGrpcHandler;
let nodeexecHandler: NodeexecHandler;

@Module({
  controllers: [ProvisioningGrpcController],
  providers: [{ provide: PROVISIONING_HANDLER, useFactory: () => provisioningHandler }],
})
class ProvisioningTransportModule {}

@Module({
  controllers: [SandboxGrpcController],
  providers: [{ provide: SANDBOX_HANDLER, useFactory: () => sandboxHandler }],
})
class SandboxTransportModule {}

@Module({
  controllers: [NodeexecGrpcController],
  providers: [{ provide: NODEEXEC_HANDLER, useFactory: () => nodeexecHandler }],
})
class NodeexecTransportModule {}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePort);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not allocate local gRPC port");
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)));
  });
  return address.port;
}

function projectRunStore(): ProjectRunProvisioningStore {
  const row = {
    project_id: PROJECT,
    provisioning_cycle_id: "cycle_1",
    provisioning_session_id: null as string | null,
    provisioning_closed_at: null,
  };
  return {
    withTenant: async (tenantId, operation) => {
      expect(tenantId).toBe(TENANT.slice("ten_".length));
      return operation({
        query: async <TRow extends Record<string, unknown> = Record<string, unknown>>(
          statement: string,
          values: readonly unknown[] = [],
        ): Promise<{ readonly rowCount: number; readonly rows: readonly TRow[] }> => {
          if (statement.includes("SELECT project_id")) {
            return { rowCount: 1, rows: [row] as unknown as readonly TRow[] };
          }
          if (statement.includes("SET provisioning_session_id")) {
            row.provisioning_session_id = values[3] as string;
            return { rowCount: 1, rows: [] };
          }
          throw new Error(`Unexpected project-run statement: ${statement}`);
        },
      } satisfies ProjectRunProvisioningTransaction);
    },
  };
}

function ledger(): NodeExecutionLedgerService {
  return {
    recordStarted: async () => ({ attempt: 1, startedAt: "2026-08-06T00:00:00.000Z" }),
    recordSucceeded: async () => undefined,
    recordFailed: async () => undefined,
    finalizeRun: async () => ({ status: "completed", endedAt: "2026-08-06T00:00:01.000Z" }),
  } as unknown as NodeExecutionLedgerService;
}

describe("project build gRPC boundary", () => {
  let provider: MockSandboxProvider;
  let artifactContent: ArtifactContentClientHandler;
  let artifactWriter: GeneratedFileArtifactWriter;
  let provisioningClient: ProvisioningClient;
  let sandboxClient: SandboxServiceClient;
  let nodeexecClient: NodeExecutionClient;
  let provisioning: ProjectRunProvisioningService;
  let provisioningApp: Awaited<ReturnType<typeof NestFactory.create>>;
  let sandboxApp: Awaited<ReturnType<typeof NestFactory.create>>;
  let nodeexecApp: Awaited<ReturnType<typeof NestFactory.create>>;

  beforeAll(async () => {
    provider = createMockSandboxProvider();
    const bytes = new Map<string, Uint8Array>();
    let artifactSequence = 0;
    const createArtifact = (content: Uint8Array): string => {
      const id = `art_grpc_${++artifactSequence}`;
      bytes.set(id, content);
      return id;
    };
    artifactContent = {
      createContent: async (request) => {
        const artifactId = createArtifact(request.content);
        return { artifact_id: artifactId, size_bytes: request.content.byteLength };
      },
      readContent: async (request) => {
        const content = bytes.get(request.artifact_id);
        if (content === undefined) throw new Error("artifact bytes not found");
        return {
          content_type: "application/octet-stream",
          content: new Uint8Array(content),
          size_bytes: content.byteLength,
        };
      },
    };
    artifactWriter = {
      create: async (_tenantId, input) => {
        const id = createArtifact(input.bytes);
        return {
          id,
          runId: input.runId,
          workspaceId: "018f4d6e-2b4a-7a3e-8c1a-1234567890ac",
          contentType: input.contentType,
          sizeBytes: input.bytes.byteLength,
          createdAt: "2026-08-06T00:00:00.000Z",
        };
      },
    };

    const sandboxPort = await availablePort();
    sandboxHandler = new SandboxServiceGrpcHandler(
      new SandboxService(provider),
      artifactContent,
    );
    sandboxApp = await NestFactory.create(SandboxTransportModule, new FastifyAdapter(), { logger: false });
    await startSandboxGrpcTransport(sandboxApp, {
      bindAddress: `127.0.0.1:${sandboxPort}`,
      protoPath: sandboxProto,
    });
    await sandboxApp.init();
    sandboxClient = new SandboxServiceClient({
      address: `127.0.0.1:${sandboxPort}`,
      protoPath: sandboxProto,
    });

    const provisioningPort = await availablePort();
    provisioningHandler = new ProvisioningServiceGrpcHandler(
      new ProvisioningService(provider, createMockSecretsProvider()),
    );
    provisioningApp = await NestFactory.create(ProvisioningTransportModule, new FastifyAdapter(), { logger: false });
    await startProvisioningGrpcTransport(provisioningApp, {
      bindAddress: `127.0.0.1:${provisioningPort}`,
      protoPath: provisioningProto,
    });
    await provisioningApp.init();
    provisioningClient = new ProvisioningClient({
      address: `127.0.0.1:${provisioningPort}`,
      protoPath: provisioningProto,
    });
    provisioning = new ProjectRunProvisioningService(projectRunStore(), provisioningClient);

    const materializer = new GeneratedFileMaterializer(artifactWriter, sandboxClient);
    const generatedFiles: NodeHandler = {
      nodeType: "LLMTask",
      async execute() {
        return { output: { files: [{ path: "src/index.ts", content: "export const built = true;\n" }] } };
      },
    };
    nodeexecHandler = new NodeexecService(
      new NodeHandlerRegistry([generatedFiles]),
      ledger(),
      undefined,
      undefined,
      undefined,
      provisioning,
      materializer,
    );
    const nodeexecPort = await availablePort();
    nodeexecApp = await NestFactory.create(NodeexecTransportModule, new FastifyAdapter(), { logger: false });
    connectNodeexecGrpcTransport(nodeexecApp, {
      bindAddress: `127.0.0.1:${nodeexecPort}`,
      protoPath: nodeexecProto,
    });
    await nodeexecApp.startAllMicroservices();
    await nodeexecApp.init();
    nodeexecClient = new NodeExecutionClient({
      address: `127.0.0.1:${nodeexecPort}`,
      protoPath: nodeexecProto,
    });
  });

  afterAll(async () => {
    nodeexecClient.close();
    sandboxClient.close();
    provisioningClient.close();
    await nodeexecApp.close();
    await provisioningApp.close();
    await sandboxApp.close();
  });

  it("provisions, executes, stores, writes, and reads exact generated bytes through real gRPC clients", async () => {
    const sessionId = await provisioning.provisionForRun(TENANT, RUN, PROJECT, {
      cycle_id: "cycle_1",
      template_id: "base",
      environment_refs: {},
      scaffold: [{ path: "package.json", content: "{}" }],
    });
    expect(sessionId).toBe("ses_mock-1");
    await expect(provisioning.getProjectDirectoryForRun(TENANT, RUN)).resolves.toBe(
      `/workspace/${PROJECT}`,
    );

    const response = await nodeexecClient.executeNode({
      tenant_id: TENANT,
      run_id: RUN,
      node_execution_id: NODE,
      node_key: "node_generate_code",
      node_type: "LLMTask",
      config_json: JSON.stringify({ prompt: "Build project", model_alias: "ADVANCED" }),
      inputs_json: "{}",
      success_criteria: [],
    });
    expect(JSON.parse(response.output_json)).toEqual({
      files: [{ path: "src/index.ts", content: "export const built = true;\n" }],
    });

    const stored = await sandboxClient.readFile({
      tenant_id: TENANT,
      run_id: RUN,
      session_id: sessionId,
      path: `/workspace/${PROJECT}/src/index.ts`,
    });
    const content = await artifactContent.readContent({
      tenant_id: TENANT,
      artifact_id: stored.content_artifact_id,
    });
    expect(new TextDecoder().decode(content.content)).toBe("export const built = true;\n");
    expect(provider.files.get(sessionId)).toEqual([
      { path: `/workspace/${PROJECT}/src/index.ts`, content: "export const built = true;\n" },
    ]);
  });
});
