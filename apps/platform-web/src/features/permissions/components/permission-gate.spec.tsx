import * as React from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { type UserRole } from "@/api/types"
import { usePermissions } from "../hooks/usePermissions"
import { PermissionGate } from "./permission-gate"

// See require-permission.spec.tsx for the full explanation: renderToStaticMarkup
// can never observe a setMockRole call (zustand's getServerSnapshot always
// resolves to getInitialState()), so a real @testing-library/react mount is
// used instead, and the setter runs from useEffect (not the render body) to
// avoid an infinite render loop from zustand's set() always producing a new
// state reference.
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
  // one test can never leak into the next.
  setRole("owner")
})

describe("PermissionGate", () => {
  it.each(["hide", "disable"] as const)(
    "renders children when the permission is held, regardless of behavior (%s)",
    (behavior) => {
      setRole("owner")
      render(
        <PermissionGate permission="credential.manage" behavior={behavior}>
          <button>Store credential</button>
        </PermissionGate>,
      )

      expect(screen.getByText("Store credential")).not.toBeNull()
    },
  )

  it("hide (the default): renders the default null fallback and not children when the permission is missing", () => {
    setRole("viewer")
    const { container } = render(
      <PermissionGate permission="credential.manage">
        <button>Store credential</button>
      </PermissionGate>,
    )

    expect(screen.queryByText("Store credential")).toBeNull()
    expect(container.innerHTML).toBe("")
  })

  it("hide: renders a custom fallback and not children when the permission is missing", () => {
    setRole("viewer")
    render(
      <PermissionGate permission="credential.manage" fallback={<span>Upgrade required</span>}>
        <button>Store credential</button>
      </PermissionGate>,
    )

    expect(screen.getByText("Upgrade required")).not.toBeNull()
    expect(screen.queryByText("Store credential")).toBeNull()
  })

  it("disable: clones a valid single child with disabled/aria-disabled/title when the permission is missing", () => {
    setRole("viewer")
    render(
      <PermissionGate permission="credential.manage" behavior="disable">
        <button>Store credential</button>
      </PermissionGate>,
    )

    const button = screen.getByText("Store credential") as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute("aria-disabled")).toBe("true")
    expect(button.getAttribute("title")).toBe("You do not have permission to perform this action.")
  })

  it("disable: falls back to fallback (no crash) when children is not a single valid element -- a bare string", () => {
    setRole("viewer")
    render(
      <PermissionGate permission="credential.manage" behavior="disable" fallback={<span>No access</span>}>
        Store credential
      </PermissionGate>,
    )

    expect(screen.getByText("No access")).not.toBeNull()
    expect(screen.queryByText("Store credential")).toBeNull()
  })

  it("disable: falls back to fallback when children is more than one element (not React.isValidElement)", () => {
    setRole("viewer")
    render(
      <PermissionGate permission="credential.manage" behavior="disable" fallback={<span>No access</span>}>
        <button>One</button>
        <button>Two</button>
      </PermissionGate>,
    )

    expect(screen.getByText("No access")).not.toBeNull()
    expect(screen.queryByText("One")).toBeNull()
    expect(screen.queryByText("Two")).toBeNull()
  })
})
