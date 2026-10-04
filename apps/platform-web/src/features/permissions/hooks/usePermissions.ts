import { create } from "zustand"
import { type Permission, type UserRole } from "@/api/types"
import { isLiveApi } from "@/api/http"
import { useAuth } from "@/features/auth/hooks/useAuth"
import { ROLE_PERMISSIONS } from "../roles"

export const workspaceKey = (id: string) => id.replace(/^ws_/, "")
const usePermissionsStore = create<{
  mockRole: UserRole; selectedWorkspaceId: string; setMockRole: (role: UserRole) => void; selectWorkspace: (id: string) => void
}>(set => ({
  mockRole: "owner", selectedWorkspaceId: "",
  setMockRole: mockRole => set({ mockRole }), selectWorkspace: selectedWorkspaceId => set({ selectedWorkspaceId }),
}))

export function usePermissions() {
  const { mockRole, selectedWorkspaceId, setMockRole, selectWorkspace } = usePermissionsStore()
  const user = useAuth(state => state.user)
  const bindings = user?.workspaceRoles ?? []
  const selectedBinding = bindings.find(binding => workspaceKey(binding.workspaceId) === workspaceKey(selectedWorkspaceId))
  const workspaceId = isLiveApi ? (selectedBinding?.workspaceId ?? (user?.tenantRole === "owner" && selectedWorkspaceId ? selectedWorkspaceId : bindings[0]?.workspaceId ?? "")) : selectedWorkspaceId || "ws_1"
  const role: UserRole = isLiveApi ? (user?.tenantRole === "owner" ? "owner" :
    bindings.find(binding => workspaceKey(binding.workspaceId) === workspaceKey(workspaceId))?.role ?? "viewer") : mockRole
  const permissions = isLiveApi && (!user || !workspaceId) ? [] : ROLE_PERMISSIONS[role] ?? []
  const can = (permission: Permission) => permissions.includes(permission)
  return { role, workspaceId, selectWorkspace, permissions, can,
    canAll: (required: Permission[]) => required.every(can), canAny: (required: Permission[]) => required.some(can),
    setMockRole }
}
