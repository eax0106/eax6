# Container images

Six images cover the fourteen deployable services. `platform-web` is not here:
it ships as a static bundle, not a container.

| Image | Built from | Covers |
|---|---|---|
| `node` | `Dockerfile.node` | all nine Node services |
| `ads-core`, `eval-service`, `intelligence-service`, `memory-service`, `verification-service` | `Dockerfile.python` | one Python service each |

The nine Node services share one image because they share a build and a runtime;
the five Python services do not, because each resolves its own `uv.lock`.

## Where the images come from

CI builds all six and, on a push to main or a release tag, pushes them to GHCR:

| | |
|---|---|
| Registry | `ghcr.io/havishalterx-eng/alter-<image>` |
| Tags | `sha-<short commit>`, plus `main` or the release tag |
| Workflow | `.github/workflows/images.yml` |

A pull request builds them without pushing, and only when it touches something
an image contains, so a Terraform-only or docs-only change builds nothing. The
image list is derived from the apps on disk rather than written in the workflow,
and the build fails if `node-entrypoint.sh` and the Node apps on disk disagree
— a Node app missing from that list cannot be started even though the image
contains its build.

The registry is GHCR because ECR does not exist yet: no AWS account has been
created. The tags already follow the scheme `modules/ecr`'s lifecycle policy
keeps, so moving to ECR is a registry and a login step.

## Build locally

```bash
scripts/docker-build.sh
```

`TAG` and `REGISTRY` are environment variables, defaulting to `dev` and `alter`.
Build one image directly with:

```bash
docker build -f docker/Dockerfile.node -t alter/node:dev .
docker build -f docker/Dockerfile.python --build-arg APP=eval-service -t alter/eval-service:dev .
```

## Run

A Node container takes its service name as the first argument, or reads
`ALTER_SERVICE_NAME`:

```bash
docker run --rm alter/node:dev platform-api
```

Any first argument that is not one of the nine names is run as a command
instead, so the same image gives a shell (`sh`) or runs a migration.

The nine names: `audit-service`, `background-workers`, `cost-ledger-service`,
`model-gateway`, `orchestration-service`, `platform-api`, `provisioning-service`,
`sandbox-service`, `tool-gateway`. The entrypoint preloads the OpenTelemetry
bootstrap for any service whose build emits one, which is what each service's Nx
`serve` target does.

A Python container runs its HTTP app by default. Three of the five also serve
gRPC from a second entry point, `python -m src.grpc_server`, reached by
overriding the command on the same image:

| Service | gRPC surface dialled on |
|---|---|
| `eval-service` | `EVAL_SERVICE_GRPC_TARGET`, 50062 |
| `memory-service` | `MEMORY_SERVICE_ADDRESS`, 50060 |
| `verification-service` | `VERIFICATION_GRPC_TARGET`, 50054 |

```bash
docker run --rm alter/eval-service:dev python -m src.grpc_server
```

Each of the three therefore runs as two containers from a single image. A
service whose gRPC surface is not running answers nothing on that port, and
its caller sees a timeout rather than an error, so treat the second container
as required rather than optional wherever that port is dialled.

## What the images do not contain

No configuration and no credentials. Every service validates its environment on
startup and resolves the rest through the config and secrets adapters, so an
image is identical across dev, staging and production and carries nothing that
identifies an environment. The bootstrap variables each service expects are
listed in `docs/specs/07-env-config-spec.md`, section 5.

Both images run as a non-root user and expect a read-only root filesystem with a
writable `/tmp`, because `infrastructure/terraform/modules/service` sets both on
every deployed task and offers no way to turn them off. A service that needs to
write elsewhere needs a mounted volume, not a relaxed image.

## Migrations

`Dockerfile.node` deliberately keeps its dev dependencies: `drizzle-kit` and
`tsx` are devDependencies and every Node migration runs through one of them, so
the same image that serves a service can migrate its database. The Python images
drop dev dependencies but keep Alembic, which is a runtime dependency.
