variable "name_prefix" {
  description = "Resource name prefix, e.g. kcw-prod."
  type        = string
}

variable "input_queue_name" {
  description = "Orchestrator input FIFO queue name (modules/orchestrator: <prefix>-orchestrator-in.fifo)."
  type        = string
}

variable "dlq_name" {
  description = "Orchestrator dead-letter FIFO queue name (<prefix>-orchestrator-dlq.fifo)."
  type        = string
}

variable "sweeper_function_name" {
  description = "Sweeper Lambda name (<prefix>-sweeper)."
  type        = string
}

variable "web_log_group_name" {
  description = "Log group of the web server Lambda (/aws/lambda/<prefix>-server); its [job] ... failed line feeds the hub-jobs alarm."
  type        = string
}
