# Failure alerts (AR8b): four CloudWatch alarms and one metric filter publish to one SNS topic.
# The owner subscribes an email address in the console; there is deliberately no subscription resource
# here, so the address never enters the repository, variables or state (pinned by scripts/test/deploy-workflow.test.ts).
# No KMS key on the topic: CloudWatch cannot publish to a topic encrypted with the AWS-managed key.

data "aws_caller_identity" "current" {}

locals {
  topic_name = "${var.name_prefix}-alerts"
  # Every alarm treats missing data (an idle queue, a Lambda that did not run) as healthy.
  actions = [aws_sns_topic.alerts.arn]
}

resource "aws_sns_topic" "alerts" {
  name = local.topic_name
}

data "aws_iam_policy_document" "topic" {
  statement {
    sid       = "CloudWatchAlarmsPublish"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.topic.json
}

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${var.name_prefix}-orchestrator-dlq-not-empty"
  alarm_description   = "A message reached the orchestrator dead-letter queue. See docs/runbooks/alerts.md."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = var.dlq_name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

resource "aws_cloudwatch_metric_alarm" "input_oldest" {
  alarm_name          = "${var.name_prefix}-orchestrator-in-oldest"
  alarm_description   = "The oldest orchestrator input message has waited over 30 minutes. See docs/runbooks/alerts.md."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = var.input_queue_name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1800
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# The sweeper throws on any failed part or an unavailable database. Two failing 15-minute periods in a
# row alarm, so one transient failure does not page.
resource "aws_cloudwatch_metric_alarm" "sweeper_failing" {
  alarm_name          = "${var.name_prefix}-sweeper-failing"
  alarm_description   = "The sweeper Lambda failed in two consecutive 15-minute periods. See docs/runbooks/alerts.md."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = var.sweeper_function_name }
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}

# apps/web/src/server/origin-wrapper.ts logs exactly "[job] <name> failed <ErrorClass>" when a scheduled
# web job fails (tested in apps/web/test/origin-wrapper-jobs.test.ts).
resource "aws_cloudwatch_log_metric_filter" "hub_job_failures" {
  name           = "${var.name_prefix}-hub-job-failures"
  log_group_name = var.web_log_group_name
  pattern        = "\"[job]\" \"failed\""

  metric_transformation {
    name          = "HubJobFailures"
    namespace     = "kcw"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "hub_jobs_failing" {
  alarm_name          = "${var.name_prefix}-hub-jobs-failing"
  alarm_description   = "A scheduled web job (social-daily, inbox-push) failed today. See docs/runbooks/alerts.md."
  namespace           = aws_cloudwatch_log_metric_filter.hub_job_failures.metric_transformation[0].namespace
  metric_name         = aws_cloudwatch_log_metric_filter.hub_job_failures.metric_transformation[0].name
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
}
