# Staff tenant detail activity

D26 tenant detail is a read-only projection of actual platform membership,
Engine workflow/run and cost-ledger records. The console retains existing staff
notes and tenant controls. Review assignment, billing operations and tenant
deployments are separate required D26 work.

`GET /api/v1/admin/tenants/:tenantId/activity` uses the current staff session.
The existing read roles are staff_admin, staff_support, staff_billing_ops and
staff_security. An admin or support role requires an active, unrevoked
`tenant:read` JIT grant matching both the current staff member and tenant;
adding another role does not remove that requirement. A deleted or unknown
tenant returns 404. An invalid tenant identifier returns 400.

The platform sets one exact 30-day UTC window ending at its request-time clock.
Both owning services receive the same tenant and window with the existing M2M
credential. Engine's Identity & Tenant Gateway authenticates this endpoint and
requires a service actor; delegated users and system principals cannot assert
an arbitrary tenant. Cost-ledger's existing global service guard authenticates
its endpoint. Neither route is public. Member queries and both service
projections execute under the ordinary database role and named tenant RLS.

The response contains actual total membership and workflow counts, workflows
ordered by most recent update, runs created at or after the start and strictly
before the end, and the total count of those runs. Each list is bounded to 50.
The member projection excludes erased identity records. Workflows include all
stored lifecycle states; their count is not restricted to the run time window.
Counts are independent of the number of rows displayed. Strict shared schemas
reject unexpected fields, inconsistent totals, mismatched scope/windows and
runs outside the requested period.

Spend is execution usage calculated from actual cost events across the tenant's
workspaces during that exact window, grouped by their stored currency. It uses
the ledger's configured canonical integer billing rule on each currency total,
without creating or finalizing a billing rollup. This is a billed usage
projection, not an invoice total; finalized invoices, subscription charges,
credits and refunds are outside it. INR and USD remain separate; no exchange
rate is applied. Arbitrarily large minor units remain decimal strings and the
console formats them without floating-point conversion. Internal costs,
margins and provider breakdowns are absent from the response. An empty currency
list means no recorded cost events; a recorded zero-cost event remains a
currency row with zero amount and its actual event count.

A platform read records the current staff actor and tenant in central audit.
Engine also acknowledges a service-attributed tenant read. Each mandatory audit
acknowledgement precedes a successful response. There is no distributed commit
between those read acknowledgements. Malformed, scope-mismatched, unavailable
or unauthenticated upstream replies become an explicit 502. Audit failure does
not produce a successful detail response. The console exposes loading, empty,
unavailable and reload states and never substitutes demo data after a live
failure. Demo mode serves explicitly fictional records through the same view.

There is no new storage table or migration, and no new retained tenant data.
Existing erasure paths remove the membership, workflow, run and cost records
from which this projection reads. Removing the feature's route/module/UI wiring
reverts the feature without rewriting those records.

Verification exercises actual ordinary PostgreSQL, exact interval boundaries,
more records than the list bound, current staff cookies and scoped grants,
loopback signed JWKS/M2M transport through the real guards, actual audit HTTP
validation and rendered live/demo UI. The earlier page fails the recorded
workflow DOM expectation. Fault controls separately remove scope, boundaries,
billing conversion, revision-independent grant checks, service actor checks,
audit acknowledgements and truthful UI handling, require normal test failure,
restore the source and rerun the positive test. Auth0 userinfo and central audit
storage are controlled test edges; no live Auth0 account or vendor charge is
claimed by these checks. Exact-head CI is required before squash merge.
