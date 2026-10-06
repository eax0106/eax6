import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { workflowTemplatesService } from "./workflow-templates"

const TEMPLATE_DIR = resolve(__dirname, "../../../../intelligence-service/src/capability_registry/templates/v1")

describe("demo-mode starter templates", () => {
  it("mirror the reviewed set's ids, titles and summaries", async () => {
    const reviewed = readdirSync(TEMPLATE_DIR).filter(file => file.endsWith(".json")).sort()
      .map(file => JSON.parse(readFileSync(resolve(TEMPLATE_DIR, file), "utf8")) as { template_id: string; title: string; summary: string })
    const demo = await workflowTemplatesService.list()
    expect(demo.map(({ template_id, title, summary }) => ({ template_id, title, summary })))
      .toEqual(reviewed.map(({ template_id, title, summary }) => ({ template_id, title, summary })))
  })

  it("creates a draft workflow chat named after the template", async () => {
    const result = await workflowTemplatesService.instantiate("knowledge-qa")
    expect(result.status).toBe("compiled")
    expect(result.conversation).toMatchObject({ type: "workflow_builder", title: "Knowledge Q&A over your documents" })
    await expect(workflowTemplatesService.instantiate("not-a-template")).rejects.toThrow("Template not found")
  })
})
