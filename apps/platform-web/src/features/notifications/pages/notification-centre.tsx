import { useState } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { PageHeader } from "@/components/common/page-header"
import { Button } from "@/components/ui/button"
import { api } from "@/api/client"
import { isLiveApi } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import { formatDistanceToNow } from "date-fns"
import { Link, useNavigate } from "react-router-dom"
import { ExternalLink, Check, Bell, BellOff } from "lucide-react"
import { cn } from "@/lib/utils"
import { LoadingState } from "@/components/feedback/loading-state"
import { EmptyState } from "@/components/feedback/empty-state"

export function NotificationCentrePage() {
  const [filter, setFilter] = useState<"all" | "unread">("all")
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: notifications = [], isLoading } = useQuery({
    queryKey: queryKeys.notifications.list,
    queryFn: () => api.notifications.list(),
  })

  const markRead = useMutation({
    mutationFn: (id: string) => api.notifications.markRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.list })
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.unreadCount })
    }
  })

  const markUnread = useMutation({
    mutationFn: (id: string) => api.notifications.markUnread(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.list })
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.unreadCount })
    }
  })

  const markAllRead = useMutation({
    mutationFn: () => api.notifications.markAllRead(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.list })
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.unreadCount })
    }
  })

  const filteredNotifications = notifications.filter(n => {
    if (filter === "unread") return n.status === "unread"
    return true
  }).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Notifications" description="Updates from workflows, runs, projects, connections, billing, and AlterX." />
        <LoadingState fullScreen />
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <PageHeader 
        title="Notifications" 
        description="Updates from workflows, runs, projects, connections, billing, and AlterX."
        primaryAction={
          <Button variant="outline" onClick={() => navigate("/app/settings/notifications")}>
            Preferences
          </Button>
        }
      />

      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-2">
          <Button 
            variant={filter === "all" ? "primary" : "outline"} 
            size="sm"
            onClick={() => setFilter("all")}
          >
            All
          </Button>
          <Button 
            variant={filter === "unread" ? "primary" : "outline"} 
            size="sm"
            onClick={() => setFilter("unread")}
          >
            Unread
          </Button>
        </div>
        {notifications.some(n => n.status === "unread") && (
          <Button variant="ghost" size="sm" onClick={() => markAllRead.mutate()} disabled={markAllRead.isPending}>
            <Check className="mr-2 h-4 w-4" />
            Mark all read
          </Button>
        )}
      </div>

      <div className="rounded-xl border border-border bg-surface overflow-hidden">
        {filteredNotifications.length === 0 ? (
          <EmptyState
            icon={Bell}
            title={filter === "unread" ? "You're all caught up" : "No notifications yet"}
            description={filter === "unread" ? "You have no unread notifications." : "When you receive updates, they will appear here."}
          />
        ) : (
          <div className="divide-y divide-border">
            {filteredNotifications.map(notification => (
              <div 
                key={notification.id} 
                className={cn(
                  "p-4 flex gap-4 transition-colors hover:bg-surface-hover group",
                  notification.status === "unread" ? "bg-surface-raised/30" : ""
                )}
              >
                <div className="mt-1">
                  {notification.status === "unread" ? (
                    <div className="h-2 w-2 mt-1.5 rounded-full bg-primary" />
                  ) : (
                    <div className="h-2 w-2 mt-1.5 rounded-full bg-transparent border border-border" />
                  )}
                </div>
                
                <div className="flex-1 space-y-1">
                  <div className="flex items-start justify-between gap-4">
                    <p className={cn(
                      "text-sm font-medium",
                      notification.priority === "high" ? "text-primary" : "text-text-primary"
                    )}>
                      {notification.title}
                    </p>
                    <p className="text-xs text-text-muted shrink-0">
                      {formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true })}
                    </p>
                  </div>
                  
                  {notification.message && (
                    <p className="text-sm text-text-secondary">
                      {notification.message}
                    </p>
                  )}
                  
                  <div className="pt-2 flex items-center gap-3">
                    {notification.url && (
                      <Button variant="outline" size="sm" asChild className="h-7 text-xs">
                        <Link to={notification.url}>
                          View Details
                          <ExternalLink className="ml-1.5 h-3 w-3" />
                        </Link>
                      </Button>
                    )}
                    
                    {notification.status === "unread" ? (
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-7 text-xs px-2 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => markRead.mutate(notification.id)}
                      >
                        <Check className="mr-1.5 h-3 w-3" />
                        Mark read
                      </Button>
                    ) : isLiveApi ? null : (
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-7 text-xs px-2 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => markUnread.mutate(notification.id)}
                      >
                        <BellOff className="mr-1.5 h-3 w-3" />
                        Mark unread
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
