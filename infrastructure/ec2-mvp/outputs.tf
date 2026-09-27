output "public_ip" {
  description = "Elastic IP. Point the domain's A record here."
  value       = aws_eip.host.public_ip
}

output "instance_id" {
  description = "Connect with: aws ssm start-session --target <instance_id>"
  value       = aws_instance.host.id
}

output "audit_archive_bucket" {
  value = aws_s3_bucket.audit_archive.bucket
}

output "artifacts_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "cost_events_queue" {
  value = aws_sqs_queue.cost_events.name
}

output "events_queue" {
  value = aws_sqs_queue.events.name
}
