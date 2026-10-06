import { readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { expect, it } from "vitest"

function inventory(source: string) {
  const file = ts.createSourceFile("client.ts", source, ts.ScriptTarget.Latest, true)
  const client = file.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === "ApiClient")
  if (!client || !ts.isClassDeclaration(client)) throw new Error("ApiClient source missing")
  const methods = client.members.filter(ts.isMethodDeclaration).filter(method => method.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword))
  return { total: methods.length, missing: methods.filter(method => !method.body?.getText(file).includes("isLiveApi")).map(method => method.name.getText(file)) }
}
it("measures zero async API methods without a live path", () => {
  const result = inventory(readFileSync(join(import.meta.dirname, "client.ts"), "utf8"))
  expect(result.total).toBeGreaterThan(0)
  expect(result.missing).toEqual([])
  console.info(`MVP LIVE METHODS VERIFIED: ${result.total} async methods; ${result.missing.length} missing`)
})
it("detects the known unwired-method positive control", () => {
  expect(inventory("class ApiClient { async wired() { if(isLiveApi)return live.wired() } async unwired() { await delay(600) } }")).toEqual({ total: 2, missing: ["unwired"] })
  expect(() => inventory("class WrongClient {}" )).toThrow("ApiClient source missing")
})
