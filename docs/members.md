# Workspace members and invitations (D7)

Select the current workspace in the sidebar, then open Members. The page reads
that workspace's memberships and current edit versions. Tenant owner appears as
a separate badge; workspace roles are exactly admin, editor, operator, approver
and viewer. An owner or an admin of that workspace can invite, change a role or
remove a membership. The owner's membership cannot be edited here, and every
workspace must retain an admin. Removal affects only the selected workspace.

Invitations belong to Alter's tenant/workspace record; Auth0 organization
invitations deliver the email. Emails are normalized, invitations expire after
seven days, and only the verified matching provider identity can accept the
current ticket into its assigned workspace role. Acceptance is transactional
and idempotent. Returning sign-in reads current membership rather than granting
it again. The mock provider mirrors ticket expiry, cancellation and acceptance.
Google-only identity does not support organization invitations.

Members shows delivering, pending, delivery failed, expired, accepted and
revoked history. Resend and revoke require the current ETag. A delivery still in
progress refuses a second request; after one minute its record can be retried.
Attempt IDs fence obsolete completions. Failed delivery remains visible and can
be resent. Revoking the local record takes effect even when remote cancellation
is temporarily unavailable. Audit failure rolls back the membership or
invitation mutation. Provider URLs and tickets are never returned by these
member-list routes.

Authenticated routes:

- `GET /api/v1/members?workspaceId=<id>` reads selected workspace members.
- `POST /api/v1/members` accepts `{workspaceId,email,role}` and sends an invite.
- `GET /api/v1/members/invitations?workspaceId=<id>` reads invitation history.
- `POST /api/v1/members/invitations/:id/resend` resends with `If-Match`.
- `DELETE /api/v1/members/invitations/:id` revokes with `If-Match`.
- `PATCH /api/v1/members/:id` accepts `{role}` with `If-Match`.
- `DELETE /api/v1/members/:id?scope=workspace` removes with `If-Match`.
- `GET /api/v1/auth/me` includes current tenant role and active workspace bindings.
- `POST /api/v1/auth/password-reset` requests provider email for the session user.

The application login URL configured in Auth0 must point to `/auth/sign-in`.
The browser preserves the emailed `organization` and `invitation` through PKCE
login, then submits the invitation only after callback state validation. The
Auth0 adapter verifies the signed ID token's issuer, client, subject and
organization before acceptance. Configure Auth0 Management API credentials with
organization invitation creation/cancellation access. Auth0 database password
reset uses the existing `Username-Password-Authentication` connection; social
accounts manage passwords at their own provider. Alter collects no new password.

Migration `0033_workspace_invitations.sql` has forced tenant RLS, compound
workspace scope, one active delivery per workspace/email, paired rollback and
narrow identity-bootstrap functions. Deployment grants only the needed lookup
functions to the ordinary application role. Both tenant and workspace erasure
include invitation history. Native tests use real PostgreSQL through an ordinary
role and real HTTP through session/RBAC guards; only provider/audit edges are
controlled. The live Auth0 account and email delivery still require account
configuration and are not exercised by the local test suite.

Local acceptance: seven gates passed, including twenty distinct failing/restored
fault controls. The full platform suite passed 1,741 tests with 21 conditional
skips and coverage enforcement; database integration passed 98 with one skip,
and web passed 384. Production role grants and public routing checks also ran.
These measurements do not establish delivery by a live Auth0 account.
