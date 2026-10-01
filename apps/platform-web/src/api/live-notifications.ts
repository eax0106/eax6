import { apiGet, apiPatch, apiPost } from "./http"
import type { AppNotification, NotificationPreference, NotificationType } from "./types"

// Notifications (task B3.1): live adapter over /api/v1/notifications. The API
// classifies events as workflow / project / deployment / approval / budget /
// system, delivered in-app and by email; the console's categories are mapped
// onto those six.

type AnyRecord = Record<string, unknown>
type EventClass = "workflow" | "project" | "deployment" | "approval" | "budget" | "system"

const eventClasses: readonly EventClass[] = ["workflow", "project", "deployment", "approval", "budget", "system"]
const categoryByClass: Record<EventClass, NotificationType> = {
  workflow: "workflow",
  project: "project",
  deployment: "deployment",
  approval: "human_action",
  budget: "billing",
  system: "system",
}
const classByCategory = Object.fromEntries(
  Object.entries(categoryByClass).map(([eventClass, category]) => [category, eventClass]),
) as Partial<Record<NotificationType, EventClass>>

function mapNotification(value: unknown): AppNotification {
  const item = value as AnyRecord
  const eventClass = String(item.eventClass) as EventClass
  const deepLink = typeof item.deepLink === "string" && item.deepLink.startsWith("/") ? item.deepLink : undefined
  return {
    id: String(item.id),
    type: categoryByClass[eventClass] ?? "system",
    title: String(item.title),
    message: typeof item.body === "string" ? item.body : undefined,
    status: item.readAt ? "read" : "unread",
    priority: item.severity === "info" ? "normal" : "high",
    createdAt: String(item.createdAt),
    ...(deepLink ? { url: deepLink } : {}),
  }
}

async function page(query: string): Promise<AppNotification[]> {
  const body = (await apiGet<unknown>(`/api/v1/notifications?${query}`)) as AnyRecord
  return (Array.isArray(body?.items) ? body.items : []).map(mapNotification)
}

export const listNotifications = () => page("limit=100")

/** Unread count, capped at the API's page size of 100. */
export async function unreadCount(): Promise<number> {
  return (await page("read=false&limit=100")).length
}

export async function markRead(id: string): Promise<void> {
  await apiPost<unknown>(`/api/v1/notifications/${encodeURIComponent(id)}/actions/read`)
}

export async function markAllRead(): Promise<void> {
  for (const notification of await page("read=false&limit=100")) await markRead(notification.id)
}

export async function getPreferences(): Promise<NotificationPreference[]> {
  const rows = (await apiGet<unknown>("/api/v1/notifications/preferences")) as AnyRecord[]
  const enabled = (eventClass: EventClass, channel: "in_app" | "email") => {
    if (eventClass === "approval" && channel === "in_app") return true
    const row = (Array.isArray(rows) ? rows : []).find((r) => r.eventClass === eventClass && r.channel === channel)
    // The API delivers on both channels until a preference says otherwise.
    return row ? row.enabled === true : true
  }
  return eventClasses.map((eventClass) => ({
    category: categoryByClass[eventClass],
    inApp: enabled(eventClass, "in_app"),
    email: enabled(eventClass, "email"),
  }))
}

export async function updatePreferences(preferences: NotificationPreference[]): Promise<void> {
  const body = preferences.flatMap((preference) => {
    const eventClass = classByCategory[preference.category]
    if (!eventClass) return []
    return [
      { event_class: eventClass, channel: "in_app", enabled: eventClass === "approval" || preference.inApp },
      { event_class: eventClass, channel: "email", enabled: preference.email },
    ]
  })
  if (body.length > 0) await apiPatch<unknown>("/api/v1/notifications/preferences", { preferences: body })
}
