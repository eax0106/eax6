import { useAuth } from "@/features/auth/hooks/useAuth"
import type { UserRole } from "@/api/types"

/** UI fixtures must install the same scoped session bindings as /auth/me. */
export function installLiveWorkspaceSession(role: UserRole = "owner") {
  useAuth.setState({ isAuthenticated: true, validated: true, user: {
    userId: "usr_ui_fixture", tenantId: "ten_ui_fixture", email: "fixture@company.test", name: "UI fixture",
    tenantRole: role === "owner" ? "owner" : "member",
    workspaceRoles: [{ workspaceId: "ws_1", role: role === "owner" ? "admin" : role }],
  } })
}
export function clearLiveWorkspaceSession() {
  useAuth.setState({ user: null, isAuthenticated: false, validated: false })
}
