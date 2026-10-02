import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import {
  ActorTokenValidator,
  M2mValidator,
  RedisReplayStore,
  RedisRespSetClient,
  SessionGatewayGuard,
  SessionGatewayRateLimitGuard,
  SessionGatewayUploadAllowlistGuard,
} from "@alterx/auth";

import { runLearningAuditClient } from "./runs/run-learning-audit";
import { SystemPrincipalAuditInterceptor } from "./system-principal-audit.interceptor";
import {
  OrchestrationInfrastructureModule,
  orchestrationStore,
  identityTenantGatewayEnvironment,
} from "./orchestration-infrastructure.module";

/**
 * Owns the three global APP_GUARD registrations in their exact order (plus the
 * system-principal audit interceptor, which runs after all guards) --
 * order is material (SessionGatewayGuard authenticates before the rate
 * limiter and upload allowlist run). Does not register
 * SessionGatewayPromptInjectionGuard (present and tested in
 * packages/auth/session-gateway but never wired into this composition
 * root's guard chain) -- that's a separate, pre-existing security-product
 * gap this refactor deliberately does not fold in, per the design doc's
 * own note under "Evidence and non-goals."
 */
@Module({
  imports: [OrchestrationInfrastructureModule],
  providers: [
    {
      provide: APP_GUARD,
      useFactory: () => {
        const config = identityTenantGatewayEnvironment(process.env);
        const replayStore = new RedisReplayStore(
          new RedisRespSetClient(config.redisUrl),
        );
        return new SessionGatewayGuard(
          new M2mValidator({
            auth0Domain: config.auth0Domain,
            apiAudience: config.apiAudience,
            ...(config.auth0JwksUrl ? { jwksUrl: config.auth0JwksUrl } : {})
          }),
          new ActorTokenValidator(
            {
              issuer: config.actorTokenIssuer,
              audience: config.actorTokenAudience,
              jwksUrl: config.actorTokenJwksUrl,
            },
            replayStore,
          ),
          orchestrationStore(config),
        );
      },
    },
    {
      provide: APP_GUARD,
      useFactory: () => new SessionGatewayRateLimitGuard(),
    },
    {
      provide: APP_GUARD,
      useFactory: () => new SessionGatewayUploadAllowlistGuard(),
    },
    {
      // D1: every read by the system principal is recorded with its type.
      provide: APP_INTERCEPTOR,
      useFactory: () =>
        new SystemPrincipalAuditInterceptor(runLearningAuditClient(process.env)),
    },
  ],
})
export class SecurityModule {}
