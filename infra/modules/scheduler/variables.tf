variable "name_prefix" {
  description = "Prefix for every resource name, e.g. kcw-prod. The deploy role may only create and pass roles named kcw-prod-*."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name_prefix))
    error_message = "name_prefix must be 3-31 lowercase letters, digits or dashes, starting with a letter."
  }
}

variable "sweeper_package_dir" {
  description = "Directory holding the sweeper Lambda code (index.mjs exporting handler). Null: the stub in stub/sweeper, which does nothing."
  type        = string
  default     = null
}

variable "orchestrator_secret_name" {
  description = "The orchestrator's secret (db_url as orch_rw, GitHub App credentials; KCW_ORCHESTRATOR_SECRET). The sweeper acts as the orchestrator App and reads only this secret."
  type        = string
}

variable "queue_arn" {
  description = "orchestrator-in FIFO queue ARN; the sweeper may only SendMessage to it (SSE-SQS, no KMS permission needed)."
  type        = string
}

variable "queue_url" {
  description = "orchestrator-in FIFO queue URL (KCW_ORCHESTRATOR_QUEUE_URL)."
  type        = string
}

variable "schedule_expression" {
  description = "When the sweeper runs. Must stay every 15 minutes at :00/:15/:30/:45 UTC: the code's windows (SWEEP_INTERVAL_MINUTES, the nightly GC slot) assume it."
  type        = string
  default     = "cron(0/15 * * * ? *)"
}

variable "enabled" {
  description = "Schedule state. false (DISABLED) stops the sweeper without destroying anything."
  type        = bool
  default     = true
}

variable "lambda_runtime" {
  type    = string
  default = "nodejs24.x"
}

variable "memory_mb" {
  type    = number
  default = 256
}

variable "timeout_s" {
  description = "One run: a few DB reads, up to ~200 SendMessage calls and a few dozen GitHub calls."
  type        = number
  default     = 120
}

variable "log_retention_days" {
  type    = number
  default = 14
}
