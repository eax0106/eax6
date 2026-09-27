import { NavLink, useLocation } from "react-router-dom"
import { adminSectionFor, isLiveFeatureAvailable } from "@/features/availability/live-feature-policy"
import { 
  Building2, Users, LifeBuoy, Server, AlertCircle, Shield, 
  Activity, ScrollText, BadgeDollarSign, Store, ToggleLeft, 
  Search, PanelLeftClose, PanelLeft, Home
} from "lucide-react"
import { cn } from "@/lib/utils"

interface AdminSidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  isMobile?: boolean;
}

const navGroups = [
  {
    title: "Overview",
    items: [
      { name: "Home", href: "/app/admin", icon: Home },
    ]
  },
  {
    title: "Customers",
    items: [
      { name: "Tenants", href: "/app/admin/tenants", icon: Building2 },
      { name: "Users", href: "/app/admin/users", icon: Users },
      { name: "Support Access", href: "/app/admin/support", icon: LifeBuoy },
    ]
  },
  {
    title: "Operations",
    items: [
      { name: "Providers", href: "/app/admin/providers", icon: Server },
      { name: "Deployments", href: "/app/admin/deployments", icon: Activity },
      { name: "Incidents", href: "/app/admin/incidents", icon: AlertCircle },
      { name: "System Status", href: "/app/admin/system-status", icon: Activity },
    ]
  },
  {
    title: "Governance",
    items: [
      { name: "Audit Explorer", href: "/app/admin/audit", icon: ScrollText },
      { name: "Policies", href: "/app/admin/policies", icon: Shield },
      { name: "Security & Abuse", href: "/app/admin/security", icon: Shield },
    ]
  },
  {
    title: "Business & Platform",
    items: [
      { name: "Billing Ops", href: "/app/admin/billing", icon: BadgeDollarSign },
      { name: "Marketplace", href: "/app/admin/marketplace", icon: Store },
      { name: "Feature Flags", href: "/app/admin/feature-flags", icon: ToggleLeft },
    ]
  }
]

export function AdminSidebar({ collapsed, onToggle, isMobile }: AdminSidebarProps) {
  const location = useLocation()

  return (
    <div className={cn(
      "flex flex-col h-full bg-slate-950 text-slate-300 border-r border-slate-800 transition-all duration-300",
      collapsed ? "w-16" : "w-64"
    )}>
      {/* Header */}
      <div className="h-14 flex items-center justify-between px-4 border-b border-slate-800 flex-shrink-0">
        {!collapsed && (
          <div className="flex items-center gap-2 overflow-hidden">
            <div className="w-6 h-6 rounded bg-primary flex items-center justify-center text-white font-bold text-xs flex-shrink-0">
              AX
            </div>
            <span className="font-semibold text-slate-100 truncate">AlterX Admin</span>
          </div>
        )}
        {collapsed && (
          <div className="w-8 h-8 rounded bg-primary flex items-center justify-center text-white font-bold text-sm mx-auto flex-shrink-0">
            AX
          </div>
        )}
        {!isMobile && (
          <button 
            onClick={onToggle}
            className="text-slate-400 hover:text-slate-100 transition-colors hidden md:block"
          >
            {collapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
          </button>
        )}
      </div>

      <div className="p-3">
        <button className={cn(
          "flex items-center gap-2 w-full bg-slate-900 border border-slate-800 rounded-md text-slate-400 hover:text-slate-200 hover:border-slate-700 transition-colors",
          collapsed ? "justify-center h-9" : "px-3 py-1.5"
        )}>
          <Search className="w-4 h-4 flex-shrink-0" />
          {!collapsed && (
            <div className="flex-1 flex items-center justify-between">
              <span className="text-sm">Search admin...</span>
              <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700">⌘K</kbd>
            </div>
          )}
        </button>
      </div>

      {/* Nav */}
      <div className="flex-1 overflow-y-auto py-2 custom-scrollbar">
        {navGroups.map((group, i) => (
          <div key={group.title} className={cn("mb-6", i === 0 && "mt-0")}>
            {!collapsed && (
              <h3 className="px-4 text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                {group.title}
              </h3>
            )}
            <div className="space-y-0.5 px-2">
              {group.items.filter((item) => {
                // Live mode lists only sections whose backend is wired (#212, Track B1).
                const section = adminSectionFor(item.href)
                return section === undefined || isLiveFeatureAvailable(section)
              }).map((item) => {
                const isActive = item.href === "/app/admin" 
                  ? location.pathname === item.href 
                  : location.pathname.startsWith(item.href)
                return (
                  <NavLink
                    key={item.href}
                    to={item.href}
                    className={cn(
                      "flex items-center gap-3 rounded-md transition-colors group relative",
                      collapsed ? "h-10 justify-center" : "px-3 py-2 text-sm",
                      isActive 
                        ? "bg-primary-soft text-primary" 
                        : "text-slate-400 hover:text-slate-100 hover:bg-slate-800/50"
                    )}
                    title={collapsed ? item.name : undefined}
                  >
                    <item.icon className={cn("w-4 h-4 flex-shrink-0", isActive ? "text-primary" : "text-slate-400 group-hover:text-slate-200")} />
                    {!collapsed && <span className="truncate">{item.name}</span>}
                  </NavLink>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      
      {/* Footer */}
      <div className="p-3 border-t border-slate-800">
        <NavLink
          to="/app"
          className={cn(
            "flex items-center gap-3 rounded-md transition-colors group relative",
            collapsed ? "h-10 justify-center" : "px-3 py-2 text-sm",
            "text-slate-400 hover:text-slate-100 hover:bg-slate-800/50"
          )}
          title={collapsed ? "Exit Admin" : undefined}
        >
          <Building2 className="w-4 h-4 flex-shrink-0" />
          {!collapsed && <span>Exit to Workspace</span>}
        </NavLink>
      </div>
    </div>
  )
}
