/**
 * ENGINE-FIX-P3-7: role -> permission derivation.
 *
 * Every one of the 101 `@RequirePermission(...)` call sites across the 14
 * controllers that use it pairs the permission string with a role decorator
 * (`@RequireTenantRole` / `@RequireWorkspaceRole`) on the exact same route.
 * That pairing IS the grant: this table is the union, per role, of every
 * permission any route declares that role as sufficient for. No permission
 * is granted here that isn't backed by a real `@RequirePermission` +
 * role-decorator pair in a controller today.
 *
 * Tenant roles (`owner` > `admin` > `billing` > `member`) are rank-checked
 * elsewhere (`tenantRoleAllows`), so a higher-ranked role must inherit
 * every permission a lower-ranked tenant role was granted -- this table
 * bakes that closure in directly rather than re-deriving it at request
 * time. Workspace roles (`admin`/`editor`/`operator`/`approver`/`viewer`)
 * are exact-match only (`workspaceRoleAllows`), so no closure applies
 * there; each role's list is just the routes that literally name it.
 *
 * `admin` is both a tenant role and a workspace role -- unrelated axes
 * that happen to share a name -- so its entry below is the union of both.
 *
 * If a controller's role/permission pairing changes, update this table to
 * match. `rbac.guard.spec.ts` and every controller's own "denies missing
 * permission" tests exercise this table and will fail if it drifts from
 * the routes it's supposed to describe.
 */
const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  owner: [
    "billing:read",
    "billing:write",
    "credential:delete",
    "credential:read",
    "credential:write",
    "knowledge:admin",
    "knowledge:delete",
  ],
  admin: [
    "approvals:decide",
    "billing:read",
    "budgets:write",
    "credential:delete",
    "credential:read",
    "credential:write",
    "escalations:claim",
    "escalations:resolve",
    "human-actions:read",
    "integrations:read",
    "integrations:write",
    "knowledge:admin",
    "knowledge:delete",
    "knowledge:read",
    "media:generate",
    "projects:deploy",
    "projects:read",
    "projects:write",
    "runs:clarifications:answer",
    "runs:read",
    "runs:retention:write",
    "workflows:deploy",
    "workflows:read",
    "workflows:write",
  ],
  billing: ["credential:read"],
  member: ["credential:read"],
  editor: [
    "billing:read",
    "human-actions:read",
    "integrations:read",
    "integrations:write",
    "knowledge:admin",
    "knowledge:read",
    "media:generate",
    "projects:deploy",
    "projects:read",
    "projects:write",
    "runs:read",
    "workflows:read",
    "workflows:write",
  ],
  operator: [
    "approvals:decide",
    "billing:read",
    "escalations:claim",
    "escalations:resolve",
    "human-actions:read",
    "integrations:read",
    "knowledge:read",
    "media:generate",
    "projects:deploy",
    "projects:read",
    "runs:clarifications:answer",
    "runs:read",
    "workflows:read",
    "workflows:write",
  ],
  approver: [
    "approvals:decide",
    "billing:read",
    "escalations:claim",
    "escalations:resolve",
    "human-actions:read",
    "integrations:read",
    "knowledge:read",
    "projects:read",
    "runs:clarifications:answer",
    "runs:read",
    "workflows:read",
  ],
  viewer: [
    "billing:read",
    "human-actions:read",
    "integrations:read",
    "knowledge:read",
    "projects:read",
    "runs:read",
    "workflows:read",
  ],
};

/** Union of every permission granted to any of the given role strings. */
export function permissionsForRoles(roles: readonly string[]): string[] {
  const permissions = new Set<string>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) {
      permissions.add(permission);
    }
  }
  return [...permissions];
}
