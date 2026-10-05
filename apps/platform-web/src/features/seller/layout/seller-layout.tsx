import { NavLink, Outlet } from "react-router-dom"
import { BarChart, List, Store } from "lucide-react"
import { cn } from "@/lib/utils"

const sellerNavItems = [
  { name: "Overview", href: "/app/seller", icon: BarChart },
  { name: "Listings", href: "/app/seller/listings", icon: List },
]

export function SellerLayout() {
  return (
    <div className="flex h-full flex-col md:flex-row gap-6 lg:gap-10 p-8 overflow-y-auto bg-surface-raised/30">
      <aside className="w-full shrink-0 md:w-64 space-y-6">
        <div className="flex items-center gap-2 font-bold text-lg text-primary px-2 mb-6">
          <Store className="h-5 w-5" />
          Seller Console
        </div>
        <nav className="space-y-1">
          {sellerNavItems.map((item) => (
            <NavLink
              key={item.href}
              to={item.href}
              end={item.href === "/app/seller"}
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
      </aside>
      <div className="flex-1 w-full max-w-5xl pb-10">
        <Outlet />
      </div>
    </div>
  )
}
