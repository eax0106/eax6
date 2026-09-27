
import { NavLink } from "react-router-dom"
import {
  LayoutDashboard,
  GitGraph,
  FolderDot,
  Activity,
  Users,
  MessageSquare,
  BookOpen,
  Link as LinkIcon,
  ShoppingBag,
  CreditCard,
  Settings,
  Shield,
  SquareTerminal,
  Home,
  Inbox,
  Store
} from "lucide-react"
import { cn } from "@/lib/utils"
import { WorkspaceSwitcher } from "./workspace-switcher"
import { useTranslation } from "react-i18next"
import { useState } from "react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { isLiveFeatureAvailable, type LiveFeature } from "@/features/availability/live-feature-policy"
import type { LucideIcon } from "lucide-react"

function SidebarCollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-300">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
      <path d={collapsed ? "M13 16l4-4-4-4" : "M17 16l-4-4 4-4"} />
    </svg>
  )
}

type NavItem = {
  name: string
  href: string
  icon: LucideIcon
  feature?: LiveFeature
}

type NavGroup = {
  label: string
  items: NavItem[]
}

const getNavGroups = (t: any): NavGroup[] => [
  {
    label: "Main",
    items: [
      { name: t("sidebar.home", "Home"), href: "/app/home", icon: Home },
      { name: "Dashboard", href: "/app/dashboard", icon: LayoutDashboard },
      { name: "Conversations", href: "/app/conversations", icon: MessageSquare },
      { name: "Event Inbox", href: "/app/events", icon: Inbox },
    ],
  },
  {
    label: "Build",
    items: [
      { name: t("sidebar.workflows", "Workflows"), href: "/app/workflows", icon: GitGraph },
      { name: t("sidebar.projects", "Projects"), href: "/app/projects", icon: FolderDot },
    ],
  },
  {
    label: "Operate",
    items: [
      { name: t("sidebar.runs", "Runs"), href: "/app/runs", icon: Activity },
      { name: t("sidebar.humanActions", "Human Actions"), href: "/app/human-actions", icon: Users },
    ],
  },
  {
    label: "Data",
    items: [
      { name: t("sidebar.knowledge", "Knowledge Base"), href: "/app/knowledge/sources", icon: BookOpen },
      { name: t("sidebar.connections", "Connections"), href: "/app/connections", icon: LinkIcon },
    ],
  },
  {
    label: "Discover",
    items: [
      { name: t("sidebar.benchmarks", "Benchmarks"), href: "/app/benchmarks", icon: Activity, feature: "benchmarks" },
      { name: t("sidebar.discover", "Discover"), href: "/app/discover", icon: BookOpen, feature: "discovery" },
      { name: t("sidebar.marketplace", "Marketplace"), href: "/app/marketplace", icon: ShoppingBag },
      { name: "Seller Console", href: "/app/seller", icon: Store },
    ],
  },
  {
    label: "Manage",
    items: [
      { name: t("sidebar.usage", "Usage & Billing"), href: "/app/usage", icon: CreditCard },
      { name: "Settings", href: "/app/settings", icon: Settings },
    ],
  },
  {
    label: "Admin",
    items: [{ name: "Admin Console", href: "/app/admin", icon: Shield, feature: "admin-tenants" }],
  },
]

interface SidebarProps {
  className?: string
}

export function Sidebar({ className }: SidebarProps) {
  const { t } = useTranslation("common")
  const [collapsed, setCollapsed] = useState(false)
  const navGroups = getNavGroups(t)
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        item.feature ? isLiveFeatureAvailable(item.feature) : true
      ),
    }))
    .filter((group) => group.items.length > 0)

  return (
    <aside
      className={cn(
        "flex flex-col border-r border-ax-border bg-ax-shell relative transition-all ax-scroll-container",
        collapsed ? "w-[64px]" : "w-[260px]",
        className
      )}
      style={{ transitionDuration: "360ms", transitionTimingFunction: "cubic-bezier(.22,.61,.36,1)" }}
    >
      <div className="flex h-16 shrink-0 items-center justify-between px-4 border-b border-ax-border">
        <div className={cn("flex items-center gap-2 text-primary font-bold text-lg tracking-tight overflow-hidden transition-opacity duration-200", collapsed ? "opacity-0 w-0" : "opacity-100")}>
          <SquareTerminal className="h-5 w-5 shrink-0" />
          <span className="whitespace-nowrap">AlterX</span>
        </div>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="text-text-secondary hover:text-primary p-1.5 rounded-md hover:bg-primary-soft transition-colors shrink-0"
        >
          <SidebarCollapseIcon collapsed={collapsed} />
        </button>
      </div>

      <div className={cn("p-4 border-b border-ax-border overflow-hidden transition-opacity duration-200", collapsed ? "opacity-0 h-0 p-0 border-none" : "opacity-100")}>
        <WorkspaceSwitcher />
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-6 scrollbar-none">
        <TooltipProvider delayDuration={0}>
        {navGroups.map((group) => (
          <div key={group.label} className={cn(collapsed && "flex flex-col items-center")}>
            {!collapsed && (
              <h4 className="mb-2 px-2 text-[11px] font-bold uppercase tracking-wider text-text-muted">
                {group.label}
              </h4>
            )}
            <nav className="space-y-1 w-full">
              {group.items.map((item) => {
                const navItem = (
                  <NavLink
                    key={item.name}
                    to={item.href}
                    className={({ isActive }) =>
                      cn(
                        "group flex items-center gap-3 rounded-md px-2 py-2 text-sm ax-sidebar-hover ax-hover-fill focus-visible:outline-none",
                        isActive
                          ? "bg-primary-soft text-primary font-semibold before:scale-x-100"
                          : "text-text-secondary hover:text-text-primary",
                        collapsed && "justify-center px-0 w-10 h-10 mx-auto"
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <div className={cn("relative shrink-0 flex items-center justify-center", collapsed ? "" : "")}>
                          {isActive && !collapsed && (
                            <div className="absolute -left-2 top-[15%] h-[70%] w-0.5 rounded-r bg-primary" />
                          )}
                          <item.icon className={cn("h-4 w-4 shrink-0 transition-colors duration-300", isActive ? "text-primary" : "group-hover:text-primary")} />
                        </div>
                        <span className={cn(
                          "whitespace-nowrap transition-all duration-200 relative z-10",
                          collapsed ? "opacity-0 w-0 -translate-x-1 hidden" : "opacity-100 translate-x-0"
                        )}>
                          {item.name}
                        </span>
                      </>
                    )}
                  </NavLink>
                )

                if (collapsed) {
                  return (
                    <Tooltip key={item.name}>
                      <TooltipTrigger asChild>
                        {navItem}
                      </TooltipTrigger>
                      <TooltipContent side="right" sideOffset={12} className="bg-ax-surface-raised border-primary/20 text-ax-text font-sans text-xs px-2.5 py-1.5 font-semibold">
                        {item.name}
                      </TooltipContent>
                    </Tooltip>
                  )
                }

                return navItem
              })}
            </nav>
          </div>
        ))}
        </TooltipProvider>
      </div>
    </aside>
  )
}
