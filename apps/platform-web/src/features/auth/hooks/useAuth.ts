import { create } from "zustand"
import { getCurrentUser, logout, refreshSession, startLogin, type CurrentUser } from "@/api/auth"
import { isLiveApi } from "@/api/http"

interface AuthState {
  isAuthenticated: boolean
  user: CurrentUser | null
  validated: boolean
  signIn: () => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
  validate: () => Promise<void>
}

export const useAuth = create<AuthState>((set) => ({
  isAuthenticated: localStorage.getItem("alterx_auth") === "true",
  user: null,
  validated: false,
  signIn: async () => {
    if (isLiveApi) {
      await startLogin()
      const user = await getCurrentUser()
      set({ user, validated: true })
    }
    localStorage.setItem("alterx_auth", "true")
    set({ isAuthenticated: true })
  },
  signOut: async () => {
    if (isLiveApi) {
      await logout().catch(() => undefined)
    }
    localStorage.removeItem("alterx_auth")
    set({ isAuthenticated: false, user: null, validated: false })
  },
  refresh: async () => {
    if (!isLiveApi) return
    await refreshSession()
    localStorage.setItem("alterx_auth", "true")
    set({ isAuthenticated: true })
  },
  // Real session presence -- the localStorage flag only reflects that sign-in
  // once succeeded, not that the cookie is still valid, so it drifts from
  // reality after the access token expires. This confirms the cookie is
  // still accepted by the backend before trusting the flag.
  validate: async () => {
    try {
      const user = await getCurrentUser()
      localStorage.setItem("alterx_auth", "true")
      set({ isAuthenticated: true, user, validated: true })
    } catch {
      localStorage.removeItem("alterx_auth")
      set({ isAuthenticated: false, user: null, validated: true })
    }
  },
}))
