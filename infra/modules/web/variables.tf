variable "name_prefix" {
  description = "Prefix for every resource name, e.g. kcw-prod or kcw-pr-12. Lowercase letters, digits and dashes."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name_prefix))
    error_message = "name_prefix must be 3-31 lowercase letters, digits or dashes, starting with a letter."
  }
}

variable "kcw_env" {
  description = "prod or preview. Must match the build (artifact_dir/kcw-build.json, written by pnpm build-web)."
  type        = string

  validation {
    condition     = contains(["prod", "preview"], var.kcw_env)
    error_message = "kcw_env must be prod or preview."
  }
}

variable "artifact_dir" {
  description = "Path to the OpenNext output (apps/web/.open-next), laid out as described in AGENTS.md (OpenNext output contract)."
  type        = string
}

variable "domain_names" {
  description = "CloudFront aliases, e.g. [\"kentcrosswise.com\"]. Empty: serve on the *.cloudfront.net name only (D22)."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "us-east-1 ACM certificate covering domain_names. Required when domain_names is non-empty."
  type        = string
  default     = null
}

variable "route53_zone_id" {
  description = "Hosted zone for the alias records. Null: no DNS records."
  type        = string
  default     = null
}

variable "secret_names" {
  description = "Secrets Manager secret names the server function may read (D9)."
  type        = list(string)
  default     = []
}

variable "ssm_parameter_names" {
  description = "SSM SecureString parameter names the server function may read, e.g. the preview DB URL (D21)."
  type        = list(string)
  default     = []
}

variable "server_send_queue_arns" {
  description = "SQS queues the server function may send to (sqs:SendMessage only), e.g. the orchestrator input queue for the boss console (P2-14). Previews: none."
  type        = list(string)
  default     = []
}

variable "server_environment" {
  description = "Extra server env vars. Secret *names* only, never values (D9)."
  type        = map(string)
  default     = {}
}

variable "lambda_runtime" {
  description = "Lambda runtime for all functions."
  type        = string
  default     = "nodejs24.x"
}

variable "server_memory_mb" {
  type    = number
  default = 1024
}

variable "server_timeout_s" {
  description = "Below CloudFront's 30 s origin response timeout."
  type        = number
  default     = 25
}

variable "image_memory_mb" {
  type    = number
  default = 1536
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "price_class" {
  type    = string
  default = "PriceClass_100"
}

variable "force_destroy" {
  description = "Allow destroying the assets bucket with objects in it (previews)."
  type        = bool
  default     = false
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary for the function roles (previews: kcw-preview-boundary from infra/bootstrap)."
  type        = string
  default     = null
}

variable "origin_verify_value" {
  description = "D25: value CloudFront sends in x-kcw-origin to the server Function URL (>= 32 chars). It ends up in Terraform state and the CloudFront config."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.origin_verify_value) >= 32
    error_message = "origin_verify_value must be at least 32 characters."
  }
}

variable "origin_verify_secret_name" {
  description = "D25: where the server reads the same value: a Secrets Manager name (with origin_verify_secret_key) or an SSM SecureString name starting with \"/\"."
  type        = string
}

variable "origin_verify_secret_key" {
  description = "JSON key inside origin_verify_secret_name (Secrets Manager only)."
  type        = string
  default     = null
}
