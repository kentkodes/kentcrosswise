variable "name_prefix" {
  type = string
  validation {
    condition     = can(regex("^kcw-(prod|pr-[0-9]+)$", var.name_prefix))
    error_message = "Use kcw-prod or an owned kcw-pr-<number> prefix."
  }
}

variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be the verified twelve-digit AWS account."
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "partition" {
  type    = string
  default = "aws"
}

variable "watcher_package_dir" {
  description = "Bundled index.mjs directory, produced by pnpm build-lambdas."
  type        = string
}

variable "metadata_bucket_name" {
  description = "Private owner-managed production bucket, or an ephemeral preview bucket."
  type        = string
}

variable "credential_name" {
  description = "Secret name in production; synthetic SSM database parameter path in previews. Never a credential value."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Boundary for both module roles; previews pass kcw-preview-boundary (infra/bootstrap)."
  type        = string
  default     = null
}

variable "runtime_enabled" {
  description = "Independent runtime activation fuse; keep false until source review and smoke acceptance."
  type        = bool
  default     = false
}

variable "schedules_enabled" {
  description = "Independent schedule activation gate; false deploys only DISABLED schedules."
  type        = bool
  default     = false
}

# English Wikisource stays allowed but is not scheduled by default: its API is disallowed by
# robots.txt until an approved access path is resolved. Add "wikisource-en" = "cron(15 4 * * ? *)"
# only after that.
variable "schedule_expressions" {
  type = map(string)
  default = {
    gutenberg = "cron(0 4 * * ? *)"
  }
  validation {
    condition     = alltrue([for slug in keys(var.schedule_expressions) : contains(["gutenberg", "wikisource-en"], slug)])
    error_message = "Only reviewed Gutenberg and English Wikisource source slugs are supported."
  }
}

variable "memory_mb" {
  type    = number
  default = 512
}

variable "timeout_s" {
  type    = number
  default = 300
}

variable "reserved_concurrency" {
  description = "Reserved concurrency for the watcher. null = unreserved (no account quota taken): one daily run per source, and the per-source rate lease in Postgres already serializes requests."
  type        = number
  default     = null
}

variable "queue_visibility_timeout_s" {
  description = "Visibility timeout of the essay-urls queue. Belongs to its future consumer (the E6 fetcher), not the watcher, which only sends. Default: AWS's six times the timeout of a 300-second Lambda consumer (the previous value); revisit with E6."
  type        = number
  default     = 1800
}

variable "log_retention_days" {
  type    = number
  default = 14
}
