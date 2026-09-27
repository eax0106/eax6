import * as React from "react"
import { useNavigate, useSearchParams } from "react-router-dom"
import { completeStaffLogin } from "@/api/staff-auth"

/** Finishes staff sign-in (task B1.0) and returns to the admin console. */
export function StaffCallback() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [error, setError] = React.useState<string | null>(null)
  const started = React.useRef(false)

  React.useEffect(() => {
    // StrictMode runs effects twice in development; a code may only be spent once.
    if (started.current) return
    started.current = true
    completeStaffLogin({ code: params.get("code"), state: params.get("state") })
      .then(() => navigate("/app/admin", { replace: true }))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "Staff sign-in failed"))
  }, [navigate, params])

  return (
    <div className="flex h-screen items-center justify-center bg-slate-950 text-slate-200">
      {error ? <p role="alert">{error}</p> : <p>Signing you in…</p>}
    </div>
  )
}
