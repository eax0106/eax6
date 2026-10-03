import { expect, it } from "vitest";
import { ConfirmWorkflowBuildSchema, WorkflowPlanSchema } from "./workflow-plan";
import { SendWorkflowChatMessageSchema } from "./workflow-chat";

it("accepts an explicitly confirmed complete list, including removing all criteria", () => {
  expect(ConfirmWorkflowBuildSchema.parse({confirm:true,successCriteria:[]})).toEqual({confirm:true,successCriteria:[]});
  expect(WorkflowPlanSchema.parse({type:"plan",successCriteria:["Deliver report."],steps:[{key:"report",type:"llm",description:"Prepare report",successCriteria:["Deliver report."]}]}).steps).toHaveLength(1);
});
it("requires real message identities and rejects blank criteria or extra fields", () => {
  for(const value of [{confirm:true},{confirm:false,successCriteria:[]},{confirm:true,successCriteria:[" "]},{confirm:true,successCriteria:[],constraints:{}}])expect(ConfirmWorkflowBuildSchema.safeParse(value).success).toBe(false);
  expect(SendWorkflowChatMessageSchema.safeParse({content:"Build",build:{planMessageId:"invented",successCriteria:[]}}).success).toBe(false);
  expect(SendWorkflowChatMessageSchema.parse({content:"Build",build:{planMessageId:"msg_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",successCriteria:["Notify support."]}}).build?.successCriteria).toEqual(["Notify support."]);
});
