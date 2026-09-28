import type { CacheProvider } from "@alterx/shared-clients";

/**
 * The eval harness never reads the cache (task C17): a golden-set score must
 * measure the model, and a replayed answer would measure the cache instead.
 * Writes still go through, so the cache path itself is exercised.
 */
export function evalCacheProvider(provider: CacheProvider): CacheProvider {
  return { ...provider, getValue: async () => undefined };
}
