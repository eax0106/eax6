# Staff billing operations

D26 uses the existing current staff cookie and requires active `staff_admin` or
`staff_billing_ops`. Select a real named tenant from Billing Operations. Every
write needs a human reason (1–1000 characters) and the displayed exact revision;
missing `If-Match` returns 428, a changed revision returns 412. Reload and reselect
before retrying a stale action. Browser actor attribution is rejected.

## Actions

- **Grant run credits** accepts 1–1,000,000 extra verified runs. The owner confirmed
  that Apply credit means run credits, not a cash adjustment. The server uses the
  current configured paid plan's credits per verified run and bounds the resulting
  quantity at 1,000,000,000 credits. It records the full reason, current staff
  identity, actual run quantity and actual credits. This grants credits without
  charging the customer.
- **Retry payment** reads the actual Razorpay subscription, checks its tenant,
  subscription and plan binding, and returns its actual hosted recovery URL only
  for pending or halted subscriptions. Opening the link lets the customer complete
  recovery. Preparing the link does not confirm payment or change access.
- **Resolve** requires an active, correctly bound provider subscription and the
  latest issued invoice for that subscription: paid, the configured INR total
  including GST, and a payment time within the failed billing period. A newer
  unpaid invoice or an unpaid invoice tied for the latest issue timestamp, incomplete provider page, wrong currency/amount, old payment or
  terminal local subscription refuses resolution. Confirmed recovery updates the
  existing entitlement, billing profile and dunning state in the same transaction.

## History and recovery

The tenant remains locked against deletion while a decision is committed. Current
staff membership is checked and locked again inside that transaction. The billing
profile and dunning rows serialize decisions with the existing webhook lock order.
A mandatory acknowledged central audit event precedes commit. The immutable local
history retains the complete human reason; central audit references that operation.
History reads also require acknowledged central audit.

Credit delivery is durable. The accepted operation and exact credit quantity are
committed together with an outbox entry. Engine delivery always reuses
`staff-credit:bop_<UUIDv7>`. A lost, malformed or failed acknowledgement remains
**pending**; the existing billing synchronizer retries it. A valid duplicate
acknowledgement completes delivery without granting credits again. The UI shows
recorded delivery state and blocks another grant while a prior grant is pending.
Review history before repeating a grant after an uncertain HTTP response.

Each provider read has a five-second deadline. Provider failures return an explicit
502/504, preserve the selected form and reason, and do not advance its revision.
Live failures never become empty or fictional records. Demo records are explicitly
fictional and do not send live requests.

## Storage and deletion

Migration `0037_admin_billing_operations` adds revision tracking, immutable staff
history and exact-quantity delivery bindings. Both new tables enforce ordinary
transaction-scoped tenant FORCE RLS. History update is forbidden; delivery may
record only its first acknowledgement. Registered tenant erasure removes delivery
before history through the active exact-manifest guard and retains other tenants.
Workspace erasure retains tenant billing history. The paired downgrade refuses
retained history or pending delivery; an empty downgrade preserves prior billing
rows and the previous billing issue queue. The revision-aware staff queue has its
own helper, so replaying earlier migrations never changes a function return type.

## Verification

Native tests use actual staff HTTP guards, ordinary PostgreSQL roles, signed audit
gRPC with the production audit application, the Razorpay adapter with a controlled
provider edge, and the real authenticated Engine credit controller over TCP.
Regression cases cover audit rollback, current staff revocation locking, serialized
revisions, unpaid recovery, deadlines, credit limits, uncertain acknowledgement,
exactly-once balances, tenant isolation, actual platform erasure and paired migration
reapplication. Development does not execute live payment charges or email delivery.
