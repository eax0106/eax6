import { z } from "zod"
import { apiPost, mutationKey } from "./http"
import { getConnection } from "./live"

const pendingKey = "alterx_connection_oauth"
const authorizationSchema = z.object({ authorize_url: z.url(), state: z.string().min(1), expires_at: z.iso.datetime() })
const pendingSchema = z.object({
  connector: z.string().min(1), state: z.string().min(1), expiresAt: z.iso.datetime(),
  connectionId: z.uuid().optional(), callbackKey: z.string().min(1),
  returnTo: z.string().refine(value => value.startsWith("/app/") && !/[\\\r\n]/.test(value)),
})

export async function beginConnection(connector: string, tenantConfig?: Record<string, string>, connectionId?: string): Promise<void> {
  if (!connector) throw new Error("Select an integration")
  const result = authorizationSchema.parse(await apiPost(`/api/v1/integrations/${encodeURIComponent(connector)}/actions/authorize`, {
    redirect_uri: `${location.origin}/app/connections/callback`,
    ...(tenantConfig ? { tenant_config: tenantConfig } : {}),
    ...(connectionId ? { connection_id: connectionId } : {}),
  }, { idempotencyKey: mutationKey("connection-authorize") }))
  const url = new URL(result.authorize_url)
  if (url.protocol !== "https:" || url.searchParams.get("state") !== result.state || Date.parse(result.expires_at) <= Date.now()) {
    throw new Error("Integration authorization is unavailable. Try again.")
  }
  // ponytail: one OAuth flow per tab; key by state if simultaneous flows are added.
  sessionStorage.setItem(pendingKey, JSON.stringify(pendingSchema.parse({ connector, state: result.state,
    expiresAt: result.expires_at, connectionId, callbackKey: mutationKey("connection-callback"),
    returnTo: `${location.pathname}${location.search}${location.hash}` })))
  location.assign(result.authorize_url)
}

export async function reconnectConnection(id: string): Promise<void> {
  const connection = await getConnection(id)
  await beginConnection(connection.integrationId, undefined, connection.id)
}

export async function completeConnection(params: URLSearchParams) {
  const saved = sessionStorage.getItem(pendingKey)
  if (!saved) throw new Error("Connection authorization is missing. Start again.")
  const pending = pendingSchema.parse(JSON.parse(saved))
  if (params.get("state") !== pending.state || Date.parse(pending.expiresAt) <= Date.now()) {
    throw new Error("Connection authorization is mismatched or expired. Start again.")
  }
  if (params.has("error")) {
    sessionStorage.removeItem(pendingKey)
    throw new Error("Connection authorization was declined. Start again.")
  }
  const code = params.get("code")
  if (!code) throw new Error("Connection authorization code is missing. Start again.")
  const result = z.object({ id: z.uuid(), connector: z.string(), status: z.literal("connected"), engine_synced: z.boolean().optional() }).parse(
    await apiPost(`/api/v1/integrations/${encodeURIComponent(pending.connector)}/actions/callback`,
      { code, state: pending.state }, { idempotencyKey: pending.callbackKey }))
  if (result.connector !== pending.connector || (pending.connectionId && result.id !== pending.connectionId)) {
    throw new Error("Connection identity changed. Start again with the original account.")
  }
  sessionStorage.removeItem(pendingKey)
  return { connectionId: result.id, returnTo: pending.returnTo, engineSynced: result.engine_synced }
}
