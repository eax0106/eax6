# Single-EC2 MVP deployment (task 6.1)

One host runs every service in Docker against real AWS: Bedrock, AppConfig,
Secrets Manager, SSM, SQS, S3 and EventBridge. Temporal is Temporal Cloud
(task 6.2). Sign-in is Auth0. Decided by Havish on 2026-09-28; AWS-native
(ECS/Aurora, `infrastructure/terraform`) comes later.

| Piece | Where |
|---|---|
| AWS resources and the host | `infrastructure/ec2-mvp` (Terraform) |
| Containers | `deploy/ec2/compose.yml` |
| Bring-up | `deploy/ec2/bootstrap.sh` |
| Operator settings | `deploy/ec2/operator.env.example` |
| TLS and the web bundle | `deploy/ec2/Caddyfile` |

## Cost (ap-south-1, on-demand, measured 2026-09-28 from the AWS Pricing API)

| Item | Price | Per month |
|---|---|---|
| `t3.xlarge` (4 vCPU, 16 GiB) | $0.1792/h | ≈ $130.82 |
| 80 GiB gp3 root volume | $0.0912/GB-month | ≈ $7.30 |
| Public IPv4 (Elastic IP) | $0.005/h | ≈ $3.65 |
| **Host total** | | **≈ $142** |

Usage-priced on top: Bedrock tokens, Temporal Cloud actions ($50 per million,
$150 new-account credit), SQS/S3/EventBridge (cents at MVP volume). 16 GiB is
the floor: fourteen services, four Postgres, Redis and Presidio share it.

## Before you start (Havish)

1. **Auth0**: a tenant, an API (its identifier is `AUTH0_API_AUDIENCE`), and a
   machine-to-machine application; put the M2M client secret in Secrets Manager.
2. **Temporal Cloud**: a namespace; put its API key in Secrets Manager.
3. **A domain** you can point at the host.
4. **Approve the cost above.**

## Launch

```bash
cd infrastructure/ec2-mvp
terraform init
terraform apply            # 24 resources; prints public_ip and instance_id
```

Point the domain's A record at `public_ip`. Then, on the host:

```bash
aws ssm start-session --target <instance_id>
sudo -i
cd /opt/alter/deploy/ec2
cp operator.env.example operator.env   # fill every value
./bootstrap.sh
```

`bootstrap.sh` generates passwords once (kept across re-runs), writes `.env`
for this environment, creates the environment's generated secrets if they are
absent, starts the data containers, runs every migration, builds the web bundle
for the domain, starts all services and waits for each `/health` to answer with
its own name. Re-running it is safe.

## What is proven, and what is not

Proven without a host:
- `terraform validate`, and `terraform plan` against the real account
  (24 resources, nothing applied).
- `docker compose config` on `compose.yml`.
- `check-bootstrap-env.sh`: runs step 2 of the bootstrap in a bash 5
  container with the AWS CLI stubbed and asserts every rewrite. LocalStack
  routing and the metadata switch are dropped, environment references move to
  `/alter/<env>/`, shared vendor references stay, `${VAR:-default}` is
  expanded, no placeholder survives, and `.env` is 0600. It fails when the
  endpoint rule is removed.
- Each gateway service booting from committed configuration against real AWS
  (task 1.6, `scripts/run-service-aws.sh`).
- `check-platform-db-roles.sh` (CI, against the migrated database): the
  services' platform_db roles. The container's superuser bypasses row-level
  security, so it only migrates; platform-api connects as `platform_app`, which
  sees no tenant's rows without that tenant's context, and the staff plane as
  `platform_operations`, which reads across tenants. Neither can change the
  schema. It fails when `platform_app` is given BYPASSRLS or a role is given
  ownership. Role passwords live in `.db-roles.env` (0600, kept across re-runs).

Not proven until the first launch: the whole stack on one host, Caddy's
certificate, Auth0 and Temporal Cloud. Those need the accounts above.

## Operating

| Task | Command (on the host, in `/opt/alter/deploy/ec2`) |
|---|---|
| Status | `docker compose ps` |
| Logs | `docker compose logs -f <service>` |
| Deploy a new tag | set `ALTER_IMAGE_TAG` in `operator.env`, then `./bootstrap.sh` |
| Stop | `docker compose down` (volumes, and so data, are kept) |

Postgres data lives in Docker volumes on the root EBS volume. Back it up before
anything else goes live (task 6.5 includes `backup_restore`).
