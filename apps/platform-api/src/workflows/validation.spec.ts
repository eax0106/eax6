import type { CompiledDag } from "@alterx/contracts";
import { describe, expect, it } from "vitest";
import {
  createWorkflowSchema,
  approvalPolicySchema,
  parseTraceparent,
  parseVersionQuery,
  parseWorkflowId,
  parseWorkflowInput,
  saveCanvasSchema,
  simulateWorkflowSchema,
} from "./validation";

const workflowId = "wf_018f47a5-7b2c-7d10-8f11-123456789abc";
const instance = `/api/v1/workflows/${workflowId}`;

describe("workflow validation", () => {
  it("validates approval modes and timeout controls strictly", () => {
    expect(parseWorkflowInput(approvalPolicySchema, { mode: "ask" }, instance)).toEqual({ mode: "ask", skip_on_timeout: false, timeout_seconds: null });
    for (const input of [{ mode: "yes" }, { mode: "ask", skip_on_timeout: true }, { mode: "ask", timeout_seconds: 59 }, { mode: "ask", timeout_seconds: 2_592_001 }, { mode: "ask", timeout_seconds: 60.5 }, { mode: "auto", confirm_consequence: 42 }, { mode: "ask", set_by: "someone" }]) {
      expect(() => parseWorkflowInput(approvalPolicySchema, input, instance)).toThrow();
    }
  });

  it("accepts typed workflow inputs", () => {
    expect(
      parseWorkflowInput(createWorkflowSchema, { goal: "  Ship flow  " }, instance),
    ).toEqual({ goal: "Ship flow" });
    expect(
      parseWorkflowInput(saveCanvasSchema, { dag: workflowDag() }, instance),
    ).toEqual({ dag: workflowDag() });
    expect(
      parseWorkflowInput(
        simulateWorkflowSchema,
        { input: { amount: 10, nested: { approved: true } } },
        instance,
      ),
    ).toEqual({ input: { amount: 10, nested: { approved: true } } });
  });

  it.each([
    () => parseWorkflowInput(createWorkflowSchema, { goal: "" }, instance),
    () =>
      parseWorkflowInput(
        saveCanvasSchema,
        { dag: { nodes: [] } },
        instance,
      ),
    () =>
      parseWorkflowInput(
        simulateWorkflowSchema,
        { input: undefined },
        instance,
      ),
  ])("returns field errors for invalid input", (parse) => {
    expect(parse).toThrow(
      expect.objectContaining({
        status: 400,
        response: expect.objectContaining({
          error_code: "INVALID_WORKFLOW_REQUEST",
          field_errors: expect.arrayContaining([
            expect.objectContaining({ field: expect.any(String) }),
          ]),
        }),
      }),
    );
  });

  it("validates identifiers, trace context, and version query", () => {
    expect(parseWorkflowId(workflowId, instance)).toBe(workflowId);
    expect(parseTraceparent(undefined, instance)).toBeUndefined();
    expect(
      parseTraceparent(
        "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        instance,
      ),
    ).toContain("00-");
    expect(parseVersionQuery("next", "50", instance)).toBe(
      "?cursor=next&limit=50",
    );
    expect(parseVersionQuery(undefined, undefined, instance)).toBe("");

    expect(() => parseWorkflowId("bad", instance)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          error_code: "INVALID_WORKFLOW_ID",
        }),
      }),
    );
    expect(() => parseTraceparent("bad", instance)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          error_code: "INVALID_TRACE_CONTEXT",
        }),
      }),
    );
    expect(() => parseVersionQuery("", undefined, instance)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          error_code: "INVALID_WORKFLOW_REQUEST",
        }),
      }),
    );
    expect(() => parseVersionQuery(undefined, "201", instance)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          error_code: "INVALID_WORKFLOW_REQUEST",
        }),
      }),
    );
  });
});

function workflowDag(): CompiledDag {
  return {
    schema_version: "1",
    entry_node_keys: ["start"],
    nodes: [
      {
        key: "start",
        type: "LLMTask",
        config: {},
        metadata: { ui: { position: { x: 10, y: 20 } } },
      },
    ],
    edges: [],
    waves: [
      {
        key: "wave-1",
        order: 0,
        node_keys: ["start"],
        depends_on: [],
      },
    ],
  };
}
