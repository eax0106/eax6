import type { AdminUser, AdminNote } from "../types"
import { isLiveApi } from "../http"
import * as live from "../live-admin-users"

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const MOCK_USERS: AdminUser[] = [
  { id: "usr-1", name: "Alice Administrator", email: "alice@acme.ai", status: "active", tenantIds: ["ten-1"], createdAt: "2024-01-15T00:00:00Z", lastActiveAt: new Date().toISOString() },
  { id: "usr-2", name: "Bob Developer", email: "bob@acme.ai", status: "active", tenantIds: ["ten-1"], createdAt: "2024-02-10T00:00:00Z", lastActiveAt: new Date().toISOString() },
  { id: "usr-3", name: "Eve Suspicious", email: "eve@stark.com", status: "suspended", tenantIds: ["ten-2"], createdAt: "2024-08-01T00:00:00Z", lastActiveAt: "2024-08-05T00:00:00Z" }
]

const MOCK_NOTES: Record<string, AdminNote[]> = {
  "usr-3": [
    { id: "note-2", userId: "usr-3", author: { id: "u-sys", name: "Admin (You)" }, body: "Account suspended due to policy violation.", createdAt: "2024-08-05T10:00:00Z" }
  ]
}

export class AdminUsersService {
  async list(): Promise<AdminUser[]> {
    if (isLiveApi) return live.listUsers()
    await delay(300)
    return MOCK_USERS
  }

  async get(id: string): Promise<AdminUser> {
    if (isLiveApi) return live.getUser(id)
    await delay(200)
    const user = MOCK_USERS.find(u => u.id === id)
    if (!user) throw new Error("User not found")
    return user
  }

  async getNotes(id: string): Promise<AdminNote[]> {
    if (isLiveApi) return live.getUserTimeline(id)
    await delay(100)
    return MOCK_NOTES[id] || []
  }

  async addNote(id: string, body: string): Promise<AdminNote> {
    if (isLiveApi) throw new Error("User notes are not available yet: platform-api has no notes store")
    await delay(300)
    const newNote: AdminNote = {
      id: `note-${Date.now()}`,
      userId: id,
      author: { id: "u-sys", name: "Admin (You)" },
      body,
      createdAt: new Date().toISOString()
    }
    if (!MOCK_NOTES[id]) MOCK_NOTES[id] = []
    MOCK_NOTES[id].push(newNote)
    return newNote
  }

  async suspend(id: string, reason: string): Promise<AdminUser> {
    if (isLiveApi) return live.suspendUser(id, reason)
    await delay(400)
    const idx = MOCK_USERS.findIndex(u => u.id === id)
    if (idx === -1) throw new Error("Not found")
    MOCK_USERS[idx] = { ...MOCK_USERS[idx], status: "suspended" }
    await this.addNote(id, `Suspended. Reason: ${reason}`)
    return MOCK_USERS[idx]
  }

  async restore(id: string, reason: string): Promise<AdminUser> {
    if (isLiveApi) return live.reinstateUser(id)
    await delay(400)
    const idx = MOCK_USERS.findIndex(u => u.id === id)
    if (idx === -1) throw new Error("Not found")
    MOCK_USERS[idx] = { ...MOCK_USERS[idx], status: "active" }
    await this.addNote(id, `Restored. Reason: ${reason}`)
    return MOCK_USERS[idx]
  }

  async lockSessions(id: string, reason: string): Promise<void> {
    if (isLiveApi) return live.revokeUserSessions(id, reason)
    await delay(500)
    await this.addNote(id, `Sessions locked. Reason: ${reason}`)
  }
}
