import { WORKSPACE_ROLES, type WorkspaceRole } from "@/api/types"
import { RequirePermission } from "@/features/permissions/components/require-permission"

const descriptions: Record<WorkspaceRole, string> = {
  admin: "Manage workspace members, workflows, integrations and operations.",
  editor: "Build and edit workflows and manage integrations and knowledge.",
  operator: "Operate workflows and handle run decisions.",
  approver: "Review workflow decisions and approval requests.",
  viewer: "Read workspace workflows, runs and knowledge.",
}
export function RolesPage() {
  return <RequirePermission permission="role.read"><div className="space-y-6">
    <div><h1 className="text-2xl font-bold">Roles</h1><p className="text-text-secondary mt-1">Five fixed workspace roles. Tenant owner is a separate badge and cannot be assigned here.</p></div>
    <div className="grid gap-4 md:grid-cols-2">{WORKSPACE_ROLES.map(role => <div key={role} className="rounded-xl border border-border bg-surface p-6">
      <h2 className="text-lg font-medium capitalize">{role}</h2><p className="text-sm text-text-secondary mt-2">{descriptions[role]}</p>
    </div>)}</div>
  </div></RequirePermission>
}
