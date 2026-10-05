# Marketplace review risk

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
Historical takedowns count actual recorded actions or tool revocations, not
negative reviews or a seller deleting a draft. Reports are not inferred from
review comments. The queue preserves missing-signal warnings alongside scores.

Needs-changes, reviewer notes, seller resubmission, storage integration and
live UI remain under implementation in C127. This document defines the scoring
rules; it is not completion evidence for those remaining outcomes.
