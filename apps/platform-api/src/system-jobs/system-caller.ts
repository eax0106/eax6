import { SYSTEM_PLATFORM_JOBS_PRINCIPAL } from "@alterx/contracts";
import type { EngineCallerContext } from "../engine/types";

/**
 * The system caller (D1, design log §30 amendment).
 *
 * Platform work with no user signed in (notification producers, budget
 * alerts, drift suggestions) reaches the engine as `system:platform-jobs` on
 * the ordinary two-token path. The identity broker mints the actor token only
 * for a context recognised here, and a context is recognised only if this
 * module made it: the registry below is private, so an object built anywhere
 * else -- from request data, say -- can never become a system caller, however
 * it is shaped.
 *
 * Only background jobs may import this file. `system-caller.spec.ts` fails if
 * a controller does.
 */
const systemContexts = new WeakSet<object>();

export function createSystemCallerContext(input: {
  tenantId: string;
  traceparent: string;
}): EngineCallerContext {
  const context: EngineCallerContext = Object.freeze({
    userId: SYSTEM_PLATFORM_JOBS_PRINCIPAL,
    tenantId: input.tenantId,
    workspaceId: "",
    sessionId: "system-platform-jobs",
    authTime: Math.floor(Date.now() / 1000),
    roles: ["system"],
    permissions: [],
    traceparent: input.traceparent,
  });
  systemContexts.add(context);
  return context;
}

export function isSystemCallerContext(context: EngineCallerContext): boolean {
  return systemContexts.has(context);
}
