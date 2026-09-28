import type { AppNotification, NotificationPreference } from "../types"
import { isLiveApi } from "../http"
import * as live from "../live-notifications"

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const mockNotifications: AppNotification[] = [
  {
    id: "notif_1",
    type: "run",
    title: "Customer Support Triage completed",
    message: "184 emails processed successfully.",
    status: "unread",
    priority: "normal",
    createdAt: new Date(Date.now() - 120000).toISOString(),
    url: "/app/runs/run_1",
    entity: { type: "run", id: "run_1" }
  },
  {
    id: "notif_2",
    type: "connection",
    title: "Slack connection needs attention",
    message: "Reconnect Slack to prevent workflow failures.",
    status: "unread",
    priority: "high",
    createdAt: new Date(Date.now() - 720000).toISOString(),
    url: "/app/settings/integrations",
    entity: { type: "connection", id: "conn_slack" }
  },
  {
    id: "notif_3",
    type: "human_action",
    title: "Approval required",
    message: "Refund approval requires your decision.",
    status: "unread",
    priority: "high",
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    url: "/app/human-actions/act_1",
    entity: { type: "human_action", id: "act_1" }
  },
  {
    id: "notif_4",
    type: "billing",
    title: "Budget warning",
    message: "Workspace budget reached 80%",
    status: "read",
    priority: "normal",
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    url: "/app/usage/budgets",
  },
  {
    id: "notif_5",
    type: "marketplace",
    title: "Marketplace sale",
    message: "Someone purchased 'AI Customer Support Triage'",
    status: "read",
    priority: "normal",
    createdAt: new Date(Date.now() - 172800000).toISOString(),
    url: "/app/seller/earnings",
  }
]

const mockPreferences: NotificationPreference[] = [
  { category: "run", inApp: true, email: false },
  { category: "workflow", inApp: true, email: false },
  { category: "project", inApp: true, email: false },
  { category: "human_action", inApp: true, email: true },
  { category: "knowledge", inApp: true, email: false },
  { category: "connection", inApp: true, email: true, importantOnly: true },
  { category: "billing", inApp: true, email: true },
  { category: "marketplace", inApp: true, email: false },
  { category: "system", inApp: true, email: true },
]

export const notificationsService = {
  list: async (): Promise<AppNotification[]> => {
    if (isLiveApi) return live.listNotifications()
    await delay(300)
    return mockNotifications
  },
  getUnreadCount: async (): Promise<number> => {
    if (isLiveApi) return live.unreadCount()
    await delay(200)
    return mockNotifications.filter(n => n.status === "unread").length
  },
  markRead: async (id: string): Promise<void> => {
    if (isLiveApi) return live.markRead(id)
    await delay(300)
    const notif = mockNotifications.find(n => n.id === id)
    if (notif) notif.status = "read"
  },
  markUnread: async (id: string): Promise<void> => {
    if (isLiveApi) throw new Error("Marking a notification unread is not available")
    await delay(300)
    const notif = mockNotifications.find(n => n.id === id)
    if (notif) notif.status = "unread"
  },
  markAllRead: async (): Promise<void> => {
    if (isLiveApi) return live.markAllRead()
    await delay(500)
    mockNotifications.forEach(n => { n.status = "read" })
  },
  getPreferences: async (): Promise<NotificationPreference[]> => {
    if (isLiveApi) return live.getPreferences()
    await delay(300)
    return mockPreferences
  },
  updatePreferences: async (_prefs: NotificationPreference[]): Promise<void> => {
    if (isLiveApi) return live.updatePreferences(_prefs)
    await delay(600)
    // mock update
  }
}
