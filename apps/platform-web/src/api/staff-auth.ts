import { apiGet, apiPost } from "./http"

// Staff sign-in for the admin console (task B1.0): authorization code with PKCE
// against the dedicated staff Auth0 tenant. platform-api builds the authorize
// URL and, on callback, sets an HttpOnly staff cookie only for a recognised
// staff member. Kept apart from customer sign-in (api/auth.ts) on purpose.
const verifierKey = "alterx_staff_pkce_verifier"
const stateKey = "alterx_staff_pkce_state"
export const STAFF_CALLBACK_PATH = "/staff/callback"

export interface StaffSession {
  staffUserId: string
  email: string
  roles: string[]
}

export function getStaffSession(): Promise<StaffSession> {
  return apiGet<StaffSession>("/api/v1/admin/session")
}

export async function startStaffLogin(): Promise<void> {
  const verifier = randomString(64)
  const state = randomString(32)
  sessionStorage.setItem(verifierKey, verifier)
  sessionStorage.setItem(stateKey, state)
  const { url } = await apiPost<{ url: string }>("/api/v1/admin/session/login", {
    redirectUri: `${window.location.origin}${STAFF_CALLBACK_PATH}`,
    state,
    codeChallenge: await sha256Base64Url(verifier),
  })
  window.location.assign(url)
}

export async function completeStaffLogin(query: { code: string | null; state: string | null }): Promise<StaffSession> {
  const verifier = sessionStorage.getItem(verifierKey)
  const expectedState = sessionStorage.getItem(stateKey)
  sessionStorage.removeItem(verifierKey)
  sessionStorage.removeItem(stateKey)
  if (!query.code || !query.state || !verifier || query.state !== expectedState) {
    throw new Error("Invalid staff sign-in callback")
  }
  const params = new URLSearchParams({
    code: query.code,
    redirect_uri: `${window.location.origin}${STAFF_CALLBACK_PATH}`,
    code_verifier: verifier,
  })
  return apiGet<StaffSession>(`/api/v1/admin/session/callback?${params}`)
}

export function staffLogout(): Promise<void> {
  return apiPost<void>("/api/v1/admin/session/logout")
}

function randomString(length: number) {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return base64Url(new Uint8Array(digest))
}

function base64Url(bytes: Uint8Array) {
  let binary = ""
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
