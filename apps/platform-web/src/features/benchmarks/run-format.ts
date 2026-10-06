import type { BenchmarkRun } from "@/api/services/benchmarks"

/** A run's outcome in words: its pass rate once complete, else its state. */
export function passRateLabel(run: Pick<BenchmarkRun, "status" | "passRate" | "passed" | "caseCount" | "error">): string {
  if (run.status === "pending" || run.status === "running") return "Running"
  if (run.status === "failed") return run.error ?? "Failed"
  if (run.passRate === null) return "No result"
  return `${Math.round(run.passRate * 100)}% passed (${run.passed} of ${run.caseCount})`
}

export function costLabel(value: number | null): string {
  return value === null ? "Not priced" : `$${value.toFixed(4)}`
}

/** Parses one case's input, which must be a JSON object. */
export function parseCaseInput(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** One success criterion per non-blank line. */
export function parseCriteria(text: string): string[] {
  return text.split("\n").map(line => line.trim()).filter(line => line.length > 0)
}
