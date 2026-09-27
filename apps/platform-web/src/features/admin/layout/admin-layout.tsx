import { useState, useEffect } from "react"
import { Outlet, Navigate } from "react-router-dom"
import { AdminSidebar } from "./admin-sidebar"
import { usePermissions } from "@/features/permissions/hooks/usePermissions"
import { Topbar } from "@/layout/topbar"
import { isLiveApi } from "@/api/http"
import { StaffGate } from "./staff-gate"

export function AdminLayout() {
  // Live: staff session from the staff identity provider. Mock: the demo permission.
  if (isLiveApi) {
    return (
      <StaffGate>
        <AdminShell />
      </StaffGate>
    )
  }
  return <MockAdminLayout />
}

function MockAdminLayout() {
  const { can } = usePermissions()
  if (!can("admin.access")) {
    return <Navigate to="/app" replace />
  }
  return <AdminShell />
}

function AdminShell() {
  const [collapsed, setCollapsed] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768
      setIsMobile(mobile)
      if (mobile) setCollapsed(false)
    }
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return (
    <div className="flex h-screen bg-slate-950 text-slate-50 overflow-hidden font-sans">
      
      {/* Mobile Sidebar Overlay */}
      {isMobile && mobileMenuOpen && (
        <div 
          className="fixed inset-0 bg-slate-900/50 z-40" 
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div className={`
        ${isMobile ? 'fixed inset-y-0 left-0 z-50 transform transition-transform duration-300' : 'relative z-10'}
        ${isMobile && !mobileMenuOpen ? '-translate-x-full' : 'translate-x-0'}
      `}>
        <AdminSidebar 
          collapsed={!isMobile && collapsed} 
          onToggle={() => setCollapsed(!collapsed)} 
          isMobile={isMobile}
        />
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 h-full relative">
        <Topbar />
        <main className="flex-1 overflow-auto relative">
          <Outlet />
        </main>
      </div>

    </div>
  )
}
