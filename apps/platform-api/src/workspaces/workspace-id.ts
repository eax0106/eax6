const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The database holds bare workspace UUIDs; other surfaces (the engine, the
 * actor token, ids shown to people) use the `ws_` form. Both name the same
 * workspace. Anything else is not a workspace id, and the caller answers
 * not-found rather than letting Postgres reject it as a server error.
 */
export function bareWorkspaceId(workspaceId: string): string | undefined {
  const bare = workspaceId.startsWith("ws_") ? workspaceId.slice("ws_".length) : workspaceId;
  return UUID.test(bare) ? bare : undefined;
}
