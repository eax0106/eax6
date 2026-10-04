import * as React from "react"
import { Link, useNavigate } from "react-router-dom"
import { useAuth } from "../hooks/useAuth"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"

export function SignIn() {
  const navigate = useNavigate()
  const { signIn } = useAuth()
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [error, setError] = React.useState("")

  async function onSignIn() {
    setIsSubmitting(true)
    setError("")
    try {
      await signIn()
      navigate("/app/dashboard")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign in")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Card>
      <CardHeader className="space-y-1 text-center">
        <CardTitle className="text-2xl">Sign in</CardTitle>
        <CardDescription>
          Continue with your identity provider to access your workspace
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && <p role="alert" className="text-danger mb-3">{error}</p>}
        <Button
          variant="outline"
          type="button"
          className="w-full"
          loading={isSubmitting}
          onClick={onSignIn}
        >
          Continue with identity provider
        </Button>
      </CardContent>
      <CardFooter className="flex flex-col text-center">
        <p className="text-sm text-text-muted">
          Don't have an account?{" "}
          <Link
            to="/auth/sign-up"
            className="font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded-sm"
          >
            Create account
          </Link>
        </p>
      </CardFooter>
    </Card>
  )
}
