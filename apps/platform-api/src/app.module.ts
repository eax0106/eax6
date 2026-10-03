import { Module } from "@nestjs/common";
import { PlatformWorkflowChatModule } from "./workflow-chat/platform-workflow-chat.module";
import { DbModule } from "./db/db.module";
import { AbuseModule } from "./abuse/abuse.module";
import { EntitlementsModule } from "./entitlements/entitlements.module";
import { HealthController } from "./health/health.controller";
import { IdentityBrokerModule } from "./identity-broker/identity-broker.module";
import { IdentityModule } from "./identity/identity.module";
import { EnforcingRbacModule } from "./rbac/rbac.module";
import { MembersModule } from "./members/members.module";
import { SignupModule } from "./signup/signup.module";
import { TenantsModule } from "./tenants/tenants.module";
import { WorkspacesModule } from "./workspaces/workspaces.module";
import { OnboardingModule } from "./onboarding/onboarding.module";
import { EngineModule } from "./engine/engine.module";
import { PlannerFacadeModule } from "./planner-facade/planner-facade.module";
import { IdempotencyModule } from "./idempotency/idempotency.module";
import { StreamingModule } from "./streaming/streaming.module";
import { WorkflowModule } from "./workflows/workflow.module";
import { ProjectModule } from "./projects/project.module";
import { RunModule } from "./runs/run.module";
import { EventModule } from "./events/event.module";
import { ActionCentreModule } from "./action-centre/action-centre.module";
import { CredentialModule } from "./credentials";
import { AdsModule } from "./ads";
import { IntegrationModule } from "./integrations";
import { TriggerModule } from "./triggers";
import { BillingModule } from "./billing";
import { EnvVarModule } from "./env-vars";
import { RepositoryModule } from "./repositories";
import { BudgetModule } from "./budgets";
import { RunRetentionModule } from "./run-retention/run-retention.module";
import { WorkspaceExportModule } from "./workspace-export";
import { CostsModule } from "./costs/costs.module";
import { WhatsappModule } from "./channels/whatsapp/whatsapp.module";
import { MarketplaceModule } from "./marketplace";
import { PublisherModule } from "./publisher";
import { I18nModule } from "./i18n/i18n.module";
import { RegistryModule } from "./registry";
import { PlatformDeletionModule } from "./deletion/platform-deletion.module";
import { NotificationModule } from "./notifications";
import { EngineEventNotificationModule } from "./notifications/engine-events/engine-event-notification.module";
import { MediaModule } from "./media";
import { DiscoveryModule } from "./discovery/discovery.module";
import { SearchModule } from "./search";
import { StaffModule } from "./staff";
import { CliModule } from "./cli";
import { SystemHealthModule } from "./system-health/system-health.module";
import { AdminTenantsModule } from "./admin-tenants";
import { AdminUsersModule } from "./admin-users";
import { AdminPolicyModule } from "./admin-policy";
import { BenchmarksModule } from "./benchmarks";
import { AuditEventsModule } from "./audit-events";
import { IncidentModule } from "./incidents";
import { AdminControlsModule } from "./admin-controls";
import { MarketplaceGovernanceModule } from "./marketplace-governance";
import { AdminDeploymentModule } from "./admin-deployments";

@Module({
  imports: [
    DbModule,
    IdentityModule,
    IdentityBrokerModule,
    EnforcingRbacModule,
    EntitlementsModule,
    AbuseModule,
    SignupModule,
    TenantsModule,
    WorkspacesModule,
    MembersModule,
    OnboardingModule,
    EngineModule,
    PlannerFacadeModule,
    IdempotencyModule,
    StreamingModule,
    WorkflowModule,
    PlatformWorkflowChatModule,
    ProjectModule,
    RunModule,
    EventModule,
    ActionCentreModule,
    CredentialModule,
    AdsModule,
    IntegrationModule,
    TriggerModule,
    BillingModule,
    CostsModule,
    EnvVarModule,
    RepositoryModule,
    BudgetModule,
    RunRetentionModule,
    WorkspaceExportModule,
    WhatsappModule,
    MarketplaceModule,
    PublisherModule,
    I18nModule,
    RegistryModule,
    NotificationModule,
    PlatformDeletionModule,
    EngineEventNotificationModule,
    MediaModule,
    DiscoveryModule,
    SearchModule,
    StaffModule,
    CliModule,
    SystemHealthModule,
    AdminTenantsModule,
    AdminUsersModule,
    AdminPolicyModule,
    BenchmarksModule,
    AuditEventsModule,
    IncidentModule,
    AdminControlsModule,
    MarketplaceGovernanceModule,
    AdminDeploymentModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
