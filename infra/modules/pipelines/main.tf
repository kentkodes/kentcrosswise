terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
  }
}

locals {
  watcher_name = "${var.name_prefix}-essay-watcher"
  group_name   = "${var.name_prefix}-pipelines"
  is_preview   = startswith(var.name_prefix, "kcw-pr-")
  lambda_arn   = "arn:${var.partition}:lambda:${var.region}:${var.account_id}:function:${local.watcher_name}"
  group_arn    = "arn:${var.partition}:scheduler:${var.region}:${var.account_id}:schedule-group/${local.group_name}"
  bucket_arn   = "arn:${var.partition}:s3:::${var.metadata_bucket_name}"

  # All runtime metadata (catalog snapshots, robots audit copies) lives under this prefix
  # (scripts/lib/pipelines/metadata.ts).
  metadata_prefix = "pipelines/meta"

  # Previews read a raw SSM SecureString (names start with "/"); production reads the db_url key of
  # a Secrets Manager JSON secret (scripts/lib/pipelines/handler.ts).
  credential_is_ssm = startswith(var.credential_name, "/")
  credential_arn = (local.credential_is_ssm
    ? "arn:${var.partition}:ssm:${var.region}:${var.account_id}:parameter/${trimprefix(var.credential_name, "/")}"
    : "arn:${var.partition}:secretsmanager:${var.region}:${var.account_id}:secret:${var.credential_name}-??????"
  )
}

resource "aws_sqs_queue" "dead_letters" {
  name                      = "${var.name_prefix}-essay-urls-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "essay_urls" {
  name                      = "${var.name_prefix}-essay-urls"
  message_retention_seconds = 345600
  # Belongs to the queue's consumer (the E6 fetcher), not to the watcher, which only sends.
  visibility_timeout_seconds = var.queue_visibility_timeout_s
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letters.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "dead_letters" {
  queue_url = aws_sqs_queue.dead_letters.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.essay_urls.arn]
  })
}

resource "aws_cloudwatch_log_group" "watcher" {
  name              = "/aws/lambda/${local.watcher_name}"
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

resource "aws_iam_role" "watcher" {
  name                 = local.watcher_name
  assume_role_policy   = data.aws_iam_policy_document.lambda_assume.json
  permissions_boundary = var.permissions_boundary_arn
}

# Exactly the calls in scripts/lib/pipelines (aws.ts, entry.ts via @kcw/secrets), on exact ARNs:
# ListObjectsV2 + GetObject + PutObject on the metadata prefix, SendMessage on the essay-urls queue,
# one credential read, and this function's own log group.
data "aws_iam_policy_document" "watcher" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.watcher.arn}:*"]
  }

  statement {
    sid       = "MetadataObjects"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${local.bucket_arn}/${local.metadata_prefix}/*"]
  }

  # aws.ts lists the exact key first, so a missing object reads as a miss rather than AccessDenied.
  statement {
    sid       = "MetadataList"
    actions   = ["s3:ListBucket"]
    resources = [local.bucket_arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${local.metadata_prefix}/*"]
    }
  }

  statement {
    sid       = "PublishEssayUrls"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.essay_urls.arn]
  }

  # SecureStrings use the AWS-managed aws/ssm key, whose key policy allows decryption through SSM.
  dynamic "statement" {
    for_each = local.credential_is_ssm ? [1] : []
    content {
      sid       = "ReadDatabaseParameter"
      actions   = ["ssm:GetParameter"]
      resources = [local.credential_arn]
    }
  }

  dynamic "statement" {
    for_each = local.credential_is_ssm ? [] : [1]
    content {
      sid       = "ReadPipelineSecret"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [local.credential_arn]
    }
  }
}

resource "aws_iam_role_policy" "watcher" {
  name   = local.watcher_name
  role   = aws_iam_role.watcher.id
  policy = data.aws_iam_policy_document.watcher.json
}

data "archive_file" "watcher" {
  type             = "zip"
  output_file_mode = "0644"
  source_dir       = var.watcher_package_dir
  output_path      = "${path.root}/.terraform/kcw-pipelines/${local.watcher_name}.zip"
}

resource "aws_lambda_function" "watcher" {
  function_name                  = local.watcher_name
  role                           = aws_iam_role.watcher.arn
  filename                       = data.archive_file.watcher.output_path
  source_code_hash               = data.archive_file.watcher.output_base64sha256
  handler                        = "index.handler"
  runtime                        = "nodejs24.x"
  architectures                  = ["arm64"]
  memory_size                    = var.memory_mb
  timeout                        = var.timeout_s
  reserved_concurrent_executions = var.reserved_concurrency

  environment {
    variables = {
      KCW_ENV                       = local.is_preview ? "preview" : "prod"
      KCW_PIPELINES_ENABLED         = tostring(var.runtime_enabled)
      KCW_PIPELINE_SECRET           = var.credential_name
      KCW_PIPELINES_METADATA_BUCKET = var.metadata_bucket_name
      KCW_ESSAY_URLS_QUEUE_URL      = aws_sqs_queue.essay_urls.url
    }
  }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.watcher.name
  }
  depends_on = [aws_iam_role_policy.watcher]
}

# At-least-once URL publishing is repaired by the database recovery sweep. Avoid overlapping
# async Lambda retries; the next daily invocation is the retry after a source/network failure.
resource "aws_lambda_function_event_invoke_config" "watcher" {
  function_name                = aws_lambda_function.watcher.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 3600
}

# Nothing retries a failed run (see above), so a failure is only visible here and in the log.
# No alarm action: no notification topic exists yet. Previews are short-lived and get none.
resource "aws_cloudwatch_metric_alarm" "watcher_errors" {
  count               = local.is_preview ? 0 : 1
  alarm_name          = "${local.watcher_name}-errors"
  alarm_description   = "The essay watcher failed (fixed reason in its log). The next scheduled run is the retry."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.watcher.function_name }
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_scheduler_schedule_group" "pipelines" {
  name = local.group_name
}

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
      values   = [var.account_id]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      # Scheduler supplies its schedule GROUP ARN, not an individual schedule ARN.
      values = [local.group_arn]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name                 = "${var.name_prefix}-essay-scheduler"
  assume_role_policy   = data.aws_iam_policy_document.scheduler_assume.json
  permissions_boundary = var.permissions_boundary_arn
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [local.lambda_arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "${var.name_prefix}-essay-scheduler"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "sources" {
  for_each                     = var.schedule_expressions
  name                         = each.key
  group_name                   = aws_scheduler_schedule_group.pipelines.name
  schedule_expression          = each.value
  schedule_expression_timezone = "UTC"
  state                        = var.schedules_enabled ? "ENABLED" : "DISABLED"
  flexible_time_window {
    mode = "OFF"
  }
  target {
    arn      = aws_lambda_function.watcher.arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ source_slug = each.key, mode = "discover" })
    # Retries a failed delivery (e.g. throttled invoke) only; a run that fails is not retried.
    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 2
    }
  }
  depends_on = [aws_iam_role_policy.scheduler]
}
