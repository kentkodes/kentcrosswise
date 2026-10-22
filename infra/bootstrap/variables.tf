variable "aws_account_id" {
  description = "The AWS account to bootstrap. Also part of the state bucket name (kentcrosswise-tfstate-<id>)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be 12 digits."
  }
}

variable "aws_region" {
  description = "Region for every resource (D23)."
  type        = string
  default     = "us-east-1"
}

variable "github_owner" {
  type    = string
  default = "kentkodes"
}

variable "github_owner_id" {
  description = "Numeric GitHub owner id (immutable OIDC sub, research/infra.md §3)."
  type        = string
  default     = "107236483"
}

variable "github_repo" {
  type    = string
  default = "kentcrosswise"
}

variable "github_repo_id" {
  description = "Numeric GitHub repository id."
  type        = string
  default     = "1430035147"
}

variable "domain_name" {
  description = "Apex domain, e.g. kentcrosswise.com. Empty (default): no certificate (D22). The hosted zone must already exist."
  type        = string
  default     = ""
}

variable "orchestrator_queue_name" {
  description = "SQS FIFO queue the agent workflows send to (created in P2-06)."
  type        = string
  default     = "kcw-prod-orchestrator-in.fifo"
}
