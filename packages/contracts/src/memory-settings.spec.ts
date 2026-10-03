import { describe, expect, it } from "vitest";
import { WorkspaceMemorySettingsSchema, WorkspaceMemoryValuesSchema, WorkspaceWorkflowMemoriesSchema } from "./memory-settings";

const values = { conversationMemoryEnabled: true, workflowMemoryEnabled: true, workspaceMemoryEnabled: true, retentionDays: 90 };
const lesson = { id: "mem_018f47a5-7b2c-7d10-8f11-123456789abc", content: { lesson: "Use verified output" } };

describe("workspace memory boundaries", () => {
  it("accepts three switches, inclusive retention bounds and a pinned ETag", () => {
    for (const retentionDays of [7, 90, 365]) expect(WorkspaceMemorySettingsSchema.parse({ ...values, retentionDays, etag: '"memory-0"' }).retentionDays).toBe(retentionDays);
  });
  it("rejects invalid retention, missing switches and sensitive-data fields", () => {
    for (const retentionDays of [6, 366, 7.5, "90", true]) expect(WorkspaceMemoryValuesSchema.safeParse({ ...values, retentionDays }).success).toBe(false);
    expect(WorkspaceMemoryValuesSchema.safeParse({ ...values, allowSensitiveData: true }).success).toBe(false);
    expect(WorkspaceMemoryValuesSchema.safeParse({ retentionDays: 90 }).success).toBe(false);
    expect(WorkspaceMemorySettingsSchema.safeParse({ ...values, etag: "unversioned" }).success).toBe(false);
  });
  it("limits recalled lessons by count, byte size, identity and shape", () => {
    expect(WorkspaceWorkflowMemoriesSchema.parse([lesson])).toEqual([lesson]);
    for (const invalid of [Array(21).fill(lesson), [{ ...lesson, id: "mem_test" }], [{ ...lesson, other: true }], [{ ...lesson, content: { lesson: "界".repeat(6000) } }]]) expect(WorkspaceWorkflowMemoriesSchema.safeParse(invalid).success).toBe(false);
  });
});
