import * as React from "react"
import { Check, ChevronsUpDown, Building2 } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { api } from "@/api/client"
import { isLiveApi } from "@/api/http"
import { useQuery } from "@tanstack/react-query"
import { useAuth } from "@/features/auth/hooks/useAuth"
import { usePermissions, workspaceKey } from "@/features/permissions/hooks/usePermissions"
import { CreateWorkspaceDialog } from "@/features/workspace/components/create-workspace-dialog"

export function WorkspaceSwitcher() {
  const { workspaceId, selectWorkspace, role } = usePermissions()
  const user = useAuth(state => state.user)
  const { data, error, isLoading } = useQuery({ queryKey: ["workspaces", user?.tenantId], queryFn: () => api.getWorkspaces() })
  const workspaces = (data ?? []).filter(workspace => !isLiveApi || user?.tenantRole === "owner" ||
    user?.workspaceRoles?.some(binding => workspaceKey(binding.workspaceId) === workspaceKey(workspace.id)))
  const activeWorkspace = workspaces.find(workspace => workspaceKey(workspace.id) === workspaceKey(workspaceId)) ?? workspaces[0]
  React.useEffect(() => { if (activeWorkspace && workspaceKey(activeWorkspace.id) !== workspaceKey(workspaceId)) selectWorkspace(activeWorkspace.id) }, [activeWorkspace, workspaceId, selectWorkspace])
  const [createModalOpen, setCreateModalOpen] = React.useState(false)
  const navigate = useNavigate()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-3 w-full rounded-md p-2 hover:bg-surface-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          )}
        >
          <Avatar className="h-8 w-8 rounded-md border-border-strong">
            <AvatarFallback className="rounded-md bg-primary/10 text-primary">
              <Building2 className="h-4 w-4" />
            </AvatarFallback>
          </Avatar>
          <div className="flex flex-col flex-1 text-left line-clamp-1">
            <span className="text-sm font-semibold text-text-primary leading-tight truncate">
              {activeWorkspace?.name ?? (isLoading ? "Loading workspaces…" : "Select workspace")}
            </span>
            <span className="text-xs text-text-muted capitalize">{role}</span>
          </div>
          <ChevronsUpDown className="h-4 w-4 text-text-muted shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[240px]" align="start" sideOffset={8}>
        {workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            aria-label={workspace.name}
            onClick={() => { selectWorkspace(workspace.id); if (isLiveApi) void useAuth.getState().validate() }}
            className="flex items-center justify-between"
          >
            <div className="flex items-center gap-2 truncate">
              <Avatar className="h-6 w-6 rounded-md border-border-strong">
                <AvatarFallback className="rounded-md bg-surface-raised text-text-muted text-[10px]">
                  {workspace.name.substring(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="truncate">{workspace.name}</span>
            </div>
            {activeWorkspace?.id === workspace.id && (
              <Check className="h-4 w-4 text-primary" />
            )}
          </DropdownMenuItem>
        ))}
        {error && <p role="alert" className="p-2 text-sm text-danger">{error.message}</p>}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/app/settings/workspace")}>
          <span className="text-text-primary">Workspace settings</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setCreateModalOpen(true)}>
          <span className="text-text-muted">Create workspace...</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
      <CreateWorkspaceDialog open={createModalOpen} onOpenChange={setCreateModalOpen} />
    </DropdownMenu>
  )
}
