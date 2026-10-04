import * as React from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { type UserRole } from "@/api/types"
import { usePermissions } from "../hooks/usePermissions"
import { RequirePermission } from "./require-permission"

// usePermissionsStore (usePermissions.ts) is a module-level zustand
// singleton. setMockRole applies real, live state -- confirmed via
// useStore.getState() -- but React's SERVER renderer (renderToStaticMarkup,
// used by usePermissions.spec.tsx) reads it through zustand's
// getServerSnapshot, which zustand always resolves to getInitialState():
// the value the store was created with, frozen forever, by design, so
// renderToStaticMarkup can never observe a setMockRole call no matter how
// many times or when it's called (confirmed directly: a fresh
// renderToStaticMarkup call made strictly after a real, observable set()
// still renders the original value). A real @testing-library/react mount
// uses the CLIENT useSyncExternalStore path instead (live getSnapshot), so
// it's what these tests use for the denied-role cases -- matching the
// render/screen/cleanup convention already used elsewhere in this repo
// (see app/router.spec.tsx).
//
// setMockRole is called from useEffect, not directly in the render body:
// zustand's default set() always produces a new state object (even for an
// unchanged value), so calling it unconditionally during render would
// notify subscribers on every render and re-render forever. useEffect
// runs it exactly once per mount; @testing-library/react's render() flushes
// effects synchronously (act()-wrapped), so the role is applied before
// render() returns.
function Setter({ role }: { role: UserRole }) {
  const { setMockRole } = usePermissions()
  React.useEffect(() => {
    setMockRole(role)
  }, [role, setMockRole])
  return null
}

function setRole(role: UserRole) {
  const { unmount } = render(<Setter role={role} />)
  unmount()
}

afterEach(() => {
  cleanup()
  // Reset the singleton back to its documented default so a role set by
  // one test can never leak into the next test in this file (or, if
  // Vitest's isolation ever changes, another file).
  setRole("owner")
})

describe("RequirePermission", () => {
  it("renders children when the current role holds the permission", () => {
    setRole("owner")
    render(
      <RequirePermission permission="credential.manage">
        <button>Store credential</button>
      </RequirePermission>,
    )

    expect(screen.getByText("Store credential")).not.toBeNull()
  })

  it("renders PermissionDenied instead of children when the permission is missing", () => {
    // viewer has credential.read but not credential.manage (roles.ts) --
    // the same permission usePermissions.spec.tsx already uses for its
    // allowed-case test, so allowed vs. denied read as a clear pair.
    setRole("viewer")
    render(
      <RequirePermission permission="credential.manage">
        <button>Store credential</button>
      </RequirePermission>,
    )

    expect(screen.getByText("Access restricted")).not.toBeNull()
    expect(screen.queryByText("Store credential")).toBeNull()
  })
})
