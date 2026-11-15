# Failure alerts (AR8b): one SNS topic, four alarms, one metric filter (infra/modules/alerts).
# Names are strings, matching modules/orchestrator and modules/scheduler. The owner adds the email
# subscription in the console (docs/runbooks/alerts.md); deploy.yml publishes to the topic on failure.
module "alerts" {
  source = "../modules/alerts"

  name_prefix           = "kcw-prod"
  input_queue_name      = "kcw-prod-orchestrator-in.fifo"
  dlq_name              = "kcw-prod-orchestrator-dlq.fifo"
  sweeper_function_name = "kcw-prod-sweeper"
  web_log_group_name    = "/aws/lambda/kcw-prod-server"
}

output "alerts_topic_arn" {
  value = module.alerts.topic_arn
}
