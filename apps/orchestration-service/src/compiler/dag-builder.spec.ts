import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CompilerValidationError,
  compileTaskSkeletonToDag,
  parseTaskSkeleton,
  type TaskSkeleton,
} from "./dag-builder";

it("compiles the deterministic digest with its aggregation and external-action gates", () => {
  const definition = JSON.parse(readFileSync(resolve(__dirname,
    "../../../intelligence-service/src/capability_registry/templates/v5/04-weekly-report-digest.json"), "utf8"));
  // Template instantiation resolves the catalogue placeholder before compile.
  definition.skeleton.nodes.find((node: { key: string }) => node.key === "send_digest").config.credential_ref =
    "/alter/local/tenant/ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab/integration/email/access-token";
  const dag = compileTaskSkeletonToDag(parseTaskSkeleton(JSON.stringify(definition.skeleton)), "v1");
  expect(dag.nodes.find(node => node.key === "totals")).toMatchObject({
    type: "Merge", config: { record_aggregation: { records_field: "records" } },
  });
  expect(dag.edges).toContainEqual(expect.objectContaining({ from: "totals", to: "summarise" }));
  expect(dag.nodes.filter(node => node.config.verification)).toHaveLength(2);
  expect(dag.nodes.find(node => node.key === "send_digest")?.config.arguments).toMatchObject({
    body: { $from: "digest", path: "body" },
  });
});

function sequentialSkeleton(): TaskSkeleton {
  return {
    version: "1",
    entry_point: "node_a",
    nodes: [
      { key: "node_a", type: "llm", config: {}, depends_on: [] },
      { key: "node_b", type: "tool", config: { component: "Provisioning" }, depends_on: ["node_a"] },
      { key: "node_c", type: "llm", config: {}, depends_on: ["node_b"] },
    ],
  };
}

function managerWorkerSkeleton(): TaskSkeleton {
  return {
    version: "1",
    entry_point: "node_manager",
    nodes: [
      { key: "node_manager", type: "llm", config: {}, depends_on: [] },
      { key: "node_worker_a", type: "llm", config: {}, depends_on: ["node_manager"] },
      { key: "node_worker_b", type: "llm", config: {}, depends_on: ["node_manager"] },
      {
        key: "node_join",
        type: "join",
        config: {},
        depends_on: ["node_worker_a", "node_worker_b"],
      },
    ],
  };
}

// Skeleton with a Gate node that has two conditional branches.
function branchingSkeleton(): TaskSkeleton {
  return {
    version: "1",
    entry_point: "node_gate",
    nodes: [
      {
        key: "node_gate",
        type: "branch",
        config: {
          conditions: {
            node_yes: "output.score > 0.8",
            node_no: "output.score <= 0.8",
          },
        },
        depends_on: [],
      },
      { key: "node_yes", type: "llm", config: {}, depends_on: ["node_gate"] },
      { key: "node_no", type: "llm", config: {}, depends_on: ["node_gate"] },
    ],
  };
}

describe("parseTaskSkeleton", () => {
  it("parses a well-formed skeleton", () => {
    const json = JSON.stringify(sequentialSkeleton());

    expect(parseTaskSkeleton(json)).toEqual(sequentialSkeleton());
  });

  it("rejects invalid JSON", () => {
    expect(() => parseTaskSkeleton("{not json")).toThrow(CompilerValidationError);
  });

  it("rejects JSON that does not match the TaskSkeleton shape", () => {
    expect(() => parseTaskSkeleton(JSON.stringify({ foo: "bar" }))).toThrow(
      CompilerValidationError,
    );
  });

  it("rejects an unknown node type", () => {
    const bad = { ...sequentialSkeleton() };
    bad.nodes = [{ ...bad.nodes[0]!, type: "unknown" as never }];
    expect(() => parseTaskSkeleton(JSON.stringify(bad))).toThrow(CompilerValidationError);
  });
});

describe("compileTaskSkeletonToDag", () => {
  // -------------------------------------------------------------------------
  // Existing PLAN-9 tests (unchanged)
  // -------------------------------------------------------------------------

  it("produces one node per skeleton node with mapped types", () => {
    const dag = compileTaskSkeletonToDag(sequentialSkeleton(), "v1");

    expect(dag.nodes.map((n) => [n.key, n.type])).toEqual([
      ["node_a", "LLMTask"],
      ["node_b", "ToolCall"],
      ["node_c", "LLMTask"],
      ["verify_step_0", "Gate"],
    ]);
    for (const node of dag.nodes) {
      expect(node.metadata).toEqual({ ui: {} });
    }
  });

  it("carries schema_version through from the caller", () => {
    const dag = compileTaskSkeletonToDag(sequentialSkeleton(), "dag-schema-v3");

    expect(dag.schema_version).toBe("dag-schema-v3");
  });

  it("carries supplied success criteria onto the matching compiled node", () => {
    const skeleton = parseTaskSkeleton(JSON.stringify({
      ...sequentialSkeleton(),
      success_criteria: ["Workflow is ready for review."],
      nodes: [
        { ...sequentialSkeleton().nodes[0], success_criteria: ["Plan is ready for review."] },
        ...sequentialSkeleton().nodes.slice(1),
      ],
    }));

    const dag = compileTaskSkeletonToDag(skeleton, "v1");

    expect(dag.nodes.find((node) => node.key === "node_a")?.success_criteria).toEqual([
      "Plan is ready for review.",
    ]);
    expect(dag.success_criteria).toEqual(["Workflow is ready for review."]);
  });

  it("compiles legacy skeletons without success criteria", () => {
    const dag = compileTaskSkeletonToDag(sequentialSkeleton(), "v1");

    expect(dag.nodes.every((node) => node.success_criteria === undefined)).toBe(true);
  });

  it("preserves canonical ToolCall credential_ref into compiled config", () => {
    const skeleton = sequentialSkeleton();
    skeleton.nodes[1] = {
      ...skeleton.nodes[1]!,
      config: {
        tool_name: "search.web",
        arguments: { query: "AlterX" },
        credential_ref:
          "/alter/prod/tenant/ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab/integration/search/access-token",
      },
    };

    const dag = compileTaskSkeletonToDag(skeleton, "v1");

    expect(dag.nodes.find((node) => node.key === "node_b")?.config).toMatchObject({
      tool_name: "search.web",
      credential_ref:
        "/alter/prod/tenant/ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab/integration/search/access-token",
    });
  });

  it("sets entry_node_keys to the skeleton's entry_point", () => {
    const dag = compileTaskSkeletonToDag(sequentialSkeleton(), "v1");

    expect(dag.entry_node_keys).toEqual(["node_a"]);
  });

  it("synthesizes one sequential edge per depends_on pair", () => {
    const dag = compileTaskSkeletonToDag(sequentialSkeleton(), "v1");

    expect(dag.edges).toEqual([
      { key: "node_a-to-verify_step_0", from: "node_a", to: "verify_step_0", kind: "sequential" },
      { key: "verify_step_0-to-node_b", from: "verify_step_0", to: "node_b", kind: "conditional", condition: { expression: "true", language: "cel" } },
      { key: "node_a-to-node_b", from: "node_a", to: "node_b", kind: "sequential" },
      { key: "node_b-to-node_c", from: "node_b", to: "node_c", kind: "sequential" },
    ]);
  });

  it("marks edges into a join node as kind=merge", () => {
    const dag = compileTaskSkeletonToDag(managerWorkerSkeleton(), "v1");

    const joinEdges = dag.edges.filter((e) => e.to === "node_join");
    expect(joinEdges).toHaveLength(2);
    for (const edge of joinEdges) {
      expect(edge.kind).toBe("merge");
    }
  });

  it("computes sequential waves for a linear chain", () => {
    const dag = compileTaskSkeletonToDag(sequentialSkeleton(), "v1");

    expect(dag.waves).toEqual([
      { key: "wave_0", order: 0, node_keys: ["node_a"], depends_on: [] },
      { key: "wave_1", order: 1, node_keys: ["verify_step_0"], depends_on: ["wave_0"] },
      { key: "wave_2", order: 2, node_keys: ["node_b"], depends_on: ["wave_0", "wave_1"] },
      { key: "wave_3", order: 3, node_keys: ["node_c"], depends_on: ["wave_2"] },
    ]);
  });

  it("groups parallel workers into the same wave", () => {
    const dag = compileTaskSkeletonToDag(managerWorkerSkeleton(), "v1");

    expect(dag.waves).toEqual([
      { key: "wave_0", order: 0, node_keys: ["node_manager"], depends_on: [] },
      {
        key: "wave_1",
        order: 1,
        node_keys: ["node_worker_a", "node_worker_b"],
        depends_on: ["wave_0"],
      },
      { key: "wave_2", order: 2, node_keys: ["node_join"], depends_on: ["wave_1"] },
    ]);
  });

  it("every node belongs to exactly one wave", () => {
    const dag = compileTaskSkeletonToDag(managerWorkerSkeleton(), "v1");

    const waveNodeKeys = dag.waves.flatMap((w) => w.node_keys);
    expect(waveNodeKeys.sort()).toEqual(dag.nodes.map((n) => n.key).sort());
  });

  it("rejects an entry_point that does not exist", () => {
    const skeleton = { ...sequentialSkeleton(), entry_point: "does_not_exist" };
    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(CompilerValidationError);
  });

  it("rejects an entry_point node that has dependencies", () => {
    const skeleton = sequentialSkeleton();
    skeleton.nodes[0] = { ...skeleton.nodes[0]!, depends_on: ["node_c"] };
    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(CompilerValidationError);
  });

  it("rejects a duplicate node key", () => {
    const skeleton = sequentialSkeleton();
    skeleton.nodes.push({ key: "node_a", type: "tool", config: {}, depends_on: [] });
    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(CompilerValidationError);
  });

  it("rejects a depends_on referencing an unknown node", () => {
    const skeleton = sequentialSkeleton();
    skeleton.nodes[1] = { ...skeleton.nodes[1]!, depends_on: ["node_missing"] };
    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(CompilerValidationError);
  });

  it("rejects a dependency cycle", () => {
    const skeleton: TaskSkeleton = {
      version: "1",
      entry_point: "node_a",
      nodes: [
        { key: "node_a", type: "tool", config: {}, depends_on: [] },
        { key: "node_b", type: "tool", config: {}, depends_on: ["node_c"] },
        { key: "node_c", type: "tool", config: {}, depends_on: ["node_b"] },
      ],
    };
    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(CompilerValidationError);
  });

  it("produces a single-node DAG for a single-node skeleton", () => {
    const skeleton: TaskSkeleton = {
      version: "1",
      entry_point: "only",
      nodes: [{ key: "only", type: "llm", config: {}, depends_on: [] }],
    };
    const dag = compileTaskSkeletonToDag(skeleton, "v1");

    expect(dag.nodes).toHaveLength(1);
    expect(dag.edges).toEqual([]);
    expect(dag.waves).toEqual([
      { key: "wave_0", order: 0, node_keys: ["only"], depends_on: [] },
    ]);
  });

  it("inserts a verification Gate before every external action edge", () => {
    const dag = compileTaskSkeletonToDag(sequentialSkeleton(), "v1");
    const gate = dag.nodes.find((node) => node.key === "verify_step_0");

    expect(gate).toMatchObject({
      type: "Gate",
      config: { verification: { source_node_key: "node_a", protected_node_key: "node_b" } },
    });
    expect(dag.edges).toContainEqual({
      key: "verify_step_0-to-node_b", from: "verify_step_0", to: "node_b",
      kind: "conditional", condition: { expression: "true", language: "cel" },
    });
  });

  it("rejects an external action entry point with no output to verify", () => {
    const skeleton: TaskSkeleton = {
      version: "1", entry_point: "unsafe", nodes: [{ key: "unsafe", type: "tool", config: {}, depends_on: [] }],
    };
    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(/no upstream output exists to verify/);
  });

  // -------------------------------------------------------------------------
  // PLAN-10: Conditional edges (Gate / branch nodes)
  // -------------------------------------------------------------------------

  it("synthesizes conditional edges from a Gate node", () => {
    const dag = compileTaskSkeletonToDag(branchingSkeleton(), "v1");

    const gateEdges = dag.edges.filter((e) => e.from === "node_gate");
    expect(gateEdges).toHaveLength(2);
    for (const edge of gateEdges) {
      expect(edge.kind).toBe("conditional");
      expect(edge.condition).toBeDefined();
      expect(edge.condition?.language).toBe("cel");
    }
  });

  it("attaches the correct CEL expression to each conditional edge", () => {
    const dag = compileTaskSkeletonToDag(branchingSkeleton(), "v1");

    const toYes = dag.edges.find((e) => e.to === "node_yes");
    const toNo = dag.edges.find((e) => e.to === "node_no");

    expect(toYes?.condition?.expression).toBe("output.score > 0.8");
    expect(toNo?.condition?.expression).toBe("output.score <= 0.8");
  });

  it("rejects a Gate node with missing condition for a successor", () => {
    const skeleton: TaskSkeleton = {
      version: "1",
      entry_point: "gate",
      nodes: [
        {
          key: "gate",
          type: "branch",
          // condition for node_b is absent
          config: { conditions: { node_a: "output.flag == true" } },
          depends_on: [],
        },
        { key: "node_a", type: "llm", config: {}, depends_on: ["gate"] },
        { key: "node_b", type: "llm", config: {}, depends_on: ["gate"] },
      ],
    };

    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(CompilerValidationError);
    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(/node_b/);
  });

  it("rejects a Gate node whose conditions reference a non-successor", () => {
    const skeleton: TaskSkeleton = {
      version: "1",
      entry_point: "gate",
      nodes: [
        {
          key: "gate",
          type: "branch",
          config: {
            conditions: {
              node_a: "output.flag == true",
              ghost: "output.flag == false", // 'ghost' does not depend_on gate
            },
          },
          depends_on: [],
        },
        { key: "node_a", type: "llm", config: {}, depends_on: ["gate"] },
      ],
    };

    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(CompilerValidationError);
    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(/ghost/);
  });

  it("rejects a Gate node with an empty-string CEL expression", () => {
    const skeleton: TaskSkeleton = {
      version: "1",
      entry_point: "gate",
      nodes: [
        {
          key: "gate",
          type: "branch",
          config: { conditions: { node_a: "   " } }, // blank after trim
          depends_on: [],
        },
        { key: "node_a", type: "llm", config: {}, depends_on: ["gate"] },
      ],
    };

    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(CompilerValidationError);
  });

  it("rejects a Gate node with a non-object conditions value", () => {
    const skeleton: TaskSkeleton = {
      version: "1",
      entry_point: "gate",
      nodes: [
        {
          key: "gate",
          type: "branch",
          config: { conditions: ["not an object"] },
          depends_on: [],
        },
        { key: "node_a", type: "llm", config: {}, depends_on: ["gate"] },
      ],
    };

    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(CompilerValidationError);
  });

  it("allows a Gate node with no successors and no conditions", () => {
    const skeleton: TaskSkeleton = {
      version: "1",
      entry_point: "gate",
      nodes: [
        { key: "gate", type: "branch", config: {}, depends_on: [] },
      ],
    };

    const dag = compileTaskSkeletonToDag(skeleton, "v1");
    expect(dag.edges).toHaveLength(0);
  });

  it("non-Gate nodes ignore a conditions key in their config", () => {
    const skeleton: TaskSkeleton = {
      version: "1",
      entry_point: "node_a",
      nodes: [
        {
          key: "node_a",
          type: "llm",
          config: { conditions: { node_b: "irrelevant" } },
          depends_on: [],
        },
        { key: "node_b", type: "llm", config: {}, depends_on: ["node_a"] },
      ],
    };

    const dag = compileTaskSkeletonToDag(skeleton, "v1");
    expect(dag.edges[0]?.kind).toBe("sequential");
  });

  // -------------------------------------------------------------------------
  // PLAN-10: metadata.ui pocket
  // -------------------------------------------------------------------------

  it("passes metadata_ui through to compiled node metadata.ui", () => {
    const skeleton: TaskSkeleton = {
      version: "1",
      entry_point: "node_a",
      nodes: [
        {
          key: "node_a",
          type: "llm",
          config: {
            component: "Provisioning",
            metadata_ui: { position_x: 100, position_y: 200, label: "Provision" },
          },
          depends_on: [],
        },
      ],
    };

    const dag = compileTaskSkeletonToDag(skeleton, "v1");

    expect(dag.nodes[0]?.metadata.ui).toEqual({
      position_x: 100,
      position_y: 200,
      label: "Provision",
    });
  });

  it("strips metadata_ui from compiled node config", () => {
    const skeleton: TaskSkeleton = {
      version: "1",
      entry_point: "node_a",
      nodes: [
        {
          key: "node_a",
          type: "llm",
          config: { component: "Provisioning", metadata_ui: { x: 1 } },
          depends_on: [],
        },
      ],
    };

    const dag = compileTaskSkeletonToDag(skeleton, "v1");

    expect(dag.nodes[0]?.config).not.toHaveProperty("metadata_ui");
    expect(dag.nodes[0]?.config).toEqual({ component: "Provisioning" });
  });

  it("defaults metadata.ui to empty object when metadata_ui absent", () => {
    const dag = compileTaskSkeletonToDag(sequentialSkeleton(), "v1");

    for (const node of dag.nodes) {
      expect(node.metadata.ui).toEqual({});
    }
  });

  it("rejects metadata_ui that is not a plain object", () => {
    const skeleton: TaskSkeleton = {
      version: "1",
      entry_point: "node_a",
      nodes: [
        {
          key: "node_a",
          type: "llm",
          config: { metadata_ui: "not an object" },
          depends_on: [],
        },
      ],
    };

    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(CompilerValidationError);
    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(/metadata_ui must be a plain object/);
  });

  it("rejects metadata_ui that is an array", () => {
    const skeleton: TaskSkeleton = {
      version: "1",
      entry_point: "node_a",
      nodes: [
        {
          key: "node_a",
          type: "tool",
          config: { metadata_ui: [1, 2, 3] },
          depends_on: [],
        },
      ],
    };

    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(CompilerValidationError);
  });

  it("rejects metadata_ui with a reserved $-prefixed key", () => {
    const skeleton: TaskSkeleton = {
      version: "1",
      entry_point: "node_a",
      nodes: [
        {
          key: "node_a",
          type: "tool",
          config: { metadata_ui: { "$internal": "secret" } },
          depends_on: [],
        },
      ],
    };

    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(CompilerValidationError);
    expect(() => compileTaskSkeletonToDag(skeleton, "v1")).toThrow(/reserved prefix/);
  });

  it("accepts metadata_ui with arbitrary JSON-serializable values", () => {
    const skeleton: TaskSkeleton = {
      version: "1",
      entry_point: "node_a",
      nodes: [
        {
          key: "node_a",
          type: "llm",
          config: {
            metadata_ui: {
              position: { x: 10, y: 20 },
              tags: ["a", "b"],
              visible: true,
              count: 0,
              note: null,
            },
          },
          depends_on: [],
        },
      ],
    };

    const dag = compileTaskSkeletonToDag(skeleton, "v1");

    expect(dag.nodes[0]?.metadata.ui).toEqual({
      position: { x: 10, y: 20 },
      tags: ["a", "b"],
      visible: true,
      count: 0,
      note: null,
    });
  });
});

describe("compileTaskSkeletonToDag branch into a verified action", () => {
  const classify: TaskSkeleton["nodes"][number] = { key: "classify", type: "llm", config: {}, depends_on: [] };
  const route = (conditions: Record<string, string>): TaskSkeleton["nodes"][number] => ({
    key: "route", type: "branch", config: { conditions }, depends_on: ["classify"],
  });

  it("routes the branch to the action's verification gate, keyed by the gate", () => {
    const dag = compileTaskSkeletonToDag({
      version: "1",
      entry_point: "classify",
      nodes: [classify, route({ issue_refund: "inputs.classify.refund" }), { key: "issue_refund", type: "tool", config: {}, depends_on: ["route"] }],
    }, "v1");

    // GateHandler names active successors by condition key. Keyed only by the
    // action, the branch never activated the gate in between, so the action
    // could never run.
    const routeConfig = dag.nodes.find((node) => node.key === "route")?.config as { conditions: Record<string, string> };
    expect(routeConfig.conditions).toEqual({ issue_refund: "inputs.classify.refund", verify_step_0: "inputs.classify.refund" });
    expect(dag.edges.find((edge) => edge.from === "route" && edge.to === "verify_step_0")).toMatchObject({
      kind: "conditional", condition: { expression: "inputs.classify.refund" },
    });
    expect(dag.edges.filter((edge) => edge.to === "issue_refund")).toEqual([
      { key: "verify_step_0-to-issue_refund", from: "verify_step_0", to: "issue_refund", kind: "conditional", condition: { expression: "true", language: "cel" } },
    ]);
  });

  it("chains one gate per input so only the last one enters the action", () => {
    const dag = compileTaskSkeletonToDag({
      version: "1",
      entry_point: "classify",
      nodes: [
        classify,
        route({ send: "inputs.classify.ok" }),
        { key: "draft", type: "llm", config: {}, depends_on: ["classify"] },
        { key: "send", type: "tool", config: {}, depends_on: ["route", "draft"] },
      ],
    }, "v1");

    expect(dag.nodes.find((node) => node.key === "verify_step_0")?.config).toMatchObject({ verification: { source_node_key: "route", protected_node_key: "verify_step_1" } });
    expect(dag.nodes.find((node) => node.key === "verify_step_1")?.config).toMatchObject({ verification: { source_node_key: "draft", protected_node_key: "send" } });
    expect(dag.edges.filter((edge) => edge.to === "verify_step_0").map((edge) => [edge.from, edge.kind])).toEqual([["route", "conditional"], ["draft", "sequential"]]);
    expect(dag.edges.filter((edge) => edge.to === "verify_step_1").map((edge) => [edge.from, edge.kind])).toEqual([["verify_step_0", "conditional"]]);
    expect(dag.edges.filter((edge) => edge.to === "send").map((edge) => [edge.from, edge.kind])).toEqual([["verify_step_1", "conditional"], ["draft", "sequential"]]);
    const waveOf = (key: string) => dag.waves.find((wave) => wave.node_keys.includes(key))!.order;
    expect(waveOf("verify_step_0")).toBeGreaterThan(Math.max(waveOf("route"), waveOf("draft")));
    expect(waveOf("send")).toBeGreaterThan(waveOf("verify_step_1"));
  });
});
