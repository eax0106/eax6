variable "aws_region" {
  description = "Region for every resource. The engine is pinned to ap-south-1."
  type        = string
  default     = "ap-south-1"
}

variable "alter_env" {
  description = "ALTER_ENV the services run under; names every AWS resource and /alter/<env>/ parameter."
  type        = string
  default     = "dev"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.alter_env)
    error_message = "alter_env must be dev, staging or prod (local is for the LocalStack stack)."
  }
}

variable "instance_type" {
  description = "One host runs all 14 services, four Postgres, Redis and Presidio: 16 GiB is the floor."
  type        = string
  default     = "t3.xlarge"
}

variable "root_volume_gib" {
  description = "Root EBS volume, gp3. Holds images, Postgres data and logs."
  type        = number
  default     = 80
}

variable "ingress_cidrs" {
  description = "Who may reach 80/443. Everything else, including SSH, stays closed: operators use SSM Session Manager."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "repository_url" {
  description = "Git URL the host clones to get the deployment kit (deploy/ec2)."
  type        = string
  default     = "https://github.com/havishalterx-eng/alterengine-6.git"
}

variable "repository_ref" {
  description = "Branch, tag or commit the host deploys."
  type        = string
  default     = "main"
}

variable "shared_secret_names" {
  description = "Vendor secrets shared with the local environment (one account per vendor), readable by the host but never written."
  type        = list(string)
  default = [
    "/alter/local/tool-gateway/tavily-api-key",
    "alter/local/tool-gateway/browserbase-api-key",
    "alter/local/sandbox-service/e2b-api-key",
    "/alter/local/model-gateway/platform-admin-service-token",
  ]
}
