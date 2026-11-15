# Scheduled web-side jobs (wave 2 design, section 1). EventBridge Scheduler invokes the server
# function with {"kcw_job": "<name>", "scheduled_time": "..."}; the origin wrapper routes that
# payload to its fixed job registry before the origin check. Previews pass no scheduled_jobs.

locals {
  # Built from plan-time values: a policy document that reads aws_lambda_function.server.arn is
  # deferred to apply whenever the server code changes, so every such plan showed this policy as an
  # infrastructure update (see modules/scheduler).
  server_arn = "arn:${local.partition}:lambda:${local.region}:${local.account_id}:function:${local.server_name}"
}

data "aws_iam_policy_document" "jobs_scheduler_assume" {
  count = length(var.scheduled_jobs) > 0 ? 1 : 0

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

resource "aws_iam_role" "jobs_scheduler" {
  count = length(var.scheduled_jobs) > 0 ? 1 : 0

  name                 = "${var.name_prefix}-hub-jobs-scheduler"
  assume_role_policy   = data.aws_iam_policy_document.jobs_scheduler_assume[0].json
  permissions_boundary = var.permissions_boundary_arn
}

data "aws_iam_policy_document" "jobs_scheduler" {
  count = length(var.scheduled_jobs) > 0 ? 1 : 0

  statement {
    sid       = "InvokeServer"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.server_arn, "${local.server_arn}:*"]
  }
}

resource "aws_iam_role_policy" "jobs_scheduler" {
  count = length(var.scheduled_jobs) > 0 ? 1 : 0

  name   = "${var.name_prefix}-hub-jobs-scheduler"
  role   = aws_iam_role.jobs_scheduler[0].id
  policy = data.aws_iam_policy_document.jobs_scheduler[0].json
}

resource "aws_scheduler_schedule" "jobs" {
  for_each = var.scheduled_jobs

  name                         = "${var.name_prefix}-job-${each.key}"
  group_name                   = "default"
  schedule_expression          = each.value
  schedule_expression_timezone = "UTC"
  state                        = "ENABLED"

  # OFF: invoked at the exact times the expression names (shares the sweeper's database wake-ups).
  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.server.arn
    role_arn = aws_iam_role.jobs_scheduler[0].arn
    input    = jsonencode({ kcw_job = each.key, scheduled_time = "<aws.scheduler.scheduled-time>" })

    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 2
    }
  }

  depends_on = [aws_iam_role_policy.jobs_scheduler]
}
