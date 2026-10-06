import { afterEach, expect, it, vi } from "vitest"
vi.mock("./http", async original => ({ ...await original<typeof import("./http")>(), isLiveApi: false }))
import { api } from "./client"
afterEach(() => vi.useRealTimers())
it("keeps demo create, reconnect and workspace-data deletion behavior", async () => {
  vi.useFakeTimers()
  const create = api.createConnection({ integrationId: "github", name: "Demo" })
  await vi.runAllTimersAsync()
  const connection = await create
  expect(connection).toMatchObject({ name: "Demo", integrationId: "github", status: "connected" })
  if (!connection) throw new Error("Demo connection missing")
  const reconnect = api.reconnectConnection(connection.id)
  await vi.runAllTimersAsync()
  expect(await reconnect).toMatchObject({ id: connection.id, status: "connected" })
  const deletion = api.deleteWorkspaceData("all")
  await vi.runAllTimersAsync()
  await expect(deletion).resolves.toBeUndefined()
})
