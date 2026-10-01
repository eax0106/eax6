# Single-EC2 MVP (task 6.1, decided 2026-09-28): one host runs every service in
# Docker against real AWS. This root creates the real counterparts of what
# infrastructure/local/localstack-init fakes locally -- the two buckets and the
# parameters naming them, the cost queue, the canonical-events bus, rule and
# FIFO queue -- plus the host, its role and its network. Secrets whose values
# are generated (database DSNs, signing and pseudonym keys, tokens) are written
# by deploy/ec2/bootstrap.sh on the host, never by Terraform, so no generated
# secret ever lands in Terraform state.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  prefix     = "alter-${var.alter_env}"
  arn        = "arn:${data.aws_partition.current.partition}"
}

# --- Buckets (40-service-startup-resources.sh) --------------------------------

resource "aws_s3_bucket" "audit_archive" {
  bucket = "${local.prefix}-audit-archive-${local.account_id}"
}

resource "aws_s3_bucket" "artifacts" {
  bucket = "${local.prefix}-artifacts-${local.account_id}"
}

resource "aws_s3_bucket_versioning" "audit_archive" {
  bucket = aws_s3_bucket.audit_archive.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "all" {
  for_each                = { audit = aws_s3_bucket.audit_archive.id, artifacts = aws_s3_bucket.artifacts.id }
  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "all" {
  for_each = { audit = aws_s3_bucket.audit_archive.id, artifacts = aws_s3_bucket.artifacts.id }
  bucket   = each.value
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_ssm_parameter" "audit_archive_bucket" {
  name  = "/alter/${var.alter_env}/audit/archive-bucket"
  type  = "String"
  value = aws_s3_bucket.audit_archive.bucket
}

resource "aws_ssm_parameter" "artifacts_bucket" {
  name  = "/alter/${var.alter_env}/orchestration/artifacts-bucket"
  type  = "String"
  value = aws_s3_bucket.artifacts.bucket
}

# --- Cost events queue (10-foundation-resources.sh) ---------------------------

resource "aws_sqs_queue" "cost_events_dlq" {
  name                      = "${local.prefix}-cost-events-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "cost_events" {
  name                       = "${local.prefix}-cost-events"
  visibility_timeout_seconds = 120
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.cost_events_dlq.arn
    maxReceiveCount     = 5
  })
}

# --- Canonical events (20-canonical-events.sh) --------------------------------

resource "aws_cloudwatch_event_bus" "canonical" {
  name = local.prefix
}

resource "aws_sqs_queue" "events_dlq" {
  name                        = "${local.prefix}-events-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  message_retention_seconds   = 1209600
  sqs_managed_sse_enabled     = true
}

resource "aws_sqs_queue" "events" {
  name                        = "${local.prefix}-events.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  sqs_managed_sse_enabled     = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.events_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_cloudwatch_event_rule" "canonical" {
  name           = "${local.prefix}-canonical-events"
  event_bus_name = aws_cloudwatch_event_bus.canonical.name
  event_pattern  = jsonencode({ source = [{ prefix = "alter." }] })
}

resource "aws_cloudwatch_event_target" "canonical" {
  rule           = aws_cloudwatch_event_rule.canonical.name
  event_bus_name = aws_cloudwatch_event_bus.canonical.name
  arn            = aws_sqs_queue.events.arn
  sqs_target {
    message_group_id = "alter-events"
  }
}

resource "aws_sqs_queue_policy" "events" {
  queue_url = aws_sqs_queue.events.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowEventBridgeCanonicalRule"
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.events.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.canonical.arn } }
    }]
  })
}

# --- Host role: exactly what the services and the bootstrap touch -------------

resource "aws_iam_role" "host" {
  name = "${local.prefix}-host"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.host.name
  policy_arn = "${local.arn}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "host" {
  name = "${local.prefix}-host"
  role = aws_iam_role.host.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "Bedrock"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:Converse", "bedrock:ConverseStream"]
        Resource = "*"
      },
      {
        Sid    = "EnvironmentSecrets"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret", "secretsmanager:CreateSecret", "secretsmanager:PutSecretValue"]
        Resource = [
          "${local.arn}:secretsmanager:${var.aws_region}:${local.account_id}:secret:alter/${var.alter_env}/*",
          "${local.arn}:secretsmanager:${var.aws_region}:${local.account_id}:secret:/alter/${var.alter_env}/*",
        ]
      },
      {
        Sid      = "SharedVendorSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
        Resource = [for name in var.shared_secret_names : "${local.arn}:secretsmanager:${var.aws_region}:${local.account_id}:secret:${name}-*"]
      },
      {
        Sid      = "EnvironmentParameters"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath", "ssm:PutParameter"]
        Resource = "${local.arn}:ssm:${var.aws_region}:${local.account_id}:parameter/alter/${var.alter_env}/*"
      },
      {
        Sid      = "AppConfigRead"
        Effect   = "Allow"
        Action   = ["appconfig:StartConfigurationSession", "appconfig:GetLatestConfiguration"]
        Resource = "${local.arn}:appconfig:${var.aws_region}:${local.account_id}:application/*"
      },
      {
        Sid    = "Queues"
        Effect = "Allow"
        Action = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"]
        Resource = [
          aws_sqs_queue.cost_events.arn, aws_sqs_queue.cost_events_dlq.arn,
          aws_sqs_queue.events.arn, aws_sqs_queue.events_dlq.arn,
        ]
      },
      {
        Sid      = "Buckets"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
        Resource = flatten([for b in [aws_s3_bucket.audit_archive, aws_s3_bucket.artifacts] : [b.arn, "${b.arn}/*"]])
      },
      {
        Sid      = "MediaSpeech"
        Effect   = "Allow"
        Action   = ["polly:SynthesizeSpeech", "transcribe:StartTranscriptionJob", "transcribe:GetTranscriptionJob"]
        Resource = "*"
      },
      {
        Sid      = "Events"
        Effect   = "Allow"
        Action   = ["events:PutEvents"]
        Resource = aws_cloudwatch_event_bus.canonical.arn
      },
    ]
  })
}

resource "aws_iam_instance_profile" "host" {
  name = "${local.prefix}-host"
  role = aws_iam_role.host.name
}

# --- Network and host ----------------------------------------------------------

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_security_group" "host" {
  name        = "${local.prefix}-host"
  description = "HTTP and HTTPS only; no SSH (use SSM Session Manager)"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP (redirects to HTTPS)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.ingress_cidrs
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.ingress_cidrs
  }

  egress {
    description = "Outbound: AWS APIs, Temporal Cloud, vendors, image pulls"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "host" {
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.instance_type
  subnet_id              = sort(data.aws_subnets.default.ids)[0]
  vpc_security_group_ids = [aws_security_group.host.id]
  iam_instance_profile   = aws_iam_instance_profile.host.name

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gib
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    alter_env      = var.alter_env
    aws_region     = var.aws_region
    repository_url = var.repository_url
    repository_ref = var.repository_ref
  })

  tags = {
    Name = "${local.prefix}-host"
  }

  lifecycle {
    ignore_changes = [ami]
  }
}

resource "aws_eip" "host" {
  instance = aws_instance.host.id
  domain   = "vpc"
}
