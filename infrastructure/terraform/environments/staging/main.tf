terraform {
  required_version = ">= 1.11.0, < 2.0.0"
  required_providers { aws = { source = "hashicorp/aws", version = "= 6.53.0" } }
  backend "local" { path = "../../state/staging.tfstate" }
}
variable "aws_region" { type = string }
variable "aws_partition" { type = string }
variable "mock_provider" { type = bool }
variable "configuration" {
  type = object({
    account_id = string, target_role_arn = string
    budget     = object({ limit_usd = number, thresholds = list(number), alert_email = string })
    ci         = object({ principal_arn = string, external_id = string, actions = set(string), global_actions = set(string), resource_arns = set(string) })
    network    = object({ vpc_cidr = string, availability_zones = list(string), public_subnet_cidrs = list(string), private_subnet_cidrs = list(string), nat_gateway_strategy = string, flow_log_retention_days = number })
    foundation = object({ aurora_engine_version = string, aurora_parameter_group_family = string, aurora_min_capacity = number, aurora_max_capacity = number, backup_retention_days = number, deletion_protection = bool, redis_engine_version = string, redis_node_type = string, redis_snapshot_retention_days = number })
  })
}
check "configuration" {
  assert {
    condition     = var.aws_region == "ap-south-1" && can(regex("^[0-9]{12}$", var.configuration.account_id)) && can(regex("^arn:[^:]+:iam::[0-9]{12}:role/.+$", var.configuration.target_role_arn)) && alltrue([for az in var.configuration.network.availability_zones : startswith(az, var.aws_region)])
    error_message = "Region, account ID, target role ARN, or availability zones are invalid."
  }
}
provider "aws" {
  region                      = var.aws_region
  allowed_account_ids         = var.mock_provider ? null : [var.configuration.account_id]
  skip_credentials_validation = var.mock_provider
  skip_metadata_api_check     = var.mock_provider
  skip_requesting_account_id  = var.mock_provider
  dynamic "assume_role" {
    for_each = var.mock_provider ? [] : [var.configuration.target_role_arn]
    content {
      role_arn     = assume_role.value
      session_name = "alter-staging-terraform"
    }
  }
  default_tags { tags = { ManagedBy = "terraform", Project = "alterx", Account = "alter-staging" } }
}
# ---------------------------------------------------------------------------
# Service inventory and service-to-service call graph.
#
# THIS MAP IS KNOWINGLY PARTIAL. Read both gaps before applying it anywhere.
# As written it opens the gRPC port of eleven single-surface services and
# nothing else. A connection these rules do not cover is dropped, and a dropped
# connect to a Fargate task times out rather than being refused, so the failure
# reads as slowness rather than as a missing rule.
#
# GAP 1 -- orchestration-service is deliberately absent from mesh_calls. It
# hosts NINE gRPC surfaces in one process (local.orchestration_surfaces), while
# var.services carries one grpc_port per service, so any single port named here
# would be wrong for the other eight. Omitting it fails closed: no rule is
# generated at all, rather than one rule pointing at a port eight of its nine
# surfaces do not answer on. Its callers are preserved in
# local.unmodelled_mesh_calls so the information is not lost.
#
# GAP 2 -- HTTP edges are not modelled. Only the single port named per service
# is opened, and platform-api reaches four of its dependencies over HTTP rather
# than gRPC: its own startup refuses without ENGINE_BASE_URL,
# ADS_CORE_BASE_URL, COST_LEDGER_BASE_URL and AUDIT_SERVICE_BASE_URL. None of
# those four edges exists in this file.
#
# Closing both gaps means changing var.services from one port per service to
# named surfaces, and deriving the HTTP caller graph. Until that happens this
# is an accurate description of eleven edges and an incomplete description of
# the system.
#
# The ports below are the ports the code actually binds. Seven of the twelve
# entries here were wrong until they were checked against the bind sites, and
# because a wrong port fails as a timeout rather than an error, nothing would
# have reported it. local.code_bind_ports is the canonical list and names the
# file that sets each default; the check block at the end asserts this file
# agrees with it.
# ---------------------------------------------------------------------------
locals {
  # Every gRPC surface in the system, the port its own code binds, and where
  # that default is set. This is the authority: a number here that disagrees
  # with the code is a bug in this file, not in the service.
  code_bind_ports = {
    "ads-core.adsq"                      = 50050 # apps/ads-core/src/query/grpc_server.py
    "model-gateway"                      = 50051 # apps/model-gateway/src/config/environment.ts
    "orchestration-service.conversation" = 50052 # apps/orchestration-service/src/config/environment.ts
    "tool-gateway"                       = 50053 # apps/tool-gateway/src/config/environment.ts
    "verification-service"               = 50054 # apps/verification-service/src/grpc_server.py
    "provisioning-service"               = 50055 # apps/provisioning-service/src/config/environment.ts
    "orchestration-service.compiler"     = 50056 # apps/orchestration-service/src/config/compiler-environment.ts
    "sandbox-service"                    = 50057 # apps/sandbox-service/src/config/environment.ts
    "orchestration-service.recovery"     = 50058 # apps/orchestration-service/src/config/recovery-environment.ts
    "orchestration-service.runs"         = 50059 # apps/orchestration-service/src/config/runs-environment.ts
    "memory-service"                     = 50060 # apps/memory-service/src/grpc_server.py
    "intelligence-service.capability"    = 50061 # apps/intelligence-service/src/config.py
    "eval-service"                       = 50062 # apps/eval-service/src/config.py
    "orchestration-service.registry"     = 50063 # apps/orchestration-service/src/config/registry-environment.ts
    "orchestration-service.nodeexec"     = 50064 # apps/orchestration-service/src/config/nodeexec-environment.ts
    "orchestration-service.blackboard"   = 50065 # apps/orchestration-service/src/config/blackboard-environment.ts
    "orchestration-service.deployctl"    = 50066 # apps/orchestration-service/src/config/workflow-lifecycle-environment.ts
    "orchestration-service.artifact"     = 50067 # apps/orchestration-service/src/config/artifact-content-environment.ts
    "audit-service"                      = 50068 # apps/audit-service/src/config/environment.ts
    "cost-ledger-service"                = 50069 # apps/cost-ledger-service/src/config/environment.ts
  }

  # The nine surfaces one orchestration-service process listens on. This is
  # what var.services cannot express today, and the whole of GAP 1.
  orchestration_surfaces = [
    "orchestration-service.conversation",
    "orchestration-service.compiler",
    "orchestration-service.recovery",
    "orchestration-service.runs",
    "orchestration-service.registry",
    "orchestration-service.nodeexec",
    "orchestration-service.blackboard",
    "orchestration-service.deployctl",
    "orchestration-service.artifact",
  ]

  # Two of the twenty surfaces have no caller anywhere in the repository --
  # neither TypeScript, Python, nor the eval harness. They are bound and never
  # dialled, so they need no ingress rule; if they stay uncalled they are
  # candidates for deletion rather than for a rule.
  uncalled_surfaces = [
    "orchestration-service.registry",
    "orchestration-service.deployctl",
  ]

  services = {
    "platform-api"           = {}
    "background-workers"     = {}
    "model-gateway"          = { grpc_port = local.code_bind_ports["model-gateway"] }
    "tool-gateway"           = { grpc_port = local.code_bind_ports["tool-gateway"] }
    "verification-service"   = { grpc_port = local.code_bind_ports["verification-service"] }
    "provisioning-service"   = { grpc_port = local.code_bind_ports["provisioning-service"] }
    "intelligence-service"   = { grpc_port = local.code_bind_ports["intelligence-service.capability"] }
    "sandbox-service"        = { grpc_port = local.code_bind_ports["sandbox-service"] }
    "ads-core"               = { grpc_port = local.code_bind_ports["ads-core.adsq"] }
    "eval-service"           = { grpc_port = local.code_bind_ports["eval-service"] }
    "memory-service"         = { grpc_port = local.code_bind_ports["memory-service"] }
    "cost-ledger-service"    = { grpc_port = local.code_bind_ports["cost-ledger-service"] }
    "audit-service"          = { grpc_port = local.code_bind_ports["audit-service"] }
    "orchestration-service"  = {}
  }

  # callee => callers permitted to open its gRPC port. Everything omitted is
  # denied. orchestration-service is omitted for the reason in GAP 1.
  mesh_calls = {
    "model-gateway"        = ["orchestration-service", "platform-api", "ads-core", "audit-service", "intelligence-service", "eval-service"]
    "tool-gateway"         = ["orchestration-service", "eval-service"]
    "sandbox-service"      = ["orchestration-service"]
    "memory-service"       = ["orchestration-service", "intelligence-service", "eval-service", "cost-ledger-service"]
    "intelligence-service" = ["orchestration-service", "eval-service", "memory-service"]
    "verification-service" = ["orchestration-service", "eval-service"]
    "ads-core"             = ["orchestration-service", "platform-api", "eval-service", "intelligence-service"]
    "provisioning-service" = ["orchestration-service"]
    "eval-service"         = ["orchestration-service"]
    "cost-ledger-service"  = ["orchestration-service", "platform-api", "background-workers", "model-gateway"]
    "audit-service"        = ["orchestration-service", "platform-api", "tool-gateway", "eval-service"]
  }

  # GAP 1's data, kept rather than deleted. Each entry is a real caller of one
  # of orchestration-service's nine surfaces, taken from the client variables
  # those services read. Move these into mesh_calls when var.services can name
  # a surface instead of a service.
  unmodelled_mesh_calls = {
    "orchestration-service.conversation" = ["eval-service"]
    "orchestration-service.compiler"     = ["platform-api"]
    "orchestration-service.recovery"     = ["eval-service"]
    "orchestration-service.runs"         = ["background-workers", "cost-ledger-service"]
    "orchestration-service.nodeexec"     = ["background-workers"]
    "orchestration-service.blackboard"   = ["background-workers"]
    "orchestration-service.artifact"     = ["sandbox-service"]
  }

  # Workloads that hold control-plane database / Redis credentials.
  control_plane_db_clients = [
    "platform-api",
    "orchestration-service",
    "background-workers",
    "memory-service",
    "intelligence-service",
    "verification-service",
    "eval-service",
    "cost-ledger-service",
    "audit-service",
  ]
}

check "mesh_ports_match_the_code" {
  assert {
    condition = alltrue([
      local.services["model-gateway"].grpc_port == local.code_bind_ports["model-gateway"],
      local.services["tool-gateway"].grpc_port == local.code_bind_ports["tool-gateway"],
      local.services["verification-service"].grpc_port == local.code_bind_ports["verification-service"],
      local.services["provisioning-service"].grpc_port == local.code_bind_ports["provisioning-service"],
      local.services["intelligence-service"].grpc_port == local.code_bind_ports["intelligence-service.capability"],
      local.services["sandbox-service"].grpc_port == local.code_bind_ports["sandbox-service"],
      local.services["ads-core"].grpc_port == local.code_bind_ports["ads-core.adsq"],
      local.services["eval-service"].grpc_port == local.code_bind_ports["eval-service"],
      local.services["memory-service"].grpc_port == local.code_bind_ports["memory-service"],
      local.services["cost-ledger-service"].grpc_port == local.code_bind_ports["cost-ledger-service"],
      local.services["audit-service"].grpc_port == local.code_bind_ports["audit-service"],
    ])
    error_message = "A service's grpc_port disagrees with the port its own code binds. The code wins: fix this file, not the service."
  }
}

check "known_gaps_are_still_declared" {
  assert {
    condition = (
      !contains(keys(local.mesh_calls), "orchestration-service") &&
      length(local.orchestration_surfaces) == 9 &&
      length(local.unmodelled_mesh_calls) > 0
    )
    error_message = "orchestration-service's nine surfaces cannot be expressed as one grpc_port. It must stay out of mesh_calls, with its callers recorded in unmodelled_mesh_calls, until var.services can name a surface."
  }
}

module "environment" {
  source                    = "../../modules/environment"
  account_name              = "staging"
  account_id                = var.configuration.account_id
  purpose                   = "staging workloads"
  aws_partition             = var.aws_partition
  aws_region                = var.aws_region
  budget_limit_usd          = var.configuration.budget.limit_usd
  budget_alert_thresholds   = var.configuration.budget.thresholds
  budget_alert_email        = var.configuration.budget.alert_email
  create_ci_role            = true
  ci_principal_arn          = var.configuration.ci.principal_arn
  ci_external_id            = var.configuration.ci.external_id
  deployment_actions        = var.configuration.ci.actions
  global_deployment_actions = var.configuration.ci.global_actions
  deployment_resource_arns  = var.configuration.ci.resource_arns
  network                   = var.configuration.network
}

module "runtime_config" {
  source = "../../modules/runtime-config"

  environment   = "staging"
  account_id    = var.configuration.account_id
  aws_partition = var.aws_partition
  aws_region    = var.aws_region
}

module "data" {
  source = "../../modules/data"

  environment                       = "staging"
  account_id                        = var.configuration.account_id
  aws_partition                     = var.aws_partition
  aws_region                        = var.aws_region
  vpc_id                            = module.environment.vpc_id
  allowed_control_plane_security_group_ids = {
    for name in local.control_plane_db_clients :
    name => module.compute.service_security_group_ids[name]
  }
  allowed_source_security_group_ids = { ads_client = module.compute.ads_client_security_group_id }
  private_subnet_ids                = module.environment.private_subnet_ids
  environment_kms_key_arn           = module.environment.kms_key_arn
  secrets_kms_key_arn               = module.runtime_config.secrets_kms_key_arn
  aurora_engine_version             = var.configuration.foundation.aurora_engine_version
  aurora_parameter_group_family     = var.configuration.foundation.aurora_parameter_group_family
  aurora_min_capacity               = var.configuration.foundation.aurora_min_capacity
  aurora_max_capacity               = var.configuration.foundation.aurora_max_capacity
  backup_retention_days             = var.configuration.foundation.backup_retention_days
  deletion_protection               = var.configuration.foundation.deletion_protection
  redis_engine_version              = var.configuration.foundation.redis_engine_version
  redis_node_type                   = var.configuration.foundation.redis_node_type
  redis_snapshot_retention_days     = var.configuration.foundation.redis_snapshot_retention_days
}

module "messaging" {
  source = "../../modules/messaging"

  environment             = "staging"
  account_id              = var.configuration.account_id
  environment_kms_key_arn = module.environment.kms_key_arn
}

module "compute" {
  source = "../../modules/compute"

  environment             = "staging"
  environment_kms_key_arn = module.environment.kms_key_arn
  vpc_id                  = module.environment.vpc_id
  services                = local.services
  mesh_calls              = local.mesh_calls
}

output "kms_key_arn" { value = module.environment.kms_key_arn }
output "ci_deployment_role_arn" { value = module.environment.ci_deployment_role_arn }
output "vpc_id" { value = module.environment.vpc_id }
output "control_plane_cluster_arn" { value = module.data.control_plane_cluster_arn }
output "ads_cluster_arn" { value = module.data.ads_cluster_arn }
output "event_bus_arn" { value = module.messaging.event_bus_arn }
output "ecs_cluster_arn" { value = module.compute.cluster_arn }
