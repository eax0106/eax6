import { ProviderCapabilitiesSchema } from "@alterx/contracts";
import type { ProviderContractSuite } from "./contract-testing";
import type {
  BillingProvider,
  CacheProvider,
  ConfigProvider,
  DurableExecutionProvider,
  EmbeddingProvider,
  ModelProvider,
  ObjectStorageProvider,
  ParameterStoreProvider,
  ObservabilityProvider,
  PIIRedactionProvider,
  SearchProvider,
  SecretsProvider,
} from "./provider-types";

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function rejects(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}

export const secretsProviderContract: ProviderContractSuite<SecretsProvider> = {
  name: "SecretsProvider",
  cases: [
    {
      name: "publishes valid base-provider metadata and capabilities",
      assert: async (provider) => {
        ensure(
          provider.metadata.interfaceName === "SecretsProvider",
          "Secrets adapter must identify its canonical interface",
        );
        ProviderCapabilitiesSchema.parse(provider.capabilities);
        const health = await provider.healthCheck();
        ensure(
          health.status === "healthy",
          "Contract fixture must be healthy",
        );
        return {
          capabilities: provider.capabilities,
          health,
          interfaceName: provider.metadata.interfaceName,
        };
      },
    },
    {
      name: "resolves a secret exclusively through its reference ID",
      assert: async (provider) => {
        const secret = await provider.getSecret("contract/secret");
        ensure(
          secret === "contract-secret-value",
          "Known contract secret must resolve deterministically",
        );
        ensure(
          await rejects(() => provider.getSecret("contract/missing")),
          "Unknown secret references must be rejected",
        );
        return { resolved: true };
      },
    },
  ],
};

export const objectStorageProviderContract: ProviderContractSuite<ObjectStorageProvider> = {
  name: "ObjectStorageProvider",
  cases: [
    {
      name: "publishes valid object-storage metadata and capabilities",
      assert: async (provider) => {
        ensure(
          provider.metadata.interfaceName === "ObjectStorageProvider",
          "Object-storage adapter must identify its canonical interface",
        );
        ProviderCapabilitiesSchema.parse(provider.capabilities);
        const health = await provider.healthCheck();
        ensure(health.status === "healthy", "Contract fixture must be healthy");
        return { interfaceName: provider.metadata.interfaceName, health: health.status };
      },
    },
    {
      name: "writes and reads opaque binary data",
      assert: async (provider) => {
        const reference = "s3://contract-bucket/regulated/bytes";
        const body = Buffer.from([0, 1, 2, 255]);
        await provider.putObject(reference, body, "application/octet-stream");
        const read = await provider.getObject(reference);
        ensure(Buffer.compare(read, body) === 0, "Read object must match written bytes");
        return { reference, byteLength: read.length };
      },
    },
    {
      name: "deletes an object idempotently and verifies absence",
      assert: async (provider) => {
        const reference = "s3://contract-bucket/regulated/object";
        ensure(await provider.objectExists(reference), "Contract object must initially exist");
        await provider.deleteObject(reference);
        ensure(!(await provider.objectExists(reference)), "Deleted object must verify absent");
        await provider.deleteObject(reference);
        return { deleted: true, exists: await provider.objectExists(reference) };
      },
    },
  ],
};

export const parameterStoreProviderContract: ProviderContractSuite<ParameterStoreProvider> = {
  name: "ParameterStoreProvider",
  cases: [
    {
      name: "resolves a known parameter and rejects a missing parameter",
      assert: async (provider) => {
        ensure(await provider.getParameter("/contract/parameter") === "contract-value", "Known parameter must resolve deterministically");
        ensure(await rejects(() => provider.getParameter("/contract/missing")), "Unknown parameter must be rejected");
        return { resolved: true };
      },
    },
  ],
};

export const billingProviderContract: ProviderContractSuite<BillingProvider> = {
  name: "BillingProvider",
  cases: [
    {
      name: "publishes valid billing metadata and capabilities",
      assert: async (provider) => {
        ensure(
          provider.metadata.interfaceName === "BillingProvider",
          "Billing adapter must identify its canonical interface",
        );
        ProviderCapabilitiesSchema.parse(provider.capabilities);
        const health = await provider.healthCheck();
        ensure(health.status === "healthy", "Contract fixture must be healthy");
        return {
          capabilities: provider.capabilities,
          health,
          interfaceName: provider.metadata.interfaceName,
        };
      },
    },
    {
      name: "supports plans, subscription lifecycle, invoices, and token references",
      assert: async (provider) => {
        const tenantId = "tenant-contract";
        const availablePlans = await provider.listPlans();
        ensure(availablePlans.length > 0, "Contract needs at least one plan");
        const planId = availablePlans[0]!.id;
        const method = await provider.attachPaymentMethod(
          tenantId,
          "token_contract",
        );
        const created = await provider.createSubscription(
          tenantId,
          planId,
          method.ref,
        );
        const changed = await provider.changeSubscription(tenantId, planId);
        const invoices = await provider.listInvoices(tenantId);
        const cancelled = await provider.cancelSubscription(tenantId);
        await provider.detachPaymentMethod(tenantId, method.ref);
        return {
          cancelled: cancelled.status,
          changed: changed.planId,
          created: created.planId,
          invoiceCount: invoices.items.length,
          methods: (await provider.listPaymentMethods(tenantId)).length,
        };
      },
    },
  ],
};

export const observabilityProviderContract: ProviderContractSuite<ObservabilityProvider> =
  {
    name: "ObservabilityProvider",
    cases: [
      {
        name: "publishes valid base-provider metadata and capabilities",
        assert: async (provider) => {
          ensure(
            provider.metadata.interfaceName === "ObservabilityProvider",
            "Observability adapter must identify its canonical interface",
          );
          ProviderCapabilitiesSchema.parse(provider.capabilities);
          const health = await provider.healthCheck();
          ensure(
            health.status === "healthy",
            "Contract fixture must be healthy",
          );
          return {
            capabilities: provider.capabilities,
            health,
            interfaceName: provider.metadata.interfaceName,
          };
        },
      },
      {
        name: "accepts normalized traces",
        assert: (provider) =>
          provider.emitTrace({
            traceId: "0123456789abcdef0123456789abcdef",
            spanId: "0123456789abcdef",
            name: "contract.trace",
            startedAt: "2026-07-22T00:00:00.000Z",
          }),
      },
      {
        name: "accepts normalized metrics",
        assert: (provider) =>
          provider.emitMetric({
            name: "contract.metric",
            value: 1,
            recordedAt: "2026-07-22T00:00:00.000Z",
            unit: "count",
          }),
      },
      {
        name: "accepts normalized logs",
        assert: (provider) =>
          provider.emitLog({
            severity: "info",
            message: "contract log",
            recordedAt: "2026-07-22T00:00:00.000Z",
          }),
      },
      {
        name: "accepts normalized error captures",
        assert: (provider) =>
          provider.captureError({
            name: "ContractError",
            message: "contract error",
            occurredAt: "2026-07-22T00:00:00.000Z",
            traceId: "0123456789abcdef0123456789abcdef",
            spanId: "0123456789abcdef",
          }),
      },
    ],
  };

export const durableExecutionProviderContract: ProviderContractSuite<DurableExecutionProvider> =
  {
    name: "DurableExecutionProvider",
    cases: [
      {
        name: "publishes valid base-provider metadata and capabilities",
        assert: async (provider) => {
          ensure(
            provider.metadata.interfaceName === "DurableExecutionProvider",
            "Durable adapter must identify its canonical interface",
          );
          ProviderCapabilitiesSchema.parse(provider.capabilities);
          const health = await provider.healthCheck();
          ensure(
            health.status === "healthy",
            "Contract fixture must be healthy",
          );
          return {
            capabilities: provider.capabilities,
            health,
            interfaceName: provider.metadata.interfaceName,
          };
        },
      },
      {
        name: "supports a complete durable workflow lifecycle",
        assert: async (provider) => {
          const handle = await provider.startWorkflow({
            workflowId: "contract-workflow",
            workflowType: "contract",
            input: { attempt: 1 },
          });
          ensure(
            handle.workflowId === "contract-workflow",
            "Started workflow ID must remain canonical",
          );

          await provider.signalWorkflow({
            workflowId: handle.workflowId,
            signalName: "contract-signal",
            payload: { approved: true },
          });
          const running = await provider.queryWorkflow({
            workflowId: handle.workflowId,
            queryName: "status",
          });
          ensure(
            JSON.stringify(running.value) ===
              JSON.stringify({ status: "running", terminationReason: null }),
            "Workflow must report running before termination",
          );

          await provider.terminateWorkflow({
            workflowId: handle.workflowId,
            reason: "contract complete",
          });
          const terminated = await provider.queryWorkflow({
            workflowId: handle.workflowId,
            queryName: "status",
          });
          ensure(
            JSON.stringify(terminated.value) ===
              JSON.stringify({
                status: "terminated",
                terminationReason: "contract complete",
              }),
            "Workflow termination must be queryable",
          );
          return { handle, running, terminated };
        },
      },
    ],
  };

export const configProviderContract: ProviderContractSuite<ConfigProvider> = {
  name: "ConfigProvider",
  cases: [
    {
      name: "publishes valid base-provider metadata and capabilities",
      assert: async (provider) => {
        ensure(
          provider.metadata.interfaceName === "ConfigProvider",
          "Config adapter must identify its canonical interface",
        );
        ProviderCapabilitiesSchema.parse(provider.capabilities);
        const health = await provider.healthCheck();
        ensure(
          health.status === "healthy",
          "Contract fixture must be healthy",
        );
        return {
          capabilities: provider.capabilities,
          health,
          interfaceName: provider.metadata.interfaceName,
        };
      },
    },
    {
      name: "resolves every alias tier to a non-empty model binding",
      assert: async (provider) => {
        const aliases = ["FAST", "STANDARD", "ADVANCED", "CEILING"] as const;
        const resolved: Record<string, unknown> = {};
        for (const alias of aliases) {
          const binding = await provider.resolveModelAlias(alias);
          ensure(
            binding.model_id.length > 0,
            `Alias ${alias} must resolve to a non-empty model_id`,
          );
          ensure(
            Array.isArray(binding.capability_tags),
            `Alias ${alias} must resolve capability_tags as an array`,
          );
          resolved[alias] = binding;
        }
        return resolved;
      },
    },
    {
      name: "rejects an alias with no policy binding",
      assert: async (provider) => {
        ensure(
          await rejects(() =>
            provider.resolveModelAlias(
              "UNKNOWN" as Parameters<
                ConfigProvider["resolveModelAlias"]
              >[0],
            ),
          ),
          "Unbound aliases must be rejected, never silently substituted",
        );
        return { rejected: true };
      },
    },
    {
      name: "resolves a tool permission binding",
      assert: async (provider) => {
        const binding = await provider.resolveToolPermission({
          tenantId: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
          toolName: "contract.search",
        });
        ensure(
          typeof binding.allowed === "boolean",
          "Tool permission must return an explicit allowed flag",
        );
        ensure(
          Number.isInteger(binding.rateLimitPerMinute) &&
            binding.rateLimitPerMinute > 0,
          "Tool permission must return a positive integer rate limit",
        );
        ensure(
          Array.isArray(binding.requiredScopes),
          "Tool permission must return requiredScopes as an array",
        );
        return binding;
      },
    },
    {
      name: "resolves a cost limit binding",
      assert: async (provider) => {
        const binding = await provider.resolveCostLimit({
          tenantId: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
          runId: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
        });
        ensure(
          Number.isInteger(binding.maxTokensPerCall) &&
            binding.maxTokensPerCall > 0,
          "Cost limit must return a positive integer token cap",
        );
        ensure(
          typeof binding.maxCostUsdPerCall === "number" &&
            binding.maxCostUsdPerCall > 0,
          "Cost limit must return a positive USD cap",
        );
        return binding;
      },
    },
  ],
};

export const modelProviderContract: ProviderContractSuite<ModelProvider> = {
  name: "ModelProvider",
  cases: [
    {
      name: "publishes valid base-provider metadata and capabilities",
      assert: async (provider) => {
        ensure(
          provider.metadata.interfaceName === "ModelProvider",
          "Model adapter must identify its canonical interface",
        );
        ProviderCapabilitiesSchema.parse(provider.capabilities);
        const health = await provider.healthCheck();
        ensure(
          health.status === "healthy",
          "Contract fixture must be healthy",
        );
        return {
          capabilities: provider.capabilities,
          health,
          interfaceName: provider.metadata.interfaceName,
        };
      },
    },
    {
      name: "invokes a resolved model and returns usage accounting",
      assert: async (provider) => {
        const result = await provider.invoke({
          tenantId: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
          runId: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
          nodeExecutionId: "node_018f47a2-7b11-7b11-8a11-1234567890ab",
          modelId: "contract-model",
          capabilityTags: ["general"],
          inputJson: JSON.stringify({
            messages: [{ role: "user", content: "contract fixture" }],
          }),
        });
        ensure(
          typeof result.outputJson === "string" && result.outputJson.length > 0,
          "Invoke must return non-empty output_json",
        );
        ensure(
          typeof result.usageJson === "string" && result.usageJson.length > 0,
          "Invoke must return non-empty usage_json",
        );
        JSON.parse(result.outputJson);
        JSON.parse(result.usageJson);
        return result;
      },
    },
    {
      name: "streams incremental deltas and a terminal usage chunk",
      assert: async (provider) => {
        ensure(
          provider.capabilities.streaming,
          "A streaming ModelProvider must advertise streaming capability",
        );
        const chunks = [];
        for await (const chunk of provider.stream({
          tenantId: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
          runId: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
          nodeExecutionId: "node_018f47a2-7b11-7b11-8a11-1234567890ab",
          modelId: "contract-model",
          capabilityTags: ["general"],
          inputJson: JSON.stringify({
            messages: [{ role: "user", content: "contract fixture" }],
          }),
        })) {
          chunks.push(chunk);
        }
        ensure(chunks.length >= 2, "Stream must emit data before its final chunk");
        ensure(
          chunks.slice(0, -1).some((chunk) => chunk.delta.length > 0),
          "Stream must emit at least one non-empty incremental delta",
        );
        ensure(
          chunks.every((chunk, index) => chunk.sequence === index + 1),
          "Stream sequence must be contiguous and one-based",
        );
        ensure(
          chunks.slice(0, -1).every((chunk) => !chunk.final),
          "Only the last stream chunk may be final",
        );
        const final = chunks[chunks.length - 1];
        ensure(final?.final === true, "Stream must end with a final chunk");
        ensure(
          final.final && JSON.parse(final.usageJson) !== undefined,
          "Final stream chunk must carry valid usage JSON",
        );
        return chunks;
      },
    },
  ],
};

export const embeddingProviderContract: ProviderContractSuite<EmbeddingProvider> =
  {
    name: "EmbeddingProvider",
    cases: [
      {
        name: "publishes valid base-provider metadata and capabilities",
        assert: async (provider) => {
          ensure(
            provider.metadata.interfaceName === "EmbeddingProvider",
            "Embedding adapter must identify its canonical interface",
          );
          ProviderCapabilitiesSchema.parse(provider.capabilities);
          const health = await provider.healthCheck();
          ensure(
            health.status === "healthy",
            "Contract fixture must be healthy",
          );
          return {
            capabilities: provider.capabilities,
            health,
            interfaceName: provider.metadata.interfaceName,
          };
        },
      },
      {
        name: "returns a 512-dimensional embedding",
        assert: async (provider) => {
          const result = await provider.embed({
            tenantId: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
            text: "contract embedding fixture",
            dimensions: 512,
          });
          ensure(
            result.dimensions === 512,
            "Embedding result dimensions must match the 512 request",
          );
          ensure(
            result.vector.length === 512,
            "Embedding vector must contain exactly 512 values",
          );
          ensure(
            result.modelId.length > 0,
            "Embedding result must include a non-empty model ID",
          );
          return {
            dimensions: result.dimensions,
            length: result.vector.length,
            modelId: result.modelId,
          };
        },
      },
      {
        name: "returns a 1024-dimensional embedding",
        assert: async (provider) => {
          const result = await provider.embed({
            tenantId: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
            text: "contract embedding fixture",
            dimensions: 1024,
          });
          ensure(
            result.dimensions === 1024,
            "Embedding result dimensions must match the 1024 request",
          );
          ensure(
            result.vector.length === 1024,
            "Embedding vector must contain exactly 1024 values",
          );
          ensure(
            result.modelId.length > 0,
            "Embedding result must include a non-empty model ID",
          );
          return {
            dimensions: result.dimensions,
            length: result.vector.length,
            modelId: result.modelId,
          };
        },
      },
    ],
  };

export const piiRedactionProviderContract: ProviderContractSuite<PIIRedactionProvider> =
  {
    name: "PIIRedactionProvider",
    cases: [
      {
        name: "publishes valid base-provider metadata and capabilities",
        assert: async (provider) => {
          ensure(
            provider.metadata.interfaceName === "PIIRedactionProvider",
            "PII redaction adapter must identify its canonical interface",
          );
          ProviderCapabilitiesSchema.parse(provider.capabilities);
          const health = await provider.healthCheck();
          ensure(
            health.status === "healthy",
            "Contract fixture must be healthy",
          );
          return {
            capabilities: provider.capabilities,
            health,
            interfaceName: provider.metadata.interfaceName,
          };
        },
      },
      {
        name: "redacts a detected custom Indian PII entity",
        assert: async (provider) => {
          const result = await provider.redact({
            tenantId: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
            text: "PAN on file: ABCDE1234F",
          });
          ensure(
            !result.redactedText.includes("ABCDE1234F"),
            "Redacted text must not contain the original PAN",
          );
          ensure(
            result.entities.some((entity) => entity.entityType === "IN_PAN"),
            "Redaction result must report an IN_PAN entity",
          );
          return {
            redactedText: result.redactedText,
            entityTypes: result.entities.map((entity) => entity.entityType),
          };
        },
      },
      {
        name: "returns text unchanged when no PII is present",
        assert: async (provider) => {
          const result = await provider.redact({
            tenantId: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
            text: "no sensitive content here",
          });
          ensure(
            result.redactedText === "no sensitive content here",
            "Text without PII must be returned unchanged",
          );
          ensure(
            result.entities.length === 0,
            "No entities should be reported for PII-free text",
          );
          return {
            redactedText: result.redactedText,
            entityCount: result.entities.length,
          };
        },
      },
    ],
  };

export const searchProviderContract: ProviderContractSuite<SearchProvider> = {
  name: "SearchProvider",
  cases: [
    {
      name: "publishes valid base-provider metadata and capabilities",
      assert: async (provider) => {
        ensure(
          provider.metadata.interfaceName === "SearchProvider",
          "Search adapter must identify its canonical interface",
        );
        ProviderCapabilitiesSchema.parse(provider.capabilities);
        const health = await provider.healthCheck();
        ensure(
          health.status === "healthy",
          "Contract fixture must be healthy",
        );
        return {
          capabilities: provider.capabilities,
          health,
          interfaceName: provider.metadata.interfaceName,
        };
      },
    },
    {
      name: "returns at least one result for a real query",
      assert: async (provider) => {
        const result = await provider.search({
          tenantId: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
          query: "alterx contract test query",
        });
        ensure(
          result.results.length > 0,
          "Search must return at least one result for the contract fixture",
        );
        for (const item of result.results) {
          ensure(item.url.length > 0, "Every result must carry a URL");
          ensure(
            item.score >= 0 && item.score <= 1,
            "Score must be normalized between 0 and 1",
          );
        }
        return { resultCount: result.results.length };
      },
    },
  ],
};

export const cacheProviderContract: ProviderContractSuite<CacheProvider> = {
  name: "CacheProvider",
  cases: [
    {
      name: "publishes valid base-provider metadata and capabilities",
      assert: async (provider) => {
        ensure(
          provider.metadata.interfaceName === "CacheProvider",
          "Cache adapter must identify its canonical interface",
        );
        ProviderCapabilitiesSchema.parse(provider.capabilities);
        const health = await provider.healthCheck();
        ensure(
          health.status === "healthy",
          "Contract fixture must be healthy",
        );
        return {
          capabilities: provider.capabilities,
          health,
          interfaceName: provider.metadata.interfaceName,
        };
      },
    },
    {
      name: "reads, writes, and deletes exact-key values",
      assert: async (provider) => {
        const key = "contract:cache-provider:exact-value";
        await provider.deleteValue(key);
        ensure(
          (await provider.getValue(key)) === undefined,
          "A missing exact-key value must return undefined",
        );
        await provider.setValue(key, "contract-value", 60);
        ensure(
          (await provider.getValue(key)) === "contract-value",
          "An exact-key value must round-trip unchanged",
        );
        await provider.deleteValue(key);
        ensure(
          (await provider.getValue(key)) === undefined,
          "A deleted exact-key value must return undefined",
        );
        return { deleted: true, roundTripped: true };
      },
    },
    {
      name: "misses on a lookup before anything is stored",
      assert: async (provider) => {
        const result = await provider.lookupSemantic({
          tenantId: "ten_018f47a2-7b11-7b11-8a11-1234567890ab",
          embedding: [1, 0, 0, 0],
        });
        ensure(!result.hit, "A fresh tenant cache must start empty");
        return { hit: result.hit };
      },
    },
    {
      name: "hits on an identical embedding after storing it",
      assert: async (provider) => {
        const tenantId = "ten_018f47a2-7b11-7b11-8a11-2222222222bb";
        const embedding = [0.6, 0.8, 0, 0];
        await provider.storeSemantic({
          tenantId,
          embedding,
          valueJson: JSON.stringify({ cached: true }),
        });
        const result = await provider.lookupSemantic({
          tenantId,
          embedding,
        });
        ensure(result.hit, "An identical embedding must hit after storing");
        ensure(
          result.valueJson === JSON.stringify({ cached: true }),
          "Cache hit must return the exact stored value",
        );
        return { hit: result.hit, valueJson: result.valueJson };
      },
    },
    {
      name: "misses across different tenants even with the same embedding",
      assert: async (provider) => {
        const embedding = [0, 1, 0, 0];
        await provider.storeSemantic({
          tenantId: "ten_018f47a2-7b11-7b11-8a11-3333333333cc",
          embedding,
          valueJson: JSON.stringify({ scoped: "tenant-a" }),
        });
        const result = await provider.lookupSemantic({
          tenantId: "ten_018f47a2-7b11-7b11-8a11-4444444444dd",
          embedding,
        });
        ensure(!result.hit, "Cache must never leak across tenants");
        return { hit: result.hit };
      },
    },
  ],
};
