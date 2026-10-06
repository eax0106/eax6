import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { completeConnection } from "@/api/live-connections"
import { queryKeys } from "@/api/query-keys"
import { Button } from "@/components/ui/button"

export function ConnectionCallbackPage() {
  const navigate = useNavigate(), queryClient = useQueryClient()
  const task = useRef<ReturnType<typeof completeConnection> | null>(null)
  const [message, setMessage] = useState("Completing connection authorization…")
  useEffect(() => {
    let active = true
    if (!task.current) {
      const params = new URLSearchParams(location.search)
      // Remove provider code/state from the address bar before making requests.
      history.replaceState(history.state, "", location.pathname)
      task.current = completeConnection(params)
    }
    void task.current.then(result => {
      if (!active) return
      void queryClient.invalidateQueries({ queryKey: queryKeys.connections.list })
      void queryClient.invalidateQueries({ queryKey: queryKeys.connections.detail(result.connectionId) })
      if (result.engineSynced === false) setMessage("Connection saved. Workflow synchronization is pending. Return to your connections to check its status.")
      else navigate(result.returnTo, { replace: true })
    }, () => { if (active) setMessage("Connection authorization failed. Return to your connections and start again.") })
    return () => { active = false }
  }, [navigate, queryClient])
  return <div className="p-8 space-y-4"><p role="status">{message}</p><Button onClick={() => navigate("/app/connections", { replace: true })}>Back to connections</Button></div>
}
