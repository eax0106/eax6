# Hosted public forms

An existing form tool, CRM or website remains the default submission source.
Workflow trigger setup offers an Alter hosted form only when selected. Choose
an existing compiled workflow version, edit its title/description and at most
20 text, long-text, email, number or choice fields, then create the draft.
An administrator with workflow deployment permission can enable its public
link. An unbound draft cannot be enabled. File uploads are unavailable.

Settings show the current public link and definition. Saving fields creates a
new immutable trigger version and replaces the link; prior links stop serving
or accepting submissions. Changes use the displayed version/status ETag, so
another editor's changes produce a conflict. Reload explicitly before retrying
that conflict. An error fetching a newly created link keeps the trigger ID, so
retrying the read cannot create a duplicate form. Form settings do not silently
reload while the editor switches browser tabs.

## Runtime

`public-surface` is a separate Node process. It serves only `/f/<token>` and a
readiness endpoint. It authenticates an opaque AES-GCM capability bound to
one tenant, trigger and immutable trigger version, then checks the current
enabled definition through ordinary tenant RLS. Its `public_surface` database
role receives only scoped trigger/version SELECT columns through migration
0053; it cannot read workflow tables or modify trigger definitions. Initialization
must create that role before the migration, including on an existing volume.
The process checks its runtime role and actual Redis connectivity before startup
and in readiness. Missing configuration or unavailable checks cannot accept a
submission.

The public page escapes all definitions and uses a nonce-based CSP, no-referrer
and no-store. Submission accepts only the declared fields in bounded JSON.
Independent page/submission Redis counters apply form and visitor limits before
expensive work, across replicas. Direct requests ignore forwarded visitor IDs.
The EC2 deployment explicitly trusts its loopback Caddy edge; other proxies must
have a reviewed trust configuration before deployment. Only Caddy's public
ports are opened by the EC2 security group.

Cloudflare Turnstile is verified server-side against the expected hostname,
`public_form` action and form context. Submitted fields then use the shared D15
prompt-injection classifier through Model Gateway. A refused challenge, blocked
input, unavailable classifier or failed event publication returns an error.
Every external call in the native regression tests is identified as a controlled
Cloudflare/model/AWS edge; those tests do not claim a live vendor deployment.

Verified submissions publish the existing canonical trigger event through
EventBridge. The existing canonical consumer calls the engine's CreateRun RPC;
ordinary tenant storage, workspace holds, run budgets and durable queue remain
authoritative. The engine rejects a superseded hosted trigger version before
creating an event/run. Before launching a hosted run, the launcher hydrates its
submitted fields through the existing BlackboardService; the real executor's
entry node receives those fields. Ordinary triggers and event-replay input
retain their existing behavior.

A page keeps one submission UUID across retries. Redis stores only a payload
hash and verified/published receipt for five minutes; it stores no field values
or raw visitor IP. A verified pending retry need not reuse a consumed challenge,
and the engine's durable event idempotency still prevents duplicate runs after
receipt expiration. A retry with different fields under the same UUID is
refused. Publication retries require the submitting client; there is no separate
form outbox. Field values live in the existing event/run/blackboard storage and
follow its tenant erasure paths. Operational hashes expire automatically within
five minutes rather than participating in immediate tenant erasure.

## Deployment configuration

The shared Node image includes `public-surface`; its entrypoint accepts that
service name. EC2 compose starts it independently on port 3021 and Caddy routes
`/f/*` there. Bootstrap keeps a distinct database password and 64-hex-character
capability key in its private `.public-form.env`, reuses them across restarts,
creates the role before migrations and writes the same capability key/origin
for authoring and intake. Rotating that key intentionally invalidates all links.

Fill `PUBLIC_FORM_TURNSTILE_SITE_KEY` and `PUBLIC_FORM_TURNSTILE_SECRET_REF` in
the operator settings. The widget must allow the configured public hostname;
the referenced Secrets Manager value is the Turnstile secret string. Existing
EC2 instance permissions allow environment-scoped Secrets Manager, EventBridge
and Model Gateway access. This task adds no cloud accounts and applies no cloud
infrastructure. EC2 shares one instance identity across its services; dedicated
PostgreSQL grants are verified separately.

For local use, enable the commented `PUBLIC_FORM_TOKEN_KEY` and
`PUBLIC_FORM_BASE_URL` together in the private environment and provide the
`PUBLIC_SURFACE_DATABASE_URL` for its dedicated role. Set the Redis URL,
Turnstile site key/secret reference, Model Gateway address, event bus and AWS
region. Own-source workflows run without the optional authoring key/origin.
Without a public-role password, fresh local database initialization leaves that
role without a usable password; it never borrows another service's credential.

CI runs the app's Nx build/typecheck/lint/test, native ordinary-role PostgreSQL
and real Redis specs, the signed platform-to-engine authoring proof and the
separate HTTP/canonical-consumer/gRPC/real-Temporal execution proof. Bootstrap
and production configuration checks verify the deployed service settings,
credential persistence and refusal of each missing required form setting.
Architecture checks include the new process. Private `.unlazy` acceptance and
mutation scripts measure this build but are not CI wiring.
