# Staff security review assignment

D26's security queue reads recorded abuse signals and allows current staff_admin
and staff_security reviewers to assign or reassign an open review to an actual
active eligible staff member. The picker is served by the existing staff-cookie
and RBAC path. Deactivated staff and other roles are excluded. The server derives
the actor from the authenticated current staff session; request bodies cannot
supply attribution. Live transport errors never switch the queue to demo data.

Assignment and review decision requests require the exact signal ETag in
If-Match. Missing preconditions return 428, changed revisions return 412, and
closed reviews or unavailable assignees return 409. The transaction establishes
the named tenant context, locks the live tenant FOR SHARE, locks the signal FOR
UPDATE and checks its current revision. It locks the chosen eligible staff row
FOR SHARE. These locks remain until the mandatory central audit acknowledgement
and database commit. Audit failure rolls back the updated signal, revision and
local action history. Concurrent requests with the same revision allow one
successful write; the second must reload.

Migration 0036 adds assignment fields and a monotonic revision trigger. Refresh
writes also advance the revision, so old review forms cannot overwrite newly
recorded evidence. Existing reviews and identifiers remain readable. New signal
and action identifiers use prefixed UUIDv7. Assignment remains open in storage;
the console labels an assigned open review as investigating. A decision closes
the existing signal and preserves its assignment. This feature does not create
or synthesize evidence, reopen a closed review, or automatically decide abuse.

The current assignment retains the full human reason, actor and timestamp.
Every assignment or decision appends a separate immutable action with its own
revision and full reason, including up to 1,000 Unicode characters. Central
audit uses stable reason codes and the local history reference in its supported
scope payload. History has ordinary-role FORCE RLS and a composite tenant/signal
foreign key. Its append-only trigger refuses privileged mutation too. Tenant
erasure removes it through the dedicated function, owned by the existing
non-login erasure role, with a matching active tenant manifest. The deletion
registry, subject locator and tenant erasure path include the new table.
Workspace erasure retains tenant-level security reviews. Rollback refuses to
remove retained action history or assignments; an unused migration can be
reverted without rewriting legacy review evidence.

The console displays the actual assignee, current eligibility and recorded
reason, offers an actual eligible picker, requires a bounded human reason, and
sends the exact displayed revision for assignment and decisions. Loading, empty,
picker failure, failed write and unavailable queue have distinct states. Failed
writes retain the unsaved reason and selected staff member; reviewers can reload
current records explicitly. Closed rows expose no mutation actions. Demo mode
uses explicitly fictional staff and versioned in-memory records.

Verification uses migrated PostgreSQL with an ordinary NOSUPERUSER/NOBYPASSRLS
role, current staff middleware and real guards, parallel HTTP writes, rendered
live/demo UI, actual central audit HTTP schema validation and native tenant
erasure/rollback. Auth0 userinfo and audit storage are controlled edges; the
audit transport, validation and acknowledgements are exercised locally. The
previous queue fails the recorded assignment DOM case. Independent fault tests
must fail normally, restore exact source bytes, then rerun their positive check.
Full local gates and exact-head CI are required before merge. D26 billing
operations and tenant deployments remain separate roadmap work.
