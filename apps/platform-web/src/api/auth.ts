import type { TenantRole, WorkspaceRole } from "./types"
import { apiGet, apiPost, mutationKey } from "./http"

const verifierKey = "alterx_pkce_verifier"
const stateKey = "alterx_pkce_state"
const invitationKey = "alterx_pkce_invitation"

export interface AuthSession {
  userId: string
}

export interface CurrentUser {
  userId: string
  tenantId: string
  email: string
  name: string
  tenantRole?: TenantRole | null
  workspaceRoles?: Array<{ workspaceId: string; role: WorkspaceRole }>
}

export async function getCurrentUser() {
  return apiGet<CurrentUser>("/api/v1/auth/me")
}

export async function startLogin() {
  const parameters = new URL(window.location.href).searchParams
  const invitation = parameters.get("invitation")
  const organizationId = parameters.get("organization")
  if ((invitation !== null || organizationId !== null) && (!invitation || invitation.length > 4096 || !organizationId || organizationId.length > 50)) {
    throw new Error("Invalid invitation link")
  }
  sessionStorage.removeItem(invitationKey)
  if (invitation) sessionStorage.setItem(invitationKey, invitation)
  const verifier = randomString(64)
  const state = randomString(32)
  const codeChallenge = await sha256Base64Url(verifier)
  const redirectUri = `${window.location.origin}/auth/callback`

  sessionStorage.setItem(verifierKey, verifier)
  sessionStorage.setItem(stateKey, state)

  const response = await fetch("/api/v1/auth/login", {
    method: "POST",
    credentials: "include",
    headers: {
      "Accept": "application/json, application/problem+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ redirectUri, state, codeChallenge, ...(invitation ? { invitation, organizationId } : {}) }),
  })

  if (response.ok) {
    const { url: location } = (await response.json()) as { url: string }
    const url = new URL(location)
    if (url.hostname === "mock.identity.local") {
      await completeLogin({ code: invitation ? `invite:${invitation}` : "user:00000000-0000-7000-8000-000000000101", state })
      return
    }
    window.location.assign(location)
    await new Promise(() => undefined)
  }

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || "Unable to start sign-in")
  }
}

export async function completeLogin(query: { code?: string | null; state?: string | null }) {
  const verifier = sessionStorage.getItem(verifierKey)
  const expectedState = sessionStorage.getItem(stateKey)
  if (!query.code || !query.state || !verifier || query.state !== expectedState) {
    throw new Error("Invalid sign-in callback")
  }

  const invitation = sessionStorage.getItem(invitationKey)
  const redirectUri = `${window.location.origin}/auth/callback`
  // /api/v1/signup finds-or-creates the user/tenant/workspace and issues the
  // session in one atomic, idempotent step, so it handles both first-time and
  // returning Google sign-ins -- the plain /api/v1/auth/callback route assumes
  // the user already exists and has nowhere to provision a brand-new one.
  await apiPost<AuthSession>(
    "/api/v1/signup",
    { code: query.code, redirectUri, codeVerifier: verifier, ...(invitation ? { invitation } : {}) },
    { idempotencyKey: mutationKey("signup") },
  )

  sessionStorage.removeItem(verifierKey)
  sessionStorage.removeItem(stateKey)
  sessionStorage.removeItem(invitationKey)
}

export async function refreshSession() {
  return apiPost<AuthSession>("/api/v1/auth/refresh")
}

export async function logout() {
  await apiPost<void>("/api/v1/auth/logout")
}

function randomString(length: number) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

async function sha256Base64Url(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return base64Url(new Uint8Array(digest))
}

function base64Url(bytes: Uint8Array) {
  let binary = ""
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
