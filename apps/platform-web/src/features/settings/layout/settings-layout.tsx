import { NavLink, Outlet } from "react-router-dom"
import { Shield, User, MonitorSmartphone, Globe, Building2, Users, Key, ScrollText, LifeBuoy, MapPinned, GitBranch } from "lucide-react"
import { cn } from "@/lib/utils"

const personalNavItems = [
  { name: "Profile", href: "/app/settings/profile", icon: User },
  { name: "Security", href: "/app/settings/security", icon: Shield },
  { name: "Sessions", href: "/app/settings/sessions", icon: MonitorSmartphone },
  { name: "Appearance & Region", href: "/app/settings/language", icon: Globe },
]

const workspaceNavItems = [
  { name: "General", href: "/app/settings/workspace", icon: Building2 },
  { name: "Members", href: "/app/settings/members", icon: Users },
  { name: "Roles", href: "/app/settings/roles", icon: Key },
  { name: "Data residency", href: "/app/settings/data-residency", icon: MapPinned },
  { name: "Repositories", href: "/app/settings/repositories", icon: GitBranch },
  { name: "Audit Logs", href: "/app/settings/audit", icon: ScrollText },
  { name: "Support Access", href: "/app/settings/support", icon: LifeBuoy },
]

export function SettingsLayout() {
  
  // Mobile dropdown simulation (we could use an actual select, but for now we rely on a clean grid or hidden sidebar)
  return (
    <div className="flex h-full flex-col md:flex-row gap-6 lg:gap-10">
      <aside className="w-full shrink-0 md:w-64 space-y-6">
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted px-2">
            Personal
          </h2>
          <nav className="space-y-1">
            {personalNavItems.map((item) => (
              <NavLink
                key={item.href}
                to={item.href}
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
            Workspace
          </h2>
          <nav className="space-y-1">
            {workspaceNavItems.map((item) => (
              <NavLink
                key={item.href}
                to={item.href}
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
      <div className="flex-1 w-full max-w-4xl pb-10">
        <Outlet />
      </div>
    </div>
  )
}
