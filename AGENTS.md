# AGENTS.md — working on Alter

Instructions for any coding agent (Claude, Codex or another) working in this
repository. Read it fully before your first change. This file holds the rules and
the map, which change rarely. The current state of the work (what is done, what
is next, who is working on what) lives in a handoff note outside the
repository; the repository owner gives you its location.

This repository is public. Nothing sensitive belongs in it, in an issue or in a
pull request: see "Secrets and security" below.

## What Alter is

An autonomous execution platform whose v1 is **Workflow Mode** (build, run and
maintain business workflows). **Project Mode** (build, test, deploy and
maintain software) is deferred under design log §23; keep Sandbox and
Provisioning small so it remains addable on the shared Engine. `README.md` has
the overview and `docs/specs/` the design:

- `00-architecture-decision-context.md`, `01-PRD.md`
- `03-tech-spec-architecture.md`, `04-data-model.md`, `05-api-spec.md`
- `07-env-config-spec.md`, `08-test-plan.md`, `09-deploy-checklist.md`

Treat a spec's claim that something is "operational" as intent until you have
checked the code: several were not.

## Who decides

- The **repository owner** owns architecture and product decisions and decides
  every merge of an agent's pull request. Do not merge unless they have told you
  to, for that pull request.
- A decision the owner has already made stays made. Do not reopen one; if new
  evidence bears on it, report the evidence and let the owner decide.
- A question that is a product choice (what the product should do), not an
  engineering one, goes to the owner with a recommendation. Do not settle it by
  building one answer.
- `satwicc` (Satwik Gogu) is a collaborator who merges his own pull requests.
  They need no review from you.

## Rules that are not negotiable

1. **Every change goes through a pull request.** Branch from an up-to-date
   `origin/main`, commit, push, open the PR with `gh pr create`. `main` is
   protected and direct pushes fail anyway.
2. **Nothing is done until CI says so, and you read CI yourself.** Use
   `gh pr checks <n>` or `gh run watch <run-id> --exit-status`. Never report a
   CI result someone else relayed. Before you report, confirm the PR's head is
   your commit (`gh pr view <n> --json headRefOid`): `gh pr checks` reports on
   whatever the head is.
3. **Squash-merge only, and never delete a branch**: no `--delete-branch`, no
   `--no-verify`, no force-push, ever. Merged branches are the record of how a
   change was built.
4. **One branch per logical change.** Do not bundle unrelated fixes.
5. **`packages/contracts` changes need the owner's explicit approval** before
   merge. Contracts are shared by every service.
6. **Work in your own git worktree**, never in a checkout another agent may be
   using (see "Working alongside other agents").

## Secrets and security

- Never read out, paste, log or commit a secret value: tokens, keys, passwords,
  `.env.local` contents, AWS credentials. Refer to a secret by its name, or to
  the file that holds it by its path.
- A security finding (a vulnerability, a way to bypass authorization or tenant
  isolation, a leak) never goes in a public issue, pull request, commit message
  or code comment. Report it to the owner privately; they file it as a private
  GitHub security advisory.
- A fix that loosens a protection (PII redaction, RBAC, tenant isolation, audit)
  needs the owner's go-ahead first, with the narrowest change that works.

## Repository map

Nx + pnpm monorepo. TypeScript services use NestJS on Fastify; Python services
use FastAPI with `uv`. Node 22 (see `.nvmrc`); Python 3.12.

| Area | Path | Notes |
|---|---|---|
| Web app | `apps/platform-web` | React + Vite. `src/api/live.ts` is the real HTTP client; `client.ts` switches between live and mock data |
| Platform API | `apps/platform-api` | Tenants, workspaces, RBAC, identity broker (actor tokens), action centre, planner facade, safeguards; Drizzle migrations in `src/db/migrations` |
| Orchestration | `apps/orchestration-service` | Compilers (`src/compiler`: skeleton and architecture to CompiledDag), node handlers (`src/registry/handlers`), runs, approvals, recovery; migrations in `drizzle/` with paired `drizzle/rollback/` |
| Intelligence | `apps/intelligence-service` | Planner (`src/planner`), Problem Understanding, architecture synthesizer, selection and binding, Capability Registry (`src/capability_registry`, including `canonical_tools.py`) |
| Model Gateway | `apps/model-gateway` | Every model call: alias routing (FAST, STANDARD, ADVANCED, CEILING), PII redaction (Presidio), semantic cache, cost |
| Tool Gateway | `apps/tool-gateway` | Dispatches exactly the canonical tools in `packages/contracts/src/tool-names.ts` |
| Eval | `apps/eval-service` | Golden sets (`src/db/*golden_set*.py`, seeded by alembic migrations) and the eval orchestrator |
| Others | `apps/*` | ads-core, audit, background-workers, cost-ledger, memory, provisioning, sandbox, verification |
| Contracts | `packages/contracts` | Zod schemas, protos (`proto/`, checked by `buf breaking`), OpenAPI |
| Adapters | `packages/adapters` | Vendor SDKs (AWS, Temporal, Presidio, gRPC clients) and test harnesses (`@alterx/adapters/testing`) |
| Auth, tenancy, shared clients | `packages/auth`, `packages/tenancy`, `packages/shared-clients` | Session gateway guard, actor-token validation, provider interfaces |

`docs/local-dev.md` explains how to run each service locally.

## Architecture rules the code already enforces

- **Vendor SDKs stay in `packages/adapters`.** Application code must not import
  `@temporalio/*` or other vendor SDKs directly; tests use the harnesses in
  `@alterx/adapters/testing` (for example `createExecutorTestHarness`). No
  cross-app relative imports. `scripts/check-architecture-boundaries.sh` fails
  CI on either.
- **Every platform-api route is classified for RBAC** (`@RequireTenantRole`,
  `@RequireWorkspaceRole`, `@RequirePermission` or `@Public`), enforced by
  `scripts/check-rbac-classification.sh`.
- **Tenant isolation is Postgres row-level security** keyed on
  `app.current_tenant_id`, set per transaction (`withTenant`,
  `queryTenant`). Do not add a query that bypasses it.
- **IDs are prefixed UUIDv7** (`ten_`, `ws_`, `usr_`, `run_`, `wf_`, `apr_`...).
  Database columns hold the bare UUID.
- **Engine calls from platform-api carry two tokens**: an M2M token and a
  short-lived, single-use actor token minted by the identity broker for the real
  caller. A call with an empty or made-up identity is rejected by the engine.
- **Writes that change a setting** follow one pattern: `If-Match` required
  (428 missing, 412 stale) and checked against the row locked `FOR UPDATE` in the
  same transaction, plus an audit event in that transaction, so a write whose
  audit fails is rolled back. See the tenant residency and safeguards services.
- **Migrations come with a rollback**: every Drizzle migration has a paired file
  in `rollback/` and a journal entry, checked by
  `scripts/check-migration-rollback-pairing.sh`.
- **The planner may only name canonical tools** (the eleven in
  `tool-names.ts`); anything else cannot be dispatched.
- **Model payloads**: a system message marked `alter_authored: true` skips PII
  redaction in the gateway. Put it only on a constant prompt with no tenant or
  user text in it (see `packages/contracts/src/model-invocation-payload.ts`).

## Build, test, verify

CI (`.github/workflows/ci.yml`, job `gate`, about 10 minutes) runs, on a pull
request, `nx affected -t lint,typecheck,build` and `nx affected -t test`, plus
platform-api's tests against a migrated database, the boundary, RBAC,
placeholder and rollback-pairing checks, gitleaks, a dependency audit,
`buf breaking` and an SBOM. Pushes to main run the full sweep.

Locally:

- TypeScript: `pnpm exec nx run <project>:typecheck|lint|test`, or
  `npx vitest run <path>` for one spec.
- Python (from the app's directory): `uv run pytest`, `uv run ruff check .`,
  `uv run mypy .`.
- **Tests import `packages/*` from their built `dist`.** After changing a
  package, run `pnpm exec nx run <package>:build` before testing an app that
  uses it, or you will test the old package.
- Integration specs use Testcontainers, so they need Docker running.
- If your environment cannot run something (no Docker, no AWS credentials, a
  sandbox without network access), say which checks you could not run and let
  CI run them. Never report a check as passed that you did not run.
- Some specs fail locally for environment reasons only (for example
  platform-api specs without `DATABASE_URL` and the marketplace variables CI
  sets). Compare with `origin/main` before assuming you broke something, and
  say so in your report.

Known traps:

- `buf generate` and some typecheck targets rewrite files under
  `packages/contracts/src/generated/`; restore them before staging if you did
  not change a proto.
- Windows: files written by scripts can come out with CRLF line endings.
  Normalise to LF before committing.
- Pass commit messages and PR bodies through a file (`git commit -F`,
  `gh pr create --body-file`), never inline: backticks in a shell string run as
  commands.

## Live model checks

Some behaviour can only be measured against a real model. The local recipe
(details in `docs/local-dev.md`):

1. Create `.env.local` from `.env.local.example` (it is gitignored; every machine
   keeps its own) and start the dependency containers:
   `docker compose --env-file .env.local up -d`.
2. Start the mock M2M issuer: `node scripts/local-mock-auth0/server.js` (port
   4999; without it the gateway answers UNAUTHENTICATED).
3. Start the Model Gateway on Bedrock: `sh scripts/run-model-gateway-aws.sh`.
   It needs a built gateway and AWS credentials with Bedrock access on this
   machine, in the named profile the script uses (`alter` unless
   `MODEL_GATEWAY_AWS_PROFILE` says otherwise).
4. Run the live test with `.env.local` loaded and `AWS_ENDPOINT_URL` unset.

Live golden sets in the repository run only when their variable is set:
`PLANNER_TOOL_NAMING_LIVE_MODEL_GATEWAY` (intelligence-service) and
`AGENT_INSTRUCTIONS_LIVE_MODEL_GATEWAY` (intelligence-service), and
`AGENT_IDENTITY_LIVE_MODEL_GATEWAY` (orchestration-service). The gateway caches
answers per tenant by prompt similarity, so a live evaluation must plan as a
fresh tenant each run, or it replays earlier answers.

## How work is done here

- **Golden set first.** Before changing behaviour a model decides, write the
  cases that define correct behaviour, derive each expectation from a stated
  rule (never from what some implementation currently returns), and record the
  current implementation's score as the baseline.
- **Prove a fix with a test that fails on the old code**, and check that it does.
- **Prefer real infrastructure in tests**: real Postgres with RLS through a
  non-owner role, a real Temporal test server, real HTTP through the real
  guards. Mock only the edge you cannot run.
- **Report model scores over several runs**, never one; a model's output varies.
- **Fix the root cause where every caller passes through**, not the one caller a
  report names.
- **Read before you write.** Reuse the helpers and patterns already here; many
  exist that are not obvious.

## Working alongside other agents

Several agents work on this repository at the same time.

- **Use your own worktree**:
  `git worktree add ../alter-x-4-<topic> -b <branch> origin/main`. Never switch
  branches in a checkout you did not create: another agent's uncommitted work or
  next commit lands on whatever is checked out.
- **Take one task at a time**, as named in the handoff note, and do not start one
  another agent holds.
- **Avoid editing a file another open pull request edits.** If you must, say so
  in your PR so the owner can order the merges.
- **Before you stop, update the handoff note**: what you merged or opened, what
  you measured, what you found and left, and what you would do next.

## Pull requests and reports

Commit messages use conventional commits (`fix(planner): ...`), and the body
says what was wrong, why, and what changed. End it with a `Co-Authored-By:`
trailer naming the agent that wrote the change.

A PR description has four parts:

- **Problem**: what was wrong, with the evidence.
- **Fix**: what changed, and why that approach.
- **Proof**: tests and live results, with numbers.
- **Not in this PR**: what you saw and deliberately left out.

When you report back to the owner, lead with the outcome and the evidence. Say
plainly what is verified and what is not, and never claim "done" without the CI
result for the PR's head commit.

## Standing environment rules

- Never clone into a cloud-synced folder (iCloud Desktop, OneDrive Desktop): git
  hangs there. `~/alter-work/` is the convention.
- Node 22 only: Testcontainers tests fail on Node 20.
- Check for a running `pnpm` process before `install`, `add` or `update`;
  concurrent installs corrupt the lockfile and `node_modules`.
- Windows: `generate_protos.py --check` fails on CRLF-checked-out generated
  Python bindings; rewrite them with `git show HEAD:<path> > <path>`.
