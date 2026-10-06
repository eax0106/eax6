import {
  createMockAuditEventHandler,
  createMockCacheProvider,
  createMockConfigProvider,
  createMockQueueProvider,
  createMockSearchProvider,
  createMockSecretsProvider,
  type AuditEventHandler,
  type CacheProvider,
  type ConfigProvider,
  type EmailProvider,
  type QueueProvider,
  type SearchProvider,
  type SecretsProvider,
  type ToolPermissionRequest,
} from "@alterx/shared-clients";
import { describe, expect, it, vi } from "vitest";

import {
  MockBrowserAutomationProvider,
  MockEmailProvider,
  SsrfGuardedFetcher,
  ToolGatewayNotImplementedError,
  ToolGatewayPermissionError,
  ToolGatewayRateLimitError,
  ToolGatewayValidationError,
  type BrowserAutomationProvider,
  type DatabaseOperationProvider,
  type DnsResolver,
  type FetchFn,
} from "@alterx/adapters";
import {
  ToolGatewayService,
  type ToolGatewayServiceOptions,
} from "./tool-gateway.service";
import { dispatchedToolNames } from "./tool-catalog";

const RAW_SECRET_VALUE = "raw-tool-api-key-value";
const TENANT_A = "ten_018f47a2-7b11-7b11-8a11-1234567890ab";
const TENANT_B = "ten_018f47a2-7b11-7b11-8a11-0000000000bb";
const INTEGRATION_A = "itg_018f47a2-7b11-7b11-8a11-1234567890ab";
const INTEGRATION_B = "itg_018f47a2-7b11-7b11-8a11-0000000000bb";
const SECRET_REF = `/alter/prod/tenant/${TENANT_A}/integration/${INTEGRATION_A}/access-token`;
const WRONG_TENANT_SECRET_REF = `/alter/prod/tenant/${TENANT_B}/integration/${INTEGRATION_A}/access-token`;
const WRONG_INTEGRATION_SECRET_REF = `/alter/prod/tenant/${TENANT_A}/integration/${INTEGRATION_B}/access-token`;

function invokeRequest(
  overrides: Partial<Parameters<ToolGatewayService["invokeTool"]>[0]> = {},
) {
  return {
    tenant_id: TENANT_A,
    run_id: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
    node_execution_id: "node_018f47a2-7b11-7b11-8a11-1234567890ab",
    tool_name: "other.tool",
    input_json: JSON.stringify({ query: "hello" }),
    credential_ref: SECRET_REF,
    ...overrides,
  };
}

function resolveRequest(
  overrides: Partial<Parameters<ToolGatewayService["resolveCredential"]>[0]> = {},
) {
  return {
    tenant_id: TENANT_A,
    integration_id: INTEGRATION_A,
    credential_ref: SECRET_REF,
    ...overrides,
  };
}

function secretProvider() {
  return createMockSecretsProvider({
    secrets: { [SECRET_REF]: RAW_SECRET_VALUE },
  });
}

function noopDnsResolver(): DnsResolver {
  return async () => [{ address: "93.184.216.34", family: 4 }];
}

function noopFetchFn(): FetchFn {
  return async () => ({
    status: 200,
    headers: { get: () => null },
    body: undefined,
    arrayBuffer: async () => new ArrayBuffer(0),
  });
}

function fakeDatabaseProvider(
  execute: DatabaseOperationProvider["execute"] = vi.fn(async () => ({
    rowCount: 1,
    rows: [{ answer: 42 }],
  })),
): DatabaseOperationProvider {
  return { providerId: "mock.database", execute };
}

interface ServiceOverrides {
  readonly configProvider?: ConfigProvider;
  readonly secretsProvider?: SecretsProvider;
  readonly searchProvider?: SearchProvider;
  readonly urlFetcher?: SsrfGuardedFetcher;
  readonly auditClient?: AuditEventHandler;
  readonly databaseProvider?: DatabaseOperationProvider;
  readonly costQueue?: QueueProvider;
  readonly costEventsQueueName?: string;
  readonly cacheProvider?: CacheProvider;
  readonly browserProvider?: BrowserAutomationProvider;
  readonly emailProvider?: EmailProvider;
  readonly options?: ToolGatewayServiceOptions;
}

function buildService(overrides: ServiceOverrides = {}): ToolGatewayService {
  return new ToolGatewayService(
    overrides.configProvider ?? createMockConfigProvider(),
    overrides.secretsProvider ?? secretProvider(),
    overrides.searchProvider ?? createMockSearchProvider(),
    overrides.urlFetcher ??
      new SsrfGuardedFetcher({}, noopDnsResolver(), noopFetchFn()),
    overrides.auditClient ?? createMockAuditEventHandler(),
    overrides.databaseProvider ?? fakeDatabaseProvider(),
    overrides.costQueue ?? createMockQueueProvider(),
    overrides.costEventsQueueName ?? "test-cost-events",
    overrides.cacheProvider ?? createMockCacheProvider(),
    overrides.browserProvider ?? mockBrowserProvider(),
    overrides.emailProvider ?? mockEmailProvider(),
    overrides.options ?? {},
  );
}

// Real MockBrowserAutomationProvider (not a hand-rolled fake) so the
// browser.* dispatch tests re-prove exactly what sandbox-service's spec
// proved before ENGINE-RESTRUCTURE-P4-1b moved the code: scoped session
// isolation, real navigate/extract result shapes, SSRF-guarded URLs.
function mockBrowserProvider(): BrowserAutomationProvider {
  return new MockBrowserAutomationProvider(
    new SsrfGuardedFetcher({}, noopDnsResolver(), noopFetchFn()),
  );
}

// Real MockEmailProvider (not a hand-rolled fake), same reasoning as
// mockBrowserProvider above -- exercises the real EmailProvider contract
// (metadata.providerId, real sentRaw recording), not a stand-in.
function mockEmailProvider(): EmailProvider {
  return new MockEmailProvider();
}

describe("ToolGatewayService", () => {
  it("rejects invalid JSON before permission or credential work", async () => {
    const resolveToolPermission = vi.fn();
    const service = buildService({
      configProvider: createMockConfigProvider({ resolveToolPermission }),
    });

    await expect(
      service.invokeTool(invokeRequest({ input_json: "{bad" })),
    ).rejects.toBeInstanceOf(ToolGatewayValidationError);
    expect(resolveToolPermission).not.toHaveBeenCalled();
  });

  it("rejects missing required request fields", async () => {
    const service = buildService();

    await expect(
      service.invokeTool(invokeRequest({ tool_name: "" })),
    ).rejects.toThrow(/tool_name/);
    await expect(
      service.resolveCredential(resolveRequest({ integration_id: "" })),
    ).rejects.toThrow(/integration_id/);
  });

  it("enforces permission-denied bindings and audits the denial", async () => {
    const auditClient = createMockAuditEventHandler();
    const service = buildService({
      configProvider: createMockConfigProvider({
        toolPermission: {
          allowed: false,
          rateLimitPerMinute: 60,
          requiredScopes: ["tools:search"],
        },
      }),
      auditClient,
    });

    await expect(service.invokeTool(invokeRequest())).rejects.toBeInstanceOf(
      ToolGatewayPermissionError,
    );
    expect(
      (auditClient as ReturnType<typeof createMockAuditEventHandler>).getRecordedEvents(),
    ).toContainEqual(expect.objectContaining({ result: "denied" }));
  });

  it("audits the unimplemented-tool rejection after the credential was already resolved", async () => {
    const auditClient = createMockAuditEventHandler();
    const getSecret = vi.fn(async () => RAW_SECRET_VALUE);
    const service = buildService({
      secretsProvider: { ...secretProvider(), getSecret },
      auditClient,
    });

    await expect(service.invokeTool(invokeRequest())).rejects.toBeInstanceOf(
      ToolGatewayNotImplementedError,
    );
    expect(getSecret).toHaveBeenCalledWith(SECRET_REF);
    expect(
      (auditClient as ReturnType<typeof createMockAuditEventHandler>).getRecordedEvents(),
    ).toContainEqual(
      expect.objectContaining({
        action: "tool.invoke",
        target_ref: "other.tool",
        result: "denied",
      }),
    );
  });

  it("enforces per-tenant per-tool rate limits", async () => {
    const service = buildService({
      configProvider: createMockConfigProvider({
        toolPermission: {
          allowed: true,
          rateLimitPerMinute: 1,
          requiredScopes: [],
        },
      }),
    });

    await expect(service.invokeTool(invokeRequest())).rejects.toBeInstanceOf(
      ToolGatewayNotImplementedError,
    );
    await expect(service.invokeTool(invokeRequest())).rejects.toBeInstanceOf(
      ToolGatewayRateLimitError,
    );
  });

  it("rejects malformed permission rate limits", async () => {
    const service = buildService({
      configProvider: createMockConfigProvider({
        toolPermission: {
          allowed: true,
          rateLimitPerMinute: 0,
          requiredScopes: [],
        },
      }),
    });

    await expect(service.invokeTool(invokeRequest())).rejects.toThrow(
      /rateLimitPerMinute/,
    );
  });

  it("dispatches search.web to the real SearchProvider and returns its result", async () => {
    const search = vi.fn(async () => ({
      results: [
        { title: "t", url: "https://example.com", snippet: "s", score: 0.5 },
      ],
    }));
    const auditClient = createMockAuditEventHandler();
    const service = buildService({
      searchProvider: { ...createMockSearchProvider(), search },
      auditClient,
    });

    const response = await service.invokeTool(
      invokeRequest({
        tool_name: "search.web",
        input_json: JSON.stringify({ query: "hello world", maxResults: 3 }),
      }),
    );

    expect(search).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      query: "hello world",
      maxResults: 3,
    });
    expect(JSON.parse(response.output_json)).toEqual({
      results: [
        { title: "t", url: "https://example.com", snippet: "s", score: 0.5 },
      ],
    });
    expect(response.audit_id).toMatch(
      /^aud_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      (auditClient as ReturnType<typeof createMockAuditEventHandler>).getRecordedEvents(),
    ).toContainEqual(
      expect.objectContaining({ target_ref: "search.web", result: "success" }),
    );
  });

  describe("search.web caching (ENGINE-RESTRUCTURE-P4-3, real Cache/Reuse cross-cutting wiring)", () => {
    function searchRequest(
      overrides: Partial<Parameters<ToolGatewayService["invokeTool"]>[0]> = {},
    ) {
      return invokeRequest({
        tool_name: "search.web",
        input_json: JSON.stringify({ query: "hello world", maxResults: 3 }),
        ...overrides,
      });
    }

    it("reuses a cached result instead of calling the real SearchProvider again", async () => {
      const search = vi.fn(async () => ({
        results: [{ title: "t", url: "https://example.com", snippet: "s", score: 0.5 }],
      }));
      const cacheProvider = createMockCacheProvider();
      const service = buildService({
        searchProvider: { ...createMockSearchProvider(), search },
        cacheProvider,
      });

      const first = await service.invokeTool(searchRequest());
      const second = await service.invokeTool(searchRequest());

      expect(search).toHaveBeenCalledTimes(1);
      expect(JSON.parse(second.output_json)).toEqual(JSON.parse(first.output_json));
    });

    it("shares the cache across tenants since search.web results are public web content", async () => {
      const search = vi.fn(async () => ({
        results: [{ title: "t", url: "https://example.com", snippet: "s", score: 0.5 }],
      }));
      const cacheProvider = createMockCacheProvider();
      const service = buildService({
        searchProvider: { ...createMockSearchProvider(), search },
        cacheProvider,
        secretsProvider: createMockSecretsProvider({
          secrets: {
            [SECRET_REF]: RAW_SECRET_VALUE,
            [`/alter/prod/tenant/${TENANT_B}/integration/${INTEGRATION_A}/access-token`]:
              RAW_SECRET_VALUE,
          },
        }),
      });

      await service.invokeTool(searchRequest());
      await service.invokeTool(
        searchRequest({
          tenant_id: TENANT_B,
          credential_ref: `/alter/prod/tenant/${TENANT_B}/integration/${INTEGRATION_A}/access-token`,
        }),
      );

      expect(search).toHaveBeenCalledTimes(1);
    });

    it("falls through to a real search when the cache lookup itself fails (fail-open)", async () => {
      const search = vi.fn(async () => ({
        results: [{ title: "t", url: "https://example.com", snippet: "s", score: 0.5 }],
      }));
      const cacheProvider: CacheProvider = {
        ...createMockCacheProvider(),
        getValue: () => {
          throw new Error("cache unavailable");
        },
      };
      const service = buildService({
        searchProvider: { ...createMockSearchProvider(), search },
        cacheProvider,
      });

      await expect(service.invokeTool(searchRequest())).resolves.toBeDefined();
      expect(search).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects search.web input missing a query", async () => {
    const service = buildService();

    await expect(
      service.invokeTool(
        invokeRequest({ tool_name: "search.web", input_json: "{}" }),
      ),
    ).rejects.toThrow(/non-empty query/);
  });

  it.each([0, -1, -100])(
    "rejects search.web input with a non-positive maxResults (%i)",
    async (maxResults) => {
      const service = buildService();

      await expect(
        service.invokeTool(
          invokeRequest({
            tool_name: "search.web",
            input_json: JSON.stringify({ query: "x", maxResults }),
          }),
        ),
      ).rejects.toThrow(/positive integer/);
    },
  );

  it("audits an error result when the underlying search call throws", async () => {
    const auditClient = createMockAuditEventHandler();
    const service = buildService({
      searchProvider: {
        ...createMockSearchProvider(),
        search: async () => {
          throw new Error("upstream failure");
        },
      },
      auditClient,
    });

    await expect(
      service.invokeTool(
        invokeRequest({
          tool_name: "search.web",
          input_json: JSON.stringify({ query: "x" }),
        }),
      ),
    ).rejects.toThrow("upstream failure");
    expect(
      (auditClient as ReturnType<typeof createMockAuditEventHandler>).getRecordedEvents(),
    ).toContainEqual(expect.objectContaining({ result: "error" }));
  });

  describe("database.* dispatch (ENGINE-RESTRUCTURE-P4-1, moved from SandboxService)", () => {
    const DATABASE_ID = "db_accounts";
    const DATABASE_CREDENTIAL_REF = `/alter/prod/tenant/${TENANT_A}/integration/${DATABASE_ID}/password`;
    const WRONG_DATABASE_CREDENTIAL_REF = `/alter/prod/tenant/${TENANT_A}/integration/db_other/password`;

    function databaseSecretsProvider() {
      return createMockSecretsProvider({
        secrets: {
          [SECRET_REF]: RAW_SECRET_VALUE,
          [DATABASE_CREDENTIAL_REF]: "postgres://db-connection-string",
          [WRONG_DATABASE_CREDENTIAL_REF]: "postgres://db-connection-string",
          [WRONG_TENANT_SECRET_REF]: "postgres://db-connection-string",
        },
      });
    }

    function databaseInvokeRequest(
      overrides: Partial<Parameters<ToolGatewayService["invokeTool"]>[0]> = {},
    ) {
      return invokeRequest({
        tool_name: "database.select",
        input_json: JSON.stringify({
          databaseId: DATABASE_ID,
          statement: "SELECT 1",
          parameters: [],
        }),
        credential_ref: DATABASE_CREDENTIAL_REF,
        ...overrides,
      });
    }

    function serviceWithScope(
      requiredScopes: readonly string[],
      overrides: ServiceOverrides = {},
    ): ToolGatewayService {
      return buildService({
        secretsProvider: databaseSecretsProvider(),
        configProvider: createMockConfigProvider({
          toolPermission: { allowed: true, rateLimitPerMinute: 60, requiredScopes },
        }),
        ...overrides,
      });
    }

    it("dispatches a real database operation and audits success", async () => {
      const auditClient = createMockAuditEventHandler();
      const execute = vi.fn(async () => ({ rowCount: 1, rows: [{ answer: 42 }] }));
      const service = serviceWithScope([`database:${DATABASE_ID}`], {
        databaseProvider: fakeDatabaseProvider(execute),
        auditClient,
      });

      const response = await service.invokeTool(databaseInvokeRequest());

      expect(JSON.parse(response.output_json)).toEqual({
        rowCount: 1,
        rows: [{ answer: 42 }],
      });
      expect(execute).toHaveBeenCalledWith({
        credentialReference: DATABASE_CREDENTIAL_REF,
        databaseId: DATABASE_ID,
        operation: "select",
        statement: "SELECT 1",
        parameters: [],
      });
      expect(
        (auditClient as ReturnType<typeof createMockAuditEventHandler>).getRecordedEvents(),
      ).toContainEqual(
        expect.objectContaining({ target_ref: "database.select", result: "success" }),
      );
    });

    it("emits a real cost event scoped to tool_gateway on a successful dispatch", async () => {
      const publish = vi.fn<(queueName: string, message: unknown) => Promise<void>>(
        async () => undefined,
      );
      const service = serviceWithScope([`database:${DATABASE_ID}`], {
        costQueue: createMockQueueProvider({ publish }),
        costEventsQueueName: "test-cost-events",
      });

      await service.invokeTool(databaseInvokeRequest());

      expect(publish).toHaveBeenCalledTimes(1);
      const [queueName, event] = publish.mock.calls[0] as [string, Record<string, unknown>];
      expect(queueName).toBe("test-cost-events");
      expect(event).toMatchObject({ source: "tool_gateway" });
      expect(JSON.parse(event.usage_json as string)).toMatchObject({
        resource_type: "tool_gateway.database.select",
        outcome: "success",
      });
    });

    it("rejects a database.* tool_name naming an unsupported operation", async () => {
      const service = serviceWithScope([`database:${DATABASE_ID}`]);

      await expect(
        service.invokeTool(
          databaseInvokeRequest({ tool_name: "database.drop" }),
        ),
      ).rejects.toBeInstanceOf(ToolGatewayNotImplementedError);
    });

    it("rejects a credential_ref naming a different database (strict ownership)", async () => {
      const service = serviceWithScope([`database:${DATABASE_ID}`, "database:db_other"]);

      await expect(
        service.invokeTool(
          databaseInvokeRequest({ credential_ref: WRONG_DATABASE_CREDENTIAL_REF }),
        ),
      ).rejects.toThrow(/not owned by this tenant\/database/);
    });

    it("rejects a credential_ref owned by a different tenant", async () => {
      const otherTenantDatabaseRef = `/alter/prod/tenant/${TENANT_B}/integration/${DATABASE_ID}/password`;
      const service = serviceWithScope([`database:${DATABASE_ID}`], {
        secretsProvider: createMockSecretsProvider({
          secrets: {
            [SECRET_REF]: RAW_SECRET_VALUE,
            [otherTenantDatabaseRef]: "postgres://db-connection-string",
          },
        }),
      });

      await expect(
        service.invokeTool(
          databaseInvokeRequest({ credential_ref: otherTenantDatabaseRef }),
        ),
      ).rejects.toThrow(/not owned/);
    });

    it("denies a database scope the tenant's tool permission binding doesn't grant, and audits the denial", async () => {
      const auditClient = createMockAuditEventHandler();
      const service = serviceWithScope(["database:some_other_db"], { auditClient });

      await expect(
        service.invokeTool(databaseInvokeRequest()),
      ).rejects.toBeInstanceOf(ToolGatewayPermissionError);
      expect(
        (auditClient as ReturnType<typeof createMockAuditEventHandler>).getRecordedEvents(),
      ).toContainEqual(
        expect.objectContaining({ target_ref: "database.select", result: "denied" }),
      );
    });

    it("grants access via a database:* wildcard scope", async () => {
      const service = serviceWithScope(["database:*"]);

      await expect(
        service.invokeTool(databaseInvokeRequest()),
      ).resolves.toBeDefined();
    });
  });

  describe("browser.* dispatch (ENGINE-RESTRUCTURE-P4-1b, moved from SandboxService)", () => {
    const SANDBOX_SESSION_ID = "ses_mock-1";
    const BROWSER_CREDENTIAL_REF = `/alter/prod/tenant/${TENANT_A}/integration/browser-automation/session`;
    const WRONG_TENANT_BROWSER_REF = `/alter/prod/tenant/${TENANT_B}/integration/browser-automation/session`;

    function browserInvokeRequest(
      overrides: Partial<Parameters<ToolGatewayService["invokeTool"]>[0]> = {},
      inputOverrides: Record<string, unknown> = {},
    ) {
      return invokeRequest({
        tool_name: "browser.session.create",
        input_json: JSON.stringify({
          session_id: SANDBOX_SESSION_ID,
          ...inputOverrides,
        }),
        credential_ref: BROWSER_CREDENTIAL_REF,
        ...overrides,
      });
    }

    it("drives a scoped create/navigate/click/extract/close flow end to end", async () => {
      const service = buildService();

      const created = await service.invokeTool(browserInvokeRequest());
      const { sessionId } = JSON.parse(created.output_json) as { sessionId: string };
      expect(sessionId).toMatch(/^browser_mock-/);

      await expect(
        service.invokeTool(
          browserInvokeRequest(
            { tool_name: "browser.navigate" },
            {
              browser_session_id: sessionId,
              url: "https://example.com/page",
            },
          ),
        ),
      ).resolves.toMatchObject({
        output_json: JSON.stringify({
          url: "https://example.com/page",
          title: "Local mock page",
        }),
      });

      await expect(
        service.invokeTool(
          browserInvokeRequest(
            { tool_name: "browser.click" },
            { browser_session_id: sessionId, selector: "#go" },
          ),
        ),
      ).resolves.toMatchObject({
        output_json: JSON.stringify({
          confirmation: { status: "unconfirmed", reason: "No expected page state was declared for this click" },
        }),
      });

      await expect(
        service.invokeTool(
          browserInvokeRequest(
            { tool_name: "browser.click" },
            { browser_session_id: sessionId, selector: "#go", expected_page_state: { selector: "main" } },
          ),
        ),
      ).resolves.toMatchObject({
        output_json: JSON.stringify({
          snapshot: { text: "mock:main", url: "https://example.com/page" },
          confirmation: { status: "confirmed", basis: "post-click snapshot matched expected page state" },
        }),
      });

      const extracted = await service.invokeTool(
        browserInvokeRequest(
          { tool_name: "browser.extract" },
          { browser_session_id: sessionId, selector: "main" },
        ),
      );
      expect(JSON.parse(extracted.output_json)).toEqual({
        text: "mock:main",
        url: "https://example.com/page",
      });

      await expect(
        service.invokeTool(
          browserInvokeRequest(
            { tool_name: "browser.session.close" },
            { browser_session_id: sessionId },
          ),
        ),
      ).resolves.toMatchObject({ output_json: "{}" });
    });

    it("reads only declared expectations, accepts empty matching selectors, and bills the extra read", async () => {
      const browserProvider = mockBrowserProvider();
      const extract = vi.spyOn(browserProvider, "extract").mockResolvedValue({ text: "", url: "https://example.com" });
      const publish = vi.fn<QueueProvider["publish"]>(async () => undefined);
      const service = buildService({ browserProvider, costQueue: createMockQueueProvider({ publish }) });
      const { sessionId } = JSON.parse((await service.invokeTool(browserInvokeRequest())).output_json);
      publish.mockClear();
      const click = async (expected_page_state?: Record<string, unknown>) => JSON.parse((await service.invokeTool(browserInvokeRequest(
        { tool_name: "browser.click" }, { browser_session_id: sessionId, selector: "#go", ...(expected_page_state ? { expected_page_state } : {}) },
      ))).output_json);
      expect(await click()).toMatchObject({ confirmation: { status: "unconfirmed" } });
      expect(extract).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledTimes(1);
      publish.mockClear();
      expect(await click({ selector: "#done" })).toMatchObject({ confirmation: { status: "confirmed" } });
      expect(extract).toHaveBeenLastCalledWith(expect.any(Object), sessionId, "#done");
      expect(publish.mock.calls.map(call => JSON.parse((call[1] as { usage_json: string }).usage_json).resource_type).sort()).toEqual([
        "tool_gateway.browser.click", "tool_gateway.browser.extract",
      ]);
      extract.mockResolvedValueOnce({ text: "Saved", url: "https://example.com" });
      expect(await click({ text: "Saved" })).toMatchObject({ confirmation: { status: "confirmed" } });
      expect(await click({ text: "Saved" })).toMatchObject({ confirmation: { status: "failed" } });
      const action = vi.spyOn(browserProvider, "click");
      extract.mockRejectedValueOnce(new Error("snapshot unavailable"));
      expect(await click({ selector: "#missing" })).toMatchObject({ confirmation: { status: "unconfirmed", reason: expect.stringContaining("could not be read") } });
      expect(action).toHaveBeenCalledTimes(1);
      await expect(click({})).rejects.toBeInstanceOf(ToolGatewayValidationError);
      await expect(click({ text: "   " })).rejects.toBeInstanceOf(ToolGatewayValidationError);
      await expect(click({ selector: "#done", typo: true })).rejects.toBeInstanceOf(ToolGatewayValidationError);
      expect(action).toHaveBeenCalledTimes(1);
    });

    it("requires the exact tenant browser grant for every browser operation", async () => {
      const resolveToolPermission = vi.fn<
        (request: ToolPermissionRequest) => Promise<{
          readonly allowed: boolean;
          readonly rateLimitPerMinute: number;
          readonly requiredScopes: readonly string[];
        }>
      >(async () => ({
        allowed: true,
        rateLimitPerMinute: 60,
        requiredScopes: [],
      }));
      const service = buildService({
        configProvider: createMockConfigProvider({ resolveToolPermission }),
      });

      const created = await service.invokeTool(browserInvokeRequest());
      const { sessionId } = JSON.parse(created.output_json) as { sessionId: string };
      await service.invokeTool(
        browserInvokeRequest(
          { tool_name: "browser.navigate" },
          { browser_session_id: sessionId, url: "https://example.com/page" },
        ),
      );
      await service.invokeTool(
        browserInvokeRequest(
          { tool_name: "browser.click" },
          { browser_session_id: sessionId, selector: "#go" },
        ),
      );
      await service.invokeTool(
        browserInvokeRequest(
          { tool_name: "browser.extract" },
          { browser_session_id: sessionId, selector: "main" },
        ),
      );
      await service.invokeTool(
        browserInvokeRequest(
          { tool_name: "browser.session.close" },
          { browser_session_id: sessionId },
        ),
      );

      expect(resolveToolPermission.mock.calls.map(([request]) => request)).toEqual([
        { tenantId: TENANT_A, toolName: "browser.session.create" },
        { tenantId: TENANT_A, toolName: "browser.navigate" },
        { tenantId: TENANT_A, toolName: "browser.click" },
        { tenantId: TENANT_A, toolName: "browser.extract" },
        { tenantId: TENANT_A, toolName: "browser.session.close" },
      ]);
    });

    it.each(["browser.session.create", "browser.navigate", "browser.click", "browser.extract", "browser.session.close"])(
      "denies %s when the tenant grant is absent and audits the denial",
      async (toolName) => {
        const auditClient = createMockAuditEventHandler();
        const service = buildService({
          configProvider: createMockConfigProvider({
            toolPermission: {
              allowed: false,
              rateLimitPerMinute: 60,
              requiredScopes: [],
            },
          }),
          auditClient,
        });

        await expect(
          service.invokeTool(browserInvokeRequest({ tool_name: toolName })),
        ).rejects.toBeInstanceOf(ToolGatewayPermissionError);
        expect(
          (auditClient as ReturnType<typeof createMockAuditEventHandler>).getRecordedEvents(),
        ).toContainEqual(
          expect.objectContaining({ target_ref: toolName, result: "denied" }),
        );
      },
    );

    it("emits a real cost event scoped to tool_gateway.browser.* on success", async () => {
      const publish = vi.fn<(queueName: string, message: unknown) => Promise<void>>(
        async () => undefined,
      );
      const service = buildService({
        costQueue: createMockQueueProvider({ publish }),
        costEventsQueueName: "test-cost-events",
      });

      await service.invokeTool(browserInvokeRequest());

      expect(publish).toHaveBeenCalledTimes(1);
      const [queueName, event] = publish.mock.calls[0] as [string, Record<string, unknown>];
      expect(queueName).toBe("test-cost-events");
      expect(event).toMatchObject({ source: "tool_gateway" });
      expect(JSON.parse(event.usage_json as string)).toMatchObject({
        resource_type: "tool_gateway.browser.create",
        outcome: "success",
      });
    });

    it("rejects a browser credential_ref owned by a different tenant without touching SecretsProvider", async () => {
      const getSecret = vi.fn(secretProvider().getSecret);
      const service = buildService({
        secretsProvider: { ...secretProvider(), getSecret },
      });

      await expect(
        service.invokeTool(
          browserInvokeRequest({ credential_ref: WRONG_TENANT_BROWSER_REF }),
        ),
      ).rejects.toThrow(/not owned by this tenant\/integration/);
      expect(getSecret).not.toHaveBeenCalled();
    });

    it("skips secret resolution for the reserved browser-automation credential template", async () => {
      const getSecret = vi.fn(secretProvider().getSecret);
      const auditClient = createMockAuditEventHandler();
      const service = buildService({ secretsProvider: { ...secretProvider(), getSecret }, auditClient });

      await expect(service.invokeTool(browserInvokeRequest())).resolves.toBeDefined();

      expect(getSecret).not.toHaveBeenCalledWith(BROWSER_CREDENTIAL_REF);
      expect(getSecret).not.toHaveBeenCalled();
      expect(
        (auditClient as ReturnType<typeof createMockAuditEventHandler>).getRecordedEvents(),
      ).toContainEqual(
        expect.objectContaining({
          target_ref: "browser.session.create",
          result: "success",
        }),
      );
    });

    it("keeps provider-side session isolation: another sandbox session id cannot drive an existing browser session", async () => {
      const auditClient = createMockAuditEventHandler();
      const service = buildService({ auditClient });

      const created = await service.invokeTool(browserInvokeRequest());
      const { sessionId } = JSON.parse(created.output_json) as { sessionId: string };

      await expect(
        service.invokeTool(
          browserInvokeRequest(
            { tool_name: "browser.navigate" },
            {
              session_id: "ses_a-different-sandbox-session",
              browser_session_id: sessionId,
              url: "https://example.com/page",
            },
          ),
        ),
      ).rejects.toThrow(/not owned by this execution scope/);
      expect(
        (auditClient as ReturnType<typeof createMockAuditEventHandler>).getRecordedEvents(),
      ).toContainEqual(expect.objectContaining({ result: "error" }));
    });

    it("validates browser input fields before dispatch", async () => {
      const service = buildService();

      await expect(
        service.invokeTool(
          browserInvokeRequest({ input_json: JSON.stringify({}) }),
        ),
      ).rejects.toThrow(/non-empty session_id/);
      await expect(
        service.invokeTool(
          browserInvokeRequest({
            tool_name: "browser.navigate",
            input_json: JSON.stringify({ session_id: SANDBOX_SESSION_ID }),
          }),
        ),
      ).rejects.toThrow(/non-empty browser_session_id/);
      await expect(
        service.invokeTool(
          browserInvokeRequest({
            tool_name: "browser.navigate",
            input_json: JSON.stringify({
              session_id: SANDBOX_SESSION_ID,
              browser_session_id: "browser_mock-1",
            }),
          }),
        ),
      ).rejects.toThrow(/non-empty url/);
    });
  });

  describe("email.send dispatch (real, new tool action -- free-text send, SES Content.Simple)", () => {
    const EMAIL_CREDENTIAL_REF = `/alter/prod/tenant/${TENANT_A}/integration/email-send/outbound`;
    const WRONG_TENANT_EMAIL_REF = `/alter/prod/tenant/${TENANT_B}/integration/email-send/outbound`;

    function emailInvokeRequest(
      overrides: Partial<Parameters<ToolGatewayService["invokeTool"]>[0]> = {},
      inputOverrides: Record<string, unknown> = {},
    ) {
      return invokeRequest({
        tool_name: "email.send",
        input_json: JSON.stringify({
          to: "recipient@example.com",
          subject: "Run failed",
          body: "See the run detail page for the failure reason.",
          ...inputOverrides,
        }),
        credential_ref: EMAIL_CREDENTIAL_REF,
        ...overrides,
      });
    }

    it("sends a real email through the mock provider and returns its result", async () => {
      const emailProvider = mockEmailProvider();
      const service = buildService({ emailProvider });

      const response = await service.invokeTool(emailInvokeRequest());

      expect(JSON.parse(response.output_json)).toMatchObject({ messageId: "mock-email-1" });
      expect((emailProvider as MockEmailProvider).sentRaw).toEqual([
        {
          to: "recipient@example.com",
          subject: "Run failed",
          body: "See the run detail page for the failure reason.",
          html: undefined,
        },
      ]);
    });

    it("passes options.html through when the input sets html:true", async () => {
      const emailProvider = mockEmailProvider();
      const service = buildService({ emailProvider });

      await service.invokeTool(
        emailInvokeRequest({}, { body: "<p>See the run detail page.</p>", html: true }),
      );

      expect((emailProvider as MockEmailProvider).sentRaw[0]).toMatchObject({ html: true });
    });

    it("denies email.send when the tenant grant is absent and audits the denial", async () => {
      const auditClient = createMockAuditEventHandler();
      const service = buildService({
        configProvider: createMockConfigProvider({
          toolPermission: { allowed: false, rateLimitPerMinute: 60, requiredScopes: [] },
        }),
        auditClient,
      });

      await expect(service.invokeTool(emailInvokeRequest())).rejects.toBeInstanceOf(
        ToolGatewayPermissionError,
      );
      expect(
        (auditClient as ReturnType<typeof createMockAuditEventHandler>).getRecordedEvents(),
      ).toContainEqual(
        expect.objectContaining({ target_ref: "email.send", result: "denied" }),
      );
    });

    it("emits a real cost event scoped to tool_gateway.email.send on success", async () => {
      const publish = vi.fn<(queueName: string, message: unknown) => Promise<void>>(
        async () => undefined,
      );
      const service = buildService({
        costQueue: createMockQueueProvider({ publish }),
        costEventsQueueName: "test-cost-events",
        emailProvider: mockEmailProvider(),
      });

      await service.invokeTool(emailInvokeRequest());

      expect(publish).toHaveBeenCalledTimes(1);
      const [queueName, event] = publish.mock.calls[0] as [string, Record<string, unknown>];
      expect(queueName).toBe("test-cost-events");
      expect(event).toMatchObject({ source: "tool_gateway" });
      expect(JSON.parse(event.usage_json as string)).toMatchObject({
        resource_type: "tool_gateway.email.send",
        outcome: "success",
      });
    });

    it("rejects an email credential_ref owned by a different tenant without touching SecretsProvider", async () => {
      const getSecret = vi.fn(secretProvider().getSecret);
      const service = buildService({
        secretsProvider: { ...secretProvider(), getSecret },
      });

      await expect(
        service.invokeTool(
          emailInvokeRequest({ credential_ref: WRONG_TENANT_EMAIL_REF }),
        ),
      ).rejects.toThrow(/not owned by this tenant\/integration/);
      expect(getSecret).not.toHaveBeenCalled();
    });

    it("skips secret resolution for the reserved email-send credential template, like browser automation", async () => {
      const getSecret = vi.fn(secretProvider().getSecret);
      const auditClient = createMockAuditEventHandler();
      const service = buildService({
        secretsProvider: { ...secretProvider(), getSecret },
        auditClient,
        emailProvider: mockEmailProvider(),
      });

      await expect(service.invokeTool(emailInvokeRequest())).resolves.toBeDefined();

      expect(getSecret).not.toHaveBeenCalled();
      expect(
        (auditClient as ReturnType<typeof createMockAuditEventHandler>).getRecordedEvents(),
      ).toContainEqual(
        expect.objectContaining({ target_ref: "email.send", result: "success" }),
      );
    });

    it.each([
      [{ to: "not-an-email" }, /valid to email address/],
      [{ to: "" }, /valid to email address/],
      [{ subject: "" }, /non-empty subject/],
      [{ subject: "x".repeat(999) }, /at most 998 characters/],
      [{ body: "" }, /non-empty body/],
      [{ html: "yes" }, /html, if present, must be a boolean/],
    ])("rejects an invalid email.send input %o", async (inputOverrides, expectedMessage) => {
      const service = buildService({ emailProvider: mockEmailProvider() });

      await expect(
        service.invokeTool(emailInvokeRequest({}, inputOverrides)),
      ).rejects.toThrow(expectedMessage);
    });

    it("rejects a subject+body combination larger than SES's declared maximum payload before dispatching", async () => {
      const emailProvider = mockEmailProvider();
      const service = buildService({ emailProvider });

      await expect(
        service.invokeTool(
          emailInvokeRequest({}, { body: "x".repeat(11_000_000) }),
        ),
      ).rejects.toThrow(/exceeds the maximum payload/);
      expect((emailProvider as MockEmailProvider).sentRaw).toEqual([]);
    });

    it("lists email.send in the not-implemented error message for an unrecognized tool", async () => {
      const service = buildService();

      await expect(service.invokeTool(invokeRequest({ tool_name: "other.tool" }))).rejects.toThrow(
        /email\.send/,
      );
    });
  });

  it("accepts a canonical tenant integration secret path and mints an opaque token", async () => {
    const service = buildService({
      options: {
        now: () => new Date("2026-07-24T00:00:00.000Z"),
        mintCredentialToken: () => "cred_test-token",
      },
    });

    const response = await service.resolveCredential(resolveRequest());
    const serialized = JSON.stringify(response);

    expect(response).toEqual({
      resolved_reference: "cred_test-token",
      expires_at: "2026-07-24T00:05:00.000Z",
    });
    expect(response.resolved_reference).not.toBe(SECRET_REF);
    expect(serialized).not.toContain(SECRET_REF);
    expect(serialized).not.toContain(RAW_SECRET_VALUE);
  });

  it("rejects canonical credential resolution when tenant segment is wrong", async () => {
    const getSecret = vi.fn(secretProvider().getSecret);
    const service = buildService({
      secretsProvider: { ...secretProvider(), getSecret },
    });

    await expect(
      service.resolveCredential(
        resolveRequest({ credential_ref: WRONG_TENANT_SECRET_REF }),
      ),
    ).rejects.toThrow(/not owned/);
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("rejects canonical credential resolution when integration segment is wrong", async () => {
    const getSecret = vi.fn(secretProvider().getSecret);
    const service = buildService({
      secretsProvider: { ...secretProvider(), getSecret },
    });

    await expect(
      service.resolveCredential(
        resolveRequest({ credential_ref: WRONG_INTEGRATION_SECRET_REF }),
      ),
    ).rejects.toThrow(/not owned/);
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("rejects system-shaped secret references for tenant tool credentials", async () => {
    const getSecret = vi.fn(secretProvider().getSecret);
    const service = buildService({
      secretsProvider: { ...secretProvider(), getSecret },
    });

    await expect(
      service.resolveCredential(
        resolveRequest({
          credential_ref: "/alter/prod/tool-gateway/system/bootstrap-token",
        }),
      ),
    ).rejects.toThrow(/tenant integration secret reference/);
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("rejects expired opaque credential tokens", async () => {
    let nowMs = Date.parse("2026-07-24T00:00:00.000Z");
    const service = buildService({
      options: {
        credentialTokenTtlMs: 1_000,
        now: () => new Date(nowMs),
        mintCredentialToken: () => "cred_expiring-token",
      },
    });
    const resolved = await service.resolveCredential(resolveRequest());
    nowMs += 1_001;

    await expect(
      service.invokeTool(
        invokeRequest({ credential_ref: resolved.resolved_reference }),
      ),
    ).rejects.toThrow(/not recognized/);
  });

  it("rejects cross-tenant opaque credential token consumption", async () => {
    const service = buildService({
      options: { mintCredentialToken: () => "cred_tenant-a-token" },
    });
    const resolved = await service.resolveCredential(resolveRequest());

    await expect(
      service.invokeTool(
        invokeRequest({
          tenant_id: TENANT_B,
          credential_ref: resolved.resolved_reference,
        }),
      ),
    ).rejects.toThrow(/not owned/);
  });

  it("accepts non-expired opaque credential tokens without resolving SecretsProvider again", async () => {
    const getSecret = vi.fn(secretProvider().getSecret);
    const service = buildService({
      secretsProvider: { ...secretProvider(), getSecret },
      options: { mintCredentialToken: () => "cred_active-token" },
    });
    const resolved = await service.resolveCredential(resolveRequest());
    getSecret.mockClear();

    await expect(
      service.invokeTool(
        invokeRequest({ credential_ref: resolved.resolved_reference }),
      ),
    ).rejects.toBeInstanceOf(ToolGatewayNotImplementedError);
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("bounds credential token storage by evicting expired records", async () => {
    let nowMs = Date.parse("2026-07-24T00:00:00.000Z");
    let tokenIndex = 0;
    const getSecret = vi.fn(secretProvider().getSecret);
    const service = buildService({
      secretsProvider: { ...secretProvider(), getSecret },
      options: {
        credentialTokenTtlMs: 1_000,
        maxCredentialTokens: 1,
        now: () => new Date(nowMs),
        mintCredentialToken: () => `cred_sweep-${(tokenIndex += 1)}`,
      },
    });
    const expired = await service.resolveCredential(resolveRequest());
    nowMs += 1_001;
    await service.resolveCredential(resolveRequest());
    getSecret.mockClear();

    await expect(
      service.invokeTool(
        invokeRequest({ credential_ref: expired.resolved_reference }),
      ),
    ).rejects.toThrow(/not recognized/);
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("fails loudly if opaque token minting cannot produce a unique value", async () => {
    const service = buildService({
      options: { mintCredentialToken: () => "cred_duplicate" },
    });

    await service.resolveCredential(resolveRequest());
    await expect(service.resolveCredential(resolveRequest())).rejects.toThrow(
      /unique credential token/,
    );
  });

  it("accepts raw canonical SecretsProvider references through invokeTool but never dispatches an unimplemented tool", async () => {
    const getSecret = vi.fn(secretProvider().getSecret);
    const service = buildService({
      secretsProvider: { ...secretProvider(), getSecret },
    });

    await expect(service.invokeTool(invokeRequest())).rejects.toSatisfy(
      (error: unknown) => {
        const serialized = JSON.stringify(error);
        return (
          error instanceof ToolGatewayNotImplementedError &&
          !serialized.includes(RAW_SECRET_VALUE)
        );
      },
    );
    expect(getSecret).toHaveBeenCalledWith(SECRET_REF);
  });

  it("fetches a public URL through the SSRF-guarded fetcher and stores an artifact", async () => {
    const auditClient = createMockAuditEventHandler();
    const urlFetcher = new SsrfGuardedFetcher(
      {},
      noopDnsResolver(),
      async () => ({
        status: 200,
        headers: { get: () => null },
        body: undefined,
        arrayBuffer: async () => new TextEncoder().encode("hello").buffer as ArrayBuffer,
      }),
    );
    const service = buildService({ urlFetcher, auditClient });

    const response = await service.fetchUrl({
      tenant_id: TENANT_A,
      run_id: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
      node_execution_id: "node_018f47a2-7b11-7b11-8a11-1234567890ab",
      url: "https://example.com",
      network_policy_json: "{}",
    });

    expect(response.status_code).toBe(200);
    expect(response.content_artifact_id).toMatch(/^art_/);
    expect(
      (auditClient as ReturnType<typeof createMockAuditEventHandler>).getRecordedEvents(),
    ).toContainEqual(
      expect.objectContaining({ action: "url.fetch", result: "success" }),
    );
  });

  it("rejects and audits an SSRF-blocked fetchUrl target as denied", async () => {
    const auditClient = createMockAuditEventHandler();
    const urlFetcher = new SsrfGuardedFetcher(
      {},
      async () => [{ address: "10.0.0.5", family: 4 }],
      noopFetchFn(),
    );
    const service = buildService({ urlFetcher, auditClient });

    await expect(
      service.fetchUrl({
        tenant_id: TENANT_A,
        run_id: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
        node_execution_id: "node_018f47a2-7b11-7b11-8a11-1234567890ab",
        url: "https://internal.example.com",
        network_policy_json: "{}",
      }),
    ).rejects.toThrow(/blocked private\/internal IP/);
    expect(
      (auditClient as ReturnType<typeof createMockAuditEventHandler>).getRecordedEvents(),
    ).toContainEqual(
      expect.objectContaining({ action: "url.fetch", result: "denied" }),
    );
  });

  it("rejects an invalid fetchUrl URL before touching the fetcher", async () => {
    const service = buildService();

    await expect(
      service.fetchUrl({
        tenant_id: TENANT_A,
        run_id: "run_018f47a2-7b11-7b11-8a11-1234567890ab",
        node_execution_id: "node_018f47a2-7b11-7b11-8a11-1234567890ab",
        url: "not-a-url",
        network_policy_json: "{}",
      }),
    ).rejects.toBeInstanceOf(ToolGatewayValidationError);
  });
});

describe("ToolGatewayService dispatch agrees with the catalogue", () => {
  // tool-catalog.spec.ts asserts the catalogue matches the canonical enum.
  // That is bookkeeping until something proves the catalogue also matches the
  // dispatcher, which is the half that was never pinned: the real set lived
  // in an `if` chain, so a tool could be added or lost there silently.
  //
  // `{}` is deliberately invalid input for every tool. A tool that dispatches
  // gets far enough to have its own input parser (or its permission scope)
  // reject it; a tool with no dispatch falls through the whole chain to
  // ToolGatewayNotImplementedError. So "not that error" is exactly the
  // assertion "dispatch was reached", without needing eleven valid payloads.
  it.each(dispatchedToolNames())("reaches a real dispatch for %s", async (toolName) => {
    // knowledge.search and whatsapp.send dispatch only once their ports are wired.
    const service = buildService({
      options: {
        knowledgeSearch: { search: async () => [] },
        whatsappSend: { send: async () => ({ messageId: "unused" }) },
      },
    });

    const outcome = await service
      .invokeTool(invokeRequest({ tool_name: toolName, input_json: "{}" }))
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(outcome).not.toBeInstanceOf(ToolGatewayNotImplementedError);
  });

  it("refuses an uncatalogued name as not a tool, not as one still coming", async () => {
    const service = buildService();

    await expect(
      service.invokeTool(invokeRequest({ tool_name: "browser.screenshot" })),
    ).rejects.toThrow(/is not a tool this gateway offers/);
  });
});

describe("knowledge.search and whatsapp.send dispatch (run-scoped workspace tools)", () => {
  const KNOWLEDGE_REF = `/alter/prod/tenant/${TENANT_A}/integration/knowledge-search/default`;
  const WHATSAPP_REF = `/alter/prod/tenant/${TENANT_A}/integration/whatsapp-send/default`;

  function knowledgeRequest(inputOverrides: Record<string, unknown> = {}) {
    return invokeRequest({
      tool_name: "knowledge.search",
      input_json: JSON.stringify({ query: "refund policy", ...inputOverrides }),
      credential_ref: KNOWLEDGE_REF,
    });
  }

  function whatsappRequest(inputOverrides: Record<string, unknown> = {}) {
    return invokeRequest({
      tool_name: "whatsapp.send",
      input_json: JSON.stringify({ to: "919876543210", text: "Your order shipped.", ...inputOverrides }),
      credential_ref: WHATSAPP_REF,
    });
  }

  it("searches through the port with the request's tenant and run", async () => {
    const search = vi.fn(async () => [{ documentId: "doc-1", title: "Policy", text: "Refunds within 30 days.", score: 0.9 }]);
    const service = buildService({ options: { knowledgeSearch: { search } } });

    const response = await service.invokeTool(knowledgeRequest({ topK: 2 }));

    expect(search).toHaveBeenCalledWith(
      { tenantId: TENANT_A, runId: "run_018f47a2-7b11-7b11-8a11-1234567890ab" },
      { query: "refund policy", topK: 2 },
    );
    expect(JSON.parse(response.output_json)).toEqual({
      results: [{ documentId: "doc-1", title: "Policy", text: "Refunds within 30 days.", score: 0.9 }],
    });
  });

  it("keeps whole results only when the output would pass the size cap", async () => {
    const big = "x".repeat(400_000);
    const search = vi.fn(async () => [
      { documentId: "a", title: null, text: big, score: 0.9 },
      { documentId: "b", title: null, text: big, score: 0.8 },
      { documentId: "c", title: null, text: big, score: 0.7 },
      { documentId: "d", title: null, text: big, score: 0.6 },
    ]);
    const service = buildService({ options: { knowledgeSearch: { search } } });

    const response = await service.invokeTool(knowledgeRequest());
    const kept = (JSON.parse(response.output_json) as { results: { documentId: string }[] }).results;

    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(4);
    expect(kept.map((result) => result.documentId)).toEqual(["a", "b", "c", "d"].slice(0, kept.length));
  });

  it("rejects a bad knowledge.search input before the port is called", async () => {
    const search = vi.fn(async () => []);
    const service = buildService({ options: { knowledgeSearch: { search } } });

    await expect(service.invokeTool(knowledgeRequest({ topK: 99 }))).rejects.toBeInstanceOf(ToolGatewayValidationError);
    expect(search).not.toHaveBeenCalled();
  });

  it("sends a WhatsApp message through the port and emits a cost event", async () => {
    const send = vi.fn(async () => ({ messageId: "wamid.42" }));
    const publish = vi.fn<(queueName: string, message: unknown) => Promise<void>>(async () => undefined);
    const service = buildService({ costQueue: createMockQueueProvider({ publish }), options: { whatsappSend: { send } } });

    const response = await service.invokeTool(whatsappRequest());

    expect(JSON.parse(response.output_json)).toEqual({ messageId: "wamid.42" });
    expect(send).toHaveBeenCalledWith(
      { tenantId: TENANT_A, runId: "run_018f47a2-7b11-7b11-8a11-1234567890ab" },
      { to: "919876543210", text: "Your order shipped." },
    );
    const [, event] = publish.mock.calls[0] as [string, Record<string, unknown>];
    expect(JSON.parse(event.usage_json as string)).toMatchObject({ resource_type: "tool_gateway.whatsapp.send", outcome: "success" });
  });

  it("denies whatsapp.send without a grant, audits it and never sends", async () => {
    const send = vi.fn(async () => ({ messageId: "never" }));
    const auditClient = createMockAuditEventHandler();
    const service = buildService({
      configProvider: createMockConfigProvider({ toolPermission: { allowed: false, rateLimitPerMinute: 60, requiredScopes: [] } }),
      auditClient,
      options: { whatsappSend: { send } },
    });

    await expect(service.invokeTool(whatsappRequest())).rejects.toBeInstanceOf(ToolGatewayPermissionError);
    expect(send).not.toHaveBeenCalled();
    expect((auditClient as ReturnType<typeof createMockAuditEventHandler>).getRecordedEvents()).toContainEqual(
      expect.objectContaining({ target_ref: "whatsapp.send", result: "denied" }),
    );
  });

  it("rejects a credential_ref owned by another tenant for both tools", async () => {
    const search = vi.fn(async () => []);
    const send = vi.fn(async () => ({ messageId: "never" }));
    const service = buildService({ options: { knowledgeSearch: { search }, whatsappSend: { send } } });
    const other = (integration: string) => `/alter/prod/tenant/${TENANT_B}/integration/${integration}/default`;

    await expect(service.invokeTool({ ...knowledgeRequest(), credential_ref: other("knowledge-search") })).rejects.toThrow();
    await expect(service.invokeTool({ ...whatsappRequest(), credential_ref: other("whatsapp-send") })).rejects.toThrow();
    expect(search).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("stays not-implemented when the workspace ports are not wired", async () => {
    const service = buildService();

    await expect(service.invokeTool(knowledgeRequest())).rejects.toBeInstanceOf(ToolGatewayNotImplementedError);
    await expect(service.invokeTool(whatsappRequest())).rejects.toBeInstanceOf(ToolGatewayNotImplementedError);
  });
});
