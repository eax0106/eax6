import { describe, expect, it } from "vitest"
import { costLabel, parseCaseInput, parseCriteria, passRateLabel } from "./run-format"

describe("benchmark formatting", () => {
  it("describes a run by its state, then its pass rate", () => {
    const run = { status: "completed" as const, passRate: 0.5, passed: 1, caseCount: 2, error: null }
    expect(passRateLabel(run)).toBe("50% passed (1 of 2)")
    expect(passRateLabel({ ...run, status: "running" })).toBe("Running")
    expect(passRateLabel({ ...run, status: "pending" })).toBe("Running")
    expect(passRateLabel({ ...run, status: "failed", error: "No active version" })).toBe("No active version")
    expect(passRateLabel({ ...run, status: "failed" })).toBe("Failed")
    expect(passRateLabel({ ...run, passRate: null })).toBe("No result")
    expect(costLabel(null)).toBe("Not priced")
    expect(costLabel(0.00123)).toBe("$0.0012")
  })

  it("accepts only JSON objects as inputs and one criterion per line", () => {
    expect(parseCaseInput('{"a": 1}')).toEqual({ a: 1 })
    expect(parseCaseInput("[1]")).toBeUndefined()
    expect(parseCaseInput("null")).toBeUndefined()
    expect(parseCaseInput("{")).toBeUndefined()
    expect(parseCriteria(" one \n\n two\n")).toEqual(["one", "two"])
  })
})
