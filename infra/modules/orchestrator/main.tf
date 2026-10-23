# Orchestrator (DESIGN §1, §4.3, D5): one SQS FIFO input queue (+ DLQ) feeding the orchestrator
# Lambda, and the GitHub webhook relay Lambda behind a public Function URL that enqueues to it.
# Each Lambda has its own role and reads only its own secrets (D9: env vars hold secret names).

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.region

  orchestrator_name = "${var.name_prefix}-orchestrator"
  relay_name        = "${var.name_prefix}-relay"
  # The input queue name is also in infra/bootstrap (var.orchestrator_queue_name), which lets
  # kcw-gh-agent send to it: keep both in sync.
  queue_name = "${var.name_prefix}-orchestrator-in.fifo"
  dlq_name   = "${var.name_prefix}-orchestrator-dlq.fifo"

  zip_dir                  = "${path.root}/.terraform/kcw-orchestrator"
  orchestrator_package_dir = coalesce(var.orchestrator_package_dir, "${path.module}/stub/orchestrator")
  relay_package_dir        = coalesce(var.relay_package_dir, "${path.module}/stub/relay")

  secret_arn_prefix        = "arn:${local.partition}:secretsmanager:${local.region}:${local.account_id}:secret"
  orchestrator_secret_arns = [for n in var.orchestrator_secret_names : "${local.secret_arn_prefix}:${n}-??????"]
  relay_secret_arns = [
    for n in [var.relay_webhook_secret_name, var.relay_db_secret_name] : "${local.secret_arn_prefix}:${n}-??????"
  ]
}

# ---------- queues ----------

resource "aws_sqs_queue" "dlq" {
  name                      = local.dlq_name
  fifo_queue                = true
  message_retention_seconds = 1209600 # 14 days, the maximum
  sqs_managed_sse_enabled   = true
}

# D5: every orchestrator input (relay, kcw-report, console, sweeper) goes here with
# MessageGroupId = thread id (task-<id>) and an explicit MessageDeduplicationId.
resource "aws_sqs_queue" "input" {
  name                        = local.queue_name
  fifo_queue                  = true
  content_based_deduplication = false
  visibility_timeout_seconds  = 6 * var.orchestrator_timeout_s
  message_retention_seconds   = 345600 # 4 days
  sqs_managed_sse_enabled     = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })
}

# ---------- shared IAM ----------

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}
