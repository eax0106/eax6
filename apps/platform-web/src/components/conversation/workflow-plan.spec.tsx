import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { WorkflowPlanCard } from "./workflow-plan"

afterEach(cleanup)
const plan = { type: "plan" as const, successCriteria: ["Notify support.", "Archive mail."], steps: [{ key: "notify", type: "tool", description: "Route urgent mail to support", successCriteria: ["Notify support."] }] }
it("shows steps and criteria, edits/adds/removes, and confirms only on Build", () => {
  const build = vi.fn()
  render(<WorkflowPlanCard plan={plan} onBuild={build} pending={false} />)
  expect(screen.getByText("Route urgent mail to support")).toBeTruthy()
  expect(build).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText("Success criterion 1"), { target: { value: "Notify billing." } })
  fireEvent.click(screen.getByRole("button", { name: "Remove criterion 2" }))
  fireEvent.click(screen.getByRole("button", { name: "Add criterion" }))
  expect((screen.getByRole("button", { name: "Build" }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText("Success criterion 2"), { target: { value: "  File a report.  " } })
  fireEvent.click(screen.getByRole("button", { name: "Build" }))
  expect(build).toHaveBeenCalledWith(["Notify billing.", "File a report."])
})
it("permits removing all criteria and disables an old or pending plan", () => {
  const build = vi.fn(), view = render(<WorkflowPlanCard plan={plan} onBuild={build} pending={false} />)
  fireEvent.click(screen.getByRole("button", { name: "Remove criterion 2" }))
  fireEvent.click(screen.getByRole("button", { name: "Remove criterion 1" }))
  fireEvent.click(screen.getByRole("button", { name: "Build" }))
  expect(build).toHaveBeenCalledWith([])
  view.rerender(<WorkflowPlanCard plan={plan} onBuild={build} pending={true} />)
  expect(screen.getByRole("button", { name: "Build" }).closest("fieldset")?.disabled).toBe(true)
})
