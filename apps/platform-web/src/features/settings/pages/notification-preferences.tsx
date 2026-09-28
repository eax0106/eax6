import { useState, useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { PageHeader } from "@/components/common/page-header"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { api } from "@/api/client"
import { queryKeys } from "@/api/query-keys"
import type { NotificationPreference } from "@/api/types"
import { LoadingState } from "@/components/feedback/loading-state"
import { toast } from "sonner"
import { Bell, Mail } from "lucide-react"

export function NotificationPreferencesPage() {
  const queryClient = useQueryClient()
  
  const { data: preferences, isLoading } = useQuery({
    queryKey: queryKeys.notifications.preferences,
    queryFn: () => api.notifications.getPreferences(),
  })

  const [localPrefs, setLocalPrefs] = useState<NotificationPreference[]>([])
  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    if (preferences) {
      setLocalPrefs(JSON.parse(JSON.stringify(preferences)))
      setHasChanges(false)
    }
  }, [preferences])

  const savePreferences = useMutation({
    mutationFn: (prefs: NotificationPreference[]) => api.notifications.updatePreferences(prefs),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.preferences })
      toast.success("Notification preferences saved")
      setHasChanges(false)
    },
    onError: () => {
      toast.error("Failed to save preferences")
    }
  })

  const handleToggle = (category: string, field: "inApp" | "email") => {
    setLocalPrefs(prev => 
      prev.map(p => {
        if (p.category === category) {
          return { ...p, [field]: !p[field] }
        }
        return p
      })
    )
    setHasChanges(true)
  }

  const categoryLabels: Record<string, { title: string, desc: string }> = {
    "run": { title: "Run Activity", desc: "Started, completed, and failed runs." },
    "workflow": { title: "Workflows", desc: "Workflow health and version changes." },
    "project": { title: "Projects", desc: "Project plan approvals and build events." },
    "deployment": { title: "Deployments", desc: "Promotions, rollbacks and deployment health." },
    "human_action": { title: "Human Actions", desc: "Tasks requiring your approval, clarification, or review." },
    "knowledge": { title: "Knowledge Base", desc: "Sync status and indexing failures." },
    "connection": { title: "Connections", desc: "Integration status and credential expiration." },
    "billing": { title: "Billing & Budgets", desc: "Invoices, cost thresholds, and budget warnings." },
    "marketplace": { title: "Marketplace", desc: "Asset installs, sales, and reviews." },
    "system": { title: "System Alerts", desc: "Platform maintenance and security notices." },
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Notification Preferences" description="Manage how and when AlterX contacts you." />
        <LoadingState />
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <PageHeader 
        title="Notification Preferences" 
        description="Manage how and when AlterX contacts you."
      />

      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        
        {/* Table Header */}
        <div className="grid grid-cols-12 gap-4 p-4 border-b border-border bg-surface-raised/50 items-center">
          <div className="col-span-8">
            <h4 className="text-sm font-semibold">Category</h4>
          </div>
          <div className="col-span-2 text-center flex items-center justify-center gap-2">
            <Bell className="h-4 w-4 text-text-muted" />
            <span className="text-sm font-medium">In-App</span>
          </div>
          <div className="col-span-2 text-center flex items-center justify-center gap-2">
            <Mail className="h-4 w-4 text-text-muted" />
            <span className="text-sm font-medium">Email</span>
          </div>
        </div>

        {/* Rows */}
        <div className="divide-y divide-border">
          {localPrefs.map(pref => {
            const meta = categoryLabels[pref.category] || { title: pref.category, desc: "" }
            return (
              <div key={pref.category} className="grid grid-cols-12 gap-4 p-4 items-center hover:bg-surface-hover/50 transition-colors">
                <div className="col-span-8">
                  <Label htmlFor={`${pref.category}-inapp`} className="text-sm font-medium cursor-pointer">
                    {meta.title}
                  </Label>
                  <p className="text-xs text-text-secondary mt-1">
                    {meta.desc}
                  </p>
                </div>
                <div className="col-span-2 flex justify-center">
                  <Switch 
                    id={`${pref.category}-inapp`} 
                    checked={pref.inApp} 
                    onCheckedChange={() => handleToggle(pref.category, "inApp")}
                  />
                </div>
                <div className="col-span-2 flex justify-center">
                  <Switch 
                    id={`${pref.category}-email`} 
                    checked={pref.email} 
                    onCheckedChange={() => handleToggle(pref.category, "email")}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex justify-end mt-6">
        <Button 
          disabled={!hasChanges || savePreferences.isPending} 
          onClick={() => savePreferences.mutate(localPrefs)}
          loading={savePreferences.isPending}
        >
          Save Preferences
        </Button>
      </div>
    </div>
  )
}
