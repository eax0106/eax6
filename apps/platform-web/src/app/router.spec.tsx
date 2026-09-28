// Smoke test for the /app/admin subtree's lazy-loading (perf finding:
// platform-web shipped one ~1.4MB main bundle with almost no code-splitting
// -- see router.tsx). A missing/wrong Suspense boundary here fails silently
// as a blank screen rather than a build error, so this renders the real
// exported router, navigates it to /app/admin the same way a real user
// would, and asserts the lazily-loaded AdminLayout shell actually reaches
// the DOM past the Suspense boundary that wraps it.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, it } from "vitest"
import { RouterProvider } from "react-router-dom"
import { router } from "./router"

afterEach(() => {
  cleanup()
})

describe("admin subtree lazy-loading", () => {
  it("renders the lazily-loaded AdminLayout shell past the Suspense boundary", { timeout: 20_000 }, async () => {
    localStorage.setItem("alterx_auth", "true")
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )

    // router is the real createBrowserRouter singleton -- its initial
    // location is fixed at module-load time, so reaching /app/admin has to
    // go through the router's own navigate() (the same mechanism <Link>/
    // useNavigate use), not a raw window.history.pushState.
    await router.navigate("/app/admin")

    // AdminSidebar renders this brand label regardless of which admin page
    // is loaded -- proves AdminLayout itself (also lazy) resolved and
    // mounted. getByText throws (and waitFor retries) until it's found, so
    // no extra assertion is needed on the result.
    // The first lazy import transforms the whole admin subtree; under a full
    // parallel suite that takes longer than waitFor's 1 s default, so the
    // wait is bounded by the test timeout instead (it still ends the moment
    // the shell mounts).
    await waitFor(() => screen.getByText("AlterX Admin"), { timeout: 15_000 })
  })
})
