import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { NodeHandlerValidationError } from "../handler";
import { MergeHandler } from "./merge.handler";

const aggregation = { records_field: "records", group_field: "type", amount_field: "amount" };
const golden = JSON.parse(readFileSync(resolve(__dirname,
  "../../../../intelligence-service/tests/weekly_digest_golden.json"), "utf8")) as {
  name: string; records: { type: string; amount: number }[]; expected: Record<string, unknown>;
}[];

describe("MergeHandler", () => {
  it("has nodeType Merge", () => {
    expect(new MergeHandler().nodeType).toBe("Merge");
  });

  it("merges every upstream output into one object", async () => {
    const handler = new MergeHandler();

    const result = await handler.execute({
      config: {},
      inputs: {
        node_a: { x: 1 },
        node_b: { y: 2 },
      },
    });

    expect(result.output).toEqual({ x: 1, y: 2 });
  });

  it("resolves key collisions by ascending upstream node key", async () => {
    const handler = new MergeHandler();

    const result = await handler.execute({
      config: {},
      inputs: {
        node_a: { shared: "from-a" },
        node_z: { shared: "from-z" },
      },
    });

    expect(result.output).toEqual({ shared: "from-z" });
  });

  it("returns an empty object for no upstream inputs", async () => {
    const handler = new MergeHandler();

    const result = await handler.execute({ config: {}, inputs: {} });

    expect(result.output).toEqual({});
  });

  it.each(golden)("aggregates $name exactly in the input units", async ({ records, expected }) => {
    const result = await new MergeHandler().execute({
      config: { record_aggregation: aggregation }, inputs: { intake: { records } },
    });
    expect(result.output).toEqual(expected);
  });

  it("rounds the final sum, not each record", async () => {
    const result = await new MergeHandler().execute({
      config: { record_aggregation: aggregation },
      inputs: { intake: { records: [{ type: "a", amount: 1.005 }, { type: "a", amount: 0.005 }] } },
    });
    expect(result.output).toEqual({ included: 2, by_type: { a: { count: 2, total: 1.01 } } });
  });

  it("retains computed totals when merging an untrusted summary", async () => {
    const totals = golden[0]!.expected;
    const result = await new MergeHandler().execute({ config: {}, inputs: {
      summarise: { body: "2 orders totaling 350.00 and 1 refund totaling 50.00.", included: 0, by_type: {} },
      totals,
    } });
    expect(result.output).toEqual({ ...totals, body: "2 orders totaling 350.00 and 1 refund totaling 50.00." });
  });

  it.each(["100", null, NaN, Infinity, 1e21])("rejects invalid or unsafe amounts: %s", async (amount) => {
    await expect(new MergeHandler().execute({
      config: { record_aggregation: aggregation }, inputs: { intake: { records: [{ type: "a", amount }] } },
    })).rejects.toBeInstanceOf(NodeHandlerValidationError);
  });

  it("rejects a total whose JSON number spelling would lose a cent", async () => {
    await expect(new MergeHandler().execute({
      config: { record_aggregation: aggregation },
      inputs: { intake: { records: [{ type: "a", amount: 90071992547409.9 }, { type: "a", amount: 0.01 }] } },
    })).rejects.toBeInstanceOf(NodeHandlerValidationError);
  });

  it("handles scientific notation and prototype-shaped group names as data", async () => {
    const result = await new MergeHandler().execute({
      config: { record_aggregation: aggregation },
      inputs: { intake: { records: [{ type: "__proto__", amount: 1e-7 }] } },
    });
    expect(Object.keys(result.output.by_type as object)).toEqual(["__proto__"]);
    expect((result.output.by_type as Record<string, unknown>)["__proto__"]).toEqual({ count: 1, total: 0 });
  });

  it("rejects malformed aggregation configuration", async () => {
    await expect(new MergeHandler().execute({ config: { record_aggregation: {} }, inputs: {} }))
      .rejects.toBeInstanceOf(NodeHandlerValidationError);
  });

  it.each([{}, { records: null }, { records: [null] }, { records: [{ type: 2, amount: 10 }] }])(
    "rejects malformed record data: %j", async (input) => {
      await expect(new MergeHandler().execute({ config: { record_aggregation: aggregation }, inputs: { intake: input } }))
        .rejects.toBeInstanceOf(NodeHandlerValidationError);
    },
  );
});
