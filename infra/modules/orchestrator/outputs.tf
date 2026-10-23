output "queue_url" {
  description = "orchestrator-in FIFO queue URL (KCW_ORCHESTRATOR_QUEUE_URL for kcw-report and the web console)."
  value       = aws_sqs_queue.input.url
}

output "queue_arn" {
  value = aws_sqs_queue.input.arn
}

output "dlq_url" {
  value = aws_sqs_queue.dlq.url
}

output "relay_url" {
  description = "Function URL to set as the orchestrator GitHub App's webhook URL (P2-07)."
  value       = aws_lambda_function_url.relay.function_url
}

output "orchestrator_function_name" {
  value = aws_lambda_function.orchestrator.function_name
}

output "relay_function_name" {
  value = aws_lambda_function.relay.function_name
}
