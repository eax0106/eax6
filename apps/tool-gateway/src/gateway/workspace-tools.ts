import { RunScopeLookupSchema, RunScopeSchema, type RunScope, type RunScopeLookup } from "@alterx/contracts";
import { ToolGatewayCredentialMissingError, ToolGatewayValidationError, type AdsQueryHandlerClient } from "@alterx/adapters";

/**
 * knowledge.search and whatsapp.send act in the run's own workspace: its
 * documents, its connected WhatsApp account. The engine owns which workspace a
 * run belongs to, so both ask it (POST /internal/connections/run-scope) rather
 * than trusting anything in the tool input.
 */

export const KNOWLEDGE_SEARCH_TOOL_NAME = "knowledge.search";
export const WHATSAPP_SEND_TOOL_NAME = "whatsapp.send";

export interface KnowledgeSearchInput { readonly query: string; readonly topK: number }
export interface WhatsappSendInput { readonly to: string; readonly text: string; readonly phoneNumberId?: string }

export interface KnowledgeResult { readonly documentId: string; readonly title: string | null; readonly text: string; readonly score: number }

export interface KnowledgeSearchPort {
  search(scope: { readonly tenantId: string; readonly runId: string }, input: KnowledgeSearchInput): Promise<readonly KnowledgeResult[]>;
}
export interface WhatsappSendPort {
  send(scope: { readonly tenantId: string; readonly runId: string }, input: WhatsappSendInput): Promise<{ readonly messageId: string }>;
}

function object(json: string, tool: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new ToolGatewayValidationError(`${tool} input must be a JSON object`); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ToolGatewayValidationError(`${tool} input must be a JSON object`);
  return value as Record<string, unknown>;
}

export function parseKnowledgeSearchInput(json: string): KnowledgeSearchInput {
  const value = object(json, KNOWLEDGE_SEARCH_TOOL_NAME);
  const unknown = Object.keys(value).filter((key) => key !== "query" && key !== "topK");
  if (unknown.length > 0) throw new ToolGatewayValidationError(`knowledge.search does not accept: ${unknown.join(", ")}`);
  const query = typeof value["query"] === "string" ? value["query"].trim() : "";
  if (query.length === 0 || query.length > 2000) throw new ToolGatewayValidationError("knowledge.search requires a query of 1 to 2000 characters");
  const topK = value["topK"] ?? 5;
  if (typeof topK !== "number" || !Number.isInteger(topK) || topK < 1 || topK > 10) throw new ToolGatewayValidationError("knowledge.search topK must be an integer from 1 to 10");
  return { query, topK };
}

export function parseWhatsappSendInput(json: string): WhatsappSendInput {
  const value = object(json, WHATSAPP_SEND_TOOL_NAME);
  const unknown = Object.keys(value).filter((key) => !["to", "text", "phoneNumberId"].includes(key));
  if (unknown.length > 0) throw new ToolGatewayValidationError(`whatsapp.send does not accept: ${unknown.join(", ")}`);
  const to = typeof value["to"] === "string" ? value["to"].replace(/^\+/, "") : "";
  if (!/^[1-9][0-9]{6,14}$/.test(to)) throw new ToolGatewayValidationError("whatsapp.send requires `to` as an international phone number");
  const text = typeof value["text"] === "string" ? value["text"].trim() : "";
  if (text.length === 0 || text.length > 4096) throw new ToolGatewayValidationError("whatsapp.send requires text of 1 to 4096 characters");
  const phoneNumberId = value["phoneNumberId"];
  if (phoneNumberId !== undefined && (typeof phoneNumberId !== "string" || !/^[0-9]{1,32}$/.test(phoneNumberId))) {
    throw new ToolGatewayValidationError("whatsapp.send phoneNumberId must be the connected number's id");
  }
  return { to, text, ...(phoneNumberId === undefined ? {} : { phoneNumberId }) };
}

export type RunScopeResolver = (lookup: RunScopeLookup) => Promise<RunScope>;

export function httpRunScopeResolver(baseUrl: string, serviceToken: string, fetchImpl: typeof fetch = fetch): RunScopeResolver {
  return async (lookup) => {
    const body = RunScopeLookupSchema.parse(lookup);
    const response = await fetchImpl(new URL("/internal/connections/run-scope", baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) throw new ToolGatewayValidationError("The run is not known to the engine");
    if (!response.ok) throw new Error("Run scope lookup failed");
    return RunScopeSchema.parse(await response.json());
  };
}

export function adsKnowledgeSearch(resolveScope: RunScopeResolver, ads: AdsQueryHandlerClient): KnowledgeSearchPort {
  return {
    async search(scope, input) {
      const run = await resolveScope({ tenant_id: scope.tenantId, run_id: scope.runId });
      const hits = await ads.retrieve({
        tenant_id: scope.tenantId, workspace_id: `ws_${run.workspace_id}`, query: input.query, top_k: input.topK, requester: "tool-gateway",
      });
      return hits.map((hit) => ({ documentId: hit.document_id, title: documentTitle(hit.provenance_json), text: hit.context, score: hit.score }));
    },
  };
}

function documentTitle(provenanceJson: string): string | null {
  try {
    const provenance: unknown = JSON.parse(provenanceJson);
    const document = typeof provenance === "object" && provenance !== null ? (provenance as Record<string, unknown>)["document"] : undefined;
    const title = typeof document === "object" && document !== null ? (document as Record<string, unknown>)["title"] : undefined;
    return typeof title === "string" ? title : null;
  } catch {
    return null;
  }
}

export interface WhatsappTextSender {
  sendTextMessage(account: { readonly phoneNumberId: string; readonly wabaId: string; readonly accessTokenRef: string }, to: string, text: string): Promise<{ readonly messageId: string }>;
}

export function connectedWhatsappSend(resolveScope: RunScopeResolver, sender: WhatsappTextSender): WhatsappSendPort {
  return {
    async send(scope, input) {
      const run = await resolveScope({ tenant_id: scope.tenantId, run_id: scope.runId });
      const accounts = input.phoneNumberId === undefined
        ? run.whatsapp_accounts
        : run.whatsapp_accounts.filter((account) => account.phone_number_id === input.phoneNumberId);
      // A missing or ambiguous account is a connection gap, never a guess.
      if (accounts.length !== 1) throw new ToolGatewayCredentialMissingError();
      const account = accounts[0]!;
      return sender.sendTextMessage({ phoneNumberId: account.phone_number_id, wabaId: "", accessTokenRef: account.access_token_ref }, input.to, input.text);
    },
  };
}
