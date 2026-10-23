variable "name_prefix" {
  description = "Prefix for every resource name, e.g. kcw-prod. The deploy role may only create and pass roles named kcw-prod-*."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name_prefix))
    error_message = "name_prefix must be 3-31 lowercase letters, digits or dashes, starting with a letter."
  }
}

variable "orchestrator_package_dir" {
  description = "Directory holding the orchestrator Lambda code (index.mjs exporting handler, plus anything it imports). Null: the stub in stub/orchestrator, which fails every message so it lands in the DLQ instead of being consumed."
  type        = string
  default     = null
}

variable "relay_package_dir" {
  description = "Directory holding the webhook relay Lambda code (index.mjs exporting handler). Null: the stub in stub/relay, which answers 503 to every request."
  type        = string
  default     = null
}

variable "orchestrator_secret_names" {
  description = "Secrets Manager names the orchestrator Lambda may read (D9, DESIGN §6)."
  type        = list(string)
}

variable "relay_secret_names" {
  description = "Secrets Manager names the relay Lambda may read (D9, DESIGN §6)."
  type        = list(string)
}

variable "orchestrator_environment" {
  description = "Extra orchestrator env vars. Secret *names* only, never values (D9)."
  type        = map(string)
  default     = {}
}

variable "relay_environment" {
  description = "Extra relay env vars. Secret *names* only, never values (D9)."
  type        = map(string)
  default     = {}
}

variable "langsmith_tracing" {
  description = "LANGSMITH_TRACING for the orchestrator. The API key is read from Secrets Manager at cold start (D9), not set here."
  type        = bool
  default     = true
}

variable "langsmith_project" {
  description = "LANGSMITH_PROJECT for the orchestrator traces. Null: <name_prefix>-orchestrator."
  type        = string
  default     = null
}

variable "lambda_runtime" {
  type    = string
  default = "nodejs24.x"
}

variable "orchestrator_memory_mb" {
  type    = number
  default = 512
}

variable "orchestrator_timeout_s" {
  description = "DESIGN §1: target under 2 min per invocation, timeout 5 min. The queue's visibility timeout is 6x this (AWS recommendation for SQS event sources)."
  type        = number
  default     = 300
}

variable "relay_memory_mb" {
  type    = number
  default = 256
}

variable "relay_timeout_s" {
  description = "GitHub gives a webhook delivery 10 s to answer."
  type        = number
  default     = 10
}

variable "max_receive_count" {
  description = "Deliveries of one message before SQS moves it to the DLQ (AWS recommends at least 5 for Lambda event sources)."
  type        = number
  default     = 5
}

variable "log_retention_days" {
  type    = number
  default = 14
}
