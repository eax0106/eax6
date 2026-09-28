import { NavLink, Outlet } from "react-router-dom"
import { BarChart3, Receipt, Wallet, CreditCard, Activity, Box } from "lucide-react"
import { cn } from "@/lib/utils"
import { isLiveFeatureAvailable } from "@/features/availability/live-feature-policy"

const usageNavItems = [
  { name: "Overview", href: "/app/usage", icon: Activity },
  { name: "Cost Breakdown", href: "/app/usage/costs", icon: BarChart3 },
  { name: "Budgets", href: "/app/usage/budgets", icon: Wallet },
].filter((item) => item.href !== "/app/usage/budgets" || isLiveFeatureAvailable("budgets"))

const billingNavItems = [
  { name: "Billing Overview", href: "/app/billing", icon: Box },
  { name: "Subscription Plan", href: "/app/billing/plans", icon: Receipt },
  { name: "Payment Method", href: "/app/billing/payment-method", icon: CreditCard },
  { name: "Invoices", href: "/app/billing/invoices", icon: Receipt },
]

export function MoneyLayout() {
  return (
    <div className="flex h-full flex-col md:flex-row gap-6 lg:gap-10 p-8 overflow-y-auto">
      <aside className="w-full shrink-0 md:w-64 space-y-6">
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted px-2">
            Usage
          </h2>
          <nav className="space-y-1">
            {usageNavItems.map((item) => (
              <NavLink
                key={item.href}
                to={item.href}
                end={item.href === "/app/usage" || item.href === "/app/billing"}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                  )
                }
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.name}
              </NavLink>
            ))}
          </nav>
        </div>

        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted px-2">
            Billing
          </h2>
          <nav className="space-y-1">
            {billingNavItems.map((item) => (
              <NavLink
                key={item.href}
                to={item.href}
                end={item.href === "/app/billing"}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                  )
                }
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {item.name}
              </NavLink>
            ))}
          </nav>
        </div>
      </aside>
      <div className="flex-1 w-full max-w-5xl pb-10">
        <Outlet />
      </div>
    </div>
  )
}
