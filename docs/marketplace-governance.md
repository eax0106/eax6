# Marketplace review, corrections and advisory risk

D27 risk is an advisory queue ordering, never a publication decision. The
existing exact-version clean scan and first-version staff review requirements
still decide whether publication can proceed.

Risk reasons use observed records only. The bounded score adds these weights:

- Current scanner verdict: blocked 35; findings 20; clean 0.
- Seller's actual first listing: 15.
- Declared outside actions: 20 when present.
- Declared account scopes: 15 when present.
- Recorded prior takedowns: 10 each, capped at 25.

The total is capped at 100. Error, unavailable or absent scans contribute no
invented finding; they mark the score incomplete. Unrecorded action/scope data
also remain explicit. Zero with complete evidence is distinct from zero with
missing evidence. Reasons identify scanner evidence and declared actions/scopes.
Historical takedowns count attributed staff governance actions across the
seller's listings and tool manifests. Owner tool revocations, negative reviews
and a seller deleting a draft do not count. Reports are not inferred from review
comments. The queue preserves missing-signal warnings alongside scores.

The queue ranks the full eligible population before selecting its highest-risk
200 resources. Equal scores use oldest update then resource ID. Tool evidence
comes from each active version's current scan-report pointer and recorded
declarations. Unknown custom capabilities leave outside-action evidence
incomplete. Listings without linked scanner/declaration records expose those
signals as missing. Risk never approves, publishes or withdraws a resource.

## Review and seller corrections

Staff decisions require the current locked resource revision in `If-Match` and
a reason containing 1–1000 characters. Requested changes retain the reviewer's
identity and reason in append-only history. They keep a resource out of approval
until its owner edits and explicitly resubmits it into review. Seller edits
save actual name/description fields and append their own attributed reason;
edits and resubmission each return a new revision. Current tenant membership
and owner role apply at request time. An unrelated tenant cannot read or change
the resource or its history.

Tool scans remain separate from approval: a clean scan during requested changes
stays pending, and direct version review is refused until seller resubmission.
The existing pinned scan and recorded staff decision requirements remain in
force. Listings remain free-only and require an actual version for publication.

The live reviewer screen displays numeric risk, evidence, missing signals,
review notes and a bounded decision reason. Tool approval uses its exact-version
review controls. Seller listing review displays notes and lets the owner save
corrections and resubmit their saved revision. Failed writes and conflicts
remain visible and require a reload; they never fabricate success. Explicit
demo adapters share their own in-memory correction/history state and never
substitute for a failed live request.

## Persistence, audit and erasure

Marketplace migration `0008` adds row revisions and UUIDv7 governance events.
Ordinary PostgreSQL roles use forced tenant RLS. History has no ordinary update
or delete policy and its trigger rejects privileged mutation as well. Queue
responses include five recent notes per item; seller history is bounded at 100.

Every transition appends local history and requires central audit acknowledgement
before its local transaction commits. Central audit uses a stable reason code
and links the local history ID in its allowed scope; the full human reason stays
in local history. Audit failure rolls back fields, revision and history. This is
acknowledgement before local commit, not a distributed atomic commit: a subsequent
local commit failure can leave a central attempted-action record.

Tenant erasure locks and deletes resources before purging their history in the
same transaction. Only the no-login erasure role's pinned security-definer
function can delete history, and only for the matching active erasure manifest.
Other tenants remain intact. Rollback refuses while any history or requested
changes remain, rather than discarding them to permit downgrade.
