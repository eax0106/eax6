import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Loader2, ShieldCheck } from "lucide-react"
import { ApiHttpError } from "@/api/http"
import { getStaffSession, startStaffLogin } from "@/api/staff-auth"
import { Button } from "@/components/ui/button"

/**
 * Live-mode gate for the admin console (task B1.0). The console is staff-only
 * and staff are not tenant users: access comes from a staff session on the
 * dedicated staff identity provider, checked by platform-api, not from a
 * tenant permission.
 */
export function StaffGate({ children }: { children: React.ReactNode }) {
  const [starting, setStarting] = React.useState(false)
  const [startError, setStartError] = React.useState<string | null>(null)
  const session = useQuery({ queryKey: ["staff", "session"], queryFn: getStaffSession, retry: false })

  if (session.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-950">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    )
  }
  if (session.data) return <>{children}</>

  const unauthenticated =
    session.error instanceof ApiHttpError && (session.error.status === 401 || session.error.status === 403)

  return (
    <div className="flex h-screen items-center justify-center bg-slate-950 p-6">
      <div className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-8 text-slate-100">
        <ShieldCheck className="h-8 w-8 text-slate-300" />
        <h1 className="mt-4 text-xl font-semibold">Staff sign-in required</h1>
        <p className="mt-2 text-sm text-slate-400">
          {unauthenticated
            ? "The admin console is for Alter staff. Sign in with your staff account."
            : "The staff session could not be checked. Try again."}
        </p>
        {startError && <p className="mt-3 text-sm text-red-400">{startError}</p>}
        <Button
          className="mt-6 w-full"
          disabled={starting}
          onClick={async () => {
            setStarting(true)
            setStartError(null)
            try {
              await startStaffLogin()
            } catch (error) {
              setStarting(false)
              setStartError(error instanceof Error ? error.message : "Staff sign-in could not start")
            }
          }}
        >
          {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sign in as staff"}
        </Button>
      </div>
    </div>
  )
}
