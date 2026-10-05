# Configured subscription billing

Staff configure paid plan definitions at `/api/v1/admin/policy/plans/:plan`.
Read the plan first and send its ETag as `If-Match` when replacing or deleting
it. Only `staff_admin` and `staff_billing_ops` can write; the locked change and
its attributed audit commit together. History is available at `:plan/history`.

The commercial object uses INR and integer minor units:

- `basePriceMinor`: recurring price excluding GST.
- `razorpayPlanId`: the configured Razorpay plan identifier.
- `includedCredits`: credits granted for a captured recurring charge.
- `extraCreditPriceMinor`: configured price for additional credits.
- `creditsPerVerifiedRun`: positive credits consumed by a verified run.

All five values must be configured, with a positive base price, before paid
checkout is available. No default price is inferred. GST is 18 percent, rounded
once in integer minor units; gateway fees are absorbed. The provider plan must
be active, denominated in INR, and match the calculated total including GST.
The extra-credit price is configuration only: this change does not expose an
additional-credit purchase endpoint.

Tenant admins can read `/api/v1/billing/plans`, `/subscription`, `/credits` and
`/invoices`. Tenant owners with billing write permission create subscriptions
with `plan_id`, the current ISO `plan_version`, and an optional validated GSTIN.
Plan changes carry the new plan version and the subscription ETag; changes and
cancellation require `If-Match`. The hosted checkout accepts no card data in
Alter. A checkout attempt grants no paid entitlement before provider activation.

Signed provider callbacks retain their tenant-bound checkout identity and
commercial snapshot. Duplicate, stale and unrelated callbacks cannot grant
credits twice or reopen terminal subscriptions. A failed or uncertain provider
write remains visible; uncertain submissions are reconciled before another
creation is permitted. Payment history retains the original commercial terms.

Run admission reserves configured daily capacity and credits in the same
transaction as creating the run. Manual, triggered and replay starts use this
path. Free-tier admission requires verified email. Credits settle once only
when persisted run-level acceptance confirms a verified outcome. Failed and
unverified outcomes release reservations. Workspace erasure and run retention
settle accepted runs before deleting reservations; tenant-wide credit balances
remain intact when one workspace is erased.

Platform API publishes policy and captured-charge grants to the Engine through
the dedicated `BILLING_SYNC_SERVICE_TOKEN_REF`. Engine verifies the configured
`BILLING_SYNC_SERVICE_TOKEN_SHA256`. Local and EC2 bootstrap generate and retain
this service token; never substitute a user's session or print its value.
Provider credentials and webhook signing credentials remain deployment
configuration. Tests use controlled provider edges; no live payment is claimed.

V1 marketplace publication and installation are free only. Priced listings
cannot be created, edited into a paid offering, published or installed. Free
installations remain available; paid checkout, payouts and KYC UI are retired.
