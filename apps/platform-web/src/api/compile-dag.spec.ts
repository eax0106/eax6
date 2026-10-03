import { describe, expect, it } from "vitest"

import { compileDag, dagToCanvas, WorkflowGraphCycleError } from "./compile-dag"

const nodes = [
  { id: "trigger", type: "YAMLImport", position: { x: 0, y: 0 }, data: { label: "Trigger" } },
  { id: "review", type: "HumanApproval", position: { x: 0, y: 0 }, data: { label: "Review" } },
  { id: "publish", type: "PubSub", position: { x: 0, y: 0 }, data: { label: "Publish" } },
]

describe("compileDag", () => {
  it("keeps workflow and node criteria outside config through a canvas edit", () => {
    const source = compileDag(nodes, [])
    source.success_criteria = ["Review the invoice."]
    source.nodes[0]!.success_criteria = ["Read the invoice."]
    const canvas = dagToCanvas(source)
    canvas.nodes[0].data.label = "Edited label"
    const result = compileDag(canvas.nodes, canvas.edges, source.success_criteria)
    expect(result.success_criteria).toEqual(source.success_criteria)
    expect(result.nodes[0]!.success_criteria).toEqual(source.nodes[0]!.success_criteria)
    expect(result.nodes[0]!.config).not.toHaveProperty("successCriteria")
  })
  it("compiles a valid DAG into ordered waves", () => {
    const dag = compileDag(nodes, [
      { id: "trigger-review", source: "trigger", target: "review" },
      { id: "review-publish", source: "review", target: "publish" },
    ])

    expect(dag.entry_node_keys).toEqual(["trigger"])
    expect(dag.waves.map((wave) => wave.node_keys)).toEqual([
      ["trigger"],
      ["review"],
      ["publish"],
    ])
  })

  it("rejects a cycle and names only the participating nodes", () => {
    expect(() => compileDag(nodes, [
      { id: "trigger-review", source: "trigger", target: "review" },
      { id: "review-publish", source: "review", target: "publish" },
      { id: "publish-review", source: "publish", target: "review" },
    ])).toThrow("Publish, Review")

    try {
      compileDag(nodes, [
        { id: "trigger-review", source: "trigger", target: "review" },
        { id: "review-publish", source: "review", target: "publish" },
        { id: "publish-review", source: "publish", target: "review" },
      ])
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowGraphCycleError)
      expect((error as WorkflowGraphCycleError).nodeIds).toEqual(["publish", "review"])
    }
  })
})
