# Configured extra-credit purchases

The Billing Overview lets the current tenant owner buy execution credits for
the current paid plan. The displayed price is the plan's configured INR minor
unit price per credit, with 18% GST rounded once on the entire quantity and no
added gateway fee. Credits per verified run is shown separately. Missing
configuration makes checkout unavailable; development and demo never invent a
paid price or submit a live charge.

The request carries only quantity, displayed plan version and optional GSTIN.
The server locks current active membership, paid entitlement and configuration,
then records an immutable quote, actual caller, request fingerprint and revision.
An acknowledged central audit precedes the local commit. A stable caller request
key permits identical retries; a changed request conflicts. One unresolved
purchase per tenant prevents blind repeat checkout after provider uncertainty.
Central audit acknowledgement and local commit are separate durable operations.

The adapter creates a Razorpay Payment Link using the durable purchase id as
its unique reference, with partial payments, reminders and customer notifications
disabled. Its reference lookup and named reads validate actual tenant, link,
amount, currency, GSTIN and captured payment evidence. Nested payment receipts
are bound to that validated parent checkout; an explicit link id must match,
while documented receipts that omit it remain valid. Only a matching fully
paid purchase enqueues its original credit quantity through the existing Engine
delivery. A lost or malformed acknowledgement retains the same payment key and
quantity for recovery. Delivery is shown only after the durable outbox records
the acknowledged grant. Buying credits does not change subscription access.

Manual payment refresh requires the displayed exact revision and an empty body.
Signed raw provider webhooks can reconcile the same purchase. Provider operations
have a five-second response deadline; a background reconciler reserves durable
backoff and processes bounded batches. Tenant reads and writes use the ordinary
database identity under forced row security; due inventory alone uses
`OPERATIONS_PLATFORM_DATABASE_URL`, with the existing local database fallback.
Only active tenants enter that bounded inventory; suspended tenants become due
again after reactivation, without occupying work that scoped writes cannot take.

The page reloads configured price, subscription, balance and purchase history,
preserves quantity and GSTIN input, and uses GET recovery after uncertainty.
Only validated actual Razorpay HTTPS checkout links are rendered. A return URL
never confirms payment. Pending confirmation, pending delivery, delivered,
unavailable, empty and demo states have distinct messages.

Migration `0038_credit_purchases.sql` has paired rollback, immutable snapshots,
append-only events and guarded erasure. Nonempty downgrade is refused. Tenant
erasure removes purchase history through the exact active manifest helper while
preserving other tenants. The existing legal hold retains only the minimal
tax record for its statutory window, without actor or GSTIN.

Verification exercises ordinary PostgreSQL,
actual tenant sessions, central audit HTTP, the deployed role kit, signed
notifications, real Engine grants and rendered live UI. Full suites, coverage
and 23 behavioral fault controls protect these outcomes. Fresh verification
passed all six acceptance gates on the repaired source. Exact-head CI remains
required before merge.
