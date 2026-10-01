# SES uses the default event bus. The generated webhook key stays on the host
# and in EventBridge's managed connection secret, outside Terraform state.
data "aws_cloudwatch_event_bus" "ses_default" {
  name = "default"
}

resource "aws_sesv2_configuration_set" "delivery" {
  configuration_set_name = "${local.prefix}-delivery"
}

resource "aws_sesv2_configuration_set_event_destination" "delivery" {
  configuration_set_name = aws_sesv2_configuration_set.delivery.configuration_set_name
  event_destination_name = "engine-readback"
  event_destination {
    enabled              = true
    matching_event_types = ["DELIVERY", "BOUNCE"]
    event_bridge_destination {
      event_bus_arn = data.aws_cloudwatch_event_bus.ses_default.arn
    }
  }
}

resource "aws_cloudwatch_event_rule" "ses_delivery" {
  name = "${local.prefix}-ses-delivery"
  event_pattern = jsonencode({
    source        = ["aws.ses"]
    "detail-type" = ["Email Delivered", "Email Bounced"]
    detail = {
      mail = {
        tags = {
          "ses:configuration-set" = [aws_sesv2_configuration_set.delivery.configuration_set_name]
          alter_tenant_id         = [{ exists = true }]
        }
      }
    }
  })
}

resource "aws_sqs_queue" "ses_delivery_dlq" {
  name                      = "${local.prefix}-ses-delivery-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue_policy" "ses_delivery_dlq" {
  queue_url = aws_sqs_queue.ses_delivery_dlq.url
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.ses_delivery_dlq.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.ses_delivery.arn } }
    }]
  })
}

resource "aws_iam_role" "ses_delivery" {
  name = "${local.prefix}-ses-delivery"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "events.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy" "ses_delivery" {
  role = aws_iam_role.ses_delivery.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "events:InvokeApiDestination"
      Resource = "${local.arn}:events:${var.aws_region}:${local.account_id}:api-destination/${aws_cloudwatch_event_rule.ses_delivery.name}/*"
    }]
  })
}

resource "aws_ssm_parameter" "ses_delivery_kit" {
  name = "/alter/${var.alter_env}/ses/delivery-kit"
  type = "String"
  value = jsonencode({
    configurationSet = aws_sesv2_configuration_set.delivery.configuration_set_name
    ruleName         = aws_cloudwatch_event_rule.ses_delivery.name
    roleArn          = aws_iam_role.ses_delivery.arn
    deadLetterArn    = aws_sqs_queue.ses_delivery_dlq.arn
  })
}

resource "aws_iam_role_policy" "ses_delivery_bootstrap" {
  role = aws_iam_role.host.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["events:DescribeConnection", "events:CreateConnection", "events:UpdateConnection"]
        Resource = "${local.arn}:events:${var.aws_region}:${local.account_id}:connection/${aws_cloudwatch_event_rule.ses_delivery.name}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["events:DescribeApiDestination", "events:CreateApiDestination", "events:UpdateApiDestination"]
        Resource = "${local.arn}:events:${var.aws_region}:${local.account_id}:api-destination/${aws_cloudwatch_event_rule.ses_delivery.name}/*"
      },
      {
        Effect = "Allow", Action = "events:PutTargets", Resource = aws_cloudwatch_event_rule.ses_delivery.arn
      },
      {
        Effect    = "Allow", Action = "iam:PassRole", Resource = aws_iam_role.ses_delivery.arn
        Condition = { StringEquals = { "iam:PassedToService" = "events.amazonaws.com" } }
      },
      {
        Effect    = "Allow", Action = "iam:CreateServiceLinkedRole"
        Resource  = "${local.arn}:iam::${local.account_id}:role/aws-service-role/apidestinations.events.amazonaws.com/*"
        Condition = { StringEquals = { "iam:AWSServiceName" = "apidestinations.events.amazonaws.com" } }
      }
    ]
  })
}
