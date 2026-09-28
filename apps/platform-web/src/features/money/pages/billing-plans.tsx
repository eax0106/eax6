import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { PageHeader } from "@/components/common/page-header"
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { api } from "@/api/client"
import { isLiveApi } from "@/api/http"
import { queryKeys } from "@/api/query-keys"
import { formatPlanPeriod, formatProviderMoney } from "../provider-pricing"

export function BillingPlansPage() {
  const queryClient = useQueryClient()
  const plans = useQuery({ queryKey: queryKeys.billing.plans, queryFn: () => api.billing.getPlans() })
  const subscription = useQuery({ queryKey: queryKeys.billing.subscription, queryFn: () => api.billing.getSubscription() })
  const paymentMethod = useQuery({ queryKey: queryKeys.billing.paymentMethod, queryFn: () => api.billing.getPaymentMethod() })
  const subscribe = useMutation({
    mutationFn: ({ planId, paymentMethodRef }: { planId: string; paymentMethodRef: string }) => api.billing.subscribe(planId, paymentMethodRef),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.billing.subscription })
    },
  })
  const change = useMutation({
    mutationFn: (planId: string) => api.billing.changePlan(planId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.billing.subscription })
    },
  })

  if (plans.isLoading || subscription.isLoading) return <div className="p-8 text-muted-foreground animate-pulse">Loading plans...</div>

  return (
    <div className="space-y-8">
      <PageHeader title="Subscription Plans" description={isLiveApi ? "Plans and prices from the billing provider." : "Demo plan catalog."} />
      {(plans.isError || subscription.isError) && <p role="alert" className="text-destructive">Could not load billing plans.</p>}
      {!subscription.data && !subscription.isError && !paymentMethod.data && !paymentMethod.isLoading && <p className="text-sm text-muted-foreground">Add a payment method before subscribing to a plan.</p>}
      {!subscription.data && !subscription.isError && paymentMethod.data && <p className="text-sm text-muted-foreground">Choose a plan to subscribe with the card ending {paymentMethod.data.last4 ?? "on file"}.</p>}
      {change.isError && <p role="alert" className="text-destructive">{change.error.message}</p>}
      {subscribe.isError && <p role="alert" className="text-destructive">{subscribe.error.message}</p>}
      {plans.data?.filter(plan => plan.active).length === 0 && <p className="text-muted-foreground">No plans are available.</p>}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        {plans.data?.filter(plan => plan.active).map(plan => {
          const current = subscription.data?.planId === plan.id
          return (
            <Card key={plan.id} className={current ? "border-primary shadow-md relative" : ""}>
              {current && <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-primary text-primary-foreground text-xs font-medium px-3 py-1 rounded-full">Current Plan</div>}
              <CardHeader>
                <CardTitle>{plan.name}</CardTitle>
                <CardDescription className="h-10">{plan.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <span className="text-3xl font-bold">{formatProviderMoney(plan.amount, plan.currency)}</span>
                <span className="text-muted-foreground text-sm"> {formatPlanPeriod(plan)}</span>
              </CardContent>
              <CardFooter>
                {subscription.data ? (
                  <Button
                    variant={current ? "outline" : "primary"}
                    className="w-full"
                    disabled={current || change.isPending}
                    onClick={() => {
                      if (window.confirm(`Change to ${plan.name} for ${formatProviderMoney(plan.amount, plan.currency)} ${formatPlanPeriod(plan)}?`)) change.mutate(plan.id)
                    }}
                  >
                    {current ? "Current" : "Change Plan"}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    className="w-full"
                    disabled={!paymentMethod.data || subscription.isError || subscribe.isPending}
                    onClick={() => {
                      const method = paymentMethod.data
                      if (method && window.confirm(`Subscribe to ${plan.name} for ${formatProviderMoney(plan.amount, plan.currency)} ${formatPlanPeriod(plan)}?`)) {
                        subscribe.mutate({ planId: plan.id, paymentMethodRef: method.ref })
                      }
                    }}
                  >
                    Subscribe
                  </Button>
                )}
              </CardFooter>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
