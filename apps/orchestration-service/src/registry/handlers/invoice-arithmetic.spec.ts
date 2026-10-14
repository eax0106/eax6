import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { compileTaskSkeletonToDag, parseTaskSkeleton } from "../../compiler/dag-builder";
import { GateHandler } from "./gate.handler";
import { MergeHandler } from "./merge.handler";

const definition = JSON.parse(readFileSync(resolve(__dirname,
  "../../../../intelligence-service/src/capability_registry/templates/v5/03-invoice-to-sheet.json"), "utf8"));
const skeleton = parseTaskSkeleton(JSON.stringify(definition.skeleton));
const compute = skeleton.nodes.find(node => node.key === "compute")!;
const check = skeleton.nodes.find(node => node.key === "check")!;

it("compiles the invoice sum ahead of the gate and preserves external-action verification", () => {
  const dag = compileTaskSkeletonToDag(skeleton, "v1");
  expect(dag.edges).toContainEqual(expect.objectContaining({ from: "compute", to: "check" }));
  expect(dag.nodes.filter(node => node.config.verification)).toHaveLength(2);
});

it.each([
  { name: "decimal sum", net: 0.1, tax: 0.2, total: 0.3, complete: true, route: "add_row" },
  { name: "wrong model sum", net: 500, tax: 45, total: 600, complete: true, route: "hold_for_review" },
  { name: "unknown tax", net: 500, tax: null, total: 545, complete: false, route: "hold_for_review" },
  { name: "unknown amounts", net: null, tax: null, total: null, complete: true, route: "hold_for_review" },
])("invoice routes using deterministic arithmetic: $name", async ({ net, tax, total, complete, route }) => {
  const calculated = await new MergeHandler().execute({ config: compute.config,
    inputs: { extract: { invoice: { net, tax, total }, complete, net_plus_tax: total } },
  });
  const result = await new GateHandler().execute({ config: check.config, inputs: { compute: calculated.output } });
  expect(result.output.activeSuccessors).toEqual([route]);
});
