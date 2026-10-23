# Schedules (DESIGN §4.3, P2-17): the sweeper Lambda and the EventBridge Scheduler schedule that
# runs it every 15 minutes. The sweeper (agents/orchestrator/src/sweeper) sends sweep messages to
# orchestrator-in, cancels agent runs while agents_paused, dispatches preview-gc.yml nightly and
# redelivers failed webhook deliveries. It has its own role: SendMessage on the queue and read on
# the orchestrator secret, nothing else.

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.region

  sweeper_name   = "${var.name_prefix}-sweeper"
  scheduler_name = "${var.name_prefix}-sweeper-scheduler"

  zip_dir             = "${path.root}/.terraform/kcw-scheduler"
  sweeper_package_dir = coalesce(var.sweeper_package_dir, "${path.module}/stub/sweeper")

  orchestrator_secret_arn = "arn:${local.partition}:secretsmanager:${local.region}:${local.account_id}:secret:${var.orchestrator_secret_name}-??????"
}

# ---------- sweeper Lambda ----------

data "archive_file" "sweeper" {
  type             = "zip"
  output_file_mode = "0644"
  source_dir       = local.sweeper_package_dir
  output_path      = "${local.zip_dir}/${local.sweeper_name}.zip"
}

resource "aws_cloudwatch_log_group" "sweeper" {
  name              = "/aws/lambda/${local.sweeper_name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sweeper" {
  name               = local.sweeper_name
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "sweeper" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.sweeper.arn}:*"]
  }

  statement {
    sid       = "EnqueueToOrchestrator"
    actions   = ["sqs:SendMessage"]
    resources = [var.queue_arn]
  }

  # db_url (orch_rw) and the orchestrator App credentials. A separate kcw/prod/sweeper secret would
  # need a second copy of the App private key, so the sweeper reads the orchestrator's own.
  statement {
    sid       = "ReadOrchestratorSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.orchestrator_secret_arn]
  }
}

resource "aws_iam_role_policy" "sweeper" {
  name   = local.sweeper_name
  role   = aws_iam_role.sweeper.id
  policy = data.aws_iam_policy_document.sweeper.json
}

resource "aws_lambda_function" "sweeper" {
  function_name    = local.sweeper_name
  role             = aws_iam_role.sweeper.arn
  filename         = data.archive_file.sweeper.output_path
  source_code_hash = data.archive_file.sweeper.output_base64sha256
  handler          = "index.handler"
  runtime          = var.lambda_runtime
  architectures    = ["arm64"]
  memory_size      = var.memory_mb
  timeout          = var.timeout_s

  environment {
    # Read by agents/orchestrator/src/sweeper/lambda.ts. Names only (D9).
    variables = {
      KCW_ORCHESTRATOR_SECRET    = var.orchestrator_secret_name
      KCW_ORCHESTRATOR_QUEUE_URL = var.queue_url
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.sweeper.name
  }

  depends_on = [aws_iam_role_policy.sweeper]
}

# Scheduler invokes Lambda asynchronously. No Lambda-side retries: the next run 15 minutes later is
# the retry, and a run older than its window is not worth starting.
resource "aws_lambda_function_event_invoke_config" "sweeper" {
  function_name                = aws_lambda_function.sweeper.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 600
}

# ---------- EventBridge Scheduler ----------

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = local.scheduler_name
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    sid       = "InvokeSweeper"
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.sweeper.arn, "${aws_lambda_function.sweeper.arn}:*"]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = local.scheduler_name
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "sweeper" {
  name                         = local.sweeper_name
  group_name                   = "default"
  schedule_expression          = var.schedule_expression
  schedule_expression_timezone = "UTC"
  state                        = var.enabled ? "ENABLED" : "DISABLED"

  # OFF: invoked at the exact :00/:15/:30/:45 times the code's windows assume.
  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.sweeper.arn
    role_arn = aws_iam_role.scheduler.arn
    # The scheduled time stays the same on a retried delivery: the sweeper derives its window,
    # dedupe ids and nightly decision from it.
    input = jsonencode({ scheduled_time = "<aws.scheduler.scheduled-time>" })

    retry_policy {
      maximum_event_age_in_seconds = 300
      maximum_retry_attempts       = 2
    }
  }

  depends_on = [aws_iam_role_policy.scheduler]
}
