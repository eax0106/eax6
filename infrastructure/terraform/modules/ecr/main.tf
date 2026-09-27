# One repository per image, not per service.
#
# This list used to name ten services, which was wrong twice over: four
# deployable services were missing (provisioning-service, ads-core,
# cost-ledger-service, audit-service), and the nine Node services do not have
# nine images. docker/Dockerfile.node builds a single image that runs any of
# them, chosen by the container's command, so nine repositories would hold nine
# copies of the same bytes.
#
# The result is six repositories for fourteen services: one for the shared Node
# image, and one for each Python service, which cannot share an image because
# each resolves its own uv.lock. platform-web has no repository because it ships
# as a static bundle.
locals {
  images = toset([
    "node",
    "ads-core",
    "eval-service",
    "intelligence-service",
    "memory-service",
    "verification-service",
  ])

  # The nine services the "node" image serves. Named here so the count below is
  # checked against something, rather than asserting a bare 6 that nothing ties
  # back to the services actually deployed.
  node_services = toset([
    "audit-service",
    "background-workers",
    "cost-ledger-service",
    "model-gateway",
    "orchestration-service",
    "platform-api",
    "provisioning-service",
    "sandbox-service",
    "tool-gateway",
  ])
}

check "image_catalog_covers_every_deployable_service" {
  assert {
    condition = (
      length(local.images) == 6 &&
      length(local.node_services) == 9 &&
      length(setintersection(local.images, local.node_services)) == 0 &&
      !contains(local.images, "platform-web") &&
      !contains(local.node_services, "platform-web")
    )
    error_message = "ECR must hold six images -- the shared Node image plus one per Python service -- covering all fourteen deployable services and excluding platform-web."
  }
}

resource "aws_ecr_repository" "service" {
  for_each = local.images

  name                 = "alter-${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name  = "alter-${each.key}"
    Scope = "backend-container"

    # What this image runs. The Node image serves nine services, so it carries
    # the whole list rather than a single Service tag that would have to name
    # one of them and be wrong about the other eight.
    Services = each.key == "node" ? join(",", sort(tolist(local.node_services))) : each.key
  }
}

resource "aws_ecr_lifecycle_policy" "service" {
  for_each = aws_ecr_repository.service

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 14 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Retain the newest 100 tagged images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["v", "sha-"]
          countType     = "imageCountMoreThan"
          countNumber   = 100
        }
        action = { type = "expire" }
      },
    ]
  })
}
