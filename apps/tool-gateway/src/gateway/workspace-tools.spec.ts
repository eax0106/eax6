import { describe, expect, it, vi } from "vitest";
import { ToolGatewayCredentialMissingError, ToolGatewayValidationError, type AdsQueryHandlerClient } from "@alterx/adapters";
import type { RunScope } from "@alterx/contracts";

import {
  adsKnowledgeSearch,
  connectedWhatsappSend,
  httpRunScopeResolver,
  parseKnowledgeSearchInput,
  parseWhatsappSendInput,
  type RunScopeResolver,
  type WhatsappTextSender,
} from "./workspace-tools";

const TENANT = "ten_018f47a2-7b11-7b11-8a11-1234567890ab";
const RUN = "run_018f47a2-7b11-7b11-8a11-1234567890ab";
const WORKSPACE = "018f47a2-7b11-7b11-8a11-1234567890cd";

const ACCOUNT_A = { account_id: "acc-a", phone_number_id: "111", access_token_ref: "/alter/prod/tenant/t/connection/a/token" };
const ACCOUNT_B = { account_id: "acc-b", phone_number_id: "222", access_token_ref: "/alter/prod/tenant/t/connection/b/token" };

function scope(accounts: RunScope["whatsapp_accounts"] = [ACCOUNT_A]): RunScope {
  return { workspace_id: WORKSPACE, whatsapp_accounts: accounts };
}

describe("parseKnowledgeSearchInput", () => {
  it("defaults topK to 5 and trims the query", () => {
    expect(parseKnowledgeSearchInput(JSON.stringify({ query: "  refund policy " }))).toEqual({ query: "refund policy", topK: 5 });
  });

  it.each([
    ["not json", "{bad"],
    ["an array", "[]"],
    ["an empty query", JSON.stringify({ query: "  " })],
    ["a missing query", JSON.stringify({})],
    ["an over-long query", JSON.stringify({ query: "x".repeat(2001) })],
    ["topK zero", JSON.stringify({ query: "a", topK: 0 })],
    ["topK eleven", JSON.stringify({ query: "a", topK: 11 })],
    ["a fractional topK", JSON.stringify({ query: "a", topK: 2.5 })],
    ["a workspace in the input", JSON.stringify({ query: "a", workspace_id: WORKSPACE })],
  ])("rejects %s", (_name, json) => {
    expect(() => parseKnowledgeSearchInput(json)).toThrow(ToolGatewayValidationError);
  });
});

describe("parseWhatsappSendInput", () => {
  it("strips a leading plus and keeps the optional phone number id", () => {
    expect(parseWhatsappSendInput(JSON.stringify({ to: "+919876543210", text: " hi ", phoneNumberId: "111" }))).toEqual({
      to: "919876543210", text: "hi", phoneNumberId: "111",
    });
  });

  it.each([
    ["a short number", { to: "12345", text: "hi" }],
    ["a number with letters", { to: "9198765abcde", text: "hi" }],
    ["empty text", { to: "919876543210", text: " " }],
    ["over-long text", { to: "919876543210", text: "x".repeat(4097) }],
    ["a bad phone number id", { to: "919876543210", text: "hi", phoneNumberId: "abc" }],
    ["an unknown field", { to: "919876543210", text: "hi", token: "x" }],
  ])("rejects %s", (_name, input) => {
    expect(() => parseWhatsappSendInput(JSON.stringify(input))).toThrow(ToolGatewayValidationError);
  });
});

describe("httpRunScopeResolver", () => {
  it("posts the lookup with the service token and parses the scope", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(scope()), { status: 200 }));
    const result = await httpRunScopeResolver("http://engine.test", "svc-token", fetchImpl)({ tenant_id: TENANT, run_id: RUN });

    expect(result.workspace_id).toBe(WORKSPACE);
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("http://engine.test/internal/connections/run-scope");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer svc-token");
    expect(JSON.parse(init.body as string)).toEqual({ tenant_id: TENANT, run_id: RUN });
  });

  it("turns 404 into a validation error and other failures into a plain error", async () => {
    const lookup = { tenant_id: TENANT, run_id: RUN };
    await expect(httpRunScopeResolver("http://e", "t", async () => new Response("", { status: 404 }))(lookup)).rejects.toBeInstanceOf(ToolGatewayValidationError);
    await expect(httpRunScopeResolver("http://e", "t", async () => new Response("", { status: 500 }))(lookup)).rejects.toThrow("Run scope lookup failed");
  });

  it("rejects a malformed scope body", async () => {
    const bad = httpRunScopeResolver("http://e", "t", async () => new Response(JSON.stringify({ workspace_id: "nope" }), { status: 200 }));
    await expect(bad({ tenant_id: TENANT, run_id: RUN })).rejects.toThrow();
  });
});

describe("adsKnowledgeSearch", () => {
  function ads(retrieve: AdsQueryHandlerClient["retrieve"]): AdsQueryHandlerClient {
    return { retrieve } as AdsQueryHandlerClient;
  }

  it("searches the workspace the engine names, never one from the input", async () => {
    const retrieve = vi.fn(async () => [
      { document_id: "doc-1", context: "Refunds within 30 days.", score: 0.9, provenance_json: JSON.stringify({ document: { title: "Policy" } }) },
      { document_id: "doc-2", context: "Shipping is free.", score: 0.4, provenance_json: "not json" },
    ]);
    const resolve: RunScopeResolver = vi.fn(async () => scope());

    const results = await adsKnowledgeSearch(resolve, ads(retrieve as unknown as AdsQueryHandlerClient["retrieve"])).search({ tenantId: TENANT, runId: RUN }, { query: "refund", topK: 3 });

    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT, workspace_id: `ws_${WORKSPACE}`, query: "refund", top_k: 3 }));
    expect(results).toEqual([
      { documentId: "doc-1", title: "Policy", text: "Refunds within 30 days.", score: 0.9 },
      { documentId: "doc-2", title: null, text: "Shipping is free.", score: 0.4 },
    ]);
  });

  it("does not search when the run cannot be resolved", async () => {
    const retrieve = vi.fn();
    const resolve: RunScopeResolver = async () => { throw new ToolGatewayValidationError("The run is not known to the engine"); };
    await expect(adsKnowledgeSearch(resolve, ads(retrieve as unknown as AdsQueryHandlerClient["retrieve"])).search({ tenantId: TENANT, runId: RUN }, { query: "q", topK: 1 })).rejects.toBeInstanceOf(ToolGatewayValidationError);
    expect(retrieve).not.toHaveBeenCalled();
  });
});

describe("connectedWhatsappSend", () => {
  function sender(): WhatsappTextSender & { readonly sendTextMessage: ReturnType<typeof vi.fn> } {
    return { sendTextMessage: vi.fn(async () => ({ messageId: "wamid.1" })) };
  }

  it("sends through the single connected account with its own token reference", async () => {
    const s = sender();
    const result = await connectedWhatsappSend(async () => scope(), s).send({ tenantId: TENANT, runId: RUN }, { to: "919876543210", text: "hello" });

    expect(result).toEqual({ messageId: "wamid.1" });
    expect(s.sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: "111", accessTokenRef: ACCOUNT_A.access_token_ref }), "919876543210", "hello");
  });

  it("refuses when no account is connected", async () => {
    const s = sender();
    await expect(connectedWhatsappSend(async () => scope([]), s).send({ tenantId: TENANT, runId: RUN }, { to: "919876543210", text: "hi" })).rejects.toBeInstanceOf(ToolGatewayCredentialMissingError);
    expect(s.sendTextMessage).not.toHaveBeenCalled();
  });

  it("refuses to guess between two accounts, but honours an explicit phone number id", async () => {
    const s = sender();
    const port = connectedWhatsappSend(async () => scope([ACCOUNT_A, ACCOUNT_B]), s);

    await expect(port.send({ tenantId: TENANT, runId: RUN }, { to: "919876543210", text: "hi" })).rejects.toBeInstanceOf(ToolGatewayCredentialMissingError);
    expect(s.sendTextMessage).not.toHaveBeenCalled();

    await port.send({ tenantId: TENANT, runId: RUN }, { to: "919876543210", text: "hi", phoneNumberId: "222" });
    expect(s.sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: "222", accessTokenRef: ACCOUNT_B.access_token_ref }), "919876543210", "hi");
  });

  it("refuses a phone number id that is not connected to the run's workspace", async () => {
    const s = sender();
    await expect(connectedWhatsappSend(async () => scope([ACCOUNT_A]), s).send({ tenantId: TENANT, runId: RUN }, { to: "919876543210", text: "hi", phoneNumberId: "999" })).rejects.toBeInstanceOf(ToolGatewayCredentialMissingError);
    expect(s.sendTextMessage).not.toHaveBeenCalled();
  });
});
