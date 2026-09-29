import type { EngineCallerContext } from "../../engine";

/** Injection token for the list of producers the runner walks each pass. */
export const ENGINE_EVENT_PRODUCERS = Symbol("ENGINE_EVENT_PRODUCERS");

export interface EngineEventProducerContext {
  readonly tenantId: string;
  /** The system principal's caller context (D1): read-only, this tenant only. */
  readonly caller: EngineCallerContext;
  readonly now: Date;
}

/**
 * Turns something the engine reports about a tenant into notifications. A
 * producer reads through `context.caller` only, and must be safe to run again
 * over the same happening: it dedupes with a key, it does not remember.
 */
export interface EngineEventProducer {
  readonly name: string;
  /** Returns how many notifications this pass created. */
  produce(context: EngineEventProducerContext): Promise<number>;
}

/** The engine names workspaces `ws_<uuid>`; platform_db holds the bare uuid. */
export function bareId(prefix: string, value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.startsWith(`${prefix}_`) ? value.slice(prefix.length + 1) : value;
}
