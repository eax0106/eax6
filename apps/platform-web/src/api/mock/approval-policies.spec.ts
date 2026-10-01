import { expect, it } from "vitest"
import { getMockApprovalPolicies as getApprovalPolicies, setMockApprovalPolicy as setApprovalPolicy } from "./approval-policies"
import { ApiHttpError } from "../http"
it("mirrors explicit confirmation, timeout validation and current ETag writes", async () => {
  const workflow = "wf_01JXYZ123"
  const initial = (await getApprovalPolicies(workflow)).policies[0]!
  const change = { mode: "auto" as const, skipOnTimeout: true, timeoutSeconds: 120 }
  await expect(setApprovalPolicy(workflow, initial.nodeKey, change, initial.etag)).rejects.toThrow(/consequence/)
  await expect(setApprovalPolicy(workflow, initial.nodeKey, { ...change, timeoutSeconds: 59 }, initial.etag)).rejects.toThrow(/timeout/)
  const saved = await setApprovalPolicy(workflow, initial.nodeKey, { ...change, confirmConsequence: initial.sideEffectConsequence! }, initial.etag)
  expect(saved).toMatchObject({ mode: "auto", timeoutSeconds: 120, autoConfirmedBy: "mock-user", promotionSuggested: false })
  expect(saved.etag).not.toBe(initial.etag)
  await expect(setApprovalPolicy(workflow, initial.nodeKey, change, initial.etag)).rejects.toBeInstanceOf(ApiHttpError)
  saved.mode = "ask"
  expect((await getApprovalPolicies(workflow)).policies[0]!.mode).toBe("auto")
})
