import { expect, it } from "vitest";
import { WorkflowFolderInputSchema, WorkflowFolderMoveSchema, WorkflowFolderIdSchema } from "./workflow-folders";

it("accepts trimmed names and Ungrouped while rejecting invalid names, identities and extra fields", () => {
  expect(WorkflowFolderInputSchema.parse({ name: " Finance " })).toEqual({ name: "Finance" });
  for (const body of [{ name: " " }, { name: "x".repeat(161) }, { name: "OK", workspaceId: "other" }]) {
    expect(WorkflowFolderInputSchema.safeParse(body).success).toBe(false);
  }
  expect(WorkflowFolderMoveSchema.parse({ folderId: null })).toEqual({ folderId: null });
  expect(WorkflowFolderMoveSchema.safeParse({ folderId: "fld_fake" }).success).toBe(false);
  expect(WorkflowFolderIdSchema.safeParse("wf_019a1b2c-3d4e-7f50-8a61-72839405a6b1").success).toBe(false);
});
