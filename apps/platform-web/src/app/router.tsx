import { createBrowserRouter, Navigate } from "react-router-dom"
import { lazy, Suspense } from "react"
import { AppShell } from "@/layout/app-shell"
import { AuthLayout } from "@/layout/auth-layout"
import { SignIn } from "@/features/auth/pages/sign-in"
import { SignUp } from "@/features/auth/pages/sign-up"
import { AuthCallback } from "@/features/auth/pages/auth-callback"
import { StaffCallback } from "@/features/admin/pages/staff-callback"
import { OnboardingWizard } from "@/features/onboarding/pages/onboarding-wizard"
import { Dashboard } from "@/features/dashboard/pages"
import { Home, ConversationsList, ConversationDetail } from "@/features/conversations/pages"
import { EventList, EventDetail } from "@/features/events/pages"
import { WorkflowsList } from "@/features/workflows/pages"
import { WorkflowCreate } from "@/features/workflows/pages/workflow-create"
import { WorkflowDetail } from "@/features/workflows/pages/workflow-detail"
import { WorkflowReview } from "@/features/workflows/pages/workflow-review"
import { WorkflowVersions } from "@/features/workflows/pages/workflow-versions"
import { WorkflowSimulation } from "@/features/workflows/pages/workflow-simulation"
import { ProjectsList } from "@/features/projects/pages/projects-list"
import { ProjectCreate } from "@/features/projects/pages/project-create"
import { ProjectDetail } from "@/features/projects/pages/project-detail"
import { ProjectBuild } from "@/features/projects/pages/project-build"
import { RunsList } from "@/features/runs/pages/runs-list"
import { RunDetail } from "@/features/runs/pages/run-detail"
import { ArtifactsList } from "@/features/artifacts/pages/artifacts-list"
import { HumanActionsList } from "@/features/human-actions/pages/human-actions-list"
import { HumanActionDetail } from "@/features/human-actions/pages/human-action-detail"
import { WorkflowHealthList } from "@/features/workflows/pages/workflow-health"
import { RequirePermission } from "@/features/permissions/components/require-permission"

import { ComponentTestPage } from "@/features/dev/components"
import { SettingsLayout } from "@/features/settings/layout/settings-layout"
import { WorkspaceSettings } from "@/features/workspace/pages/workspace-settings"
import { MembersPage } from "@/features/members/pages/members-page"
import { RolesPage } from "@/features/roles/pages/roles-page"
import { ProfileSettings } from "@/features/settings/pages/profile-settings"
import { SecuritySettings } from "@/features/settings/pages/security-settings"
import { SessionsPage } from "@/features/settings/pages/sessions-page"
import { WebhooksPage } from "@/features/settings/pages/webhooks-page"
import { LanguageSettings } from "@/features/settings/pages/language-settings"
import { KnowledgeListPage } from "@/features/knowledge/pages/knowledge-list"
import { SourceDetailPage } from "@/features/knowledge/pages/source-detail"
import { RetrievalTestPage } from "@/features/knowledge/pages/retrieval-test"
import { MemorySettingsPage } from "@/features/knowledge/pages/memory-settings"
import { DataControlsPage } from "@/features/knowledge/pages/data-controls"
import { IntegrationCatalogPage } from "@/features/connections/pages/catalog"
import { ConnectionDetailPage } from "@/features/connections/pages/connection-detail"
import { CredentialsVaultPage } from "@/features/connections/pages/credentials-vault"
import { WhatsAppChannelPage } from "@/features/connections/pages/whatsapp-channel"
import { MoneyLayout } from "@/features/money/layout/money-layout"
import { UsageOverviewPage } from "@/features/money/pages/usage-overview"
import { UsageCostsPage } from "@/features/money/pages/usage-costs"
import { BudgetsPage } from "@/features/money/pages/budgets"
import { BillingOverviewPage } from "@/features/money/pages/billing-overview"
import { BillingPlansPage } from "@/features/money/pages/billing-plans"
import { PaymentMethodPage } from "@/features/money/pages/payment-method"
import { InvoicesPage } from "@/features/money/pages/invoices"
import { MarketplaceLayout } from "@/features/marketplace/layout/marketplace-layout"
import { MarketplaceHomePage } from "@/features/marketplace/pages/marketplace-home"
import { MarketplaceSearchPage } from "@/features/marketplace/pages/marketplace-search"
import { ListingDetailPage } from "@/features/marketplace/pages/listing-detail"
import { MyAssetsPage } from "@/features/marketplace/pages/my-assets"
import { SellerLayout } from "@/features/seller/layout/seller-layout"
import { SellerDashboardPage } from "@/features/seller/pages/seller-dashboard"
import { SellerListingsPage } from "@/features/seller/pages/seller-listings"
import { NewListingPage } from "@/features/seller/pages/new-listing"
import { EarningsPage } from "@/features/seller/pages/earnings"
import { PayoutsPage } from "@/features/seller/pages/payouts"
import { KycPage } from "@/features/seller/pages/kyc"
import { NotificationCentrePage } from "@/features/notifications/pages/notification-centre"
import { NotificationPreferencesPage } from "@/features/settings/pages/notification-preferences"
import { DataResidencySettings } from "@/features/settings/pages/data-residency"
import { RepositorySettings } from "@/features/settings/pages/repositories"
import { DiscoveryPage } from "@/features/discovery/pages/discovery-page"
import { BenchmarkListPage } from "@/features/benchmarks/pages/benchmark-list"
import { CreateBenchmarkPage } from "@/features/benchmarks/pages/create-benchmark"
import { BenchmarkDetailPage } from "@/features/benchmarks/pages/benchmark-detail"
import { SettingsAudit } from "@/features/settings/pages/audit"
import { SettingsSupport } from "@/features/settings/pages/support"
import { NotFound } from "@/components/feedback/not-found"
import { LiveFeatureGate } from "@/features/availability/live-feature-gate"

const WorkflowBuilder = lazy(() =>
  import("@/features/workflows/pages/workflow-builder").then(({ WorkflowBuilder }) => ({
    default: WorkflowBuilder,
  })),
)

// The whole /app/admin subtree is staff-only and an ordinary tenant user
// never navigates here, so it's lazy-loaded as one unit rather than shipped
// in the main bundle. One Suspense boundary wraps the parent route's
// AdminLayout element below -- Suspense catches suspension from any
// descendant, so these children need no Suspense of their own even though
// each is its own lazy() (same mechanism as WorkflowBuilder above, just not
// individually wrapped -- that's the "one boundary for the whole shell"
// part of this).
const AdminLayout = lazy(() =>
  import("@/features/admin/layout/admin-layout").then(({ AdminLayout }) => ({
    default: AdminLayout,
  })),
)
const AdminHome = lazy(() =>
  import("@/features/admin/pages/admin-home").then(({ AdminHome }) => ({ default: AdminHome })),
)
const TenantList = lazy(() =>
  import("@/features/admin/pages/tenants/tenant-list").then(({ TenantList }) => ({
    default: TenantList,
  })),
)
const TenantDetail = lazy(() =>
  import("@/features/admin/pages/tenants/tenant-detail").then(({ TenantDetail }) => ({
    default: TenantDetail,
  })),
)
const UserList = lazy(() =>
  import("@/features/admin/pages/users/user-list").then(({ UserList }) => ({ default: UserList })),
)
const UserDetail = lazy(() =>
  import("@/features/admin/pages/users/user-detail").then(({ UserDetail }) => ({
    default: UserDetail,
  })),
)
const SupportQueue = lazy(() =>
  import("@/features/admin/pages/support-queue").then(({ SupportQueue }) => ({
    default: SupportQueue,
  })),
)
const ProvidersList = lazy(() =>
  import("@/features/admin/pages/operations/providers-list").then(({ ProvidersList }) => ({
    default: ProvidersList,
  })),
)
const DeploymentsList = lazy(() =>
  import("@/features/admin/pages/operations/deployments-list").then(({ DeploymentsList }) => ({
    default: DeploymentsList,
  })),
)
const IncidentsList = lazy(() =>
  import("@/features/admin/pages/operations/incidents-list").then(({ IncidentsList }) => ({
    default: IncidentsList,
  })),
)
const IncidentDetail = lazy(() =>
  import("@/features/admin/pages/operations/incident-detail").then(({ IncidentDetail }) => ({
    default: IncidentDetail,
  })),
)
const SystemStatusPage = lazy(() =>
  import("@/features/admin/pages/operations/system-status").then(({ SystemStatusPage }) => ({
    default: SystemStatusPage,
  })),
)
const AuditExplorer = lazy(() =>
  import("@/features/admin/pages/governance/audit-explorer").then(({ AuditExplorer }) => ({
    default: AuditExplorer,
  })),
)
const PoliciesList = lazy(() =>
  import("@/features/admin/pages/governance/policies-list").then(({ PoliciesList }) => ({
    default: PoliciesList,
  })),
)
const SecurityQueue = lazy(() =>
  import("@/features/admin/pages/governance/security-queue").then(({ SecurityQueue }) => ({
    default: SecurityQueue,
  })),
)
const BillingOpsQueue = lazy(() =>
  import("@/features/admin/pages/platform/billing-ops").then(({ BillingOpsQueue }) => ({
    default: BillingOpsQueue,
  })),
)
const MarketplaceAdmin = lazy(() =>
  import("@/features/admin/pages/platform/marketplace-admin").then(({ MarketplaceAdmin }) => ({
    default: MarketplaceAdmin,
  })),
)
const FeatureFlagsPage = lazy(() =>
  import("@/features/admin/pages/platform/feature-flags").then(({ FeatureFlagsPage }) => ({
    default: FeatureFlagsPage,
  })),
)

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Navigate to="/app/home" replace />,
  },
  {
    // Staff sign-in lands here (task B1.0); staff are not tenant users, so
    // this sits outside /app and its tenant session.
    path: "/staff/callback",
    element: <StaffCallback />,
  },
  {
    path: "/auth",
    element: <AuthLayout />,
    children: [
      { path: "sign-in", element: <SignIn /> },
      { path: "sign-up", element: <SignUp /> },
      { path: "callback", element: <AuthCallback /> },
      { path: "", element: <Navigate to="/auth/sign-in" replace /> },
    ],
  },
  {
    path: "/onboarding",
    element: <OnboardingWizard />,
  },
  {
    path: "/app",
    element: <AppShell />,
    children: [
      { path: "", element: <Navigate to="/app/home" replace /> },
      { path: "home", element: <Home /> },
      { path: "dashboard", element: <Dashboard /> },
      { path: "workflows", element: <WorkflowsList /> },
      { 
        path: "workflows/new", 
        element: <RequirePermission permission="workflow.create"><WorkflowCreate /></RequirePermission> 
      },
      { path: "workflows/:workflowId", element: <WorkflowDetail /> },
      { 
        path: "workflows/:workflowId/build", 
        element: <RequirePermission permission="workflow.update"><Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading workflow builder…</div>}><WorkflowBuilder /></Suspense></RequirePermission>
      },
      { 
        path: "workflows/:workflowId/review", 
        element: <RequirePermission permission="workflow.update"><WorkflowReview /></RequirePermission> 
      },
      { 
        path: "workflows/:workflowId/versions", 
        element: <RequirePermission permission="workflow.update"><WorkflowVersions /></RequirePermission> 
      },
      { 
        path: "workflows/:workflowId/simulation", 
        element: <RequirePermission permission="workflow.run"><WorkflowSimulation /></RequirePermission> 
      },
      {
        path: "workflows/health",
        element: <RequirePermission permission="workflow.read"><WorkflowHealthList /></RequirePermission>
      },
      { path: "projects", element: <ProjectsList /> },
      { 
        path: "projects/new", 
        element: <RequirePermission permission="project.create"><ProjectCreate /></RequirePermission> 
      },
      { path: "projects/:projectId", element: <ProjectDetail /> },
      { 
        path: "projects/:projectId/build", 
        element: <RequirePermission permission="project.run"><ProjectBuild /></RequirePermission> 
      },
      { path: "runs", element: <RequirePermission permission="run.read"><RunsList /></RequirePermission> },
      { path: "runs/:runId", element: <RequirePermission permission="run.read"><RunDetail /></RequirePermission> },
      { path: "artifacts", element: <RequirePermission permission="run.read"><ArtifactsList /></RequirePermission> },
      { 
        path: "human-actions", 
        element: <RequirePermission permission="human_action.read"><HumanActionsList /></RequirePermission> 
      },
      {
        path: "human-actions/:actionId",
        element: <RequirePermission permission="human_action.read"><HumanActionDetail /></RequirePermission>
      },
      { 
        path: "conversations", 
        element: <RequirePermission permission="conversation.read"><ConversationsList /></RequirePermission> 
      },
      { 
        path: "conversations/:conversationId", 
        element: <RequirePermission permission="conversation.read"><ConversationDetail /></RequirePermission> 
      },
      {
        path: "events",
        element: <RequirePermission permission="event.read"><EventList /></RequirePermission>
      },
      {
        path: "events/:eventId",
        element: <RequirePermission permission="event.read"><EventDetail /></RequirePermission>
      },
      { 
        path: "knowledge/sources", 
        element: <RequirePermission permission="knowledge.read"><KnowledgeListPage /></RequirePermission> 
      },
      { 
        path: "knowledge/sources/:id", 
        element: <RequirePermission permission="knowledge.read"><SourceDetailPage /></RequirePermission> 
      },
      { 
        path: "knowledge/retrieval", 
        element: <RequirePermission permission="knowledge.test_retrieval"><RetrievalTestPage /></RequirePermission> 
      },
      { 
        path: "knowledge/memory", 
        element: <RequirePermission permission="knowledge.memory_manage"><MemorySettingsPage /></RequirePermission> 
      },
      { 
        path: "knowledge/data", 
        element: <RequirePermission permission="data.export"><DataControlsPage /></RequirePermission> 
      },
      {
        path: "connections",
        element: <RequirePermission permission="connection.read"><IntegrationCatalogPage /></RequirePermission>
      },
      {
        path: "connections/whatsapp",
        element: <RequirePermission permission="channel.read"><WhatsAppChannelPage /></RequirePermission>
      },
      {
        path: "connections/:id",
        element: <RequirePermission permission="connection.read"><ConnectionDetailPage /></RequirePermission>
      },
      { 
        path: "marketplace", 
        element: <MarketplaceLayout />,
        children: [
          { path: "", element: <MarketplaceHomePage /> },
          { path: "search", element: <MarketplaceSearchPage /> },
          { path: "listings/:listingId", element: <ListingDetailPage /> },
          { path: "my-assets", element: <MyAssetsPage /> },
        ]
      },
      { 
        path: "seller", 
        element: <RequirePermission permission="seller.access"><SellerLayout /></RequirePermission>,
        children: [
          { path: "", element: <SellerDashboardPage /> },
          { path: "listings", element: <SellerListingsPage /> },
          { path: "listings/new", element: <NewListingPage /> },
          { path: "earnings", element: <EarningsPage /> },
          { path: "payouts", element: <PayoutsPage /> },
          { path: "kyc", element: <KycPage /> },
        ]
      },
      { 
        path: "usage", 
        element: <MoneyLayout />,
        children: [
          { path: "", element: <UsageOverviewPage /> },
          { path: "costs", element: <UsageCostsPage /> },
          { path: "budgets", element: <BudgetsPage /> },
        ]
      },
      { 
        path: "billing", 
        element: <MoneyLayout />,
        children: [
          { path: "", element: <BillingOverviewPage /> },
          { path: "plans", element: <BillingPlansPage /> },
          { path: "payment-method", element: <PaymentMethodPage /> },
          { path: "invoices", element: <InvoicesPage /> },
        ]
      },
      { 
        path: "settings", 
        element: <SettingsLayout />,
        children: [
          { path: "", element: <Navigate to="profile" replace /> },
          { path: "profile", element: <ProfileSettings /> },
          { path: "security", element: <SecuritySettings /> },
          { path: "sessions", element: <SessionsPage /> },
          { path: "language", element: <LanguageSettings /> },
          { path: "notifications", element: <LiveFeatureGate feature="notifications"><NotificationPreferencesPage /></LiveFeatureGate> },
          { path: "credentials", element: <RequirePermission permission="credential.read"><CredentialsVaultPage /></RequirePermission> },
          { path: "webhooks", element: <RequirePermission permission="webhook.read"><WebhooksPage /></RequirePermission> },
          { path: "workspace", element: <WorkspaceSettings /> },
          { path: "members", element: <MembersPage /> },
          { path: "roles", element: <RolesPage /> },
          { path: "data-residency", element: <DataResidencySettings /> },
          { path: "repositories", element: <RepositorySettings /> },
          { path: "audit", element: <RequirePermission permission="audit.read"><SettingsAudit /></RequirePermission> },
          { path: "support", element: <SettingsSupport /> },
        ]
      },

      { path: "notifications", element: <LiveFeatureGate feature="notifications"><NotificationCentrePage /></LiveFeatureGate> },
      { path: "discover", element: <LiveFeatureGate feature="discovery"><DiscoveryPage /></LiveFeatureGate> },
      { path: "benchmarks", element: <LiveFeatureGate feature="benchmarks"><BenchmarkListPage /></LiveFeatureGate> },
      { path: "benchmarks/new", element: <LiveFeatureGate feature="benchmarks"><RequirePermission permission="benchmark.create"><CreateBenchmarkPage /></RequirePermission></LiveFeatureGate> },
      { path: "benchmarks/:benchmarkId", element: <LiveFeatureGate feature="benchmarks"><BenchmarkDetailPage /></LiveFeatureGate> },
      { path: "*", element: <NotFound /> },
    ],
  },
  {
    path: "/app/admin",
    element: <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading admin console…</div>}><AdminLayout /></Suspense>,
    children: [
      { path: "", element: <LiveFeatureGate feature="admin-tenants"><AdminHome /></LiveFeatureGate> },
      { path: "tenants", element: <LiveFeatureGate feature="admin-tenants"><TenantList /></LiveFeatureGate> },
      { path: "tenants/:tenantId", element: <LiveFeatureGate feature="admin-tenants"><TenantDetail /></LiveFeatureGate> },
      { path: "users", element: <LiveFeatureGate feature="admin-users"><UserList /></LiveFeatureGate> },
      { path: "users/:userId", element: <LiveFeatureGate feature="admin-users"><UserDetail /></LiveFeatureGate> },
      { path: "support", element: <LiveFeatureGate feature="admin-support"><SupportQueue /></LiveFeatureGate> },
      { path: "providers", element: <LiveFeatureGate feature="admin-providers"><ProvidersList /></LiveFeatureGate> },
      { path: "deployments", element: <LiveFeatureGate feature="admin-deployments"><DeploymentsList /></LiveFeatureGate> },
      { path: "incidents", element: <LiveFeatureGate feature="admin-incidents"><IncidentsList /></LiveFeatureGate> },
      { path: "incidents/:incidentId", element: <LiveFeatureGate feature="admin-incidents"><IncidentDetail /></LiveFeatureGate> },
      { path: "system-status", element: <LiveFeatureGate feature="admin-system-status"><SystemStatusPage /></LiveFeatureGate> },
      { path: "audit", element: <LiveFeatureGate feature="admin-audit"><AuditExplorer /></LiveFeatureGate> },
      { path: "policies", element: <LiveFeatureGate feature="admin-policies"><PoliciesList /></LiveFeatureGate> },
      { path: "security", element: <LiveFeatureGate feature="admin-security"><SecurityQueue /></LiveFeatureGate> },
      { path: "billing", element: <LiveFeatureGate feature="admin-billing"><BillingOpsQueue /></LiveFeatureGate> },
      { path: "marketplace", element: <LiveFeatureGate feature="admin-marketplace"><MarketplaceAdmin /></LiveFeatureGate> },
      { path: "feature-flags", element: <LiveFeatureGate feature="admin-feature-flags"><FeatureFlagsPage /></LiveFeatureGate> },
    ]
  },
  {
    path: "/dev/components",
    element: <ComponentTestPage />,
  },
  {
    path: "*",
    element: <NotFound />,
  },
])
