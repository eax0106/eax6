import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { api } from "@/api/client"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"

export function SecuritySettings() {
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">Security</h1>
        <p className="text-text-secondary mt-2">Manage your password and authentication settings.</p>
      </div>

      <PasswordForm />
      <TwoFactorAuth />
    </div>
  )
}

function PasswordForm() {
  const reset = useMutation({ mutationFn: () => api.requestPasswordReset() })
  return <div className="rounded-xl border border-border bg-surface p-6 space-y-4">
    <h3 className="text-lg font-medium">Password reset</h3>
    <p className="text-sm text-text-secondary">Request a password reset email from your identity provider. Google and other social accounts manage passwords with their provider.</p>
    <Button disabled={reset.isPending} onClick={() => reset.mutate()}>
      {reset.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Request password reset
    </Button>
    {reset.isSuccess && <p role="status">Password reset requested. Check your email.</p>}
    {reset.error && <p role="alert" className="text-danger">{reset.error.message}</p>}
  </div>
}

function TwoFactorAuth() {
  const [enabled, setEnabled] = React.useState(false)

  const handleToggle = () => {
    if (!enabled) {
      alert("Authenticator app setup will be connected to the AlterX identity backend later.")
      setEnabled(true)
    } else {
      if (confirm("Are you sure you want to disable two-factor authentication?")) {
        setEnabled(false)
        toast.success("Two-factor authentication disabled")
      }
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface overflow-hidden">
      <div className="px-6 py-5 border-b border-border">
        <h3 className="text-lg font-medium text-text-primary">Two-Factor Authentication</h3>
      </div>
      <div className="px-6 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="font-medium text-text-primary">Authenticator App</h4>
            <p className="text-sm text-text-secondary mt-1 max-w-md">
              Add an additional layer of security to your account by requiring a code from a mobile app when you log in.
            </p>
          </div>
          <Button variant={enabled ? "outline" : "primary"} onClick={handleToggle}>
            {enabled ? "Disable 2FA" : "Enable 2FA"}
          </Button>
        </div>
      </div>
    </div>
  )
}
