import { createHash, randomUUID } from "node:crypto";

import type {
  ToolgwFetchUrlRequest,
  ToolgwFetchUrlResponse,
  ToolgwInvokeToolRequest,
  ToolgwInvokeToolResponse,
  ToolgwResolveCredentialRequest,
  ToolgwResolveCredentialResponse,
} from "@alterx/contracts";
import {
  SES_EMAIL_CAPABILITIES,
  SsrfBlockedError,
  SsrfGuardedFetcher,
  ToolGatewayNotImplementedError,
  ToolGatewayPermissionError,
  ToolGatewayRateLimitError,
  ToolGatewayValidationError,
  type BrowserAutomationProvider,
  type BrowserSessionScope,
  type DatabaseOperationProvider,
  type DatabaseOperationResult,
  type ToolgwHandler,
} from "@alterx/adapters";
import type {
  AuditEventHandler,
  CacheProvider,
  ConfigProvider,
  EmailProvider,
  JsonValue,
  QueueProvider,
  SearchProvider,
  SecretsProvider,
  ToolPermissionBinding,
} from "@alterx/shared-clients";

import {
  dispatchedToolNames,
  isCanonicalToolName,
  toolNamesInFamily,
} from "./tool-catalog";

import { createCostEventId } from "./cost-event-id";

interface CredentialRecord {
  readonly secretValue: string;
  readonly expiresAtMs: number;
  readonly tenantId: string;
  readonly integrationId?: string;
}

interface RateLimitBucket {
  readonly windowStartedAtMs: number;
  count: number;
}

interface ArtifactRecord {
  readonly body: ArrayBuffer;
  readonly expiresAtMs: number;
}

export interface ToolGatewayServiceOptions {
  readonly credentialTokenTtlMs?: number;
  readonly maxCredentialTokens?: number;
  readonly artifactTtlMs?: number;
  readonly maxArtifacts?: number;
  readonly now?: () => Date;
  readonly mintCredentialToken?: () => string;
  readonly mintId?: () => string;
  readonly mintCostEventId?: () => string;
}

interface CostUsage {
  readonly provider: string;
  readonly resourceType: string;
  readonly units: number;
}

const DEFAULT_CREDENTIAL_TOKEN_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CREDENTIAL_TOKENS = 10_000;
const DEFAULT_ARTIFACT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ARTIFACTS = 1_000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const OPAQUE_CREDENTIAL_TOKEN_PREFIX = "cred_";
const SEARCH_WEB_TOOL_NAME = "search.web";
// ENGINE-RESTRUCTURE-P4-1: database.* moved here from sandbox-service's
// SandboxService.executeDatabaseOperation -- same real, tested logic
// (permission check, tenant/database credential-ownership check, bounded
// output), just relocated to the component the architecture doc says
// owns it. Never had a real caller in its old home either (grepped the
// whole repo before moving it) -- this is a relocation, not a rewire.
// Derived from the canonical catalogue rather than restated, so the set the
// dispatcher matches on and the set the gateway declares cannot drift apart.
const DATABASE_OPERATIONS = new Set(
  toolNamesInFamily("database").map((name) => name.slice("database.".length)),
);
const MAX_TOOL_OUTPUT_BYTES = 1_048_576;
// ENGINE-RESTRUCTURE-P4-1b: browser.* moved here from sandbox-service's
// SandboxService (createBrowserSession/navigateBrowser/clickBrowser/
// extractBrowser/closeBrowserSession) -- same real, tested logic
// (per-call tenant permission gate via resolveToolPermission, cost-event
// emission, 1MB bounded extract output), relocated to the component the
// architecture doc says owns external-tool integrations. Never had a real
// caller in its old home either (grepped the whole repo before moving it)
// -- this is a relocation, not a rewire. The tool_name strings are the
// exact literals SandboxService.#requireBrowserPermission already resolved
// tenant policy against, so existing per-tenant permission bindings stay
// valid unchanged.
const BROWSER_TOOL_NAMES = new Set<string>(toolNamesInFamily("browser"));
// ENGINE-RESTRUCTURE-P4-1b: reserved integration segment for the
// deterministic browser credential_ref template
// (`alter/{env}/tenant/{tenantId}/integration/browser-automation/session`).
// This is a deliberate, narrow exception to "every credential_ref resolves
// a real per-tenant secret": browser automation has no per-tenant
// credential concept at all -- the real Browserbase API key is one
// platform-wide secret, resolved once at startup into the provider below,
// never per call. The template exists only to satisfy invokeTool's
// existing format + tenant-ownership validation (the caller's own
// tenant_id is embedded by construction), and this segment name is how
// #resolveCredentialReference recognizes it and skips the otherwise-
// mandatory SecretsProvider.getSecret() call. Nothing else may use this
// integration segment name.
const BROWSER_AUTOMATION_INTEGRATION = "browser-automation";
// email.send: a real, new tool action, not a wiring fix. Free-text send
// (EmailProvider.sendEmail, SES's Content.Simple) rather than a new SES
// template -- see resolve-email-provider.ts and ses-email-provider.ts for
// why. Credential model follows the browser-automation precedent above
// exactly: the real SES identity is one platform-wide secret resolved
// once at startup into the provider below, never per call -- there is no
// per-tenant email-sending credential concept, same as browser
// automation's Browserbase key. This reserved integration segment name
// is how #resolveCredentialReference recognizes the deterministic
// email-send credential_ref template and skips the otherwise-mandatory
// SecretsProvider.getSecret() call, exactly like
// BROWSER_AUTOMATION_INTEGRATION above.
const EMAIL_SEND_TOOL_NAME = "email.send";
const EMAIL_SEND_INTEGRATION = "email-send";
const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// RFC 5322's own line-length convention for a header field -- a sane cap
// for a subject line, not an SES-imposed limit.
const MAX_EMAIL_SUBJECT_LENGTH = 998;
// ENGINE-RESTRUCTURE-P4-3: real Cache/Reuse cross-cutting layer wiring
// (architecture doc §12 RESTRUCTURE 3). 5 minutes balances real cost/
// latency savings on repeated identical queries against staleness risk
// for time-sensitive ones (news, prices) -- ponytail: fixed constant, add
// a per-query override only if a real caller ever needs one.
const SEARCH_CACHE_TTL_SECONDS = 5 * 60;

export class ToolGatewayService implements ToolgwHandler {
  readonly #credentialTokens = new Map<string, CredentialRecord>();
  readonly #rateLimits = new Map<string, RateLimitBucket>();
  readonly #artifacts = new Map<string, ArtifactRecord>();
  readonly #credentialTokenTtlMs: number;
  readonly #maxCredentialTokens: number;
  readonly #artifactTtlMs: number;
  readonly #maxArtifacts: number;
  readonly #now: () => Date;
  readonly #mintCredentialToken: () => string;
  readonly #mintId: () => string;
  readonly #mintCostEventId: () => string;

  constructor(
    private readonly configProvider: ConfigProvider,
    private readonly secretsProvider: SecretsProvider,
    private readonly searchProvider: SearchProvider,
    private readonly urlFetcher: SsrfGuardedFetcher,
    private readonly auditClient: AuditEventHandler,
    private readonly databaseProvider: DatabaseOperationProvider,
    private readonly costQueue: QueueProvider,
    private readonly costEventsQueueName: string,
    private readonly cacheProvider: CacheProvider,
    // ENGINE-RESTRUCTURE-P4-1b: the real browser automation provider
    // (BrowserbasePlaywrightProvider in production, constructed in main.ts
    // exactly like sandbox-service's createBrowserProvider did; mock under
    // RUNTIME_MODE=mock). Its API key is resolved once here at
    // startup from platform-wide config -- never per call.
    private readonly browserProvider: BrowserAutomationProvider,
    // email.send: the real EmailProvider (SesEmailProvider in production,
    // constructed in main.ts via the shared resolveEmailProvider(); mock
    // under RUNTIME_MODE=mock). Its SES identity is resolved once
    // here at startup from platform-wide config -- never per call, same
    // treatment as browserProvider above.
    private readonly emailProvider: EmailProvider,
    options: ToolGatewayServiceOptions = {},
  ) {
    this.#credentialTokenTtlMs =
      options.credentialTokenTtlMs ?? DEFAULT_CREDENTIAL_TOKEN_TTL_MS;
    this.#maxCredentialTokens =
      options.maxCredentialTokens ?? DEFAULT_MAX_CREDENTIAL_TOKENS;
    this.#artifactTtlMs = options.artifactTtlMs ?? DEFAULT_ARTIFACT_TTL_MS;
    this.#maxArtifacts = options.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS;
    this.#now = options.now ?? (() => new Date());
    this.#mintCredentialToken =
      options.mintCredentialToken ?? (() => `cred_${randomUUID()}`);
    this.#mintId = options.mintId ?? uuidV7;
    this.#mintCostEventId = options.mintCostEventId ?? createCostEventId;
  }

  async invokeTool(
    request: ToolgwInvokeToolRequest,
  ): Promise<ToolgwInvokeToolResponse> {
    try {
      validateInvokeToolRequest(request);
      const binding = await this.configProvider.resolveToolPermission({
        tenantId: request.tenant_id,
        toolName: request.tool_name,
      });
      try {
        ensureAllowed(binding, request.tool_name);
      } catch (error: unknown) {
        await this.#auditToolInvocation(request, "denied");
        throw error;
      }
      try {
        this.#enforceRateLimit(request.tenant_id, request.tool_name, binding);
      } catch (error: unknown) {
        await this.#auditToolInvocation(request, "denied");
        throw error;
      }
      await this.#resolveCredentialReference(
        request.credential_ref,
        request.tenant_id,
      );

      if (request.tool_name === SEARCH_WEB_TOOL_NAME) {
        const response = await this.#dispatchSearchWeb(request);
        await this.#auditToolInvocation(request, "success");
        return response;
      }

      if (isDatabaseToolName(request.tool_name)) {
        const input = parseDatabaseOperationInput(request.input_json);
        try {
          enforceDatabaseScope(binding, input.databaseId);
        } catch (error: unknown) {
          await this.#auditToolInvocation(request, "denied");
          throw error;
        }
        const response = await this.#dispatchDatabaseOperation(request, input);
        await this.#auditToolInvocation(request, "success");
        return response;
      }

      // ENGINE-RESTRUCTURE-P4-1b: no per-resource scope check beyond
      // ensureAllowed() above -- unlike database.* (where owning database X
      // must not imply database Y), browser automation has no per-resource
      // id concept to scope against; SandboxService's own gate was exactly
      // one resolveToolPermission call per tool_name.
      if (isBrowserToolName(request.tool_name)) {
        const response = await this.#dispatchBrowserTool(request);
        await this.#auditToolInvocation(request, "success");
        return response;
      }

      // No per-resource scope check beyond ensureAllowed() above -- same
      // reasoning as browser.* above: there is no per-resource id concept
      // to scope email.send against.
      if (request.tool_name === EMAIL_SEND_TOOL_NAME) {
        const response = await this.#dispatchEmail(request);
        await this.#auditToolInvocation(request, "success");
        return response;
      }

      // Audited like every other rejection path -- by this point the real
      // tenant credential has already been resolved above, so this rejection
      // is a credential-access event that must leave an audit trail.
      await this.#auditToolInvocation(request, "denied");
      // Two different failures used to share one message. A name outside the
      // canonical set is not a tool that is coming later -- it is not a tool,
      // and telling the caller "no real dispatch yet" invited them to wait for
      // one. Names are listed rather than globbed for the same reason as
      // before: neither browser.* nor database.* is a prefix match, so
      // browser.screenshot must not be refused by a message that appears to
      // promise it works.
      const dispatched = dispatchedToolNames().join(", ");
      throw new ToolGatewayNotImplementedError(
        isCanonicalToolName(request.tool_name)
          ? `Tool ${request.tool_name} is declared but has no dispatch yet; dispatched tools are: ${dispatched}`
          : `Tool ${request.tool_name} is not a tool this gateway offers; the tools it offers are: ${dispatched}`,
      );
    } catch (error: unknown) {
      if (error instanceof ToolGatewayNotImplementedError) {
        throw error;
      }
      if (
        error instanceof ToolGatewayPermissionError ||
        error instanceof ToolGatewayRateLimitError
      ) {
        throw error;
      }
      await this.#auditToolInvocation(request, "error");
      throw error;
    }
  }

  async #dispatchSearchWeb(
    request: ToolgwInvokeToolRequest,
  ): Promise<ToolgwInvokeToolResponse> {
    const input = parseSearchWebInput(request.input_json);
    const cacheKey = searchCacheKey(input);
    const cachedResultJson = await this.#lookupCacheBestEffort(cacheKey);
    if (cachedResultJson !== undefined) {
      return {
        output_json: cachedResultJson,
        audit_id: `aud_${this.#mintId()}`,
      };
    }
    const result = await this.searchProvider.search({
      tenantId: request.tenant_id,
      query: input.query,
      ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
    });
    const resultJson = JSON.stringify(result);
    await this.#storeCacheBestEffort(cacheKey, resultJson);
    return {
      output_json: resultJson,
      audit_id: `aud_${this.#mintId()}`,
    };
  }

  // ENGINE-RESTRUCTURE-P4-1b: ported from SandboxService's five browser
  // methods -- same #costed wrapper (success AND error cost events), same
  // provider-driven scope object, same 1MB output bound database.* uses.
  // click/close have no provider return value; their output_json is an
  // explicit empty object rather than a fabricated result.
  async #dispatchBrowserTool(
    request: ToolgwInvokeToolRequest,
  ): Promise<ToolgwInvokeToolResponse> {
    const input = parseBrowserToolInput(request.tool_name, request.input_json);
    // sandboxSessionId is a historical carryover from when these methods
    // lived in SandboxService (same treatment PR #39 gave the DEPLOYCTL_*
    // naming) -- kept for interface compatibility with both real and mock
    // BrowserAutomationProvider implementations. It is an opaque
    // caller-supplied session-correlation string that both providers use
    // for session-isolation enforcement (#assertScopeOwnedBy compares all
    // four scope fields and embeds it in Browserbase userMetadata), not a
    // claim that an E2B sandbox session exists.
    const scope: BrowserSessionScope = {
      tenantId: request.tenant_id,
      runId: request.run_id,
      nodeExecutionId: request.node_execution_id,
      sandboxSessionId: input.sessionId,
    };
    const outputJson = await this.#costed(
      request,
      {
        provider: this.browserProvider.metadata.providerId,
        resourceType: `tool_gateway.browser.${browserResourceName(request.tool_name)}`,
        units: 1,
      },
      async (): Promise<string> => {
        let output: unknown;
        switch (input.op) {
          case "create":
            output = await this.browserProvider.createSession(scope);
            break;
          case "navigate":
            output = await this.browserProvider.navigate(
              scope,
              input.browserSessionId,
              input.url,
            );
            break;
          case "click":
            await this.browserProvider.click(
              scope,
              input.browserSessionId,
              input.selector,
            );
            {
              const expected = input.expectedPageState;
              output = { confirmation: { status: "unconfirmed", reason: "No expected page state was declared for this click" } };
              if (expected !== undefined) {
                try {
                  const snapshot = await this.#costed(request, {
                    provider: this.browserProvider.metadata.providerId,
                    resourceType: "tool_gateway.browser.extract", units: 1,
                  }, () =>
                    this.browserProvider.extract(scope, input.browserSessionId, expected.selector));
                  // extract(selector) succeeds only after that element exists; it may have no text.
                  const matched = expected.text === undefined || snapshot.text.includes(expected.text);
                  output = { snapshot, confirmation: matched
                    ? { status: "confirmed", basis: "post-click snapshot matched expected page state" }
                    : { status: "failed", reason: "post-click snapshot did not match expected page state" } };
                } catch {
                  // The click has already happened. Return its unknown outcome without retrying it.
                  output = { confirmation: { status: "unconfirmed", reason: "Click completed but expected page state could not be read" } };
                }
              }
            }
            break;
          case "extract":
            output = await this.browserProvider.extract(
              scope,
              input.browserSessionId,
              input.selector,
            );
            break;
          case "close":
            await this.browserProvider.closeSession(
              scope,
              input.browserSessionId,
            );
            output = {};
            break;
        }
        const json = JSON.stringify(output);
        if (Buffer.byteLength(json, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
          throw new ToolGatewayValidationError(
            "Browser tool output exceeds the tool-gateway output limit",
          );
        }
        return json;
      },
    );
    return {
      output_json: outputJson,
      audit_id: `aud_${this.#mintId()}`,
    };
  }

  // Real, new tool action, not a wiring fix: EmailProvider.sendEmail
  // (SES's Content.Simple, see ses-email-provider.ts) rather than a new
  // SES template. Same #costed wrapper and MAX_TOOL_OUTPUT_BYTES bound
  // database.*/browser.* already use.
  async #dispatchEmail(
    request: ToolgwInvokeToolRequest,
  ): Promise<ToolgwInvokeToolResponse> {
    const input = parseEmailSendInput(request.input_json);
    const outputJson = await this.#costed(
      request,
      {
        provider: this.emailProvider.metadata.providerId,
        resourceType: `tool_gateway.${EMAIL_SEND_TOOL_NAME}`,
        units: 1,
      },
      async (): Promise<string> => {
        const result = await this.emailProvider.sendEmail(
          input.to,
          input.subject,
          input.body,
          {
            ...(input.html === undefined ? {} : { html: input.html }),
            tenantId: request.tenant_id,
          },
        );
        const json = JSON.stringify(result);
        if (Buffer.byteLength(json, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
          throw new ToolGatewayValidationError(
            "Email send output exceeds the tool-gateway output limit",
          );
        }
        return json;
      },
    );
    return {
      output_json: outputJson,
      audit_id: `aud_${this.#mintId()}`,
    };
  }

  // ENGINE-RESTRUCTURE-P4-3: cache is acceleration only, never a hard
  // dependency -- a cache outage must fall through to (or not block) a
  // real search, exactly the same fail-open contract model-gateway's own
  // semantic cache and Blackboard's hot-context cache already use.
  async #lookupCacheBestEffort(key: string): Promise<string | undefined> {
    try {
      return await this.cacheProvider.getValue(key);
    } catch {
      return undefined;
    }
  }

  async #storeCacheBestEffort(key: string, valueJson: string): Promise<void> {
    try {
      await this.cacheProvider.setValue(key, valueJson, SEARCH_CACHE_TTL_SECONDS);
    } catch {
      // A cache write failure must never turn an otherwise-successful
      // search into an error.
    }
  }

  async #dispatchDatabaseOperation(
    request: ToolgwInvokeToolRequest,
    input: DatabaseOperationInput,
  ): Promise<ToolgwInvokeToolResponse> {
    const operation = databaseOperationFromToolName(request.tool_name);
    assertDatabaseCredentialOwnedBy(
      request.credential_ref,
      request.tenant_id,
      input.databaseId,
    );
    const result = await this.#costed(
      request,
      {
        provider: this.databaseProvider.providerId,
        resourceType: `tool_gateway.database.${operation}`,
        units: 1,
      },
      async (): Promise<DatabaseOperationResult> => {
        const executed = await this.databaseProvider.execute({
          credentialReference: request.credential_ref,
          databaseId: input.databaseId,
          operation,
          statement: input.statement,
          parameters: input.parameters,
        });
        const outputJson = JSON.stringify(executed);
        if (Buffer.byteLength(outputJson, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
          throw new ToolGatewayValidationError(
            "Database operation output exceeds the tool-gateway output limit",
          );
        }
        return executed;
      },
    );
    return {
      output_json: JSON.stringify(result),
      audit_id: `aud_${this.#mintId()}`,
    };
  }

  async #costed<T>(
    request: ToolgwInvokeToolRequest,
    usage: CostUsage,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await operation();
      await this.#emitCostEventBestEffort(request, usage, "success");
      return result;
    } catch (error: unknown) {
      await this.#emitCostEventBestEffort(request, usage, "error");
      throw error;
    }
  }

  async #emitCostEventBestEffort(
    request: ToolgwInvokeToolRequest,
    usage: CostUsage,
    outcome: "success" | "error",
  ): Promise<void> {
    const event = {
      tenant_id: request.tenant_id,
      cost_event_id: this.#mintCostEventId(),
      run_id: request.run_id,
      node_execution_id: request.node_execution_id,
      provider_reference: usage.provider,
      usage_json: JSON.stringify({
        resource_type: usage.resourceType,
        provider: usage.provider,
        units: usage.units,
        outcome,
      }),
      amount_json: JSON.stringify({ usd: 0, estimated: true }),
      // Real cost_events.source CHECK constraint value for this service
      // (matches "model_gateway"/"sandbox"/"storage"/"browser" siblings).
      source: "tool_gateway",
      occurred_at: this.#now().toISOString(),
    } satisfies Readonly<Record<string, JsonValue>>;
    try {
      await this.costQueue.publish(this.costEventsQueueName, event);
    } catch {
      // Match Sandbox/Model Gateway telemetry pattern: queue outage cannot
      // turn an otherwise valid tool result into an execution failure.
    }
  }

  async #auditToolInvocation(
    request: ToolgwInvokeToolRequest,
    result: "success" | "denied" | "error",
  ): Promise<void> {
    await this.#recordAuditEventBestEffort({
      tenant_id: request.tenant_id,
      actor_type: "service",
      actor_ref: "tool-gateway",
      action: "tool.invoke",
      target_type: "tool",
      target_ref: request.tool_name,
      result,
      reason_code: "",
      context_json: JSON.stringify({
        runId: request.run_id,
        nodeExecutionId: request.node_execution_id,
      }),
      occurred_at: this.#now().toISOString(),
    });
  }

  async #recordAuditEventBestEffort(request: {
    readonly tenant_id: string;
    readonly actor_type: "service";
    readonly actor_ref: string;
    readonly action: string;
    readonly target_type: string;
    readonly target_ref: string;
    readonly result: "success" | "denied" | "error";
    readonly reason_code: string;
    readonly context_json: string;
    readonly occurred_at: string;
  }): Promise<void> {
    try {
      await this.auditClient.recordEvent(request);
    } catch {
      // Audit logging is best-effort: a full or unreachable audit-service
      // must never block a legitimate tool-gateway decision that already
      // completed its own authorization/rate-limit/dispatch logic.
    }
  }

  async resolveCredential(
    request: ToolgwResolveCredentialRequest,
  ): Promise<ToolgwResolveCredentialResponse> {
    try {
      validateResolveCredentialRequest(request);
      assertCredentialReferenceOwnedBy(
        request.credential_ref,
        request.tenant_id,
        request.integration_id,
      );
      const secretValue = await this.secretsProvider.getSecret(
        request.credential_ref,
      );
      const { expiresAtMs, token } = this.#mintCredentialRecord({
        secretValue,
        tenantId: request.tenant_id,
        integrationId: request.integration_id,
      });
      await this.#auditCredentialResolution(request, "success");
      return {
        resolved_reference: token,
        expires_at: new Date(expiresAtMs).toISOString(),
      };
    } catch (error: unknown) {
      await this.#auditCredentialResolution(request, "error");
      throw error;
    }
  }

  async #auditCredentialResolution(
    request: ToolgwResolveCredentialRequest,
    result: "success" | "denied" | "error",
  ): Promise<void> {
    await this.#recordAuditEventBestEffort({
      tenant_id: request.tenant_id,
      actor_type: "service",
      actor_ref: "tool-gateway",
      action: "credential.resolve",
      target_type: "integration",
      target_ref: request.integration_id,
      result,
      reason_code: "",
      context_json: "{}",
      occurred_at: this.#now().toISOString(),
    });
  }

  async fetchUrl(
    request: ToolgwFetchUrlRequest,
  ): Promise<ToolgwFetchUrlResponse> {
    try {
      validateFetchUrlRequest(request);
      const { statusCode, body } = await this.urlFetcher.fetch(request.url);
      const artifactId = this.#storeArtifact(body);
      await this.#auditFetchUrl(request, "success");
      return { status_code: statusCode, content_artifact_id: artifactId };
    } catch (error: unknown) {
      await this.#auditFetchUrl(
        request,
        error instanceof SsrfBlockedError ? "denied" : "error",
      );
      throw error;
    }
  }

  async #auditFetchUrl(
    request: ToolgwFetchUrlRequest,
    result: "success" | "denied" | "error",
  ): Promise<void> {
    await this.#recordAuditEventBestEffort({
      tenant_id: request.tenant_id,
      actor_type: "service",
      actor_ref: "tool-gateway",
      action: "url.fetch",
      target_type: "url",
      target_ref: request.url,
      result,
      reason_code: "",
      context_json: JSON.stringify({
        runId: request.run_id,
        nodeExecutionId: request.node_execution_id,
      }),
      occurred_at: this.#now().toISOString(),
    });
  }

  #storeArtifact(body: ArrayBuffer): string {
    this.#sweepExpiredArtifacts();
    if (this.#artifacts.size >= this.#maxArtifacts) {
      const oldest = this.#oldestArtifactId();
      if (oldest !== undefined) {
        this.#artifacts.delete(oldest);
      }
    }
    const artifactId = `art_${this.#mintId()}`;
    this.#artifacts.set(artifactId, {
      body,
      expiresAtMs: this.#now().getTime() + this.#artifactTtlMs,
    });
    return artifactId;
  }

  #oldestArtifactId(): string | undefined {
    let oldestId: string | undefined;
    let oldestExpiresAtMs = Number.POSITIVE_INFINITY;
    for (const [id, record] of this.#artifacts.entries()) {
      if (record.expiresAtMs < oldestExpiresAtMs) {
        oldestId = id;
        oldestExpiresAtMs = record.expiresAtMs;
      }
    }
    return oldestId;
  }

  #sweepExpiredArtifacts(): void {
    const nowMs = this.#now().getTime();
    for (const [id, record] of this.#artifacts.entries()) {
      if (record.expiresAtMs <= nowMs) {
        this.#artifacts.delete(id);
      }
    }
  }

  #enforceRateLimit(
    tenantId: string,
    toolName: string,
    binding: ToolPermissionBinding,
  ): void {
    const nowMs = this.#now().getTime();
    const key = `${tenantId}:${toolName}`;
    const bucket = this.#rateLimits.get(key);
    if (
      bucket === undefined ||
      nowMs - bucket.windowStartedAtMs >= RATE_LIMIT_WINDOW_MS
    ) {
      this.#rateLimits.set(key, { windowStartedAtMs: nowMs, count: 1 });
      return;
    }
    bucket.count += 1;
    if (bucket.count > binding.rateLimitPerMinute) {
      throw new ToolGatewayRateLimitError(
        `Rate limit exceeded for tool ${toolName}`,
      );
    }
  }

  async #resolveCredentialReference(
    reference: string,
    tenantId: string,
  ): Promise<void> {
    this.#sweepExpiredCredentialTokens();
    const record = this.#credentialTokens.get(reference);
    if (record === undefined) {
      if (reference.startsWith(OPAQUE_CREDENTIAL_TOKEN_PREFIX)) {
        throw new ToolGatewayValidationError(
          "Credential token is not recognized",
        );
      }
      assertCredentialReferenceOwnedBy(reference, tenantId);
      // ENGINE-RESTRUCTURE-P4-1b: deliberate, narrow exception to "every
      // raw credential_ref resolves a real secret" -- see the
      // BROWSER_AUTOMATION_INTEGRATION constant comment. Format and
      // tenant-ownership have already been validated above; what is
      // skipped is only the SecretsProvider.getSecret() call, because no
      // per-tenant browser-automation secret exists or needs to.
      if (
        isBrowserAutomationCredentialReference(reference) ||
        isEmailSendCredentialReference(reference)
      ) {
        return;
      }
      await this.#resolveRawSecretReference(reference, tenantId);
      return;
    }
    if (record.expiresAtMs <= this.#now().getTime()) {
      this.#credentialTokens.delete(reference);
      throw new ToolGatewayValidationError("Credential token expired");
    }
    if (record.tenantId !== tenantId) {
      throw new ToolGatewayValidationError(
        "Credential token is not owned by this tenant",
      );
    }
    // Real credential exists only in memory so later GATE-8 dispatch can use it
    // without accepting raw secrets over gRPC.
    void record.secretValue;
    return;
  }

  #mintCredentialRecord(record: {
    readonly secretValue: string;
    readonly tenantId: string;
    readonly integrationId?: string;
  }): {
    readonly expiresAtMs: number;
    readonly token: string;
  } {
    this.#evictCredentialTokensIfNeeded();
    const expiresAtMs = this.#now().getTime() + this.#credentialTokenTtlMs;
    const token = this.#mintUniqueCredentialToken();
    this.#credentialTokens.set(token, { ...record, expiresAtMs });
    return { expiresAtMs, token };
  }

  async #resolveRawSecretReference(
    reference: string,
    tenantId: string,
  ): Promise<void> {
    const secretValue = await this.secretsProvider.getSecret(reference);
    this.#mintCredentialRecord({ secretValue, tenantId });
  }

  #mintUniqueCredentialToken(): string {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = this.#mintCredentialToken();
      if (!this.#credentialTokens.has(token)) {
        return token;
      }
    }
    throw new Error("Could not mint a unique credential token");
  }

  #evictCredentialTokensIfNeeded(): void {
    this.#sweepExpiredCredentialTokens();
    if (this.#credentialTokens.size < this.#maxCredentialTokens) {
      return;
    }
    let oldestToken: string | undefined;
    let oldestExpiresAtMs = Number.POSITIVE_INFINITY;
    for (const [token, record] of this.#credentialTokens.entries()) {
      if (record.expiresAtMs < oldestExpiresAtMs) {
        oldestToken = token;
        oldestExpiresAtMs = record.expiresAtMs;
      }
    }
    if (oldestToken !== undefined) {
      this.#credentialTokens.delete(oldestToken);
    }
  }

  #sweepExpiredCredentialTokens(): void {
    const nowMs = this.#now().getTime();
    for (const [token, record] of this.#credentialTokens.entries()) {
      if (record.expiresAtMs <= nowMs) {
        this.#credentialTokens.delete(token);
      }
    }
  }
}

function uuidV7(): string {
  const uuid = randomUUID();
  return `${uuid.slice(0, 14)}7${uuid.slice(15)}`;
}

function ensureAllowed(
  binding: ToolPermissionBinding,
  toolName: string,
): void {
  if (!binding.allowed) {
    throw new ToolGatewayPermissionError(
      `Tool ${toolName} is not permitted for this tenant`,
    );
  }
  if (
    !Number.isInteger(binding.rateLimitPerMinute) ||
    binding.rateLimitPerMinute < 1
  ) {
    throw new ToolGatewayValidationError(
      "Tool permission rateLimitPerMinute must be a positive integer",
    );
  }
}

function validateInvokeToolRequest(request: ToolgwInvokeToolRequest): void {
  requireNonEmpty(request.tenant_id, "tenant_id");
  requireNonEmpty(request.run_id, "run_id");
  requireNonEmpty(request.node_execution_id, "node_execution_id");
  requireNonEmpty(request.tool_name, "tool_name");
  requireNonEmpty(request.input_json, "input_json");
  requireNonEmpty(request.credential_ref, "credential_ref");
  try {
    JSON.parse(request.input_json);
  } catch {
    throw new ToolGatewayValidationError("input_json must be valid JSON");
  }
}

function validateResolveCredentialRequest(
  request: ToolgwResolveCredentialRequest,
): void {
  requireNonEmpty(request.tenant_id, "tenant_id");
  requireNonEmpty(request.integration_id, "integration_id");
  requireNonEmpty(request.credential_ref, "credential_ref");
}

function validateFetchUrlRequest(request: ToolgwFetchUrlRequest): void {
  requireNonEmpty(request.tenant_id, "tenant_id");
  requireNonEmpty(request.run_id, "run_id");
  requireNonEmpty(request.node_execution_id, "node_execution_id");
  requireNonEmpty(request.url, "url");
  try {
    // eslint-disable-next-line no-new -- validates the URL is well-formed
    new URL(request.url);
  } catch {
    throw new ToolGatewayValidationError("url must be a valid absolute URL");
  }
}

interface SearchWebInput {
  readonly query: string;
  readonly maxResults?: number;
}

// ENGINE-RESTRUCTURE-P4-3: deliberately NOT tenant-scoped. search.web
// results are public web content, not tenant-owned data -- two tenants
// issuing the identical query get the identical, already-public results
// faster, with no cross-tenant information exposure in either direction
// (the cache key is derived only from the query text itself). Hashed
// rather than embedded raw so an arbitrarily long/unusual query never
// produces an invalid or awkward-to-inspect Redis key.
function searchCacheKey(input: SearchWebInput): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ query: input.query, maxResults: input.maxResults ?? null }))
    .digest("hex");
  return `search.web:${hash}`;
}

function parseSearchWebInput(inputJson: string): SearchWebInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    throw new ToolGatewayValidationError("input_json must be valid JSON");
  }
  const record = parsed as { readonly query?: unknown; readonly maxResults?: unknown };
  if (typeof record.query !== "string" || record.query.trim().length === 0) {
    throw new ToolGatewayValidationError(
      "search.web input_json must include a non-empty query string",
    );
  }
  if (
    record.maxResults !== undefined &&
    (typeof record.maxResults !== "number" ||
      !Number.isInteger(record.maxResults) ||
      record.maxResults < 1)
  ) {
    throw new ToolGatewayValidationError(
      "search.web input_json maxResults, if present, must be a positive integer",
    );
  }
  return {
    query: record.query,
    ...(record.maxResults === undefined
      ? {}
      : { maxResults: record.maxResults }),
  };
}

// ENGINE-RESTRUCTURE-P4-1: ported verbatim from SandboxService's own
// inline scope check inside executeDatabaseOperation -- ensureAllowed()
// above only confirms the tenant may use database.* tools AT ALL; this is
// a stricter, per-database check on top (a tenant permitted for database X
// is not automatically permitted for database Y just because both share
// the same tool_name family). Real, load-bearing: sandbox.service.spec.ts
// had a dedicated test proving a requiredScopes mismatch denies a request
// tool_name-level ensureAllowed() would otherwise pass.
function enforceDatabaseScope(
  binding: ToolPermissionBinding,
  databaseId: string,
): void {
  const databaseScope = `database:${databaseId}`;
  if (
    !binding.requiredScopes.includes(databaseScope) &&
    !binding.requiredScopes.includes("database:*")
  ) {
    throw new ToolGatewayPermissionError(
      `Database operation is not permitted for database "${databaseId}"`,
    );
  }
}

function isDatabaseToolName(toolName: string): boolean {
  const operation = toolName.startsWith("database.")
    ? toolName.slice("database.".length)
    : undefined;
  return operation !== undefined && DATABASE_OPERATIONS.has(operation);
}

// ENGINE-RESTRUCTURE-P4-1b: exact tool_name literals SandboxService's
// #requireBrowserPermission already resolved tenant policy against.
function isBrowserToolName(toolName: string): boolean {
  return BROWSER_TOOL_NAMES.has(toolName);
}

function browserResourceName(
  toolName: string,
): "create" | "navigate" | "click" | "extract" | "close" {
  switch (toolName) {
    case "browser.session.create":
      return "create";
    case "browser.navigate":
      return "navigate";
    case "browser.click":
      return "click";
    case "browser.extract":
      return "extract";
    case "browser.session.close":
      return "close";
    default:
      throw new ToolGatewayValidationError(
        `Browser tool name "${toolName}" does not name a supported operation`,
      );
  }
}

type BrowserToolInput =
  | { readonly op: "create"; readonly sessionId: string }
  | {
      readonly op: "navigate";
      readonly sessionId: string;
      readonly browserSessionId: string;
      readonly url: string;
    }
  | {
      readonly op: "click";
      readonly sessionId: string;
      readonly browserSessionId: string;
      readonly selector: string;
      readonly expectedPageState?: { readonly text?: string; readonly selector?: string };
    }
  | {
      readonly op: "extract";
      readonly sessionId: string;
      readonly browserSessionId: string;
      readonly selector?: string;
    }
  | {
      readonly op: "close";
      readonly sessionId: string;
      readonly browserSessionId: string;
    };

// session_id is the opaque sandboxSessionId correlation string (historical
// field name, see #dispatchBrowserTool); browser_session_id is the id
// returned by a previous browser.session.create call.
function parseBrowserToolInput(
  toolName: string,
  inputJson: string,
): BrowserToolInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    throw new ToolGatewayValidationError("input_json must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolGatewayValidationError("input_json must be an object");
  }
  const record = parsed as { readonly [key: string]: unknown };
  const requireString = (field: string): string => {
    const value = record[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ToolGatewayValidationError(
        `${toolName} input_json must include a non-empty ${field} string`,
      );
    }
    return value;
  };
  const optionalString = (
    field: string,
  ): string | undefined => {
    const value = record[field];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ToolGatewayValidationError(
        `${toolName} input_json ${field}, if present, must be a non-empty string`,
      );
    }
    return value;
  };
  const optionalExpectedPageState = (): { readonly text?: string; readonly selector?: string } | undefined => {
    const value = record["expected_page_state"];
    if (value === undefined) return undefined;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new ToolGatewayValidationError("browser.click expected_page_state must be an object");
    }
    const state = value as Record<string, unknown>;
    if (Object.keys(state).some(key => key !== "text" && key !== "selector")) {
      throw new ToolGatewayValidationError("browser.click expected_page_state only accepts text or selector");
    }
    const text = state.text === undefined ? undefined : optionalStringValue(state.text, "expected_page_state.text");
    const selector = state.selector === undefined ? undefined : optionalStringValue(state.selector, "expected_page_state.selector");
    if (text === undefined && selector === undefined) {
      throw new ToolGatewayValidationError("browser.click expected_page_state needs text or selector");
    }
    return { ...(text === undefined ? {} : { text }), ...(selector === undefined ? {} : { selector }) };
  };
  const sessionId = requireString("session_id");
  switch (toolName) {
    case "browser.session.create":
      return { op: "create", sessionId };
    case "browser.navigate":
      return {
        op: "navigate",
        sessionId,
        browserSessionId: requireString("browser_session_id"),
        url: requireString("url"),
      };
    case "browser.click": {
      const expectedPageState = optionalExpectedPageState();
      return {
        op: "click",
        sessionId,
        browserSessionId: requireString("browser_session_id"),
        selector: requireString("selector"),
        ...(expectedPageState === undefined ? {} : { expectedPageState }),
      };
    }
    case "browser.extract": {
      const selector = optionalString("selector");
      return {
        op: "extract",
        sessionId,
        browserSessionId: requireString("browser_session_id"),
        ...(selector === undefined ? {} : { selector }),
      };
    }
    case "browser.session.close":
      return {
        op: "close",
        sessionId,
        browserSessionId: requireString("browser_session_id"),
      };
    default:
      throw new ToolGatewayValidationError(
        `Browser tool name "${toolName}" does not name a supported operation`,
      );
  }
}

function optionalStringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolGatewayValidationError(`${field}, if present, must be a non-empty string`);
  }
  return value;
}

// ENGINE-RESTRUCTURE-P4-1b: recognizes the reserved deterministic
// browser credential template. Ownership/format validation is the
// caller's job (#resolveCredentialReference runs
// assertCredentialReferenceOwnedBy first).
function isBrowserAutomationCredentialReference(reference: string): boolean {
  const ownership = parseTenantIntegrationSecretReference(reference);
  return (
    ownership !== undefined &&
    ownership.integrationId === BROWSER_AUTOMATION_INTEGRATION
  );
}

// Same reserved-template exception as isBrowserAutomationCredentialReference
// above, for the same reason: there is no per-tenant email-sending
// credential, only one platform-wide SES identity resolved at startup.
function isEmailSendCredentialReference(reference: string): boolean {
  const ownership = parseTenantIntegrationSecretReference(reference);
  return (
    ownership !== undefined && ownership.integrationId === EMAIL_SEND_INTEGRATION
  );
}

interface EmailSendInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly html?: boolean;
}

function parseEmailSendInput(inputJson: string): EmailSendInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    throw new ToolGatewayValidationError("input_json must be valid JSON");
  }
  const record = parsed as {
    readonly to?: unknown;
    readonly subject?: unknown;
    readonly body?: unknown;
    readonly html?: unknown;
  };
  if (typeof record.to !== "string" || !EMAIL_ADDRESS_PATTERN.test(record.to)) {
    throw new ToolGatewayValidationError(
      "email.send input_json must include a valid to email address",
    );
  }
  if (typeof record.subject !== "string" || record.subject.trim().length === 0) {
    throw new ToolGatewayValidationError(
      "email.send input_json must include a non-empty subject string",
    );
  }
  if (record.subject.length > MAX_EMAIL_SUBJECT_LENGTH) {
    throw new ToolGatewayValidationError(
      `email.send input_json subject must be at most ${MAX_EMAIL_SUBJECT_LENGTH} characters`,
    );
  }
  if (typeof record.body !== "string" || record.body.trim().length === 0) {
    throw new ToolGatewayValidationError(
      "email.send input_json must include a non-empty body string",
    );
  }
  if (record.html !== undefined && typeof record.html !== "boolean") {
    throw new ToolGatewayValidationError(
      "email.send input_json html, if present, must be a boolean",
    );
  }
  // Checkable client-side before ever calling the provider, rather than
  // relying solely on SesEmailProvider's own runtime error for something
  // this cheap to validate up front -- same declared limit
  // (SES_EMAIL_CAPABILITIES.maximum_payload), checked at both layers.
  const combinedBytes =
    Buffer.byteLength(record.subject, "utf8") + Buffer.byteLength(record.body, "utf8");
  if (combinedBytes > SES_EMAIL_CAPABILITIES.maximum_payload) {
    throw new ToolGatewayValidationError(
      `email.send input_json subject+body (${combinedBytes} bytes) exceeds the maximum payload of ${SES_EMAIL_CAPABILITIES.maximum_payload} bytes`,
    );
  }
  return {
    to: record.to,
    subject: record.subject,
    body: record.body,
    ...(record.html === undefined ? {} : { html: record.html }),
  };
}

function databaseOperationFromToolName(
  toolName: string,
): "select" | "insert" | "update" | "delete" {
  const operation = toolName.slice("database.".length);
  if (!DATABASE_OPERATIONS.has(operation)) {
    throw new ToolGatewayValidationError(
      `Database tool name "${toolName}" does not name a supported operation`,
    );
  }
  return operation as "select" | "insert" | "update" | "delete";
}

interface DatabaseOperationInput {
  readonly databaseId: string;
  readonly statement: string;
  readonly parameters: readonly JsonValue[];
}

function parseDatabaseOperationInput(inputJson: string): DatabaseOperationInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch {
    throw new ToolGatewayValidationError("input_json must be valid JSON");
  }
  const record = parsed as {
    readonly databaseId?: unknown;
    readonly statement?: unknown;
    readonly parameters?: unknown;
  };
  if (typeof record.databaseId !== "string" || record.databaseId.trim().length === 0) {
    throw new ToolGatewayValidationError(
      "database.* input_json must include a non-empty databaseId string",
    );
  }
  if (typeof record.statement !== "string" || record.statement.trim().length === 0) {
    throw new ToolGatewayValidationError(
      "database.* input_json must include a non-empty statement string",
    );
  }
  if (record.parameters !== undefined && !Array.isArray(record.parameters)) {
    throw new ToolGatewayValidationError(
      "database.* input_json parameters, if present, must be an array",
    );
  }
  return {
    databaseId: record.databaseId,
    statement: record.statement,
    parameters: (record.parameters ?? []) as readonly JsonValue[],
  };
}

// ENGINE-RESTRUCTURE-P4-1: ported verbatim from SandboxService's own
// #assertDatabaseCredentialOwnedBy -- stricter than the generic
// assertCredentialReferenceOwnedBy below (which only confirms the
// credential belongs to SOME integration owned by this tenant): this also
// confirms the credential's own integration segment names the EXACT
// databaseId being operated on, not just any integration this tenant owns.
function assertDatabaseCredentialOwnedBy(
  reference: string,
  tenantId: string,
  databaseId: string,
): void {
  const segments = reference.split("/").filter(Boolean);
  if (
    segments.length < 7 ||
    segments[0] !== "alter" ||
    segments[2] !== "tenant" ||
    segments[3] !== tenantId ||
    segments[4] !== "integration" ||
    segments[5] !== databaseId
  ) {
    throw new ToolGatewayValidationError(
      "credential_ref is not owned by this tenant/database",
    );
  }
}

function assertCredentialReferenceOwnedBy(
  credentialRef: string,
  tenantId: string,
  integrationId?: string,
): void {
  const ownership = parseTenantIntegrationSecretReference(credentialRef);
  if (ownership === undefined) {
    throw new ToolGatewayValidationError(
      "credential_ref must be a tenant integration secret reference",
    );
  }
  if (
    ownership.tenantId !== tenantId ||
    (integrationId !== undefined && ownership.integrationId !== integrationId)
  ) {
    throw new ToolGatewayValidationError(
      "credential_ref is not owned by this tenant/integration",
    );
  }
}

function parseTenantIntegrationSecretReference(
  credentialRef: string,
):
  | {
      readonly tenantId: string;
      readonly integrationId: string;
    }
  | undefined {
  const segments = credentialRef.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length < 7 ||
    segments[0] !== "alter" ||
    segments[2] !== "tenant" ||
    segments[4] !== "integration"
  ) {
    return undefined;
  }
  const tenantSegment = segments[3];
  const integrationSegment = segments[5];
  if (tenantSegment === undefined || integrationSegment === undefined) {
    return undefined;
  }
  return {
    tenantId: tenantSegment,
    integrationId: integrationSegment,
  };
}

function requireNonEmpty(value: string | undefined, field: string): void {
  // gRPC delivers an unset string as undefined rather than "", so this has to
  // accept both. Dereferencing undefined threw TypeError before the validator
  // could raise its own error, and the transport reported that as a generic
  // INTERNAL -- so a caller omitting a field was told the tool invocation had
  // failed rather than which field was missing. credential_ref is the one that
  // surfaces it, being the field callers most often leave out.
  if (!value?.trim()) {
    throw new ToolGatewayValidationError(`${field} is required`);
  }
}
